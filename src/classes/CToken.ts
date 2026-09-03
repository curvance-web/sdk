import { Contract, TransactionResponse } from "ethers";
import { contractSetup, BPS, BPS_DECIMAL, ChangeRate, getRateSeconds, requireAccount, requireSigner, WAD, EMPTY_ADDRESS, toDecimal, SECONDS_PER_YEAR, toBps, NATIVE_ADDRESS, UINT256_MAX, amplifyContractSlippage } from "../helpers";
import { AdaptorTypes, DynamicMarketToken, StaticMarketToken, UserMarketToken } from "./ProtocolReader";
import { ERC20 } from "./ERC20";
import { Market, PluginTypes } from "./Market";
import { Calldata } from "./Calldata";
import Decimal from "decimal.js";
import base_ctoken_abi from '../abis/BaseCToken.json';
import { address, bytes, curvance_read_provider, curvance_signer, Percentage, TokenInput, USD, USD_WAD } from "../types";
import { Zapper, ZapperTypes, zapperTypeToName, type RedeemSwapQuote, type Swap } from "./Zapper";
import { PositionManager, PositionManagerTypes } from "./PositionManager";
import { BorrowableCToken } from "./BorrowableCToken";
import { NativeToken } from "./NativeToken";
import { ERC4626 } from "./ERC4626";
import FormatConverter from "./FormatConverter";
import type IDexAgg from "./DexAggregators/IDexAgg";
import type { DexQuoteOptions } from "./DexAggregators/IDexAgg";
import { isZapTokenExcluded } from "../zapPolicy";

const EXECUTION_DEBT_BUFFER_TIME = 100n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= 0n) {
        throw new Error("ceilDiv denominator must be positive");
    }
    return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function attachSettledTransactionContext(
    error: unknown,
    transaction: TransactionResponse,
    receipt?: unknown,
): Error {
    const contextualError = error instanceof Error ? error : new Error(String(error));

    try {
        Object.defineProperty(contextualError, "transaction", {
            configurable: true,
            enumerable: true,
            value: transaction,
        });
        if (receipt !== undefined) {
            Object.defineProperty(contextualError, "receipt", {
                configurable: true,
                enumerable: true,
                value: receipt,
            });
        }
        return contextualError;
    } catch {
        const wrapped = new Error(contextualError.message);
        Object.defineProperty(wrapped, "cause", { value: error });
        Object.defineProperty(wrapped, "transaction", {
            enumerable: true,
            value: transaction,
        });
        if (receipt !== undefined) {
            Object.defineProperty(wrapped, "receipt", {
                enumerable: true,
                value: receipt,
            });
        }
        return wrapped;
    }
}

/**
 * Leverage operation buffers — centralized for tuning.
 * Calibrated for fresh-state operation via getLeverageSnapshot under
 * Curvance's permanent single-oracle architecture.
 *
 * Single-oracle architecture (permanent design)
 * ---------------------------------------------
 * Curvance uses single-adaptor oracle configs only. The adaptor path ignores
 * the getLower flag — see line 78 of BaseOracleAdaptor.sol. Dual-feed mode
 * was deprecated in favor of the
 * price-guard system and orderflow MEV tech, and is not coming back.
 * This means MarketManager._statusOf returns symmetric prices for
 * collateral (queries with getLower=true) and debt (getLower=false), so
 * there is no oracle bound asymmetry contributing to checkSlippage forced
 * loss. Buffers below are sized accordingly — do not re-introduce
 * (L-1)-scaled buffers to "future-proof" against dual-feed.
 *
 * MEV / slippage protection model
 * -------------------------------
 * The on-chain BasePositionManager.checkSlippage modifier is per its own
 * docstring "primarily a sanity check rather than a security guarantee."
 * Real MEV protection comes from SwapperLib._swapSafe, which oracle-prices
 * the swap input and output and reverts if realized slippage exceeds the
 * Swap.slippage parameter we pass.
 *
 * Because _swapSafe measures value loss against the FULL input (pre-fee),
 * the deterministic KyberSwap fee would consume feeBps of the user's MEV
 * tolerance if not compensated. `KyberSwap.quoteAction` (the DEX adapter)
 * expands action.slippage by feeBps internally so the fee is absorbed and
 * the user's chosen tolerance is preserved for actual MEV/routing variance.
 * Callers pass raw user slippage — the adapter owns the expansion.
 *
 * Asymmetry between leverage up and deleverage
 * --------------------------------------------
 * Leverage UP: under single-oracle, the contract sees zero forced loss
 * for a perfect swap. The only real sources of difference between
 * snapshot-time prices and execution-time prices are: (a) wei-level share
 * rounding, (b) oracle price drift between the snapshot RPC and the
 * tx broadcast block. Both are small constants in absolute terms, NOT
 * leverage-scaled. A small flat buffer suffices.
 *
 * DELEVERAGE (full): forced loss comes from intentional swap overshoot
 * (DELEVERAGE_OVERHEAD_BPS) which prevents dust debt by oversizing the
 * collateral→debt swap. This is a real bps-level loss in absolute terms
 * which becomes (L-1) × bps in equity-fraction terms — so the deleverage
 * contract-slippage expansion DOES scale with leverage. Note: the contract
 * returns excess debt token to the user's wallet (BasePositionManager
 * onRedeem lines 482-493), so the economic loss from the overshoot is
 * zero — only the contract's naive equity-loss check sees it as loss.
 */
export const LEVERAGE = {
    /** Max leverage cap: fraction of theoretical max the user can select.
     *  Prevents boundary singularity at exact max leverage — the contract's
     *  post-op `canBorrow` check re-evaluates LTV against fresh on-chain
     *  state, and several loss channels can tick final LTV above collRatio
     *  at the boundary:
     *    - Pool fees (variable 1bp–1% across pools; aggregator route choice
     *      is not knowable at cap-compute time, can differ per-trade even
     *      for the same market)
     *    - `CURVANCE_FEE_BPS` (deterministic, amplified by (L-1); at L=10
     *      eats ~36bps of equity-fraction)
     *    - Oracle drift between preview snapshot and tx inclusion
     *    - Share rounding (wei-level)
     *
     *  History: 0.99 → 0.995 when caching improved precision (pre-fee era).
     *  0.995 → 0.98 when `CURVANCE_FEE_BPS = 4` landed and users on high-
     *  collRatio markets (shMON r=0.9 → 10x theoretical) hit
     *  `InsufficientCollateral` reverts at the boundary.
     *
     *  Independent of `LEVERAGE_UP_BUFFER_BPS` and `DELEVERAGE_OVERHEAD_BPS`
     *  below — those protect in-op slippage at `_swapSafe`; this protects
     *  post-op position health at `canBorrow`. */
    MAX_LEVERAGE_FACTOR: Decimal(0.98),
    /** Flat BPS buffer added to leverage-up DEX/swapSafe slippage tolerance.
     *  Under single-oracle, the only forced loss at the swap level comes from
     *  wei-level share rounding plus possible oracle price drift between
     *  snapshot RPC and tx broadcast block. Both are small constants.
     *
     *  Fee handling: KyberSwap.quoteAction expands action.slippage by feeBps
     *  internally so _swapSafe doesn't treat the fee as MEV. Each call site
     *  still computes contractSlippage (expanded by (L-1) × feeBps) so
     *  checkSlippage doesn't fire from equity-fraction amplification. This
     *  buffer covers rounding/drift only. */
    LEVERAGE_UP_BUFFER_BPS: 10n,
    /** BPS overhead on full deleverage swap sizing — absolute terms.
     *  Oversizes the collateral→debt swap so DEX impact + drift doesn't
     *  underdeliver and leave dust debt. The contract returns any excess
     *  debt token to the user, so economic loss is zero — but the contract's
     *  checkSlippage modifier sees the overshoot as equity loss and amplifies
     *  it by (L-1)x. The deleverage contract slippage expansion compensates
     *  for that amplification (see leverageDown). Keep this above observed
     *  route underdelivery so full-close attempts do not partially repay into
     *  the market's minimum-loan dust band. */
    DELEVERAGE_OVERHEAD_BPS: 60n,
    /** BPS buffer on expected-share calculations for zap/leverage paths.
     *  Covers exchange rate drift from interest accrual since cache load. */
    SHARES_BUFFER_BPS: 2n,
    /** Per-leverage-unit BPS buffer for `checkSlippage` on vault + native-vault
     *  leverage-up paths. Absorbs the drift between the collateral vault's
     *  fundamental mint rate at tx time and the stored oracle price that
     *  `marketManager.statusOf` uses inside `checkSlippage`. The vault-token
     *  oracle publishes discretely; the vault's exchange rate accrues
     *  continuously — so new shares are minted at `r_current` but valued at
     *  `r_oracle`, leaving a (L-1)-amplified equity-fraction gap that the
     *  simple path doesn't see in practice (vault-token markets default to
     *  the vault/native-vault PM and `leverageDown` drift goes the other
     *  direction as a gain). Empirically calibrated against the ~3% user
     *  slippage failure threshold on shMON/WMON native-vault leverage-up;
     *  refine via fork testing if drift distribution turns out wider. The
     *  constant is NOT "feed divergence" — shMON oracle IS derived from
     *  p_MON × r_shMON off-chain; the gap is between publish-time snapshot
     *  and tx-time state, not between two independent feeds. */
    LEVERAGE_UP_VAULT_DRIFT_BPS: 30n,
} as const;

export interface AccountSnapshot {
    asset: address;
    underlying: address;
    decimals: bigint;
    isCollateral: boolean;
    collateralPosted: bigint;
    debtBalance: bigint;
}

export interface MulticallAction {
    target: address;
    isPriceUpdate: boolean;
    data: bytes;
}

type LeverageUpPreviewOperation = 'leverage-up' | 'deposit-and-leverage';

export interface LeverageUpPreview {
    currentLeverage: Decimal;
    effectiveCurrentLeverage: Decimal;
    targetLeverage: Decimal;
    borrowAmount: Decimal;
    borrowAssets: bigint;
    debtIncrease: Decimal;
    debtIncreaseInAssets: Decimal;
    newDebt: Decimal;
    newDebtInAssets: Decimal;
    collateralIncrease: Decimal;
    collateralIncreaseInAssets: Decimal;
    newCollateral: Decimal;
    newCollateralInAssets: Decimal;
    feeBps: bigint;
    feeAssets: Decimal;
    feeUsd: Decimal;
}

interface ResolveLeverageUpPreviewParams {
    operation: LeverageUpPreviewOperation;
    targetLeverage: Decimal;
    borrow: BorrowableCToken;
    depositAssets?: bigint;
    positionManagerType?: PositionManagerTypes | undefined;
    leverageState?: LeverageStateOverride | undefined;
}

interface LeverageStateOverride {
    collateralUsd: bigint;
    debtUsd: bigint;
}

interface TokenApprovalTarget {
    token: ERC20;
    spender: address;
    spenderLabel: string;
}

interface ZapBuildResult {
    calldata: bytes;
    calldata_overrides: { [key: string]: any };
    zapper: Zapper | null;
    expectedShares?: bigint | undefined;
}

export interface TokenOracle {
    type: string;
    address: address;
}

export interface ZapToken {
    interface: NativeToken | ERC20;
    type: ZapperTypes;
    quote?: (tokenIn: string, tokenOut: string, amount: TokenInput, slippage: Percentage) => Promise<{
        minOut_raw: bigint;
        output_raw: bigint;
        minOut: Decimal;
        output: Decimal;
        extra?: any;
    }>;
}

export type ZapperInstructions =  'none' | 'native-vault' | 'vault' | 'native-simple' | {
    type: ZapperTypes;
    inputToken: address;
    slippage: Percentage;
}

export const REDEEM_ZAP = {
    DEFAULT_VALID_FOR_SECONDS: 100n,
    MAX_VALID_FOR_SECONDS: 600n,
    DEFAULT_MIN_SUBMIT_WINDOW_SECONDS: 15n,
    DEFAULT_PLANNING_TIMEOUT_MS: 12_000,
    MAX_PLANNING_TIMEOUT_MS: 12_000,
    DEFAULT_ROUTE_VALID_FOR_SECONDS: 10n,
    DEFAULT_ROUTE_MIN_SUBMIT_WINDOW_SECONDS: 2n,
    /**
     * Initial quotes are built before SimpleZapper delegation exists, so the
     * SDK cannot yet eth_call the exact state-changing redemption preview.
     * Keep that approval quote executable while the post-approval refresh
     * replaces it with the exact redeemFor return value.
     */
    PRE_APPROVAL_SOURCE_BUFFER_BPS: 1n,
    /** Headroom used only when preflighting optional destination collateral. */
    TARGET_COLLATERAL_HEADROOM_BPS: 2n,
} as const;

export type RedeemZapErrorCode =
    | "invalid-amount"
    | "capacity"
    | "source-unavailable"
    | "unsupported-token"
    | "setup-mismatch"
    | "invalid-account"
    | "stale-plan"
    | "invalid-plan"
    | "approval-required"
    | "target-unavailable"
    | "target-collateral-unavailable"
    | "aborted"
    | "timeout"
    | "simulation-failed";

export class RedeemZapError extends Error {
    readonly code: RedeemZapErrorCode;

    constructor(code: RedeemZapErrorCode, message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "RedeemZapError";
        this.code = code;
    }
}

export interface RedeemZapCapacitySnapshot {
    readonly shareBalance: bigint;
    readonly maxRedemptionShares: bigint;
    readonly liquidityAssets: bigint | null;
    readonly liquidityShares: bigint | null;
    readonly executableShares: bigint;
    readonly executableAssets: bigint;
}

export class RedeemZapCapacityError extends RedeemZapError {
    readonly requestedShares: bigint;
    readonly capacity: RedeemZapCapacitySnapshot;

    constructor(requestedShares: bigint, capacity: RedeemZapCapacitySnapshot) {
        super(
            "capacity",
            `Requested redemption requires ${requestedShares} shares, above the current executable capacity of ${capacity.executableShares}.`,
        );
        this.name = "RedeemZapCapacityError";
        this.requestedShares = requestedShares;
        this.capacity = capacity;
    }
}

export interface RedeemZapOptions {
    /** Redeem the exact fresh executable share capacity instead of round-tripping through assets. */
    redeemMax?: boolean;
    /** Lifetime of the capacity-bound plan, measured from chain time. */
    validForSeconds?: bigint;
    /** Minimum remaining lifetime required before simulation or submission. */
    minSubmitWindowSeconds?: bigint;
    /** Hard wall-clock budget for quote construction. */
    planningTimeoutMs?: number;
    /** Cancels capacity reads and route construction. */
    signal?: AbortSignal;
}

export type RefreshRedeemZapOptions = Pick<RedeemZapOptions, "planningTimeoutMs" | "signal">;

export interface RedeemZapExecutionOptions {
    /** Synchronous final intent check run after simulation and immediately before broadcast. */
    beforeBroadcast?: () => void;
}

export interface RedeemZapTargetDepositSnapshot {
    readonly mintPaused: boolean;
    readonly maxDepositAssets: bigint;
}

export interface RedeemZapTargetCollateralSnapshot {
    readonly collateralizationPaused: boolean;
    readonly collateralCapShares: bigint;
    readonly collateralPostedShares: bigint;
    readonly remainingCollateralShares: bigint;
    readonly requiredCollateralShares: bigint;
}

interface RedeemZapPlanBase {
    readonly chain: string;
    readonly chainId: number;
    readonly setupId: string;
    readonly zapper: address;
    readonly owner: address;
    readonly receiver: address;
    readonly sourceMarket: address;
    readonly sourceCToken: address;
    readonly sourceAsset: address;
    readonly sourceAssetDecimals: bigint;
    readonly outputToken: address;
    readonly requestedSourceAssets: bigint;
    readonly redeemMax: boolean;
    readonly capacity: RedeemZapCapacitySnapshot;
    readonly sourceShares: bigint;
    readonly sourceAssets: bigint;
    readonly sourceAssetRefundPossible: boolean;
    readonly quotedSourceAssetRefund: bigint;
    readonly expectedOutput: bigint;
    readonly minimumOutput: bigint;
    readonly slippageBps: bigint;
    readonly contractSlippage: bigint;
    readonly feeBps: bigint;
    readonly feeReceiver: address | undefined;
    readonly quotedAt: bigint;
    readonly validUntil: bigint;
    readonly minSubmitWindowSeconds: bigint;
    readonly routeQuotedAt: bigint;
    readonly routeValidUntil: bigint;
    readonly routeMinSubmitWindowSeconds: bigint;
    readonly forceRedeemCollateral: false;
    readonly swapAction: Swap;
    readonly calldata: bytes;
    readonly value: 0n;
}

export interface RedeemAndSwapPlan extends RedeemZapPlanBase {
    readonly kind: "curvance-redeem-and-swap-plan";
}

export interface RedeemSwapAndDepositPlan extends RedeemZapPlanBase {
    readonly kind: "curvance-redeem-swap-and-deposit-plan";
    readonly destinationMarket: address;
    readonly destinationCToken: address;
    readonly destinationAsset: address;
    readonly destinationAssetDecimals: bigint;
    readonly expectedDestinationShares: bigint;
    readonly minimumDestinationShares: bigint;
    readonly collateralizeFor: boolean;
    readonly collateralizeAccount: address;
    readonly targetDeposit: RedeemZapTargetDepositSnapshot;
    readonly targetCollateral: RedeemZapTargetCollateralSnapshot | null;
}

const redeemAndSwapPlans = new WeakSet<object>();
const redeemSwapAndDepositPlans = new WeakSet<object>();
const redeemSwapDestinations = new WeakMap<object, CToken>();

export interface ICToken {
    decimals(): Promise<bigint>;
    isBorrowable(): Promise<boolean>;
    balanceOf(account: address): Promise<bigint>;
    asset(): Promise<address>;
    totalSupply(): Promise<bigint>;
    totalAssets(): Promise<bigint>;
    marketManager(): Promise<address>;
    convertToAssets(shares: bigint): Promise<bigint>;
    convertToShares(assets: bigint): Promise<bigint>;
    exchangeRate(): Promise<bigint>;
    getSnapshot(account: address): Promise<AccountSnapshot>;
    multicall(calls: MulticallAction[]): Promise<TransactionResponse>;
    deposit(assets: bigint, receiver: address): Promise<TransactionResponse>;
    depositAsCollateral(assets: bigint, receiver: address): Promise<TransactionResponse>;
    redeem(shares: bigint, receiver: address, owner: address): Promise<TransactionResponse>;
    marketCollateralPosted(): Promise<bigint>;
    collateralPosted(account: address): Promise<bigint>;
    redeemCollateral(shares: bigint, receiver: address, owner: address): Promise<TransactionResponse>;
    redeemCollateralFor(shares: bigint, receiver: address, owner: address): Promise<TransactionResponse>;
    postCollateral(shares: bigint): Promise<TransactionResponse>;
    removeCollateral(shares: bigint): Promise<TransactionResponse>;
    symbol(): Promise<string>;
    name(): Promise<string>;
    maxDeposit(receiver: address): Promise<bigint>;
    transfer(receiver: address, amount: bigint): Promise<TransactionResponse>;
    approve(spender: address, amount: bigint): Promise<TransactionResponse>;
    allowance(owner: address, spender: address): Promise<bigint>;
    isDelegate(user: address, delegate: address): Promise<boolean>;
    setDelegateApproval(delegate: address, approved: boolean): Promise<TransactionResponse>;
    // More functions available
}

type UserCacheField =
    | "userAssetBalance"
    | "userShareBalance"
    | "userUnderlyingBalance"
    | "userCollateral"
    | "userDebt"
    | "liquidationPrice";

type UserCacheFreshness = Record<UserCacheField, boolean>;

const USER_CACHE_FIELDS: UserCacheField[] = [
    "userAssetBalance",
    "userShareBalance",
    "userUnderlyingBalance",
    "userCollateral",
    "userDebt",
    "liquidationPrice",
];

function createUserCacheFreshness(value: boolean): UserCacheFreshness {
    return {
        userAssetBalance: value,
        userShareBalance: value,
        userUnderlyingBalance: value,
        userCollateral: value,
        userDebt: value,
        liquidationPrice: value,
    };
}

export class CToken extends Calldata<ICToken> {
    provider: curvance_read_provider;
    address: address;
    contract: Contract & ICToken;
    abi: any;
    cache: StaticMarketToken & DynamicMarketToken & UserMarketToken;
    market: Market;
    zapTypes: ZapperTypes[] = [];
    leverageTypes: string[] = [];
    isVault: boolean = false;
    isNativeVault: boolean = false;
    isWrappedNative: boolean = false;
    nativeApy = Decimal(0);
    incentiveSupplyApy = Decimal(0);
    incentiveBorrowApy = Decimal(0);
    private userCacheFreshness?: UserCacheFreshness;
    get signer(): curvance_signer | null { return this.market.signer; }
    protected get account(): address | null { return this.market.account; }

    constructor(
        provider: curvance_read_provider,
        address: address,
        cache: StaticMarketToken & DynamicMarketToken & UserMarketToken,
        market: Market
    ) {
        super();
        this.provider = provider;
        this.address = address;
        this.contract = contractSetup<ICToken>(this.provider, address, base_ctoken_abi);
        this.cache = cache;
        this.market = market;

        const chainSettings = this.currentChainAssets;
        const assetAddr = this.asset.address.toLowerCase();
        this.isNativeVault = chainSettings.native_vaults.some(vault => vault.contract.toLowerCase() == assetAddr);
        this.isVault = chainSettings.vaults.some(vault => vault.contract.toLowerCase() == assetAddr);
        this.isWrappedNative = chainSettings.wrapped_native.toLowerCase() == assetAddr;

        this.refreshRouteCapabilities();
    }

    refreshRouteCapabilities() {
        this.zapTypes = [];
        this.leverageTypes = [];

        if(isZapTokenExcluded(this.currentChainAssets, this.asset)) {
            return;
        }

        const zappers = this.setup.contracts.zappers;
        const nativeVaultZapper = zappers?.nativeVaultZapper;
        const vaultZapper = zappers?.vaultZapper;
        const simpleZapper = zappers?.simpleZapper;
        const supportsNativeVaultZaps = typeof nativeVaultZapper === 'string'
            && nativeVaultZapper.toLowerCase() !== EMPTY_ADDRESS.toLowerCase();
        const supportsVaultZaps = typeof vaultZapper === 'string'
            && vaultZapper.toLowerCase() !== EMPTY_ADDRESS.toLowerCase();
        const supportsSimpleZaps = typeof simpleZapper === 'string'
            && simpleZapper.toLowerCase() !== EMPTY_ADDRESS.toLowerCase()
            && this.hasExecutableDexRoute;

        if(supportsNativeVaultZaps && this.isNativeVault) this.zapTypes.push('native-vault');
        if("nativeVaultPositionManager" in this.market.plugins && this.isNativeVault) this.leverageTypes.push('native-vault');
        if(supportsSimpleZaps && this.isWrappedNative) this.zapTypes.push('native-simple');

        if(supportsVaultZaps && this.isVault) this.zapTypes.push('vault');
        if("vaultPositionManager" in this.market.plugins && this.isVault) this.leverageTypes.push('vault');

        if(supportsSimpleZaps && "simplePositionManager" in this.market.plugins) this.leverageTypes.push('simple');
        if(supportsSimpleZaps) this.zapTypes.push('simple');
    }

    private getUserCacheFreshness(): UserCacheFreshness {
        if (this.userCacheFreshness == undefined) {
            this.userCacheFreshness = createUserCacheFreshness(true);
        }

        return this.userCacheFreshness;
    }

    markUserCacheFresh(fields: UserCacheField[] = USER_CACHE_FIELDS) {
        const freshness = this.getUserCacheFreshness();
        for (const field of fields) {
            freshness[field] = true;
        }
    }

    invalidateUserCache(fields: UserCacheField[] = USER_CACHE_FIELDS) {
        const freshness = this.getUserCacheFreshness();
        for (const field of fields) {
            freshness[field] = false;
        }
    }

    protected readFreshUserCache(field: UserCacheField, accessLabel: string): bigint {
        if (!this.getUserCacheFreshness()[field]) {
            throw new Error(
                `Token-level user data is stale for ${this.address} after a summary-only refresh on market ${this.market.address}. ` +
                `Call market.reloadUserData(account) or Market.reloadUserMarkets(...) before ${accessLabel}.`
            );
        }

        return this.cache[field] as bigint;
    }

    private get setup() { return this.market.setup; }
    private get currentChain() { return this.setup.chain; }
    private get currentChainAssets() { return this.setup.assets; }
    private get boundDexAgg(): IDexAgg | null { return this.market.dexAgg ?? null; }
    private get currentDexAgg() {
        const dexAgg = this.boundDexAgg;
        if (dexAgg == null) {
            throw new Error(
                `DEX aggregator is not bound for token ${this.address} on ${this.currentChain}. ` +
                `Use setupChain(...) result markets or attach a setup-bound dexAgg before route discovery/execution.`,
            );
        }
        return dexAgg;
    }
    private get hasExecutableDexRoute() {
        const router = this.boundDexAgg?.router;
        return typeof router === "string" && router.toLowerCase() !== EMPTY_ADDRESS.toLowerCase();
    }
    protected requireSigner() { return requireSigner(this.signer); }
    protected getAccountOrThrow(account: address | null = null) {
        return requireAccount(account ?? this.account, this.signer);
    }
    protected getWriteContract() {
        return contractSetup<ICToken>(this.requireSigner(), this.address, base_ctoken_abi);
    }

    private assertBorrowTokenBelongsToMarket(borrow: BorrowableCToken | null | undefined, label: string = "Borrow") {
        if (borrow == null) {
            return;
        }

        const borrowMarket = (borrow as BorrowableCToken & { market?: Market }).market;
        if (borrowMarket == undefined) {
            return;
        }

        if (borrowMarket === this.market) {
            return;
        }

        const borrowChain = borrowMarket.setup?.chain;
        const collateralChain = this.market.setup?.chain;
        const sameMarket = borrowMarket.address?.toLowerCase() === this.market.address.toLowerCase();
        const sameChain = borrowChain != null && collateralChain != null && borrowChain === collateralChain;
        const borrowReaderKey = borrowMarket.reader?.batchKey ?? null;
        const collateralReaderKey = this.market.reader?.batchKey ?? null;
        const sameReaderDeployment =
            borrowMarket.reader === this.market.reader ||
            (borrowReaderKey != null && borrowReaderKey === collateralReaderKey);

        if (!sameMarket || !sameChain || !sameReaderDeployment) {
            throw new Error(
                `${label} token ${borrow.address} belongs to market ${borrowMarket.address} ` +
                `on ${borrowChain ?? "unknown"}, not market ${this.market.address} on ${collateralChain ?? "unknown"} ` +
                `with the same reader deployment.`
            );
        }
    }

    private getZapType(zap: ZapperInstructions): ZapperTypes {
        return typeof zap === "object" ? zap.type : zap;
    }

    private isZapInstruction(zap: ZapperInstructions): boolean {
        return this.getZapType(zap) !== "none";
    }

    private async getZapInputDecimals(zap: ZapperInstructions): Promise<bigint> {
        const zapType = this.getZapType(zap);

        switch (zapType) {
            case "none":
                return this.asset.decimals;
            case "native-vault":
            case "native-simple":
                return 18n;
            case "vault": {
                const vaultAsset = await this.getVaultAsset(true);
                return vaultAsset.decimals ?? await vaultAsset.contract.decimals();
            }
            case "simple":
                if (typeof zap !== "object") {
                    return this.asset.decimals;
                }

                if (zap.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
                    return 18n;
                }

                const inputErc20 = new ERC20(
                    this.provider,
                    zap.inputToken,
                    undefined,
                    this.setup.contracts.OracleManager as address,
                    this.signer,
                );
                return inputErc20.decimals ?? await inputErc20.contract.decimals();
        }
    }

    private async getZapAssetAmount(amount: TokenInput, zap: ZapperInstructions): Promise<bigint> {
        return FormatConverter.decimalToBigInt(amount, await this.getZapInputDecimals(zap));
    }

    private async assertVaultLeverageBorrowAssetSupported(
        borrow: BorrowableCToken,
        type: "vault" | "native-vault",
    ) {
        this.assertBorrowTokenBelongsToMarket(borrow);
        const expectedAsset = type === "native-vault"
            ? this.currentChainAssets.wrapped_native
            : await this.getVaultAsset(false);
        const actualAsset = borrow.asset.address;

        if (actualAsset.toLowerCase() === expectedAsset.toLowerCase()) {
            return;
        }

        throw new Error(
            `${type} leverage requires borrow asset ${expectedAsset}, received ${actualAsset}. ` +
            `Use simple leverage for cross-asset borrow routes.`,
        );
    }

    get adapters() { return this.cache.adapters; }
    get borrowPaused() { return this.cache.borrowPaused }
    get collateralizationPaused() { return this.cache.collateralizationPaused }
    get mintPaused() { return this.cache.mintPaused }
    get redeemPaused() { return this.cache.redeemPaused }
    get marketManager() { return this.market; }
    get decimals() { return this.cache.decimals; }
    get symbol() { return this.cache.symbol; }
    get name() { return this.cache.name; }
    get asset() { return this.cache.asset }
    get isBorrowable() { return this.cache.isBorrowable; }
    get exchangeRate() { return this.cache.exchangeRate; }
    get canZap() { return this.zapTypes.length > 0; }
    get maxLeverage() {
        // Cap max leverage below theoretical max by applying MAX_LEVERAGE_FACTOR
        // to the (theoretical - 1) span. See LEVERAGE.MAX_LEVERAGE_FACTOR docs
        // for the loss channels this buffer absorbs and the tuning history.
        const theoretical = Decimal(this.cache.maxLeverage).div(BPS);
        const factor = theoretical.sub(1);
        return Decimal(1).add(factor.mul(LEVERAGE.MAX_LEVERAGE_FACTOR));
    }
    get canLeverage() { return this.leverageTypes.length > 0; }
    get totalAssets() { return this.cache.totalAssets; }
    get totalSupply() { return this.cache.totalSupply; }
    get liquidationPrice(): USD | null {
        const liquidationPrice = this.readFreshUserCache("liquidationPrice", "reading token liquidationPrice");
        if (liquidationPrice == UINT256_MAX) return null;
        return toDecimal(liquidationPrice, 18n);
    }
    get irmTargetRate() { return Decimal(this.cache.irmTargetRate).div(WAD); }
    get irmMaxRate() { return Decimal(this.cache.irmMaxRate).div(WAD); }
    get irmTargetUtilization() { return Decimal(this.cache.irmTargetUtilization).div(WAD); }
    get interestFee() { return Decimal(this.cache.interestFee).div(BPS); }

    virtualConvertToAssets(shares: bigint): bigint {
        if (this.totalSupply === 0n || this.totalAssets === 0n) {
            return shares;
        }

        return (shares * this.totalAssets) / this.totalSupply;
    }

    formatAssets(assets: bigint): TokenInput {
        return FormatConverter.bigIntToDecimal(assets, this.asset.decimals);
    }

    formatShares(shares: bigint): TokenInput {
        return FormatConverter.bigIntToDecimal(shares, this.decimals);
    }

    formatSharesAsAssets(shares: bigint): TokenInput {
        return this.formatAssets(this.virtualConvertToAssets(shares));
    }

    /**
     * Returns the oracle adaptor used to price this token's asset.
     *
     * Static market data stores oracle adaptor types, not adaptor addresses.
     * This resolves the first non-empty adaptor type from `adapters` through
     * the active chain deployment config, matching the app's "Oracle Address"
     * display logic while also exposing the adaptor type.
     *
     * @returns The configured oracle adaptor type and address, or `null` when
     * no adaptor is configured for the token.
     * @throws If the token references an unknown adaptor type or the active
     * chain config is missing the expected adaptor address.
     */
    getOracle(): TokenOracle | null {
        const adapter = this.adapters.find((adapter) => adapter !== 0n);
        if (adapter == undefined) {
            return null;
        }

        const adaptors = this.setup.contracts.adaptors as Partial<Record<
            "ChainlinkAdaptor" | "RedstoneClassicAdaptor" | "RedstoneCoreAdaptor",
            address
        >>;
        let adaptorName: keyof typeof adaptors;

        switch (adapter) {
            case AdaptorTypes.CHAINLINK:
                adaptorName = "ChainlinkAdaptor";
                break;
            case AdaptorTypes.REDSTONE_CLASSIC:
                adaptorName = "RedstoneClassicAdaptor";
                break;
            case AdaptorTypes.REDSTONE_CORE:
                adaptorName = "RedstoneCoreAdaptor";
                break;
            case AdaptorTypes.MOCK:
                const mockOracleAddress = (this.setup.contracts as any).MockOracle as address | undefined;
                return mockOracleAddress == undefined ? null : { type: "MockAdaptor", address: mockOracleAddress };
            default:
                throw new Error(`Unknown oracle adaptor type ${adapter.toString()} for ${this.symbol}`);
        }

        const oracleAddress = adaptors?.[adaptorName] as address | undefined;
        if (oracleAddress == undefined) {
            throw new Error(`Oracle adaptor ${adaptorName} not configured for chain ${this.currentChain}`);
        }

        return { type: adaptorName, address: oracleAddress };
    }
    
    /**
     * Convert assets to shares using cached totalSupply/totalAssets.
     * @param bufferBps Optional downward buffer in BPS to account for
     *                  exchange rate drift from interest accrual since cache load.
     *                  Matches the buffer pattern in async convertToShares().
     */
    virtualConvertToShares(assets: bigint, bufferBps: bigint = 0n): bigint {
        const shares = this.totalSupply === 0n || this.totalAssets === 0n
            ? assets
            : (assets * this.totalSupply) / this.totalAssets;
        return bufferBps > 0n ? shares * (BPS - bufferBps) / BPS : shares;
    }

    private getMarketLeverageState(leverageState?: LeverageStateOverride) {
        const currentCollateralInUsd = leverageState?.collateralUsd != null
            ? toDecimal(leverageState.collateralUsd, 18n)
            : this.market.userCollateral;
        const currentDebt = leverageState?.debtUsd != null
            ? toDecimal(leverageState.debtUsd, 18n)
            : this.market.userDebt;
        const equity = currentCollateralInUsd.sub(currentDebt);

        if (currentCollateralInUsd.lte(0) || equity.lte(0)) {
            return {
                currentCollateralInUsd,
                currentDebt,
                currentLeverage: null as Decimal | null,
            };
        }

        const currentLeverage = currentCollateralInUsd.div(equity);
        return {
            currentCollateralInUsd,
            currentDebt,
            currentLeverage: currentLeverage.eq(1) ? null : currentLeverage,
        };
    }

    getLeverage() {
        return this.getMarketLeverageState().currentLeverage;
    }

    /** @returns Remaining Collateral cap */
    getRemainingCollateral(formatted: true): USD;
    getRemainingCollateral(formatted: false): bigint;
    getRemainingCollateral(formatted: boolean = true): USD | bigint {
        const diff = this.cache.collateralCap - this.cache.collateral;
        return formatted ? this.convertSharesToUsdSync(diff) : diff;
    }

    /** @returns Remaining Debt cap */
    getRemainingDebt(formatted: true): USD;
    getRemainingDebt(formatted: false): bigint;
    getRemainingDebt(formatted:boolean = true): USD | bigint {
        const diff = this.cache.debtCap - this.cache.debt;
        return formatted ? this.convertTokensToUsd(diff) : diff;
    }

    /** @returns Collateral Ratio in BPS or bigint */
    getCollRatio(inBPS: true): Percentage;
    getCollRatio(inBPS: false): bigint;
    getCollRatio(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.collRatio).div(BPS) : this.cache.collRatio;
    }

    /** @returns Soft Collateral Requirement in BPS or bigint */
    getCollReqSoft(inBPS: true): Percentage;
    getCollReqSoft(inBPS: false): bigint;
    getCollReqSoft(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.collReqSoft).div(BPS) : this.cache.collReqSoft;
    }

    /** @returns Hard Collateral Requirement in BPS or bigint */
    getCollReqHard(inBPS: true): Percentage;
    getCollReqHard(inBPS: false): bigint;
    getCollReqHard(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.collReqHard).div(BPS) : this.cache.collReqHard;
    }

    /** @returns Liquidation Incentive Base in BPS or bigint */
    getLiqIncBase(inBPS: true): Percentage;
    getLiqIncBase(inBPS: false): bigint;
    getLiqIncBase(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.liqIncBase).div(BPS) : this.cache.liqIncBase;
    }

    /** @returns Liquidation Incentive Curve in BPS or bigint */
    getLiqIncCurve(inBPS: true): Percentage;
    getLiqIncCurve(inBPS: false): bigint;
    getLiqIncCurve(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.liqIncCurve).div(BPS) : this.cache.liqIncCurve;
    }

    /** @returns Liquidation Incentive Min in BPS or bigint */
    getLiqIncMin(inBPS: true): Percentage;
    getLiqIncMin(inBPS: false): bigint;
    getLiqIncMin(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.liqIncMin).div(BPS) : this.cache.liqIncMin;
    }

    /** @returns Liquidation Incentive Max in BPS or bigint */
    getLiqIncMax(inBPS: true): Percentage;
    getLiqIncMax(inBPS: false): bigint;
    getLiqIncMax(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.liqIncMax).div(BPS) : this.cache.liqIncMax;
    }

    /** @returns Close Factor Base in BPS or bigint */
    getCloseFactorBase(inBPS: true): Percentage;
    getCloseFactorBase(inBPS: false): bigint;
    getCloseFactorBase(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.closeFactorBase).div(BPS) : this.cache.closeFactorBase;
    }

    /** @returns Close Factor Curve in BPS or bigint */
    getCloseFactorCurve(inBPS: true): Percentage;
    getCloseFactorCurve(inBPS: false): bigint;
    getCloseFactorCurve(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.closeFactorCurve).div(BPS) : this.cache.closeFactorCurve;
    }

    /** @returns Close Factor Min in BPS or bigint */
    getCloseFactorMin(inBPS: true): Percentage;
    getCloseFactorMin(inBPS: false): bigint;
    getCloseFactorMin(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.closeFactorMin).div(BPS) : this.cache.closeFactorMin;
    }

    /** @returns Close Factor Max in Percentage or bigint */
    getCloseFactorMax(inBPS: true): Percentage;
    getCloseFactorMax(inBPS: false): bigint;
    getCloseFactorMax(inBPS: boolean) {
        return inBPS ? Decimal(this.cache.closeFactorMax).div(BPS)  : this.cache.closeFactorMax;
    }

    /** @returns User shares in USD (native balance amount) or token */
    getUserShareBalance(inUSD: true): USD;
    getUserShareBalance(inUSD: false): TokenInput;
    getUserShareBalance(inUSD: boolean): USD | TokenInput {
        const userShareBalance = this.readFreshUserCache("userShareBalance", "reading token user share balance");
        return inUSD ? this.convertTokensToUsd(userShareBalance, false) : this.formatShares(userShareBalance);
    }

    getUserShareBalanceAssets(): TokenInput {
        const userShareBalance = this.readFreshUserCache("userShareBalance", "reading token user share balance as assets");
        return this.formatSharesAsAssets(userShareBalance);
    }

    /** @returns User assets in USD (this is the raw balance that the token exchanges too) or token */
    getUserAssetBalance(inUSD: true): USD;
    getUserAssetBalance(inUSD: false): TokenInput;
    getUserAssetBalance(inUSD: boolean): USD | TokenInput {
        const userAssetBalance = this.readFreshUserCache("userAssetBalance", "reading token user asset balance");
        return inUSD ? this.convertTokensToUsd(userAssetBalance) : this.formatAssets(userAssetBalance);
    }

    /** @returns User underlying assets in USD or token */
    getUserUnderlyingBalance(inUSD: true): USD;
    getUserUnderlyingBalance(inUSD: false): TokenInput;
    getUserUnderlyingBalance(inUSD: boolean): USD | TokenInput {
        const userUnderlyingBalance = this.readFreshUserCache("userUnderlyingBalance", "reading token user underlying balance");
        return inUSD ? this.convertTokensToUsd(userUnderlyingBalance) : this.formatAssets(userUnderlyingBalance);
    }

    /** @returns Token Collateral Cap in USD or USD WAD */
    getCollateralCap(inUSD: true): USD;
    getCollateralCap(inUSD: false): USD_WAD;
    getCollateralCap(inUSD: boolean): USD | USD_WAD {
        return inUSD ? this.convertSharesToUsdSync(this.cache.collateralCap) : this.cache.collateralCap;
    }

    /** @returns Token Debt Cap in USD or USD WAD */
    getDebtCap(inUSD: true): USD;
    getDebtCap(inUSD: false): bigint;
    getDebtCap(inUSD: boolean): USD | bigint {
        return inUSD ? this.convertTokensToUsd(this.cache.debtCap) : this.cache.debtCap;
    }

    /** @returns Token Collateral in USD or USD WAD*/
    getCollateral(inUSD: true): USD;
    getCollateral(inUSD: false): USD_WAD;
    getCollateral(inUSD: boolean): USD | USD_WAD {
        return inUSD ? this.convertSharesToUsdSync(this.cache.collateral) : this.cache.collateral;
    }

    /** @returns Token Debt in USD or USD WAD */
    getDebt(inUSD: true): USD;
    getDebt(inUSD: false): USD_WAD;
    getDebt(inUSD: boolean): USD | USD_WAD {
        return inUSD ? this.convertTokensToUsd(this.cache.debt) : this.cache.debt;
    }

    /** @returns User Collateral in USD or share token amount */
    getUserCollateral(inUSD: true): USD;
    getUserCollateral(inUSD: false): TokenInput;
    getUserCollateral(inUSD: boolean): USD | TokenInput {
        const userCollateral = this.getUserCollateralShares();
        return inUSD ? this.convertTokensToUsd(userCollateral, false) : this.formatShares(userCollateral);
    }

    getUserCollateralShares(): bigint {
        return this.readFreshUserCache("userCollateral", "reading token user collateral shares");
    }

    getUserCollateralAssets(): TokenInput {
        return this.formatSharesAsAssets(this.getUserCollateralShares());
    }

    fetchUserCollateral(): Promise<bigint>;
    fetchUserCollateral(formatted: true): Promise<TokenInput>;
    fetchUserCollateral(formatted: false): Promise<bigint>;
    async fetchUserCollateral(formatted: boolean = false): Promise<bigint | TokenInput> {
        const collateral = await this.contract.collateralPosted(this.getAccountOrThrow());
        this.cache.userCollateral = collateral;
        this.markUserCacheFresh(["userCollateral"]);

        return formatted ? toDecimal(collateral, this.decimals) : collateral;
    }

    /** @returns User Debt in USD or Tokens owed (assets) */
    getUserDebt(inUSD: true): USD;
    getUserDebt(inUSD: false): TokenInput;
    getUserDebt(inUSD: boolean): USD | TokenInput {
        const userDebt = this.readFreshUserCache("userDebt", "reading token user debt");
        return inUSD ? this.convertTokensToUsd(userDebt) : FormatConverter.bigIntToDecimal(userDebt, this.asset.decimals);
    }

    earnChange(amount: USD, rateType: ChangeRate) {
        const rate = this.getApy(false);
        const rate_seconds = getRateSeconds(rateType);
        const rate_percent = Decimal(rate * rate_seconds).div(WAD);
        return amount.mul(rate_percent);
    }

    /**
     * Grabs the collateralization ratio and converts it to a Percentage.
     * @returns Percentage representation of the LTV (e.g. 0.75 for 75% LTV)
     */
    ltv(): Percentage {
        return Decimal(this.cache.collRatio).div(BPS);
    }

    getUnderlyingVault() {
        if(!this.isVault && !this.isNativeVault) {
            throw new Error("CToken does not use a vault asset as its underlying asset");
        }

        return new ERC4626(
            this.provider,
            this.getAsset(false),
            undefined,
            this.setup.contracts.OracleManager as address,
            this.signer,
        );
    }

    async getVaultAsset(asErc20: true): Promise<ERC20>;
    async getVaultAsset(asErc20: false): Promise<address>;
    async getVaultAsset(asErc20: boolean) {
        return asErc20 ? await this.getUnderlyingVault().fetchAsset(true) : await this.getUnderlyingVault().fetchAsset(false);
    }

    async getExpectedVaultShares(assets: bigint) {
        const vault = this.getUnderlyingVault();
        const vaultSharesRaw = await vault.previewDeposit(assets);

        // Vault/native-vault flows mint vault shares first, then convert those
        // into Curvance shares. Buffer the inner preview so exchange-rate drift
        // between quote time and inclusion cannot trip the outer expectedShares
        // check on otherwise-valid deposits/leverage/zaps.
        const vaultShares = vaultSharesRaw * (BPS - LEVERAGE.SHARES_BUFFER_BPS) / BPS;
        return this.convertToShares(vaultShares);
    }

    getAsset(asErc20: true): ERC20;
    getAsset(asErc20: false): address;
    getAsset(asErc20: boolean) {
        return asErc20
            ? new ERC20(
                this.provider,
                this.cache.asset.address,
                this.cache.asset,
                this.setup.contracts.OracleManager as address,
                this.signer,
            )
            : this.cache.asset.address
    }

    getPrice(): USD;
    getPrice(asset: boolean): USD;
    getPrice(asset: boolean, lower: boolean): USD;
    getPrice(asset: boolean, lower: boolean, formatted: true): USD;
    getPrice(asset: boolean, lower: boolean, formatted: false): USD_WAD;
    getPrice(asset: boolean = false, lower: boolean = false, formatted = true): USD | USD_WAD {
        return this.getCachedPrice(asset, lower, formatted);
    }

    getAssetPrice(): USD;
    getAssetPrice(lower: boolean): USD;
    getAssetPrice(lower: boolean, formatted: true): USD;
    getAssetPrice(lower: boolean, formatted: false): USD_WAD;
    getAssetPrice(lower: boolean = false, formatted = true): USD | USD_WAD {
        return this.getCachedPrice(true, lower, formatted);
    }

    getSharePrice(): USD;
    getSharePrice(lower: boolean): USD;
    getSharePrice(lower: boolean, formatted: true): USD;
    getSharePrice(lower: boolean, formatted: false): USD_WAD;
    getSharePrice(lower: boolean = false, formatted = true): USD | USD_WAD {
        return this.getCachedPrice(false, lower, formatted);
    }

    private getCachedPrice(asset: boolean, lower: boolean, formatted: boolean): USD | USD_WAD {
        const price = asset
            ? lower ? this.cache.assetPriceLower : this.cache.assetPrice
            : lower ? this.cache.sharePriceLower : this.cache.sharePrice;

        return this.formatCachedPrice(price, formatted);
    }

    private formatCachedPrice(price: USD_WAD, formatted: boolean): USD | USD_WAD {
        return formatted ? Decimal(price).div(WAD): price;
    }

    getApy(): Percentage;
    getApy(asPercentage: false): bigint;
    getApy(asPercentage: true): Percentage
    getApy(asPercentage = true): Percentage | bigint {
        // TODO: add underlying yield rate
        return asPercentage ? Decimal(this.cache.supplyRate).div(WAD).mul(SECONDS_PER_YEAR) : this.cache.supplyRate;
    }

    getTotalBorrowRate() {
        return this.getBorrowRate(true).sub(this.incentiveBorrowApy);
    }

    getTotalSupplyRate() {
        return this.getSupplyRate(true).add(this.incentiveSupplyApy).add(this.nativeApy);
    }

    getBorrowRate(): Percentage;
    getBorrowRate(inPercentage: true): Percentage;
    getBorrowRate(inPercentage: false): bigint;
    getBorrowRate(inPercentage = true) {
        return inPercentage ? Decimal(this.cache.borrowRate).div(WAD).mul(SECONDS_PER_YEAR) : this.cache.borrowRate;
    }

    getSupplyRate(): Percentage;
    getSupplyRate(asPercentage: false): bigint;
    getSupplyRate(asPercentage: true): Percentage
    getSupplyRate(asPercentage = true): Percentage | bigint {
        // TODO: add underlying yield rate
        return asPercentage ? Decimal(this.cache.supplyRate).div(WAD).mul(SECONDS_PER_YEAR) : this.cache.supplyRate;
    }

    /** @returns Deposits (underlying assets held by the cToken), in USD or raw
     *  asset bigint. Renamed from `getTvl` — the underlying field must be
     *  `totalAssets`, not `totalSupply`, or the displayed deposits are
     *  understated by the exchange-rate drift factor whenever interest has
     *  accrued. That drift also broke the `liquidity ≤ deposits` invariant
     *  on live markets (e.g. loAZND/AUSD showed $29.97K liquidity vs $29.21K
     *  deposits pre-fix — impossible for a solvent ERC4626). */
    getDeposits(inUSD: true): USD;
    getDeposits(inUSD: false): bigint;
    getDeposits(inUSD = true): USD | bigint {
        const deposits = this.cache.totalAssets;
        return inUSD ? this.convertTokensToUsd(deposits) : deposits;
    }

    async fetchDeposits(inUSD: true): Promise<USD>;
    async fetchDeposits(inUSD: false): Promise<bigint>;
    async fetchDeposits(inUSD = true): Promise<USD | bigint> {
        const deposits = await this.fetchTotalAssets();
        this.cache.totalAssets = deposits;
        return inUSD ? this.getDeposits(true) : this.getDeposits(false);
    }

    getTotalCollateral(inUSD: true): USD;
    getTotalCollateral(inUSD: false): bigint;
    getTotalCollateral(inUSD = true): USD | bigint {
        const totalCollateral = this.cache.collateral;
        return inUSD ? this.convertSharesToUsdSync(totalCollateral) : totalCollateral;
    }

    async fetchTotalCollateral(inUSD: true): Promise<USD>;
    async fetchTotalCollateral(inUSD: false): Promise<bigint>;
    async fetchTotalCollateral(inUSD = true): Promise<USD | bigint> {
        const totalCollateral = await this.contract.marketCollateralPosted();
        return inUSD ? this.fetchConvertSharesToUsd(totalCollateral) : totalCollateral;
    }

    getPositionManager(type: PositionManagerTypes) {
        const signer = this.requireSigner();

        let manager_contract = this.getPluginAddress(type, 'positionManager');

        if(manager_contract == null) {
            throw new Error("Plugin does not have an associated contract");
        }

        return new PositionManager(manager_contract, signer, type);
    }

    getZapper(type: ZapperTypes) {
        const signer = this.requireSigner();
        const zap_contract = this.getPluginAddress(type, 'zapper');

        if(zap_contract == null) {
            return null;
        }

        return new Zapper(zap_contract, signer, type, this.setup, this.currentDexAgg);
    }

    async isZapAssetApproved(instructions: ZapperInstructions, amount: bigint) {
        if(instructions == 'none') {
            return true;
        }

        const approvalTarget = await this.resolveZapApprovalTarget(instructions);
        if(approvalTarget == null) {
            return true;
        }

        return this.hasTokenApproval(approvalTarget, amount);
    }

    async approveZapAsset(instructions: ZapperInstructions, amount: TokenInput | null) {
        if(instructions == 'none') {
            throw new Error("Plugin does not have an associated contract");
        }

        const approvalTarget = await this.resolveZapApprovalTarget(instructions);
        if(approvalTarget == null) {
            return;
        }

        return approvalTarget.token.approve(approvalTarget.spender, amount);
    }

    async isPluginApproved(plugin: ZapperTypes | PositionManagerTypes, type: PluginTypes) {
        if(plugin == 'none') {
            return true;
        }

        const signer = this.requireSigner();
        const plugin_address = this.getPluginAddress(plugin, type);

        if(plugin_address == null) {
            throw new Error("Plugin does not have an associated contract");
        }

        return this.contract.isDelegate(signer.address as address, plugin_address);
    }

    async approvePlugin(plugin: ZapperTypes | PositionManagerTypes, type: PluginTypes) {
        const plugin_address = this.getPluginAddress(plugin, type);

        if(plugin_address == null) {
            throw new Error("Plugin does not have an associated contract");
        }

        return this.getWriteContract().setDelegateApproval(plugin_address, true);
    }

    getPluginAddress(plugin: ZapperTypes | PositionManagerTypes, type: PluginTypes): address | null {
        switch(type) {
            case 'zapper': {
                if(plugin == 'none') return null;
                if(!zapperTypeToName.has(plugin)) {
                    throw new Error("Plugin does not have a contract to map too");
                }

                const plugin_name = zapperTypeToName.get(plugin);
                if(!plugin_name || !this.setup.contracts.zappers || !(plugin_name in this.setup.contracts.zappers)) {
                    throw new Error(`Plugin ${plugin_name} not found in zappers`);
                }

                return this.setup.contracts.zappers[plugin_name] as address;
            }

            case 'positionManager': {
                switch(plugin) {
                    case 'vault': return this.market.plugins.vaultPositionManager as address;
                    case 'native-vault': return this.market.plugins.nativeVaultPositionManager as address;
                    case 'simple': return this.market.plugins.simplePositionManager as address;
                    default: throw new Error("Unknown position manager type");
                }
            }

            default: throw new Error("Unsupported plugin type");
        }
    }

    async getAllowance(check_contract: address, underlying = true) {
        const signer = this.requireSigner();
        const erc20 = new ERC20(
            this.provider,
            underlying ? this.asset.address : this.address,
            undefined,
            this.setup.contracts.OracleManager as address,
            this.signer,
        );
        const allowance = await erc20.allowance(signer.address as address, check_contract);
        return allowance;
    }

    /**
     * Approves the underlying asset to be used with the ctoken contract.
     * @param amount - if null it will approve the max uint256, otherwise the amount specified
     * @returns tx
     */
    async approveUnderlying(amount: TokenInput | null = null, target: address | null = null) {
        const erc20 = new ERC20(
            this.provider,
            this.asset.address,
            undefined,
            this.setup.contracts.OracleManager as address,
            this.signer,
        );
        const tx = await erc20.approve(target ? target : this.address, amount);
        return tx;
    }

    async approve(amount: TokenInput | null = null, spender: address) {
        const erc20 = new ERC20(
            this.provider,
            this.address,
            undefined,
            this.setup.contracts.OracleManager as address,
            this.signer,
        );
        const tx = await erc20.approve(spender, amount);
        return tx;
    }

    async fetchDecimals() {
        const decimals = await this.contract.decimals();
        this.cache.decimals = decimals;
        return decimals;
    }

    async fetchIsBorrowable() {
        const canBorrow = await this.contract.isBorrowable();
        this.cache.isBorrowable = canBorrow;
        return canBorrow;
    }

    async fetchAsset() {
        const asset = await this.contract.asset();
        this.cache.asset.address = asset;
        return asset;
    }

    async fetchMarketManagerAddr() {
        return this.contract.marketManager();
    }

    async fetchSymbol() {
        const symbol = await this.contract.symbol();
        this.cache.symbol = symbol;
        return symbol;
    }

    async fetchName() {
        const name = await this.contract.name();
        this.cache.name = name;
        return name;
    }

    async fetchPrice(asset = false, getLower = false, inUSD = true) {
        const priceForAddress = asset ? this.asset.address : this.address;
        const price = await this.market.oracle_manager.getPrice(priceForAddress, inUSD, getLower);

        if (asset) {
            if (getLower) this.cache.assetPriceLower = price;
            else this.cache.assetPrice = price;
        } else {
            if (getLower) this.cache.sharePriceLower = price;
            else this.cache.sharePrice = price;
        }
        return price;
    }

    async fetchTotalSupply() {
        return this.contract.totalSupply();
    }

    async fetchTotalAssets() {
        return this.contract.totalAssets();
    }

    async getExchangeRate() {
        const rate = await this.contract.exchangeRate();
        this.cache.exchangeRate = rate;
        return rate;
    }

    async marketCollateralPosted() {
        return this.contract.marketCollateralPosted();
    }

    async balanceOf(account: address) {
        return this.contract.balanceOf(account);
    }

    async maxDeposit(receiver: address) {
        return this.contract.maxDeposit(receiver);
    }

    async transfer(receiver: address, amount: TokenInput) {
        const shares = this.convertTokenInputToShares(amount);
        const calldata = this.getCallData("transfer", [receiver, shares]);
        return this.oracleRoute(calldata);
    }

    async redeemCollateral(amount: Decimal, receiver: address | null = null, owner: address | null = null) {
        const signer = this.requireSigner();
        receiver ??= signer.address as address;
        owner ??= signer.address as address;

        const shares = this.convertTokenInputToShares(amount);
        const signerAddress = signer.address as address;
        let method = "redeemCollateral";

        if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
            const isDelegated = await this.contract.isDelegate(owner, signerAddress);
            if (isDelegated) {
                method = "redeemCollateralFor";
            } else {
                const allowance = await this.contract.allowance(owner, signerAddress);
                if (allowance < shares) {
                    throw new Error(
                        `Please approve ${this.symbol} shares for ${signerAddress} or delegate ${signerAddress} before redeeming collateral for ${owner}.`
                    );
                }
            }
        }

        const calldata = this.getCallData(method, [shares, receiver, owner]);
        return this.oracleRoute(calldata, {}, owner);
    }

    async postCollateral(amount: TokenInput) {
        const signer = this.requireSigner();
        const shares = this.convertTokenInputToShares(amount);
        const balance = await this.balanceOf(signer.address as address);
        const collateral = await this.fetchUserCollateral();
        const available_shares = balance - collateral;
        const max_shares = available_shares < shares ? available_shares : shares;
        if(max_shares <= 0n) {
            throw new Error("No cToken shares available to post as collateral.");
        }
        this.assertCollateralCapacity(max_shares);

        const calldata = this.getCallData("postCollateral", [max_shares]);
        const tx = await this.oracleRoute(calldata);

        // Reload collateral state after execution
        await this.fetchUserCollateral();

        return tx;
    }

    private assertCollateralCapacity(shares?: bigint) {
        const collateralCapError = "There is not enough collateral left in this tokens collateral cap for this deposit.";
        const remainingCollateral = this.getRemainingCollateral(false);
        if(remainingCollateral <= 0n) throw new Error(collateralCapError);
        if(shares != undefined && shares > remainingCollateral) {
            throw new Error(collateralCapError);
        }
    }

    private getZapperExpectedShares(zapper: Zapper | null, calldata: bytes): bigint | undefined {
        if(zapper == null) return undefined;

        let expectedShares: bigint;
        try {
            const decoded = zapper.contract.interface.decodeFunctionData("swapAndDeposit", calldata);
            expectedShares = BigInt(decoded[3]);
        } catch {
            return undefined;
        }
        if(expectedShares <= 0n) {
            throw new Error("Zap expected shares must be greater than zero.");
        }
        return expectedShares;
    }

    async getZapBalance(zap: ZapperInstructions): Promise<bigint> {
        const signer = this.requireSigner();
        let asset: ERC20 | NativeToken;

        if(typeof zap === 'object') {
            if(zap.type === 'native-vault' || zap.type === 'native-simple' || zap.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
                asset = new NativeToken(
                    this.currentChain,
                    this.provider,
                    this.setup.contracts.OracleManager as address,
                    this.signer,
                    this.account,
                    this.currentChainAssets,
                );
            } else {
                asset = new ERC20(
                    this.provider,
                    zap.inputToken,
                    undefined,
                    this.setup.contracts.OracleManager as address,
                    this.signer,
                );
            }
        } else {
            switch (zap) {
                case 'none': asset = this.getAsset(true); break;
                case 'vault': asset = await this.getVaultAsset(true); break;
                case 'native-vault':
                    asset = new NativeToken(
                        this.currentChain,
                        this.provider,
                        this.setup.contracts.OracleManager as address,
                        this.signer,
                        this.account,
                        this.currentChainAssets,
                    );
                    break;
                case 'native-simple':
                    asset = new NativeToken(
                        this.currentChain,
                        this.provider,
                        this.setup.contracts.OracleManager as address,
                        this.signer,
                        this.account,
                        this.currentChainAssets,
                    );
                    break;
                default: throw new Error("Unsupported zap type for balance fetch");
            }
        }

        return asset.balanceOf(signer.address as address, false);
    }

    async ensureUnderlyingAmount(amount: TokenInput, zap: ZapperInstructions) : Promise<TokenInput> {
        const balance = await this.getZapBalance(zap);
        const decimals = await this.getZapInputDecimals(zap);
        const assets = FormatConverter.decimalToBigInt(amount, decimals);

        if(assets > balance) {
            const formattedBalance = FormatConverter.bigIntToDecimal(balance, decimals);
            throw new Error(
                `Insufficient balance: requested ${amount.toString()}, available ${formattedBalance.toString()}.`,
            );
        }

        return amount;
    }

    private getExecutionDebtBufferTime(): bigint {
        return this.market.userDebt.greaterThan(0) ? EXECUTION_DEBT_BUFFER_TIME : 0n;
    }

    private async resolveCollateralRemovalShares(amount: TokenInput): Promise<bigint> {
        const max_removable_shares = await this.maxRemovableCollateral(true, this.getExecutionDebtBufferTime());
        const requested_shares = this.convertTokenInputToShares(amount);
        let shares =
            max_removable_shares < requested_shares ? max_removable_shares : requested_shares;

        // If within 0.1% of the safe removable collateral, remove it all to avoid dust.
        const threshold = max_removable_shares / 1000n || 10n;
        if (max_removable_shares - shares <= threshold) {
            shares = max_removable_shares;
        }

        return shares;
    }

    private async executeCollateralRemoval(shares: bigint) {
        if (shares === 0n) {
            throw new Error("No removable collateral available.");
        }

        const calldata = this.getCallData("removeCollateral", [shares]);
        const tx = await this.oracleRoute(calldata);

        // Reload collateral state after execution
        await this.fetchUserCollateral();

        return tx;
    }

    async maxRemovableCollateral(): Promise<TokenInput>;
    async maxRemovableCollateral(in_shares: true): Promise<bigint>;
    async maxRemovableCollateral(in_shares: false): Promise<TokenInput>;
    async maxRemovableCollateral(in_shares: true, bufferTime: bigint): Promise<bigint>;
    async maxRemovableCollateral(in_shares: false, bufferTime: bigint): Promise<TokenInput>;
    async maxRemovableCollateral(in_shares: boolean = false, bufferTime: bigint = 0n): Promise<TokenInput | bigint> {
        if (in_shares) {
            const breakdown = await this.maxRedemption(true, bufferTime, true);
            return breakdown.max_collateral;
        }

        const breakdown = await this.maxRedemption(false, bufferTime, true);
        return breakdown.max_collateral;
    }

    async removeCollateralExact(amount: TokenInput) {
        const shares = await this.resolveCollateralRemovalShares(amount);
        return this.executeCollateralRemoval(shares);
    }

    async removeMaxCollateral() {
        const shares = await this.maxRemovableCollateral(true, this.getExecutionDebtBufferTime());
        return this.executeCollateralRemoval(shares);
    }

    convertTokenInputToShares(amount: TokenInput) {
        return this.virtualConvertToShares(
            FormatConverter.decimalToBigInt(amount, this.asset.decimals)
        );
    }

    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: true): TokenInput;
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: true, shares: boolean): TokenInput;
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: false, shares: boolean): bigint
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: false): bigint
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: boolean, shares: boolean = false): TokenInput | bigint {
        const fromData = {
            price: fromToken.getPrice(shares ? false : true),
            decimals: shares ? fromToken.decimals : fromToken.asset.decimals,
            amount: amount
        };

        const toData = {
            price: toToken.getPrice(shares ? false : true),
            decimals: shares ? toToken.decimals : toToken.asset.decimals
        };

        return formatted
            ? FormatConverter.tokensToTokens(fromData, toData, true)
            : FormatConverter.tokensToTokens(fromData, toData, false);
    }

    async convertToAssets(shares: bigint) {
        return this.contract.convertToAssets(shares);
    }

    async convertToShares(assets: bigint, bufferBps: bigint = LEVERAGE.SHARES_BUFFER_BPS) {
        const shares = await this.contract.convertToShares(assets);
        return bufferBps > 0n ? shares * (BPS - bufferBps) / BPS : shares;
    }

    async maxRedemption(): Promise<TokenInput>;
    async maxRedemption(in_shares: true): Promise<bigint>;
    async maxRedemption(in_shares: false): Promise<TokenInput>;
    async maxRedemption(in_shares: true, bufferTime: bigint): Promise<bigint>;
    async maxRedemption(in_shares: false, bufferTime: bigint): Promise<TokenInput>;
    async maxRedemption(in_shares: true, bufferTime: bigint, breakdown:true): Promise<{max_collateral: bigint, max_uncollateralized: bigint}>;
    async maxRedemption(in_shares: false, bufferTime: bigint, breakdown:true): Promise<{max_collateral: TokenInput, max_uncollateralized: TokenInput}>;
    async maxRedemption(in_shares: boolean = false, bufferTime: bigint = 0n, breakdown: boolean = false): Promise<(TokenInput | bigint) | {max_collateral: (TokenInput | bigint), max_uncollateralized: (TokenInput | bigint)}> {
        const data = await this.market.reader.maxRedemptionOf(this.getAccountOrThrow(), this, bufferTime);

        if(data.errorCodeHit) {
            throw new Error(`Error fetching max redemption. Possible stale price or other issues...`);
        }

        if(breakdown) {
            return {
                max_collateral: in_shares ? data.maxCollateralizedShares : FormatConverter.bigIntToDecimal(
                    this.virtualConvertToAssets(data.maxCollateralizedShares),
                    this.asset.decimals
                ),
                max_uncollateralized: in_shares ? data.maxUncollateralizedShares : FormatConverter.bigIntToDecimal(
                    this.virtualConvertToAssets(data.maxUncollateralizedShares),
                    this.asset.decimals
                ),
            };
        }

        const all_shares = data.maxCollateralizedShares + data.maxUncollateralizedShares;

        if(in_shares) return all_shares;

        const all_assets = this.virtualConvertToAssets(all_shares);
        return FormatConverter.bigIntToDecimal(all_assets, this.asset.decimals);
    }

    /** Reads the exact live constraints used to size SimpleZapper exits. */
    async fetchRedeemZapCapacity(): Promise<RedeemZapCapacitySnapshot> {
        const owner = this.getRedeemZapOwner();
        const liquidityPromise: Promise<bigint | null> = this.isBorrowable
            ? (this.contract as unknown as Contract & { assetsHeld(): Promise<bigint> }).assetsHeld()
            : Promise.resolve(null);
        const [shareBalance, maxRedemptionShares, liquidityAssets, redeemPaused] = await Promise.all([
            this.balanceOf(owner),
            this.maxRedemption(true, this.getExecutionDebtBufferTime()),
            liquidityPromise,
            this.market.contract.redeemPaused(),
        ]);
        if (redeemPaused === 2n) {
            throw new RedeemZapError(
                "source-unavailable",
                `Redemptions are currently paused for source market ${this.market.address}.`,
            );
        }
        const liquidityShares = liquidityAssets == null
            ? null
            : await this.contract.convertToShares(liquidityAssets);
        let executableShares = shareBalance < maxRedemptionShares
            ? shareBalance
            : maxRedemptionShares;
        if (liquidityShares != null && liquidityShares < executableShares) {
            executableShares = liquidityShares;
        }
        const executableAssets = executableShares > 0n
            ? await this.contract.convertToAssets(executableShares)
            : 0n;
        return Object.freeze({
            shareBalance,
            maxRedemptionShares,
            liquidityAssets,
            liquidityShares,
            executableShares,
            executableAssets,
        });
    }

    async quoteRedeemAndSwap(
        outputToken: address,
        amount: TokenInput,
        slippage: Percentage,
        options: RedeemZapOptions = {},
    ): Promise<RedeemAndSwapPlan> {
        const requestedAssets = this.parseRedeemZapAmount(amount);
        const slippageBps = FormatConverter.percentageToBps(slippage);
        return this.runRedeemZapPlanning(options, (signal) => this.buildRedeemAndSwapPlan(
            outputToken,
            requestedAssets,
            slippageBps,
            { ...options, signal },
        ));
    }

    async refreshRedeemAndSwapPlan(
        plan: RedeemAndSwapPlan,
        options: RefreshRedeemZapOptions = {},
    ): Promise<RedeemAndSwapPlan> {
        this.assertRedeemAndSwapPlanBinding(plan);
        const refreshOptions: RedeemZapOptions = {
            ...options,
            redeemMax: plan.redeemMax,
            validForSeconds: plan.validUntil - plan.quotedAt,
            minSubmitWindowSeconds: plan.minSubmitWindowSeconds,
        };
        return this.runRedeemZapPlanning(refreshOptions, (signal) => this.buildRedeemAndSwapPlan(
            plan.outputToken,
            plan.requestedSourceAssets,
            plan.slippageBps,
            { ...refreshOptions, signal },
        ));
    }

    async isRedeemAndSwapApproved(plan: RedeemAndSwapPlan): Promise<boolean> {
        this.assertRedeemAndSwapPlanBinding(plan);
        return this.contract.isDelegate(plan.owner, plan.zapper);
    }

    async approveRedeemAndSwap(plan: RedeemAndSwapPlan): Promise<TransactionResponse> {
        this.assertRedeemAndSwapPlanBinding(plan);
        return this.approvePlugin("simple", "zapper");
    }

    async simulateRedeemAndSwap(
        plan: RedeemAndSwapPlan,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const overrides = await this.preflightRedeemAndSwap(plan);
            return this.simulateOracleRoute(plan.calldata, overrides);
        } catch (error: any) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }

    async redeemAndSwap(
        plan: RedeemAndSwapPlan,
        options: RedeemZapExecutionOptions = {},
    ): Promise<TransactionResponse> {
        const overrides = await this.preflightRedeemAndSwap(plan);
        const simulation = await this.simulateOracleRoute(plan.calldata, overrides);
        if (!simulation.success) {
            throw new RedeemZapError(
                "simulation-failed",
                `Redemption swap simulation failed${simulation.error ? `: ${simulation.error}` : "."}`,
            );
        }
        await this.assertRedeemZapPlanFresh(plan);
        options.beforeBroadcast?.();
        return this.oracleRoute(plan.calldata, overrides, plan.receiver);
    }

    async quoteRedeemSwapAndDeposit(
        destination: CToken,
        amount: TokenInput,
        slippage: Percentage,
        collateralizeFor: boolean = false,
        options: RedeemZapOptions = {},
    ): Promise<RedeemSwapAndDepositPlan> {
        const requestedAssets = this.parseRedeemZapAmount(amount);
        const slippageBps = FormatConverter.percentageToBps(slippage);
        return this.runRedeemZapPlanning(options, (signal) => this.buildRedeemSwapAndDepositPlan(
            destination,
            requestedAssets,
            slippageBps,
            collateralizeFor,
            { ...options, signal },
        ));
    }

    async refreshRedeemSwapAndDepositPlan(
        plan: RedeemSwapAndDepositPlan,
        options: RefreshRedeemZapOptions = {},
    ): Promise<RedeemSwapAndDepositPlan> {
        const destination = this.assertRedeemSwapAndDepositPlanBinding(plan);
        const refreshOptions: RedeemZapOptions = {
            ...options,
            redeemMax: plan.redeemMax,
            validForSeconds: plan.validUntil - plan.quotedAt,
            minSubmitWindowSeconds: plan.minSubmitWindowSeconds,
        };
        return this.runRedeemZapPlanning(refreshOptions, (signal) => this.buildRedeemSwapAndDepositPlan(
            destination,
            plan.requestedSourceAssets,
            plan.slippageBps,
            plan.collateralizeFor,
            { ...refreshOptions, signal },
        ));
    }

    async isRedeemSwapAndDepositApproved(plan: RedeemSwapAndDepositPlan): Promise<boolean> {
        this.assertRedeemSwapAndDepositPlanBinding(plan);
        return this.contract.isDelegate(plan.owner, plan.zapper);
    }

    async approveRedeemSwapAndDeposit(plan: RedeemSwapAndDepositPlan): Promise<TransactionResponse> {
        this.assertRedeemSwapAndDepositPlanBinding(plan);
        return this.approvePlugin("simple", "zapper");
    }

    async isRedeemSwapAndDepositTargetApproved(
        plan: RedeemSwapAndDepositPlan,
    ): Promise<boolean> {
        const destination = this.assertRedeemSwapAndDepositPlanBinding(plan);
        if (!plan.collateralizeFor) return true;
        return destination.contract.isDelegate(plan.collateralizeAccount, plan.zapper);
    }

    async approveRedeemSwapAndDepositTarget(
        plan: RedeemSwapAndDepositPlan,
    ): Promise<TransactionResponse | undefined> {
        const destination = this.assertRedeemSwapAndDepositPlanBinding(plan);
        if (!plan.collateralizeFor) return undefined;
        return destination.approvePlugin("simple", "zapper");
    }

    async simulateRedeemSwapAndDeposit(
        plan: RedeemSwapAndDepositPlan,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const { overrides } = await this.preflightRedeemSwapAndDeposit(plan);
            return this.simulateOracleRoute(plan.calldata, overrides);
        } catch (error: any) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }

    async redeemSwapAndDeposit(
        plan: RedeemSwapAndDepositPlan,
        options: RedeemZapExecutionOptions = {},
    ): Promise<TransactionResponse> {
        const { destination, overrides } = await this.preflightRedeemSwapAndDeposit(plan);
        const simulation = await this.simulateOracleRoute(plan.calldata, overrides);
        if (!simulation.success) {
            throw new RedeemZapError(
                "simulation-failed",
                `Move position simulation failed${simulation.error ? `: ${simulation.error}` : "."}`,
            );
        }
        await this.assertRedeemZapPlanFresh(plan);
        options.beforeBroadcast?.();
        const tx = await this.oracleRoute(plan.calldata, overrides, plan.receiver);
        if (destination.market.address.toLowerCase() !== this.market.address.toLowerCase()) {
            try {
                await destination.market.reloadUserData(plan.receiver);
            } catch (error) {
                throw attachSettledTransactionContext(error, tx);
            }
        }
        return tx;
    }

    private parseRedeemZapAmount(amount: TokenInput): bigint {
        let assets: bigint;
        try {
            assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        } catch (error) {
            throw new RedeemZapError("invalid-amount", "Redemption amount is invalid.", error);
        }
        if (assets <= 0n) {
            throw new RedeemZapError("invalid-amount", "Redemption amount must be greater than zero.");
        }
        return assets;
    }

    private getRedeemZapSetupId(zapper: address): string {
        const oracleManager = this.setup.contracts.OracleManager as address;
        return `${this.currentChain}:${this.setup.chainId}:${oracleManager.toLowerCase()}:${zapper.toLowerCase()}`;
    }

    private getRedeemZapOwner(): address {
        const owner = this.requireSigner().address as address;
        if (owner.toLowerCase() === EMPTY_ADDRESS.toLowerCase()) {
            throw new RedeemZapError("invalid-account", "Connected account cannot be the zero address.");
        }
        if (this.account != null && this.account.toLowerCase() !== owner.toLowerCase()) {
            throw new RedeemZapError(
                "invalid-account",
                `Source market is loaded for ${this.account}, not the connected account ${owner}.`,
            );
        }
        return owner;
    }

    private assertRedeemZapOutputToken(outputToken: address) {
        if (
            outputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase() ||
            outputToken.toLowerCase() === EMPTY_ADDRESS.toLowerCase()
        ) {
            throw new RedeemZapError(
                "unsupported-token",
                "Exit output must be a nonzero ERC-20 token. Native output is not supported.",
            );
        }
    }

    private assertRedeemZapDestination(destination: CToken) {
        if (destination.address.toLowerCase() === this.address.toLowerCase()) {
            throw new RedeemZapError(
                "target-unavailable",
                "Move destination must differ from the source cToken.",
            );
        }
        if (destination.market.setup !== this.setup) {
            throw new RedeemZapError(
                "setup-mismatch",
                `Destination ${destination.address} is not bound to the source setup snapshot.`,
            );
        }
        if (isZapTokenExcluded(this.setup.assets, destination.asset)) {
            throw new RedeemZapError(
                "unsupported-token",
                `Move destination asset ${destination.asset.symbol} is excluded from zaps.`,
            );
        }
    }

    private async getRedeemZapContext(options: RedeemZapOptions) {
        const owner = this.getRedeemZapOwner();
        const validForSeconds = options.validForSeconds ?? REDEEM_ZAP.DEFAULT_VALID_FOR_SECONDS;
        const minSubmitWindowSeconds = options.minSubmitWindowSeconds
            ?? REDEEM_ZAP.DEFAULT_MIN_SUBMIT_WINDOW_SECONDS;
        if (validForSeconds <= 0n || validForSeconds > REDEEM_ZAP.MAX_VALID_FOR_SECONDS) {
            throw new RedeemZapError(
                "invalid-plan",
                `Exit plan validity must be in [1, ${REDEEM_ZAP.MAX_VALID_FOR_SECONDS}] seconds.`,
            );
        }
        if (minSubmitWindowSeconds < 0n || minSubmitWindowSeconds >= validForSeconds) {
            throw new RedeemZapError(
                "invalid-plan",
                "Exit plan minimum submit window must be non-negative and shorter than validity.",
            );
        }
        const zapper = this.getZapper("simple");
        if (zapper == null) {
            throw new RedeemZapError(
                "unsupported-token",
                `Simple Zapper is not configured for ${this.symbol}.`,
            );
        }
        const quotedAt = await this.getRedeemZapChainTimestamp();
        return {
            owner,
            receiver: owner,
            zapper,
            quotedAt,
            validUntil: quotedAt + validForSeconds,
            minSubmitWindowSeconds,
        };
    }

    private async getRedeemZapChainTimestamp(): Promise<bigint> {
        const block = await this.provider.getBlock("latest");
        if (block == null) {
            throw new RedeemZapError("stale-plan", "Could not read the latest block for exit planning.");
        }
        return BigInt(block.timestamp);
    }

    private async runRedeemZapPlanning<T>(
        options: RedeemZapOptions,
        operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const timeoutMs = options.planningTimeoutMs ?? REDEEM_ZAP.DEFAULT_PLANNING_TIMEOUT_MS;
        if (
            !Number.isInteger(timeoutMs) ||
            timeoutMs <= 0 ||
            timeoutMs > REDEEM_ZAP.MAX_PLANNING_TIMEOUT_MS
        ) {
            throw new RedeemZapError(
                "invalid-plan",
                `Exit planning timeout must be an integer in [1, ${REDEEM_ZAP.MAX_PLANNING_TIMEOUT_MS}] ms.`,
            );
        }
        if (options.signal?.aborted) {
            throw new RedeemZapError("aborted", "Exit quote planning was cancelled.", options.signal.reason);
        }

        const controller = new AbortController();
        let rejectBoundary: ((error: RedeemZapError) => void) | undefined;
        let settled = false;
        const boundary = new Promise<never>((_resolve, reject) => {
            rejectBoundary = reject;
        });
        const rejectOnce = (error: RedeemZapError) => {
            if (settled) return;
            controller.abort(error);
            rejectBoundary?.(error);
        };
        const onAbort = () => rejectOnce(new RedeemZapError(
            "aborted",
            "Exit quote planning was cancelled.",
            options.signal?.reason,
        ));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timeout = setTimeout(() => rejectOnce(new RedeemZapError(
            "timeout",
            `Exit quote planning exceeded its ${timeoutMs}ms deadline.`,
        )), timeoutMs);
        try {
            return await Promise.race([operation(controller.signal), boundary]);
        } finally {
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", onAbort);
            if (!controller.signal.aborted) controller.abort();
        }
    }

    private async assertRedeemZapHoldAvailable(owner: address, now?: bigint) {
        const [cooldownTimestamp, holdPeriod, currentTimestamp] = await Promise.all([
            this.market.contract.accountAssets(owner),
            this.market.contract.MIN_HOLD_PERIOD(),
            now == null ? this.getRedeemZapChainTimestamp() : Promise.resolve(now),
        ]);
        const availableAt = cooldownTimestamp + holdPeriod;
        if (availableAt > currentTimestamp) {
            throw new RedeemZapError(
                "source-unavailable",
                `Source market action hold is active until timestamp ${availableAt}.`,
            );
        }
    }

    private async normalizeRedeemZapAmount(
        requestedAssets: bigint,
        context: Pick<
            Awaited<ReturnType<CToken["getRedeemZapContext"]>>,
            "owner" | "quotedAt" | "zapper"
        >,
        redeemMax: boolean,
    ) {
        if (requestedAssets <= 0n) {
            throw new RedeemZapError("invalid-amount", "Redemption amount must be greater than zero.");
        }
        const requestedSharesPromise = redeemMax
            ? Promise.resolve<bigint | null>(null)
            : this.contract.convertToShares(requestedAssets);
        const [capacity, requestedShares] = await Promise.all([
            this.fetchRedeemZapCapacity(),
            requestedSharesPromise,
            this.assertRedeemZapHoldAvailable(context.owner, context.quotedAt),
        ]);
        const sourceShares = redeemMax ? capacity.executableShares : requestedShares;
        if (sourceShares == null || sourceShares <= 0n) {
            throw new RedeemZapError("invalid-amount", "Redemption amount is below the minimum share unit.");
        }
        if (sourceShares > capacity.executableShares) {
            throw new RedeemZapCapacityError(sourceShares, capacity);
        }
        const previewSourceAssets = await this.contract.convertToAssets(sourceShares);
        if (previewSourceAssets <= 0n) {
            throw new RedeemZapError("invalid-amount", "Redemption amount converts to zero source assets.");
        }
        const execution = await this.readRedeemZapExecutionAssets(
            context.owner,
            context.zapper.address,
            sourceShares,
            previewSourceAssets,
            true,
        );
        return {
            capacity,
            sourceShares,
            sourceAssets: execution.sourceAssets,
            quotedSourceAssetRefund: execution.quotedSourceAssetRefund,
            redeemMax,
        };
    }

    /**
     * `convertToAssets` reads cached totals, while `redeemFor` first runs
     * `_accrueIfNeeded`. On live borrowable markets that accrual can mint fee
     * shares, making the actual redemption a few raw units smaller than the
     * view conversion and causing the zapper's exact expected-assets check to
     * revert. Once delegated, simulate `redeemFor` from the zapper address so
     * quote and calldata use the value the deployed contract will return.
     */
    private async readRedeemZapExecutionAssets(
        owner: address,
        zapper: address,
        sourceShares: bigint,
        previewSourceAssets: bigint,
        allowPreApprovalFallback: boolean,
    ): Promise<{ sourceAssets: bigint; quotedSourceAssetRefund: bigint }> {
        const approved = await this.contract.isDelegate(owner, zapper);
        if (!approved) {
            if (!allowPreApprovalFallback) {
                throw new RedeemZapError(
                    "approval-required",
                    `Approve Simple Zapper ${zapper} to redeem source cToken ${this.address}.`,
                );
            }
            const requestedBuffer = ceilDiv(
                previewSourceAssets * REDEEM_ZAP.PRE_APPROVAL_SOURCE_BUFFER_BPS,
                BPS,
            );
            const buffer = requestedBuffer < previewSourceAssets
                ? requestedBuffer
                : previewSourceAssets - 1n;
            const sourceAssets = previewSourceAssets - buffer;
            if (sourceAssets <= 0n) {
                throw new RedeemZapError(
                    "invalid-amount",
                    "Redemption amount is below the minimum safely executable asset unit.",
                );
            }
            return {
                sourceAssets,
                quotedSourceAssetRefund: buffer,
            };
        }

        const calldata = this.getCallData("redeemFor", [
            sourceShares,
            zapper,
            owner,
        ]);
        let result: string;
        try {
            result = await this.provider.call({
                from: zapper,
                to: this.address,
                data: calldata,
            });
        } catch (error) {
            throw new RedeemZapError(
                "source-unavailable",
                "Unable to preview the exact source redemption from Simple Zapper.",
                error,
            );
        }

        let redeemedAssets: bigint;
        try {
            const decoded = this.contract.interface.decodeFunctionResult("redeemFor", result);
            redeemedAssets = BigInt(decoded[0]);
        } catch (error) {
            throw new RedeemZapError(
                "source-unavailable",
                "Source redemption preview returned malformed data.",
                error,
            );
        }
        if (redeemedAssets <= 0n) {
            throw new RedeemZapError(
                "source-unavailable",
                "Source redemption preview returned zero assets.",
            );
        }

        return {
            sourceAssets: redeemedAssets < previewSourceAssets
                ? redeemedAssets
                : previewSourceAssets,
            quotedSourceAssetRefund: redeemedAssets > previewSourceAssets
                ? redeemedAssets - previewSourceAssets
                : 0n,
        };
    }

    private async getRedeemZapRouteTiming(
        context: Awaited<ReturnType<CToken["getRedeemZapContext"]>>,
        quote: RedeemSwapQuote,
    ) {
        const usesExternalRoute = quote.action.target.toLowerCase() !== EMPTY_ADDRESS.toLowerCase();
        const routeQuotedAt = usesExternalRoute
            ? await this.getRedeemZapChainTimestamp()
            : context.quotedAt;
        if (routeQuotedAt + context.minSubmitWindowSeconds > context.validUntil) {
            throw new RedeemZapError(
                "stale-plan",
                "Exit plan expired while the swap route was being built; request a new quote.",
            );
        }
        return {
            routeQuotedAt,
            routeValidUntil: usesExternalRoute
                ? routeQuotedAt + REDEEM_ZAP.DEFAULT_ROUTE_VALID_FOR_SECONDS
                : context.validUntil,
            routeMinSubmitWindowSeconds: usesExternalRoute
                ? REDEEM_ZAP.DEFAULT_ROUTE_MIN_SUBMIT_WINDOW_SECONDS
                : context.minSubmitWindowSeconds,
        };
    }

    private createRedeemZapBase(
        context: Awaited<ReturnType<CToken["getRedeemZapContext"]>>,
        requestedAssets: bigint,
        normalized: Awaited<ReturnType<CToken["normalizeRedeemZapAmount"]>>,
        quote: RedeemSwapQuote,
        timing: Awaited<ReturnType<CToken["getRedeemZapRouteTiming"]>>,
        calldata: bytes,
    ): Omit<RedeemZapPlanBase, "kind"> {
        return {
            chain: this.currentChain,
            chainId: this.setup.chainId,
            setupId: this.getRedeemZapSetupId(context.zapper.address),
            zapper: context.zapper.address,
            owner: context.owner,
            receiver: context.receiver,
            sourceMarket: this.market.address,
            sourceCToken: this.address,
            sourceAsset: this.asset.address,
            sourceAssetDecimals: this.asset.decimals,
            outputToken: quote.outputToken,
            requestedSourceAssets: requestedAssets,
            redeemMax: normalized.redeemMax,
            capacity: normalized.capacity,
            sourceShares: normalized.sourceShares,
            sourceAssets: normalized.sourceAssets,
            sourceAssetRefundPossible: true,
            quotedSourceAssetRefund: normalized.quotedSourceAssetRefund,
            expectedOutput: quote.expectedOutput,
            minimumOutput: quote.minimumOutput,
            slippageBps: quote.slippageBps,
            contractSlippage: quote.action.slippage,
            feeBps: quote.feeBps,
            feeReceiver: quote.feeReceiver,
            quotedAt: context.quotedAt,
            validUntil: context.validUntil,
            minSubmitWindowSeconds: context.minSubmitWindowSeconds,
            ...timing,
            forceRedeemCollateral: false,
            swapAction: Object.freeze({ ...quote.action }),
            calldata,
            value: 0n,
        };
    }

    private async buildRedeemAndSwapPlan(
        outputToken: address,
        requestedAssets: bigint,
        slippageBps: bigint,
        options: RedeemZapOptions,
    ): Promise<RedeemAndSwapPlan> {
        this.assertRedeemZapOutputToken(outputToken);
        const context = await this.getRedeemZapContext(options);
        const normalized = await this.normalizeRedeemZapAmount(
            requestedAssets,
            context,
            options.redeemMax === true,
        );
        const quote = await context.zapper.quoteRedeemSwap(
            this,
            outputToken,
            normalized.sourceAssets,
            slippageBps,
            options.signal == null ? {} : { signal: options.signal },
        );
        const calldata = context.zapper.getRedeemAndSwapCalldataFromQuote(
            this,
            quote,
            normalized.sourceShares,
            context.receiver,
        );
        const timing = await this.getRedeemZapRouteTiming(context, quote);
        const plan = Object.freeze({
            kind: "curvance-redeem-and-swap-plan" as const,
            ...this.createRedeemZapBase(
                context,
                requestedAssets,
                normalized,
                quote,
                timing,
                calldata,
            ),
        });
        redeemAndSwapPlans.add(plan);
        this.assertRedeemAndSwapPlanBinding(plan);
        return plan;
    }

    private async readRedeemZapTargetDeposit(
        destination: CToken,
        receiver: address,
    ) {
        const [pauses, maxDepositAssets] = await Promise.all([
            destination.market.contract.actionsPaused(destination.address),
            destination.contract.maxDeposit(receiver),
        ]);
        const mintPaused = Boolean(pauses[0]);
        const collateralizationPaused = Boolean(pauses[1]);
        if (mintPaused || maxDepositAssets <= 0n) {
            throw new RedeemZapError(
                "target-unavailable",
                `Deposits are currently unavailable for destination ${destination.address}.`,
            );
        }
        return {
            deposit: Object.freeze({ mintPaused, maxDepositAssets }),
            collateralizationPaused,
        };
    }

    /**
     * Deposits accrue yield before converting assets to shares. Plain view
     * conversions can overstate the shares minted after that accrual. Run the
     * same accrual and conversions in one eth_call to the cToken's multicall;
     * no transaction is sent and no accrued state is persisted.
     */
    private async readRedeemZapTargetShares(
        destination: CToken,
        receiver: address,
        assets: readonly bigint[],
    ): Promise<bigint[]> {
        const abi = destination.contract.interface;
        const calls = [
            abi.encodeFunctionData("accrueIfNeeded"),
            ...assets.map((amount) => abi.encodeFunctionData("convertToShares", [amount])),
        ].map((data) => ({ target: destination.address, isPriceUpdate: false, data }));
        try {
            const result = await destination.provider.call({
                to: destination.address,
                from: receiver,
                data: abi.encodeFunctionData("multicall", [calls]),
            });
            const [results] = abi.decodeFunctionResult("multicall", result);
            if (results.length !== calls.length || results[0] !== "0x") {
                throw new Error("Invalid destination accrual preview result.");
            }
            return assets.map((_, index) => BigInt(
                abi.decodeFunctionResult("convertToShares", results[index + 1])[0],
            ));
        } catch (error) {
            throw new RedeemZapError(
                "target-unavailable",
                `Unable to preview destination ${destination.address} shares after interest accrual.`,
                error,
            );
        }
    }

    private async readRedeemZapTargetCollateral(
        destination: CToken,
        expectedShares: bigint,
        collateralizationPaused: boolean,
    ): Promise<RedeemZapTargetCollateralSnapshot> {
        const [collateralCapShares, collateralPostedShares] = await Promise.all([
            destination.market.contract.collateralCaps(destination.address),
            destination.contract.marketCollateralPosted(),
        ]);
        const remainingCollateralShares = collateralCapShares > collateralPostedShares
            ? collateralCapShares - collateralPostedShares
            : 0n;
        const requiredCollateralShares = ceilDiv(
            expectedShares * (BPS + REDEEM_ZAP.TARGET_COLLATERAL_HEADROOM_BPS),
            BPS,
        );
        const snapshot = Object.freeze({
            collateralizationPaused,
            collateralCapShares,
            collateralPostedShares,
            remainingCollateralShares,
            requiredCollateralShares,
        });
        if (
            collateralizationPaused ||
            requiredCollateralShares <= 0n ||
            requiredCollateralShares > remainingCollateralShares
        ) {
            throw new RedeemZapError(
                "target-collateral-unavailable",
                collateralizationPaused
                    ? `Collateralization is paused for destination ${destination.address}.`
                    : `Destination collateral capacity is ${remainingCollateralShares} shares, below the required ${requiredCollateralShares}.`,
            );
        }
        return snapshot;
    }

    private async buildRedeemSwapAndDepositPlan(
        destination: CToken,
        requestedAssets: bigint,
        slippageBps: bigint,
        collateralizeFor: boolean,
        options: RedeemZapOptions,
    ): Promise<RedeemSwapAndDepositPlan> {
        this.assertRedeemZapDestination(destination);
        this.assertRedeemZapOutputToken(destination.asset.address);
        const context = await this.getRedeemZapContext(options);
        const [normalized, targetState] = await Promise.all([
            this.normalizeRedeemZapAmount(
                requestedAssets,
                context,
                options.redeemMax === true,
            ),
            this.readRedeemZapTargetDeposit(destination, context.receiver),
        ]);
        const quote = await context.zapper.quoteRedeemSwap(
            this,
            destination.asset.address,
            normalized.sourceAssets,
            slippageBps,
            options.signal == null ? {} : { signal: options.signal },
        );
        if (quote.expectedOutput > targetState.deposit.maxDepositAssets) {
            throw new RedeemZapError(
                "target-unavailable",
                `Destination accepts at most ${targetState.deposit.maxDepositAssets} assets, below the quoted output ${quote.expectedOutput}.`,
            );
        }
        const [minimumShares, expectedShares] = await this.readRedeemZapTargetShares(
            destination,
            context.receiver,
            [quote.minimumOutput, quote.expectedOutput],
        );
        const expectedDestinationShares = expectedShares!;
        const minimumDestinationShares = minimumShares! * (BPS - LEVERAGE.SHARES_BUFFER_BPS) / BPS;
        if (minimumDestinationShares <= 0n || expectedDestinationShares <= 0n) {
            throw new RedeemZapError(
                "invalid-amount",
                "Move output is below the destination's minimum share unit.",
            );
        }
        const targetCollateral = collateralizeFor
            ? await this.readRedeemZapTargetCollateral(
                destination,
                expectedDestinationShares,
                targetState.collateralizationPaused,
            )
            : null;
        const calldata = context.zapper.getRedeemSwapAndDepositCalldataFromQuote(
            this,
            destination,
            quote,
            normalized.sourceShares,
            minimumDestinationShares,
            collateralizeFor,
            context.receiver,
        );
        const timing = await this.getRedeemZapRouteTiming(context, quote);
        const plan = Object.freeze({
            kind: "curvance-redeem-swap-and-deposit-plan" as const,
            ...this.createRedeemZapBase(
                context,
                requestedAssets,
                normalized,
                quote,
                timing,
                calldata,
            ),
            destinationMarket: destination.market.address,
            destinationCToken: destination.address,
            destinationAsset: destination.asset.address,
            destinationAssetDecimals: destination.asset.decimals,
            expectedDestinationShares,
            minimumDestinationShares,
            collateralizeFor,
            collateralizeAccount: context.receiver,
            targetDeposit: targetState.deposit,
            targetCollateral,
        });
        redeemSwapAndDepositPlans.add(plan);
        redeemSwapDestinations.set(plan, destination);
        this.assertRedeemSwapAndDepositPlanBinding(plan);
        return plan;
    }

    private assertRedeemZapPlanBase(plan: RedeemZapPlanBase, registered: boolean) {
        if (!registered || !Object.isFrozen(plan) || !Object.isFrozen(plan.swapAction)) {
            throw new RedeemZapError(
                "invalid-plan",
                "Exit plan was not created by this SDK instance or is not immutable.",
            );
        }
        const signer = this.requireSigner().address as address;
        const zapper = this.getZapper("simple");
        if (
            zapper == null ||
            plan.chain !== this.currentChain ||
            plan.chainId !== this.setup.chainId ||
            plan.setupId !== this.getRedeemZapSetupId(zapper.address) ||
            plan.zapper.toLowerCase() !== zapper.address.toLowerCase() ||
            plan.owner.toLowerCase() !== signer.toLowerCase() ||
            plan.receiver.toLowerCase() !== signer.toLowerCase() ||
            plan.sourceMarket.toLowerCase() !== this.market.address.toLowerCase() ||
            plan.sourceCToken.toLowerCase() !== this.address.toLowerCase() ||
            plan.sourceAsset.toLowerCase() !== this.asset.address.toLowerCase() ||
            plan.sourceAssetDecimals !== this.asset.decimals
        ) {
            throw new RedeemZapError("invalid-plan", "Exit plan does not match the active account or setup.");
        }
        if (
            plan.requestedSourceAssets <= 0n ||
            typeof plan.redeemMax !== "boolean" ||
            plan.sourceShares <= 0n ||
            plan.sourceAssets <= 0n ||
            plan.minimumOutput <= 0n ||
            plan.expectedOutput < plan.minimumOutput ||
            plan.forceRedeemCollateral !== false ||
            plan.value !== 0n ||
            plan.quotedSourceAssetRefund < 0n ||
            plan.swapAction.inputToken.toLowerCase() !== plan.sourceAsset.toLowerCase() ||
            plan.swapAction.inputAmount !== plan.sourceAssets ||
            plan.swapAction.outputToken.toLowerCase() !== plan.outputToken.toLowerCase() ||
            plan.swapAction.slippage !== plan.contractSlippage
        ) {
            throw new RedeemZapError("invalid-plan", "Exit plan amounts or swap action are inconsistent.");
        }
        if (
            plan.capacity.executableShares > plan.capacity.shareBalance ||
            plan.capacity.executableShares > plan.capacity.maxRedemptionShares ||
            (plan.capacity.liquidityShares != null &&
                plan.capacity.executableShares > plan.capacity.liquidityShares) ||
            plan.sourceShares > plan.capacity.executableShares ||
            (plan.redeemMax && plan.sourceShares !== plan.capacity.executableShares)
        ) {
            throw new RedeemZapError("invalid-plan", "Exit plan capacity snapshot is inconsistent.");
        }
        if (
            plan.quotedAt >= plan.validUntil ||
            plan.minSubmitWindowSeconds < 0n ||
            plan.minSubmitWindowSeconds >= plan.validUntil - plan.quotedAt ||
            plan.routeQuotedAt < plan.quotedAt ||
            plan.routeQuotedAt >= plan.routeValidUntil ||
            plan.routeMinSubmitWindowSeconds < 0n ||
            plan.routeMinSubmitWindowSeconds >= plan.routeValidUntil - plan.routeQuotedAt
        ) {
            throw new RedeemZapError("invalid-plan", "Exit plan timing bounds are invalid.");
        }
        this.assertRedeemZapOutputToken(plan.outputToken);
    }

    private assertDecodedRedeemSwap(plan: RedeemZapPlanBase, decodedSwap: any) {
        if (
            decodedSwap.inputToken.toLowerCase() !== plan.swapAction.inputToken.toLowerCase() ||
            BigInt(decodedSwap.inputAmount) !== plan.swapAction.inputAmount ||
            decodedSwap.outputToken.toLowerCase() !== plan.swapAction.outputToken.toLowerCase() ||
            decodedSwap.target.toLowerCase() !== plan.swapAction.target.toLowerCase() ||
            BigInt(decodedSwap.slippage) !== plan.swapAction.slippage ||
            decodedSwap.call.toLowerCase() !== plan.swapAction.call.toLowerCase()
        ) {
            throw new RedeemZapError("invalid-plan", "Exit plan calldata swap does not match its fields.");
        }
    }

    private assertRedeemAndSwapPlanBinding(plan: RedeemAndSwapPlan) {
        if (plan.kind !== "curvance-redeem-and-swap-plan") {
            throw new RedeemZapError("invalid-plan", "Invalid redeem-and-swap plan kind.");
        }
        this.assertRedeemZapPlanBase(plan, redeemAndSwapPlans.has(plan));
        const zapper = this.getZapper("simple")!;
        let decoded;
        try {
            decoded = zapper.contract.interface.decodeFunctionData("redeemAndSwap", plan.calldata);
        } catch (error) {
            throw new RedeemZapError("invalid-plan", "Plan calldata is not redeemAndSwap.", error);
        }
        if (
            decoded.redeemAction.cToken.toLowerCase() !== plan.sourceCToken.toLowerCase() ||
            BigInt(decoded.redeemAction.shares) !== plan.sourceShares ||
            decoded.redeemAction.forceRedeemCollateral !== false ||
            decoded.receiver.toLowerCase() !== plan.receiver.toLowerCase()
        ) {
            throw new RedeemZapError("invalid-plan", "redeemAndSwap calldata does not match the plan.");
        }
        this.assertDecodedRedeemSwap(plan, decoded.swapAction);
    }

    private assertRedeemSwapAndDepositPlanBinding(plan: RedeemSwapAndDepositPlan): CToken {
        if (plan.kind !== "curvance-redeem-swap-and-deposit-plan") {
            throw new RedeemZapError("invalid-plan", "Invalid move-position plan kind.");
        }
        this.assertRedeemZapPlanBase(plan, redeemSwapAndDepositPlans.has(plan));
        const destination = redeemSwapDestinations.get(plan);
        if (
            destination == null ||
            destination.market.setup !== this.setup ||
            plan.destinationMarket.toLowerCase() !== destination.market.address.toLowerCase() ||
            plan.destinationCToken.toLowerCase() !== destination.address.toLowerCase() ||
            plan.destinationAsset.toLowerCase() !== destination.asset.address.toLowerCase() ||
            plan.outputToken.toLowerCase() !== destination.asset.address.toLowerCase() ||
            plan.destinationAssetDecimals !== destination.asset.decimals ||
            plan.collateralizeAccount.toLowerCase() !== plan.owner.toLowerCase() ||
            plan.minimumDestinationShares <= 0n ||
            plan.expectedDestinationShares < plan.minimumDestinationShares ||
            (plan.collateralizeFor && plan.targetCollateral == null) ||
            (!plan.collateralizeFor && plan.targetCollateral != null)
        ) {
            throw new RedeemZapError("invalid-plan", "Move plan destination fields are inconsistent.");
        }
        const zapper = this.getZapper("simple")!;
        let decoded;
        try {
            decoded = zapper.contract.interface.decodeFunctionData(
                "redeemSwapAndDeposit",
                plan.calldata,
            );
        } catch (error) {
            throw new RedeemZapError("invalid-plan", "Plan calldata is not redeemSwapAndDeposit.", error);
        }
        if (
            decoded.cToken.toLowerCase() !== plan.destinationCToken.toLowerCase() ||
            decoded.redeemAction.cToken.toLowerCase() !== plan.sourceCToken.toLowerCase() ||
            BigInt(decoded.redeemAction.shares) !== plan.sourceShares ||
            decoded.redeemAction.forceRedeemCollateral !== false ||
            BigInt(decoded.expectedShares) !== plan.minimumDestinationShares ||
            decoded.collateralizeFor !== plan.collateralizeFor ||
            decoded.receiver.toLowerCase() !== plan.receiver.toLowerCase()
        ) {
            throw new RedeemZapError("invalid-plan", "redeemSwapAndDeposit calldata does not match the plan.");
        }
        this.assertDecodedRedeemSwap(plan, decoded.swapAction);
        return destination;
    }

    private async assertRedeemZapPlanFresh(plan: RedeemZapPlanBase): Promise<bigint> {
        const now = await this.getRedeemZapChainTimestamp();
        if (now + plan.routeMinSubmitWindowSeconds > plan.routeValidUntil) {
            throw new RedeemZapError("stale-plan", "Exit swap route is expired; request a new quote.");
        }
        if (now + plan.minSubmitWindowSeconds > plan.validUntil) {
            throw new RedeemZapError("stale-plan", "Exit capacity plan is expired; request a new quote.");
        }
        return now;
    }

    private async preflightRedeemZapBase(plan: RedeemZapPlanBase) {
        const now = await this.assertRedeemZapPlanFresh(plan);
        const [capacity] = await Promise.all([
            this.fetchRedeemZapCapacity(),
            this.assertRedeemZapHoldAvailable(plan.owner, now),
        ]);
        if (plan.sourceShares > capacity.executableShares) {
            throw new RedeemZapCapacityError(plan.sourceShares, capacity);
        }
        const previewSourceAssets = await this.contract.convertToAssets(plan.sourceShares);
        const freshExecution = await this.readRedeemZapExecutionAssets(
            plan.owner,
            plan.zapper,
            plan.sourceShares,
            previewSourceAssets,
            false,
        );
        if (freshExecution.sourceAssets < plan.sourceAssets) {
            throw new RedeemZapError(
                "stale-plan",
                `Fresh redemption output ${freshExecution.sourceAssets} is below the route input ${plan.sourceAssets}; re-quote.`,
            );
        }
        return { to: plan.zapper };
    }

    private async preflightRedeemAndSwap(plan: RedeemAndSwapPlan) {
        this.assertRedeemAndSwapPlanBinding(plan);
        return this.preflightRedeemZapBase(plan);
    }

    private async preflightRedeemSwapAndDeposit(plan: RedeemSwapAndDepositPlan) {
        const destination = this.assertRedeemSwapAndDepositPlanBinding(plan);
        const [overrides, targetState] = await Promise.all([
            this.preflightRedeemZapBase(plan),
            this.readRedeemZapTargetDeposit(destination, plan.receiver),
        ]);
        if (plan.expectedOutput > targetState.deposit.maxDepositAssets) {
            throw new RedeemZapError(
                "target-unavailable",
                "Destination deposit capacity fell below the expected plan output; re-quote.",
            );
        }
        if (plan.collateralizeFor) {
            const [expectedShares] = await this.readRedeemZapTargetShares(
                destination,
                plan.receiver,
                [plan.expectedOutput],
            );
            await this.readRedeemZapTargetCollateral(
                destination,
                expectedShares!,
                targetState.collateralizationPaused,
            );
            if (!(await destination.contract.isDelegate(plan.collateralizeAccount, plan.zapper))) {
                throw new RedeemZapError(
                    "approval-required",
                    `Approve Simple Zapper ${plan.zapper} to collateralize destination ${plan.destinationCToken}.`,
                );
            }
        }
        return { destination, overrides };
    }

    /** @returns A list of tokens mapped to their respective zap options */
    async getDepositTokens(search: string | null = null) {
        const underlying = this.getAsset(true);
        let tokens: ZapToken[] = [{
            interface: underlying,
            type: 'none'
        }];
        let tokens_exclude = [this.asset.address.toLocaleLowerCase()];

        if(this.zapTypes.includes('native-vault')) {
            tokens.push({
                interface: new NativeToken(
                    this.currentChain,
                    this.provider,
                    this.setup.contracts.OracleManager as address,
                    this.signer,
                    this.account,
                    this.currentChainAssets,
                ),
                type: 'native-vault'
            });
            tokens_exclude.push(EMPTY_ADDRESS.toLowerCase(), NATIVE_ADDRESS.toLowerCase());
        }

        if(this.zapTypes.includes('native-simple')) {
            tokens.push({
                interface: new NativeToken(
                    this.currentChain,
                    this.provider,
                    this.setup.contracts.OracleManager as address,
                    this.signer,
                    this.account,
                    this.currentChainAssets,
                ),
                type: 'native-simple'
            });

            if(!this.zapTypes.includes('native-vault')) {
                tokens_exclude.push(EMPTY_ADDRESS.toLowerCase(), NATIVE_ADDRESS.toLowerCase());
            }
        }

        if(this.zapTypes.includes('vault')) {
            const vault_asset = await this.getVaultAsset(true);
            tokens.push({
                interface: vault_asset,
                type: 'vault'
            });
            tokens_exclude.push(vault_asset.address.toLocaleLowerCase());
        }

        if(this.zapTypes.includes('simple') && this.hasExecutableDexRoute) {
            let dexAggSearch = await this.currentDexAgg.getAvailableTokens(this.provider, search, this.account);
            tokens = tokens.concat(dexAggSearch.filter(token => !tokens_exclude.includes(token.interface.address.toLocaleLowerCase())));

            // Add native MON as a zap option for any token with a simple zapper
            // (not just wrapped native). The simple zapper handles wrapping + swapping.
            if (!tokens_exclude.includes(NATIVE_ADDRESS.toLowerCase()) && !this.isWrappedNative) {
                tokens.push({
                    interface: new NativeToken(
                        this.currentChain,
                        this.provider,
                        this.setup.contracts.OracleManager as address,
                        this.signer,
                        this.account,
                        this.currentChainAssets,
                    ),
                    type: 'simple'
                });
                tokens_exclude.push(NATIVE_ADDRESS.toLowerCase());
            }
        }

        tokens = tokens.filter(token => (
            token.type === 'none' || !isZapTokenExcluded(this.currentChainAssets, token.interface)
        ));

        if(search) {
            const lowerSearch = search.toLowerCase();
            tokens = tokens.filter(token =>
                (token.interface.name ?? '').toLowerCase().includes(lowerSearch) ||
                (token.interface.symbol ?? '').toLowerCase().includes(lowerSearch)
            );
        }

        return tokens;
    }

    async hypotheticalRedemptionOf(amount: TokenInput) {
        const shares = this.convertTokenInputToShares(amount);
        return this.market.reader.hypotheticalRedemptionOf(
            this.getAccountOrThrow(),
            this,
            shares
        )
    }

    /**
     * Single-RPC snapshot of fresh position state for leverage operations.
     * Calls ProtocolReader.getLeverageSnapshot which internally uses
     * hypotheticalLiquidityOf for aggregate position + fresh oracle prices
     * + projected debt balance. Updates only token price/share caches; leverage
     * previews consume the returned aggregate values explicitly so failed or
     * simulated plans cannot leave market user totals ahead of token user rows.
     *
     * Returns the snapshot for direct use where needed (e.g. debtTokenBalance
     * for full deleverage swap sizing).
     */
    private async _getLeverageSnapshot(borrow: BorrowableCToken) {
        this.assertBorrowTokenBelongsToMarket(borrow);
        const snapshot = await this.market.reader.getLeverageSnapshot(
            this.getAccountOrThrow(), this.address, borrow.address, 120n
        );

        if (snapshot.oracleError) {
            throw new Error(`Oracle error fetching leverage snapshot for ${this.symbol}/${borrow.symbol}`);
        }

        this.cache.assetPrice = snapshot.collateralAssetPrice;
        this.cache.sharePrice = snapshot.sharePrice;
        borrow.cache.assetPrice = snapshot.debtAssetPrice;

        return snapshot;
    }

    /**
     * Compute slippage BPS for the contract's checkSlippage modifier when
     * leveraging up. Under Curvance's permanent single-oracle architecture
     * with fresh state from _getLeverageSnapshot, the only forced equity
     * loss comes from wei-level share rounding plus possible oracle price
     * drift between snapshot RPC and tx broadcast — both small constants
     * in absolute terms. We add a small flat buffer; the contract's
     * equity-fraction denominator amplifies it by (L-1)x automatically.
     * The user's swap-level slippage (passed separately to _swapSafe) is
     * unaffected — that's the layer that bounds MEV extraction.
     *
     * Applied uniformly to simple AND vault/native-vault leverage-up paths.
     * Simple path uses the buffer for share-rounding + oracle drift as
     * described above. Vault paths inherit the flat 10 bps through the
     * shared `slippage` variable before the per-branch
     * `amplifyContractSlippage(..., LEVERAGE_UP_VAULT_DRIFT_BPS)` expansion;
     * the flat addition is not amplified (base term stays flat) and covers
     * the same residual class (share-rounding, oracle drift) on vault paths
     * too. Removing the buffer for vault would save a trivial amount of
     * user slippage budget at the cost of a false-negative risk on the
     * residuals — we keep it for symmetry.
     */
    private _leverageUpSlippage(slippage: bigint, leverage: Decimal): bigint {
        if (leverage.lte(1)) return slippage;
        return slippage + LEVERAGE.LEVERAGE_UP_BUFFER_BPS;
    }

    private assertSimpleLeverageSwapAssetsDiffer(borrow: BorrowableCToken) {
        this.assertBorrowTokenBelongsToMarket(borrow);
        if (borrow.asset.address.toLowerCase() === this.asset.address.toLowerCase()) {
            throw new Error("Simple leverage requires distinct collateral and borrow assets.");
        }
    }

    private async assertLeverageBorrowCapacity(borrow: BorrowableCToken, borrowAssets: bigint) {
        this.assertBorrowTokenBelongsToMarket(borrow);
        if (borrowAssets === 0n) {
            return;
        }

        const [assetsHeld, outstandingDebt] = await Promise.all([
            borrow.fetchLiquidity(),
            borrow.marketOutstandingDebt(),
        ]);
        const remainingDebtCap = borrow.cache.debtCap > outstandingDebt
            ? borrow.cache.debtCap - outstandingDebt
            : 0n;
        const capacity = assetsHeld < remainingDebtCap ? assetsHeld : remainingDebtCap;
        if (borrowAssets > capacity) {
            throw new Error("Selected borrow token does not have enough remaining debt capacity or liquidity for this leverage operation.");
        }
    }

    private assertSelectedBorrowDebtCanDeleverage(
        borrow: BorrowableCToken,
        selectedDebtAssets: bigint,
        requiredDebtReductionUsd: USD,
    ) {
        this.assertBorrowTokenBelongsToMarket(borrow);
        if (requiredDebtReductionUsd.lte(0)) {
            return;
        }

        const price = borrow.getPrice(true);
        if (!price.isFinite() || price.lte(0)) {
            throw new Error("Selected borrow token has an invalid price for deleverage sizing.");
        }

        const requiredDebtAssets = FormatConverter.decimalToBigInt(
            requiredDebtReductionUsd.div(price),
            borrow.asset.decimals,
        );
        if (requiredDebtAssets > selectedDebtAssets) {
            throw new Error("Selected borrow token debt is too small for the requested deleverage target.");
        }
    }

    private computePostDepositNaturalLeverage(
        currentCollateralInUsd: Decimal,
        currentDebtInUsd: Decimal,
        depositInUsd: Decimal,
    ): Decimal {
        if (currentDebtInUsd.lte(0)) return Decimal(1);

        const collateralAfterDeposit = currentCollateralInUsd.add(depositInUsd);
        const equityAfterDeposit = collateralAfterDeposit.sub(currentDebtInUsd);
        if (equityAfterDeposit.lte(0)) return Decimal(1);

        return collateralAfterDeposit.div(equityAfterDeposit);
    }

    private resolveLeverageUpPreview({
        operation,
        targetLeverage,
        borrow,
        depositAssets = 0n,
        positionManagerType,
        leverageState,
    }: ResolveLeverageUpPreviewParams): LeverageUpPreview {
        this.assertBorrowTokenBelongsToMarket(borrow);
        const currentState = this.getMarketLeverageState(leverageState);
        const currentLeverage = currentState.currentLeverage ?? Decimal(1);
        const currentCollateralInUsd = currentState.currentCollateralInUsd;
        const depositInAssets = FormatConverter.bigIntToDecimal(depositAssets, this.asset.decimals);
        const depositInUsd = depositAssets > 0n
            ? this.convertTokensToUsd(depositAssets, true)
            : Decimal(0);
        const currentDebt = currentState.currentDebt;
        const effectiveCurrentLeverage = depositAssets > 0n
            ? this.computePostDepositNaturalLeverage(currentCollateralInUsd, currentDebt, depositInUsd)
            : currentLeverage;
        const cappedTargetLeverage = targetLeverage.gt(this.maxLeverage)
            ? this.maxLeverage
            : targetLeverage;
        const resolvedTargetLeverage = operation === 'deposit-and-leverage'
            ? Decimal.max(cappedTargetLeverage, effectiveCurrentLeverage)
            : cappedTargetLeverage;

        if (operation === 'leverage-up' && resolvedTargetLeverage.lte(effectiveCurrentLeverage)) {
            throw new Error("New leverage must be more than current leverage");
        }

        const collateralAfterDepositInUsd = currentCollateralInUsd.add(depositInUsd);
        const notional = collateralAfterDepositInUsd.sub(currentDebt);
        if (notional.lte(0)) {
            throw new Error("Position has no positive equity to leverage.");
        }

        const borrowPrice = borrow.getPrice(true);
        const rawDebtInUsd = notional.mul(resolvedTargetLeverage).sub(notional);
        const debtIncrease = Decimal.max(rawDebtInUsd.sub(currentDebt), Decimal(0));
        const borrowAmount = borrowPrice.gt(0)
            ? debtIncrease.div(borrowPrice)
            : Decimal(0);
        const borrowAssets = debtIncrease.gt(0)
            ? FormatConverter.decimalToBigInt(borrowAmount, borrow.asset.decimals)
            : 0n;
        const feePolicyCurrentLeverage = operation === 'deposit-and-leverage'
            ? effectiveCurrentLeverage
            : currentLeverage;
        const hasSwapFee = positionManagerType !== 'vault' && positionManagerType !== 'native-vault';
        const feeBps = borrowAssets > 0n && hasSwapFee
            ? this.setup.feePolicy.getFeeBps({
                operation,
                inputToken: borrow.asset.address,
                outputToken: this.asset.address,
                inputAmount: borrowAssets,
                currentLeverage: feePolicyCurrentLeverage,
                targetLeverage: resolvedTargetLeverage,
            })
            : 0n;
        const feeAssets = borrowAmount.mul(Decimal(Number(feeBps))).div(BPS_DECIMAL);
        const feeUsd = feeAssets.mul(borrowPrice);
        const collateralIncreaseFromBorrow = Decimal.max(debtIncrease.sub(feeUsd), Decimal(0));
        const collateralIncrease = depositInUsd.add(collateralIncreaseFromBorrow);
        const collateralIncreaseInAssets = depositInAssets.add(
            this.convertUsdToTokens(collateralIncreaseFromBorrow, true),
        );
        const newCollateralInUsd = currentCollateralInUsd.add(collateralIncrease);

        return {
            currentLeverage,
            effectiveCurrentLeverage,
            targetLeverage: resolvedTargetLeverage,
            borrowAmount,
            borrowAssets,
            debtIncrease,
            debtIncreaseInAssets: borrowAmount,
            newDebt: rawDebtInUsd,
            newDebtInAssets: borrow.convertUsdToTokens(rawDebtInUsd, true),
            collateralIncrease,
            collateralIncreaseInAssets,
            newCollateral: newCollateralInUsd,
            newCollateralInAssets: this.convertUsdToTokens(newCollateralInUsd, true),
            feeBps,
            feeAssets,
            feeUsd,
        };
    }

    previewDepositAndLeverage(
        newLeverage: Decimal,
        borrow: BorrowableCToken,
        depositAmount: bigint,
        positionManagerType?: PositionManagerTypes,
        leverageState?: LeverageStateOverride,
    ) {
        return this.resolveLeverageUpPreview({
            operation: 'deposit-and-leverage',
            targetLeverage: newLeverage,
            borrow,
            depositAssets: depositAmount,
            positionManagerType,
            leverageState,
        });
    }

    previewLeverageUp(
        newLeverage: Decimal,
        borrow: BorrowableCToken,
        depositAmount?: bigint,
        positionManagerType?: PositionManagerTypes,
        leverageState?: LeverageStateOverride,
    ) {
        if ((depositAmount ?? 0n) > 0n) {
            return this.previewDepositAndLeverage(newLeverage, borrow, depositAmount!, positionManagerType, leverageState);
        }

        return this.resolveLeverageUpPreview({
            operation: 'leverage-up',
            targetLeverage: newLeverage,
            borrow,
            positionManagerType,
            leverageState,
        });
    }

    previewLeverageDown(
        newLeverage: Decimal,
        currentLeverage: Decimal,
        borrow?: BorrowableCToken,
        leverageState?: LeverageStateOverride,
    ) {
        this.assertBorrowTokenBelongsToMarket(borrow);
        if(newLeverage.gte(currentLeverage)) {
            throw new Error("New leverage must be less than current leverage");
        }

        if(newLeverage.lt(Decimal(1))) {
            throw new Error("New leverage must be at least 1");
        }


        const currentState = this.getMarketLeverageState(leverageState);
        const collateralInUsd = currentState.currentCollateralInUsd;
        const currentDebt = currentState.currentDebt;
        const equity = collateralInUsd.sub(currentDebt);
        if (equity.lte(0)) {
            throw new Error("Position has no positive equity to deleverage.");
        }
        const targetCollateralUsd = equity.mul(newLeverage);
        const newDebtUsd = targetCollateralUsd.sub(equity);

        const collateralAssetReductionUsd = collateralInUsd.sub(targetCollateralUsd);
        const collateralAssetReduction = FormatConverter.decimalToBigInt(collateralAssetReductionUsd.div(this.getPrice(true)), this.asset.decimals);
        const leverageDiff = Decimal(1).sub(newLeverage.div(currentLeverage));

        // Fee preview: queried from the configured fee policy. The fee is
        // taken on the collateral→debt swap; size of the swap depends on
        // whether this is a partial or full deleverage. We use
        // collateralAssetReductionUsd as the swap notional approximation
        // (exact for partial; for full deleverage the actual swap is sized
        // by leverageDown using the snapshot, but the preview is close enough
        // for display purposes).
        const feeBps = borrow ? this.setup.feePolicy.getFeeBps({
            operation: 'leverage-down',
            inputToken: this.asset.address,
            outputToken: borrow.asset.address,
            inputAmount: collateralAssetReduction,
            currentLeverage,
            targetLeverage: newLeverage,
        }) : 0n;
        const feeUsd = collateralAssetReductionUsd.mul(Decimal(Number(feeBps))).div(BPS_DECIMAL);
        const feeAssets = this.getPrice(true).gt(0)
            ? feeUsd.div(this.getPrice(true))
            : Decimal(0);

        return {
            collateralAssetReduction,
            collateralAssetReductionUsd,
            leverageDiff,
            newDebt: newDebtUsd,
            newDebtInAssets: borrow ? borrow.convertUsdToTokens(newDebtUsd, true) : undefined,
            newCollateral: targetCollateralUsd,
            newCollateralInAssets: this.convertUsdToTokens(targetCollateralUsd, true),
            feeBps,
            feeAssets,
            feeUsd,
        };
    }

    async leverageUp(
        borrow: BorrowableCToken,
        newLeverage: Decimal,
        type: PositionManagerTypes,
        slippage_: Percentage = Decimal(0.05),
        simulate: boolean = false
    ): Promise<any> {
        try {
            this.assertBorrowTokenBelongsToMarket(borrow);
            this.requireSigner();
            const manager = this.getPositionManager(type);
            if (type === 'vault' || type === 'native-vault') {
                await this.assertVaultLeverageBorrowAssetSupported(borrow, type);
            } else if (type === 'simple') {
                this.assertSimpleLeverageSwapAssetsDiffer(borrow);
            }

            let calldata: bytes;
            const snapshot = await this._getLeverageSnapshot(borrow);
            const preview = this.previewLeverageUp(newLeverage, borrow, undefined, type, snapshot);
            const slippage = this._leverageUpSlippage(
                FormatConverter.percentageToBps(slippage_),
                preview.targetLeverage,
            );
            const { borrowAmount, borrowAssets, feeBps, targetLeverage } = preview;
            if (borrowAssets === 0n) {
                if (simulate) {
                    return {
                        success: false,
                        error: "Target leverage must exceed the current leverage enough to borrow more.",
                    };
                }
                throw new Error("Target leverage must exceed the current leverage enough to borrow more.");
            }
            await this.assertLeverageBorrowCapacity(borrow, borrowAssets);

            switch(type) {
                case 'simple': {
                    const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;

                    const { action, quote } = await this.currentDexAgg.quoteAction(
                        manager.address,
                        borrow.asset.address,
                        this.asset.address,
                        borrowAssets,
                        slippage,
                        feeBps,
                        feeReceiver,
                    );

                    // Fee-aware slippage expansion now lives inside KyberSwap.quoteAction
                    // so any caller inherits correct behavior. See KyberSwap.ts for the
                    // rationale. The fee still reduces swap output, which checkSlippage
                    // sees as equity loss amplified by (L-1) — handled below.

                    // The fee also reduces swap output, which checkSlippage sees
                    // as equity loss amplified by (L-1) — same pattern as
                    // deleverage. Expand the contract-level tolerance to absorb it.
                    // See `amplifyContractSlippage` in helpers.ts for rationale.
                    const contractSlippage = amplifyContractSlippage(
                        slippage,
                        targetLeverage.sub(1),
                        feeBps,
                    );

                    calldata = manager.getLeverageCalldata(
                        {
                            borrowableCToken: borrow.address,
                            borrowAssets    : borrowAssets,
                            cToken          : this.address,
                            expectedShares  : this.virtualConvertToShares(BigInt(quote.min_out), LEVERAGE.SHARES_BUFFER_BPS),
                            swapAction      : action,
                            auxData         : "0x",
                        },
                        FormatConverter.bpsToBpsWad(contractSlippage));
                    break;
                }

                case 'native-vault':
                case 'vault': {
                    // No DEX leg, so no fee-driven forced loss to absorb.
                    // The `(L-1)×K` expansion here covers the vault-token
                    // collateral drift between the vault's fundamental mint
                    // rate at tx time and the stored oracle price that
                    // `checkSlippage` reads. See LEVERAGE_UP_VAULT_DRIFT_BPS.
                    const contractSlippage = amplifyContractSlippage(
                        slippage,
                        targetLeverage.sub(1),
                        LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS,
                    );

                    calldata = manager.getLeverageCalldata(
                        {
                            borrowableCToken: borrow.address,
                            borrowAssets    : borrowAssets,
                            cToken          : this.address,
                            expectedShares  : await PositionManager.getVaultExpectedShares(
                                this,
                                borrow,
                                borrowAmount
                            ),
                            swapAction      : PositionManager.emptySwapAction(),
                            auxData         : "0x",
                        },
                        FormatConverter.bpsToBpsWad(contractSlippage));
                    break;
                }

                default:
                    if (simulate) return { success: false, error: "Unsupported position manager type" };
                    throw new Error("Unsupported position manager type");
            }

            if (simulate) return this.simulateOracleRoute(calldata, { to: manager.address });

            return this.oracleRoute(calldata, { to: manager.address });
        } catch (error: any) {
            if (simulate) return { success: false, error: error?.reason || error?.message || String(error) };
            throw error;
        }
    }

    async leverageDown(
        borrowToken: BorrowableCToken,
        currentLeverage: Decimal,
        newLeverage: Decimal,
        type: 'simple',
        slippage_: Percentage = Decimal(0.05),
        simulate: boolean = false
    ): Promise<any> {
        try {
            this.assertBorrowTokenBelongsToMarket(borrowToken);
            if(newLeverage.gte(currentLeverage)) {
                if (simulate) return { success: false, error: "New leverage must be less than current leverage" };
                throw new Error("New leverage must be less than current leverage");
            }

            this.requireSigner();

            const slippage = toBps(slippage_);
            const manager = this.getPositionManager(type);
            if (type === 'simple') {
                this.assertSimpleLeverageSwapAssetsDiffer(borrowToken);
            }
            let calldata: bytes;

            const snapshot = await this._getLeverageSnapshot(borrowToken);
            const preview = this.previewLeverageDown(newLeverage, currentLeverage, undefined, snapshot);
            const { collateralAssetReduction } = preview;
            const isFullDeleverage = newLeverage.equals(1);
            const maxTokenCollateral = this.virtualConvertToAssets(
                this.readFreshUserCache("userCollateral", "executing leverage down")
            );

            switch(type) {
                case 'simple': {
                    let swapCollateral = collateralAssetReduction;

                    // Resolve fee policy once for this operation. The fee bps
                    // contributes to the deleverage overhead because KyberSwap
                    // deducts the fee from the swap input before swapping —
                    // effective swap input = swapCollateral × (1 - feeBps).
                    // We must oversize swapCollateral to compensate, otherwise
                    // the post-fee swap underdelivers and dust debt remains.
                    //
                    // Order-of-operations note: we pass collateralAssetReduction
                    // as the inputAmount estimate. For partial deleverage this
                    // is the actual swap size; for full deleverage the actual
                    // size is computed below from the snapshot and is slightly
                    // larger. flatFeePolicy ignores inputAmount, so this is
                    // exact for current callers. Future notional-tiered policies
                    // should be aware that for full deleverage the inputAmount
                    // passed here is an underestimate.
                    const feeBps = this.setup.feePolicy.getFeeBps({
                        operation: 'leverage-down',
                        inputToken: this.asset.address,
                        outputToken: borrowToken.asset.address,
                        inputAmount: collateralAssetReduction,
                        currentLeverage: currentLeverage,
                        targetLeverage: newLeverage,
                    });
                    const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;

                    if (isFullDeleverage) {
                        // Use exact projected debt from snapshot to size the swap.
                        // debtTokenBalance is in debt-token native decimals, projected
                        // forward by bufferTime. Convert to collateral-asset terms via
                        // snapshot prices (lower-bound collateral, standard debt — both
                        // conservative, overshooting slightly). Overhead covers DEX
                        // routing impact + oracle drift + fee deduction.
                        const debtDecimals = 10n ** borrowToken.asset.decimals;
                        const collDecimals = 10n ** this.asset.decimals;
                        const debtInCollateral = (
                            snapshot.debtTokenBalance * snapshot.debtAssetPrice * collDecimals
                        ) / (snapshot.collateralAssetPrice * debtDecimals);

                        // Total overhead = base overhead (DEX impact + drift) + fee bps.
                        // Additive approximation is accurate to sub-bp at typical
                        // fee+overhead magnitudes (< 100 bps combined).
                        const overheadBps = LEVERAGE.DELEVERAGE_OVERHEAD_BPS + feeBps;
                        swapCollateral = ceilDiv(debtInCollateral * (BPS + overheadBps), BPS);

                        if (swapCollateral > maxTokenCollateral) {
                            const error = "Selected collateral token does not have enough posted collateral to fully deleverage.";
                            if (simulate) {
                                return { success: false, error };
                            }
                            throw new Error(error);
                        }
                    } else {
                        this.assertSelectedBorrowDebtCanDeleverage(
                            borrowToken,
                            snapshot.debtTokenBalance,
                            Decimal.max(this.market.userDebt.sub(preview.newDebt), Decimal(0)),
                        );

                        if (feeBps > 0n) {
                            // Partial deleverage: inflate swap size to compensate
                            // for fee deduction on input. KyberSwap deducts feeBps
                            // from input before swapping, so without compensation
                            // the swap underdelivers and actual leverage is slightly
                            // higher than target.
                            swapCollateral = ceilDiv(swapCollateral * BPS, BPS - feeBps);
                        }
                    }

                    if (!isFullDeleverage && swapCollateral > maxTokenCollateral) {
                        const error = "Selected collateral token does not have enough posted collateral to reach the requested leverage target.";
                        if (simulate) {
                            return { success: false, error };
                        }
                        throw new Error(error);
                    }

                    const { action, quote } = await this.currentDexAgg.quoteAction(
                        manager.address,
                        this.asset.address,
                        borrowToken.asset.address,
                        swapCollateral,
                        slippage,
                        feeBps,
                        feeReceiver,
                    );

                    // Fee-aware slippage expansion for `_swapSafe` is handled by
                    // KyberSwap.quoteAction. See KyberSwap.ts for rationale.

                    // In the current PositionManager, `repayAssets` is only a
                    // minimum-output guard. The PM later recomputes the actual
                    // repayment as min(assetsHeld, debtBalanceUpdated(owner)).
                    // BorrowableCToken's full-repay sentinel is `repayFor(0)`,
                    // but this PM path does not pass the action value through
                    // as the repay amount, so full-close reliability must come
                    // from conservative swap sizing rather than a sentinel here.
                    const minRepay = isFullDeleverage ? 1n : quote.min_out;

                    // checkSlippage measures equity-fraction loss. Both the
                    // intentional swap overshoot (full deleverage only) and the
                    // DEX fee (always) are real equity losses amplified by
                    // leverage. Expand contractSlippage to absorb them so the
                    // user's `slippage` budget is preserved for variable
                    // DEX impact + oracle drift.
                    //
                    // Full:    (L-1) × (overhead + fee)  — overshoot + fee
                    // Partial: (ΔL)  × fee               — fee only, no overshoot
                    //
                    // See `amplifyContractSlippage` in helpers.ts for the shared
                    // primitive + per-call-site asymmetry docs.
                    const leverageDelta = isFullDeleverage
                        ? currentLeverage.sub(1)
                        : currentLeverage.sub(newLeverage);
                    const forcedBps = isFullDeleverage
                        ? LEVERAGE.DELEVERAGE_OVERHEAD_BPS + feeBps
                        : feeBps;
                    const contractSlippage = amplifyContractSlippage(
                        slippage,
                        leverageDelta,
                        forcedBps,
                    );

                    calldata = manager.getDeleverageCalldata({
                        cToken: this.address,
                        collateralAssets: swapCollateral,
                        borrowableCToken: borrowToken.address,
                        repayAssets: BigInt(minRepay),
                        swapActions: [ action ],
                        auxData: "0x",
                    }, FormatConverter.bpsToBpsWad(contractSlippage));

                    break;
                }

                default:
                    if (simulate) return { success: false, error: "Unsupported position manager type" };
                    throw new Error("Unsupported position manager type");
            }

            if (simulate) return this.simulateOracleRoute(calldata, { to: manager.address });

            return this.oracleRoute(calldata, { to: manager.address });
        } catch (error: any) {
            if (simulate) return { success: false, error: error?.reason || error?.message || String(error) };
            throw error;
        }
    }

    async depositAndLeverage(
        depositAmount: TokenInput,
        borrow: BorrowableCToken,
        multiplier: Decimal,
        type: PositionManagerTypes,
        slippage_: Percentage = Decimal(0.05),
        simulate: boolean = false
    ): Promise<any> {
        try {
            this.assertBorrowTokenBelongsToMarket(borrow);
            if(multiplier.lte(Decimal(1))) {
                if (simulate) return { success: false, error: "Multiplier must be greater than 1" };
                throw new Error("Multiplier must be greater than 1");
            }

            depositAmount = await this.ensureUnderlyingAmount(depositAmount, 'none');
            const manager = this.getPositionManager(type);
            if (type === 'vault' || type === 'native-vault') {
                await this.assertVaultLeverageBorrowAssetSupported(borrow, type);
            } else if (type === 'simple') {
                this.assertSimpleLeverageSwapAssetsDiffer(borrow);
            }

            let calldata: bytes;

            const depositAssets = FormatConverter.decimalToBigInt(depositAmount, this.asset.decimals);
            if(depositAssets <= 0n) {
                if (simulate) return { success: false, error: "Deposit amount must be greater than zero." };
                throw new Error("Deposit amount must be greater than zero.");
            }
            await this._checkTokenApproval(this.getPositionManagerDepositApprovalTarget(manager), depositAssets);
            const snapshot = await this._getLeverageSnapshot(borrow);
            const preview = this.previewDepositAndLeverage(multiplier, borrow, depositAssets, type, snapshot);
            if (preview.borrowAssets === 0n) {
                if (simulate) {
                    return {
                        success: false,
                        error: "Target leverage must exceed the post-deposit leverage to borrow more.",
                    };
                }
                throw new Error("Target leverage must exceed the post-deposit leverage to borrow more.");
            }

            const slippage = this._leverageUpSlippage(toBps(slippage_), preview.targetLeverage);
            const { borrowAmount, borrowAssets, feeBps, targetLeverage } = preview;
            await this.assertLeverageBorrowCapacity(borrow, borrowAssets);

            switch(type) {
                case 'simple': {
                    const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;

                    const { action, quote } = await this.currentDexAgg.quoteAction(
                        manager.address,
                        borrow.asset.address,
                        this.asset.address,
                        borrowAssets,
                        slippage,
                        feeBps,
                        feeReceiver,
                    );

                    // Fee-aware slippage expansion for `_swapSafe` is handled by
                    // KyberSwap.quoteAction. See KyberSwap.ts for rationale.

                    // Fee amplification: same pattern as leverageUp. See
                    // `amplifyContractSlippage` in helpers.ts.
                    const contractSlippage = amplifyContractSlippage(
                        slippage,
                        targetLeverage.sub(1),
                        feeBps,
                    );

                    calldata = manager.getDepositAndLeverageCalldata(
                        FormatConverter.decimalToBigInt(depositAmount, this.asset.decimals),
                        {
                            borrowableCToken: borrow.address,
                            borrowAssets: borrowAssets,
                            cToken: this.address,
                            expectedShares: this.virtualConvertToShares(BigInt(quote.min_out), LEVERAGE.SHARES_BUFFER_BPS),
                            swapAction: action,
                            auxData: "0x",
                        },
                        FormatConverter.bpsToBpsWad(contractSlippage));
                    break;
                }

                case 'native-vault':
                case 'vault': {
                    // Mirrors the leverageUp vault branch: absorb (L-1) ×
                    // LEVERAGE_UP_VAULT_DRIFT_BPS for vault-token collateral
                    // drift. Uses `multiplier.sub(1)` per the per-call-site
                    // asymmetry documented in helpers.ts (depositAndLeverage
                    // leverageDelta = multiplier - 1).
                    const contractSlippage = amplifyContractSlippage(
                        slippage,
                        targetLeverage.sub(1),
                        LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS,
                    );

                    calldata = manager.getDepositAndLeverageCalldata(
                        FormatConverter.decimalToBigInt(depositAmount, this.asset.decimals),
                        {
                            borrowableCToken: borrow.address,
                            borrowAssets: borrowAssets,
                            cToken: this.address,
                            expectedShares: await PositionManager.getVaultExpectedShares(
                                this,
                                borrow,
                                borrowAmount
                            ),
                            swapAction: PositionManager.emptySwapAction(),
                            auxData: "0x",
                        },
                        FormatConverter.bpsToBpsWad(contractSlippage));
                    break;
                }

                default:
                    if (simulate) return { success: false, error: "Unsupported position manager type" };
                    throw new Error("Unsupported position manager type");
            }

            if (simulate) return this.simulateOracleRoute(calldata, { to: manager.address });

            return this.oracleRoute(calldata, { to: manager.address });
        } catch (error: any) {
            if (simulate) return { success: false, error: error?.reason || error?.message || String(error) };
            throw error;
        }
    }


    async simulateDeposit(
        amount: TokenInput,
        zap: ZapperInstructions = 'none',
        receiver: address | null = null
    ): Promise<{ success: boolean; error?: string }> {
        try {
            amount = await this.ensureUnderlyingAmount(amount, zap);
            const signer = this.requireSigner();
            receiver ??= signer.address as address;

            const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
            const zapAssets = await this.getZapAssetAmount(amount, zap);
            if(zapAssets <= 0n) {
                throw new Error("Deposit amount must be greater than zero.");
            }

            const default_calldata = this.getCallData("deposit", [depositAssets, receiver]);
            const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, false, default_calldata, receiver);

            return this.simulateOracleRoute(calldata, calldata_overrides);
        } catch (error: any) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }

    async simulateDepositAsCollateral(
        amount: TokenInput,
        zap: ZapperInstructions = 'none',
        receiver: address | null = null
    ): Promise<{ success: boolean; error?: string }> {
        try {
            amount = await this.ensureUnderlyingAmount(amount, zap);
            const signer = this.requireSigner();
            receiver ??= signer.address as address;

            const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
            const zapAssets = await this.getZapAssetAmount(amount, zap);
            if(zapAssets <= 0n) {
                throw new Error("Deposit amount must be greater than zero.");
            }
            const depositShares = this.isZapInstruction(zap) ? undefined : this.virtualConvertToShares(depositAssets);
            this.assertCollateralCapacity(depositShares);

            const collateralMethod = receiver.toLowerCase() === signer.address.toLowerCase()
                ? "depositAsCollateral"
                : "depositAsCollateralFor";
            const default_calldata = this.getCallData(collateralMethod, [depositAssets, receiver]);
            const { calldata, calldata_overrides, expectedShares } = await this.zap(zapAssets, zap, true, default_calldata, receiver);
            if(expectedShares !== undefined && expectedShares <= 0n) {
                throw new Error("Zap expected shares must be greater than zero.");
            }
            this.assertCollateralCapacity(expectedShares ?? depositShares);

            return this.simulateOracleRoute(calldata, calldata_overrides);
        } catch (error: any) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }

    async zap(assets: bigint, zap: ZapperInstructions, collateralize = false, default_calldata : bytes, receiver: address = this.requireSigner().address as address): Promise<ZapBuildResult> {
        let calldata: bytes;
        let calldata_overrides = {};
        let slippage: bigint = 0n;
        let inputToken: address | null = null;
        let type_of_zap: ZapperTypes;

        if(typeof zap == 'object') {
            slippage = FormatConverter.percentageToBps(zap.slippage);
            inputToken = zap.inputToken;
            type_of_zap = zap.type;
        } else {
            type_of_zap = zap;
        }


        let zapper = this.getZapper(type_of_zap);
        if(zapper == null) {
            if(type_of_zap != 'none') {
                throw new Error("Zapper type selected but no zapper contract found");
            }

            return { calldata: default_calldata, calldata_overrides, zapper: null };
        }

        switch(type_of_zap) {
            case 'simple':
                if(inputToken == null) throw new Error("Input token must be provided for simple zap");
                calldata = await zapper.getSimpleZapCalldata(this, inputToken, this.asset.address, assets, collateralize, slippage, receiver);
                const isNativeSimpleZap = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
                calldata_overrides = isNativeSimpleZap ? { value: assets, to: zapper.address } : { to: zapper.address };
                break;
            case 'vault':
                calldata = await zapper.getVaultZapCalldata(this, assets, collateralize, false, receiver);
                calldata_overrides = { to: zapper.address };
                break;
            case 'native-vault':
                calldata = await zapper.getNativeZapCalldata(this, assets, collateralize, false, receiver);
                calldata_overrides = { value: assets, to: zapper.address };
                break;
            case 'native-simple':
                calldata = await zapper.getNativeZapCalldata(this, assets, collateralize, true, receiver);
                calldata_overrides = { value: assets, to: zapper.address };
                break;
            default:
                throw new Error("This zap type is not supported: " + type_of_zap);
        }

        return {
            calldata,
            calldata_overrides,
            zapper,
            expectedShares: this.getZapperExpectedShares(zapper, calldata),
        };
    }

    async deposit(amount: TokenInput, zap: ZapperInstructions = 'none', receiver: address | null = null) {
        amount = await this.ensureUnderlyingAmount(amount, zap);
        const signer = this.requireSigner();
        receiver ??= signer.address as address;
        const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        const zapAssets = await this.getZapAssetAmount(amount, zap);
        if(zapAssets <= 0n) {
            throw new Error("Deposit amount must be greater than zero.");
        }
        await this._checkDepositApprovals(zap, depositAssets, zapAssets);

        const default_calldata = this.getCallData("deposit", [depositAssets, receiver]);
        const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, false, default_calldata, receiver);

        return this.oracleRoute(calldata, calldata_overrides, receiver);
    }

    async depositAsCollateral(amount: Decimal, zap: ZapperInstructions = 'none',  receiver: address | null = null) {
        amount = await this.ensureUnderlyingAmount(amount, zap);
        const signer = this.requireSigner();
        receiver ??= signer.address as address;
        const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        const zapAssets = await this.getZapAssetAmount(amount, zap);
        if(zapAssets <= 0n) {
            throw new Error("Deposit amount must be greater than zero.");
        }

        const depositShares = this.isZapInstruction(zap) ? undefined : this.virtualConvertToShares(depositAssets);
        this.assertCollateralCapacity(depositShares);

        await this._checkDepositApprovals(zap, depositAssets, zapAssets, true, receiver);

        const collateralMethod = receiver.toLowerCase() === signer.address.toLowerCase()
            ? "depositAsCollateral"
            : "depositAsCollateralFor";
        const default_calldata = this.getCallData(collateralMethod, [depositAssets, receiver]);
        const { calldata, calldata_overrides, expectedShares } = await this.zap(zapAssets, zap, true, default_calldata, receiver);
        if(expectedShares !== undefined && expectedShares <= 0n) {
            throw new Error("Zap expected shares must be greater than zero.");
        }
        this.assertCollateralCapacity(expectedShares ?? depositShares);

        return this.oracleRoute(calldata, calldata_overrides, receiver);
    }

    async redeem(amount: TokenInput) {
        const signer   = this.requireSigner();
        const receiver = signer.address as address;
        const owner    = signer.address as address;
        const converted_shares = this.convertTokenInputToShares(amount);
        if(converted_shares <= 0n) {
            throw new Error("Redeem amount must be greater than zero.");
        }

        const buffer = this.getExecutionDebtBufferTime();
        const balance_avail = await this.balanceOf(signer.address as address);
        const max_shares = await this.maxRedemption(true, buffer);

        const maxExecutableShares = max_shares < balance_avail ? max_shares : balance_avail;
        let shares = maxExecutableShares < converted_shares ? maxExecutableShares : converted_shares;
        if(maxExecutableShares === balance_avail && balance_avail - shares <= 10n) {
            shares = balance_avail;
        }
        if(shares <= 0n) {
            throw new Error("No redeemable cToken shares available.");
        }

        const calldata = this.getCallData("redeem", [shares, receiver, owner]);
        return this.oracleRoute(calldata);
    }

    async redeemShares(amount: bigint) {
        if(amount <= 0n) {
            throw new Error("Redeem amount must be greater than zero.");
        }
        const signer = this.requireSigner();
        const receiver = signer.address as address;
        const owner = signer.address as address;

        const calldata = this.getCallData("redeem", [amount, receiver, owner]);
        return this.oracleRoute(calldata);
    }

    async collateralPosted(account: address | null = null) {
        return this.contract.collateralPosted(this.getAccountOrThrow(account));
    }

    async multicall(calls: MulticallAction[]) {
        return this.getWriteContract().multicall(calls);
    }

    async getSnapshot(account: address) {
        const snapshot = await this.contract.getSnapshot(account);
        return {
            asset: snapshot.asset,
            underlying: snapshot.underlying,
            decimals: BigInt(snapshot.decimals),
            isCollateral: snapshot.isCollateral,
            collateralPosted: BigInt(snapshot.collateralPosted),
            debtBalance: BigInt(snapshot.debtBalance)
        }
    }

    convertTokensToUsd(tokenAmount: bigint, asset = true) : USD {
        const price = this.getPrice(asset, false, false);
        // Pair the price with the matching decimals: asset price ↔ asset
        // decimals, share price ↔ share decimals. Falls back to share
        // decimals if asset.decimals is somehow unset (cToken share decimals
        // always equal asset decimals on current Curvance markets, so the
        // fallback is value-equivalent).
        const decimals = asset ? (this.asset.decimals ?? this.decimals) : this.decimals;
        return FormatConverter.bigIntTokensToUsd(tokenAmount, price, decimals);
    }

    async fetchConvertTokensToUsd(tokenAmount: bigint, asset = true) {
        // Reload cache
        await this.fetchPrice(asset);
        await this.fetchDecimals();

        return this.convertTokensToUsd(tokenAmount, asset);
    }

    convertUsdToTokens(usdAmount: USD, asset = true, lower = false) {
        const price = this.getPrice(asset, lower);
        return usdAmount.div(price);
    }

    convertAssetsToUsd(tokenAmount: bigint): USD {
        const price = this.getPrice(true, false, false);
        // Asset price ↔ asset decimals (with fallback to share decimals,
        // which equal asset decimals on current Curvance markets).
        const decimals = this.asset.decimals ?? this.decimals;

        return FormatConverter.bigIntTokensToUsd(tokenAmount, price, decimals);
    }

    convertSharesToUsdSync(tokenAmount: bigint): USD {
        const price = this.getPrice(false, false, false);
        const decimals = this.decimals;

        return FormatConverter.bigIntTokensToUsd(tokenAmount, price, decimals);
    }

    async fetchConvertSharesToUsd(tokenAmount: bigint): Promise<USD> {
        await this.fetchPrice(false);
        await this.fetchDecimals();

        return this.convertSharesToUsdSync(tokenAmount);
    }

    async convertSharesToUsd(tokenAmount: bigint): Promise<USD> {
        return this.convertSharesToUsdSync(tokenAmount);
    }

    private async _checkPositionManagerApproval(manager: PositionManager) {
        const isApproved = await this.isPluginApproved(manager.type, 'positionManager');
        if (!isApproved) {
            throw new Error(`PositionManager ${manager.address} is not approved for ${this.symbol}`);
        }
    }

    private async _checkZapperApproval(zapper: Zapper) {
        const plugin_allowed = await this.isPluginApproved(zapper.type, 'zapper');
        if (!plugin_allowed) {
            throw new Error(`Please approve the ${zapper.type} Zapper to be able to move ${this.symbol} on your behalf.`);
        }
    }

    private async _checkDelegateApproval(owner: address, delegate: address, delegateLabel: string) {
        const pluginAllowed = await this.contract.isDelegate(owner, delegate);
        if (!pluginAllowed) {
            throw new Error(`Please approve ${delegateLabel} as a delegate for ${this.symbol} on behalf of ${owner}.`);
        }
    }

    private getDepositAssetApprovalTarget(): TokenApprovalTarget {
        const asset = this.getAsset(true);
        return {
            token: asset,
            spender: this.address,
            spenderLabel: this.symbol,
        };
    }

    private getPositionManagerDepositApprovalTarget(manager: PositionManager): TokenApprovalTarget {
        return {
            token: this.getAsset(true),
            spender: manager.address,
            spenderLabel: `${manager.type} PositionManager`,
        };
    }

    private async resolveZapApprovalTarget(instructions: ZapperInstructions): Promise<TokenApprovalTarget | null> {
        const zapType = typeof instructions == 'object' ? instructions.type : instructions;
        if(zapType == 'none') {
            return null;
        }

        const spender = this.getPluginAddress(zapType, 'zapper');

        if(spender == null) {
            throw new Error("Plugin does not have an associated contract");
        }

        switch(zapType) {
            case 'native-vault':
            case 'native-simple':
                return null;
            case 'vault':
                return {
                    token: await this.getVaultAsset(true),
                    spender,
                    spenderLabel: `${zapType} Zapper`,
                };
            case 'simple':
                if(typeof instructions != 'object') {
                    throw new Error("Input token must be provided for simple zap approval");
                }

                if(instructions.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
                    return null;
                }

                return {
                    token: new ERC20(
                        this.provider,
                        instructions.inputToken,
                        undefined,
                        this.setup.contracts.OracleManager as address,
                        this.signer,
                    ),
                    spender,
                    spenderLabel: `${zapType} Zapper`,
                };
        }
    }

    private async hasTokenApproval(target: TokenApprovalTarget, amount: bigint) {
        const owner = this.getAccountOrThrow();
        const allowance = await target.token.allowance(owner, target.spender);
        return allowance >= amount;
    }

    private async _checkTokenApproval(target: TokenApprovalTarget, amount: bigint) {
        const allowance = await this.hasTokenApproval(target, amount);
        if(allowance) {
            return;
        }

        let tokenLabel = target.token.symbol ?? target.token.address;
        if(target.token.symbol == undefined) {
            try {
                tokenLabel = await target.token.fetchSymbol();
            } catch {
                tokenLabel = target.token.address;
            }
        }

        throw new Error(`Please approve the ${tokenLabel} token for ${target.spenderLabel}`);
    }

    private async _checkDepositApprovals(
        zap: ZapperInstructions,
        depositAssets: bigint,
        zapAssets: bigint,
        collateralize: boolean = false,
        receiver: address | null = null,
    ) {
        const zapType = typeof zap == 'object' ? zap.type : zap;
        const signer = this.requireSigner();

        if(zapType != 'none') {
            const zapper = this.getZapper(zapType);
            if(!zapper) {
                throw new Error(`No zapper contract found for type '${zapType}' on ${this.symbol}`);
            }

            if (collateralize) {
                const receiverAddress = receiver ?? signer.address as address;
                if (receiverAddress.toLowerCase() === signer.address.toLowerCase()) {
                    await this._checkZapperApproval(zapper);
                } else {
                    await this._checkDelegateApproval(receiverAddress, signer.address as address, "the connected signer");
                    await this._checkDelegateApproval(receiverAddress, zapper.address, `${zapper.type} Zapper`);
                }
            }
        } else if (collateralize && receiver && receiver.toLowerCase() !== signer.address.toLowerCase()) {
            await this._checkDelegateApproval(receiver, signer.address as address, "the connected signer");
        }

        const approvalTarget = zapType == 'none'
            ? this.getDepositAssetApprovalTarget()
            : await this.resolveZapApprovalTarget(zap);
        if(approvalTarget == null) {
            return;
        }

        const approvalAmount = zapType == 'none' ? depositAssets : zapAssets;
        await this._checkTokenApproval(approvalTarget, approvalAmount);
    }

    async oracleRoute(
        calldata: bytes,
        override: { [key: string]: any } = {},
        reloadAccount: address | null = null,
    ): Promise<TransactionResponse> {
        const signer = this.requireSigner();
        const tx = await this.executeCallData(calldata, override);
        let receipt: unknown;
        if (typeof tx.wait === "function") {
            receipt = await tx.wait();
        }
        const signerAddress = signer.address as address;
        const refreshAccount = reloadAccount?.toLowerCase() === signerAddress.toLowerCase()
            ? reloadAccount
            : signerAddress;
        try {
            await this.market.reloadUserData(refreshAccount);
        } catch (error) {
            throw attachSettledTransactionContext(error, tx, receipt);
        }

        return tx;
    }

    async simulateOracleRoute(calldata: bytes, override: { [key: string]: any } = {}): Promise<{ success: boolean; error?: string }> {
        return this.simulateCallData(calldata, override);
    }
}
