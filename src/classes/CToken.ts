import { Contract, TransactionResponse } from "ethers";
import { contractSetup, BPS, ChangeRate, getRateSeconds, requireAccount, requireSigner, WAD, getChainConfig, EMPTY_ADDRESS, toDecimal, SECONDS_PER_YEAR, toBps, NATIVE_ADDRESS, UINT256_MAX, amplifyContractSlippage } from "../helpers";
import { AdaptorTypes, DynamicMarketToken, StaticMarketToken, UserMarketToken } from "./ProtocolReader";
import { ERC20 } from "./ERC20";
import { Market, PluginTypes } from "./Market";
import { Calldata } from "./Calldata";
import Decimal from "decimal.js";
import base_ctoken_abi from '../abis/BaseCToken.json';
import { address, bytes, curvance_read_provider, curvance_signer, Percentage, TokenInput, USD, USD_WAD } from "../types";
import { Redstone } from "./Redstone";
import { Zapper, ZapperTypes, zapperTypeToName } from "./Zapper";
import { PositionManager, PositionManagerTypes } from "./PositionManager";
import { BorrowableCToken } from "./BorrowableCToken";
import { NativeToken } from "./NativeToken";
import { ERC4626 } from "./ERC4626";
import FormatConverter from "./FormatConverter";

const EXCLUDED_ZAP_SYMBOLS = new Set([
    'eBTC', 'earnAUSD', 'vUSD', 'syzUSD', 'ezETH', 'YZM', 'wsrUSD', 'sAUSD',
]);
const EXECUTION_DEBT_BUFFER_TIME = 100n;

/**
 * Leverage operation buffers — centralized for tuning.
 * Calibrated for fresh-state operation via getLeverageSnapshot under
 * Curvance's permanent single-oracle architecture.
 *
 * Single-oracle architecture (permanent design)
 * ---------------------------------------------
 * Curvance uses single-adaptor oracle configs only (Redstone Core/Classic
 * via BaseOracleAdaptor, which ignores the getLower flag — see line 78 of
 * BaseOracleAdaptor.sol). Dual-feed mode was deprecated in favor of the
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
 * rounding, (b) Redstone update drift between the snapshot RPC and the
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
     *    - Oracle drift between preview snapshot and Redstone payload at
     *      tx inclusion
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
     *  wei-level share rounding plus possible Redstone price drift between
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
     *  for that amplification (see leverageDown). Bump when aggregator fees
     *  are enabled to keep dust prevention reliable. */
    DELEVERAGE_OVERHEAD_BPS: 20n,
    /** BPS buffer on virtualConvertToShares for leverage + collateral cap.
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
}

interface TokenApprovalTarget {
    token: ERC20;
    spender: address;
    spenderLabel: string;
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

        const chainSettings = this.currentChainConfig;
        const assetAddr = this.asset.address.toLowerCase();
        this.isNativeVault = chainSettings.native_vaults.some(vault => vault.contract.toLowerCase() == assetAddr);
        this.isVault = chainSettings.vaults.some(vault => vault.contract.toLowerCase() == assetAddr);
        this.isWrappedNative = chainSettings.wrapped_native.toLowerCase() == assetAddr;

        if(EXCLUDED_ZAP_SYMBOLS.has(this.asset.symbol)) {
            return;
        }

        if(this.isNativeVault) this.zapTypes.push('native-vault');
        if("nativeVaultPositionManager" in this.market.plugins && this.isNativeVault) this.leverageTypes.push('native-vault');
        if(this.isWrappedNative) this.zapTypes.push('native-simple');

        if(this.isVault) this.zapTypes.push('vault');
        if("vaultPositionManager" in this.market.plugins && this.isVault) this.leverageTypes.push('vault');

        if("simplePositionManager" in this.market.plugins) this.leverageTypes.push('simple');
        this.zapTypes.push('simple');
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
    private get currentChainConfig() { return getChainConfig(this.currentChain); }
    protected requireSigner() { return requireSigner(this.signer); }
    protected getAccountOrThrow(account: address | null = null) {
        return requireAccount(account ?? this.account, this.signer);
    }
    protected getWriteContract() {
        return contractSetup<ICToken>(this.requireSigner(), this.address, base_ctoken_abi);
    }

    get adapters() { return this.cache.adapters; }
    get borrowPaused() { return this.cache.borrowPaused }
    get collateralizationPaused() { return this.cache.collateralizationPaused }
    get mintPaused() { return this.cache.mintPaused }
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
        return (shares * this.totalAssets) / this.totalSupply;
    }

    /**
     * Convert assets to shares using cached totalSupply/totalAssets.
     * @param bufferBps Optional downward buffer in BPS to account for
     *                  exchange rate drift from interest accrual since cache load.
     *                  Matches the buffer pattern in async convertToShares().
     */
    virtualConvertToShares(assets: bigint, bufferBps: bigint = 0n): bigint {
        const shares = (assets * this.totalSupply) / this.totalAssets;
        return bufferBps > 0n ? shares * (10000n - bufferBps) / 10000n : shares;
    }

    private getMarketLeverageState() {
        const currentCollateralInUsd = this.market.userCollateral;
        const currentDebt = this.market.userDebt;
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
        return formatted ? this.convertTokensToUsd(diff) : diff;
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
        return inUSD ? this.convertTokensToUsd(userShareBalance, false) : FormatConverter.bigIntToDecimal(userShareBalance, this.decimals);
    }

    /** @returns User assets in USD (this is the raw balance that the token exchanges too) or token */
    getUserAssetBalance(inUSD: true): USD;
    getUserAssetBalance(inUSD: false): TokenInput;
    getUserAssetBalance(inUSD: boolean): USD | TokenInput {
        const userAssetBalance = this.readFreshUserCache("userAssetBalance", "reading token user asset balance");
        return inUSD ? this.convertTokensToUsd(userAssetBalance) : FormatConverter.bigIntToDecimal(userAssetBalance, this.asset.decimals);
    }

    /** @returns User underlying assets in USD or token */
    getUserUnderlyingBalance(inUSD: true): USD;
    getUserUnderlyingBalance(inUSD: false): TokenInput;
    getUserUnderlyingBalance(inUSD: boolean): USD | TokenInput {
        const userUnderlyingBalance = this.readFreshUserCache("userUnderlyingBalance", "reading token user underlying balance");
        return inUSD ? this.convertTokensToUsd(userUnderlyingBalance) : FormatConverter.bigIntToDecimal(userUnderlyingBalance, this.decimals);
    }

    /** @returns Token Collateral Cap in USD or USD WAD */
    getCollateralCap(inUSD: true): USD;
    getCollateralCap(inUSD: false): USD_WAD;
    getCollateralCap(inUSD: boolean): USD | USD_WAD {
        return inUSD ? this.convertTokensToUsd(this.cache.collateralCap) : this.cache.collateralCap;
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
        return inUSD ? this.convertTokensToUsd(this.cache.collateral) : this.cache.collateral;
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
        const userCollateral = this.readFreshUserCache("userCollateral", "reading token user collateral");
        return inUSD ? this.convertTokensToUsd(userCollateral, false) : FormatConverter.bigIntToDecimal(userCollateral, this.decimals);
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
        const vaultShares = vaultSharesRaw * (10000n - LEVERAGE.SHARES_BUFFER_BPS) / 10000n;
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
        let price = asset ? this.cache.assetPrice : this.cache.sharePrice;
        if(lower) {
            price = asset ? this.cache.assetPriceLower : this.cache.sharePriceLower;
        }

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
        return inUSD ? this.convertTokensToUsd(totalCollateral) : totalCollateral;
    }

    async fetchTotalCollateral(inUSD: true): Promise<USD>;
    async fetchTotalCollateral(inUSD: false): Promise<bigint>;
    async fetchTotalCollateral(inUSD = true): Promise<USD | bigint> {
        const totalCollateral = await this.contract.marketCollateralPosted();
        return inUSD ? this.fetchConvertTokensToUsd(totalCollateral) : totalCollateral;
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

        return new Zapper(zap_contract, signer, type, this.setup);
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
        const erc20 = new ERC20(this.provider, underlying ? this.asset.address : this.address, undefined, undefined, this.signer);
        const allowance = await erc20.allowance(signer.address as address, check_contract);
        return allowance;
    }

    /**
     * Approves the underlying asset to be used with the ctoken contract.
     * @param amount - if null it will approve the max uint256, otherwise the amount specified
     * @returns tx
     */
    async approveUnderlying(amount: TokenInput | null = null, target: address | null = null) {
        const erc20 = new ERC20(this.provider, this.asset.address, undefined, undefined, this.signer);
        const tx = await erc20.approve(target ? target : this.address, amount);
        return tx;
    }

    async approve(amount: TokenInput | null = null, spender: address) {
        const erc20 = new ERC20(this.provider, this.address, undefined, undefined, this.signer);
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
        return this.getWriteContract().transfer(receiver, shares);
    }

    async redeemCollateral(amount: Decimal, receiver: address | null = null, owner: address | null = null) {
        const signer = this.requireSigner();
        receiver ??= signer.address as address;
        owner ??= signer.address as address;

        const shares = this.convertTokenInputToShares(amount);
        const calldata = this.getCallData("redeemCollateral", [shares, receiver, owner]);
        return this.oracleRoute(calldata);
    }

    async postCollateral(amount: TokenInput) {
        const signer = this.requireSigner();
        const shares = this.convertTokenInputToShares(amount);
        const balance = await this.balanceOf(signer.address as address);
        const collateral = await this.fetchUserCollateral();
        const available_shares = balance - collateral;
        const max_shares = available_shares < shares ? available_shares : shares;

        const calldata = this.getCallData("postCollateral", [max_shares]);
        const tx = await this.oracleRoute(calldata);

        // Reload collateral state after execution
        await this.fetchUserCollateral();

        return tx;
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
                );
            } else {
                asset = new ERC20(this.provider, zap.inputToken, undefined, undefined, this.signer);
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
                    );
                    break;
                case 'native-simple':
                    asset = new NativeToken(
                        this.currentChain,
                        this.provider,
                        this.setup.contracts.OracleManager as address,
                        this.signer,
                        this.account,
                    );
                    break;
                default: throw new Error("Unsupported zap type for balance fetch");
            }
        }

        return asset.balanceOf(signer.address as address, false);
    }

    async ensureUnderlyingAmount(amount: TokenInput, zap: ZapperInstructions) : Promise<TokenInput> {
        const balance = await this.getZapBalance(zap);
        const isZapping = typeof zap === 'object' && zap.type !== 'none';

        // Use the zap input token's decimals when zapping, otherwise the deposit token's decimals
        let decimals = this.asset.decimals;
        if (isZapping && zap.inputToken) {
            if (zap.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
                decimals = 18n;
            } else {
                const inputErc20 = new ERC20(this.provider, zap.inputToken as address, undefined, undefined, this.signer);
                decimals = inputErc20.decimals ?? await inputErc20.contract.decimals();
            }
        }

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

    async convertToShares(assets: bigint, bufferBps: bigint = 2n) {
        const shares = await this.contract.convertToShares(assets);
        return bufferBps > 0n ? shares * (10000n - bufferBps) / 10000n : shares;
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
                ),
                type: 'native-vault'
            });
            tokens_exclude.push(EMPTY_ADDRESS, NATIVE_ADDRESS);
        }

        if(this.zapTypes.includes('native-simple')) {
            tokens.push({
                interface: new NativeToken(
                    this.currentChain,
                    this.provider,
                    this.setup.contracts.OracleManager as address,
                    this.signer,
                    this.account,
                ),
                type: 'native-simple'
            });

            if(!this.zapTypes.includes('native-vault')) {
                tokens_exclude.push(EMPTY_ADDRESS, NATIVE_ADDRESS);
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

        if(this.zapTypes.includes('simple')) {
            let dexAggSearch = await this.currentChainConfig.dexAgg.getAvailableTokens(this.provider, search, this.account);
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
                    ),
                    type: 'simple'
                });
                tokens_exclude.push(NATIVE_ADDRESS.toLowerCase());
            }
        }

        tokens = tokens.filter(token => token.type === 'none' || !EXCLUDED_ZAP_SYMBOLS.has(token.interface.symbol ?? ''));

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
     * + projected debt balance. Updates the local cache so downstream
     * preview computations (previewLeverageUp/Down) read fresh values.
     *
     * Returns the snapshot for direct use where needed (e.g. debtTokenBalance
     * for full deleverage swap sizing).
     */
    private async _getLeverageSnapshot(borrow: BorrowableCToken) {
        const snapshot = await this.market.reader.getLeverageSnapshot(
            this.getAccountOrThrow(), this.address, borrow.address, 120n
        );

        if (snapshot.oracleError) {
            throw new Error(`Oracle error fetching leverage snapshot for ${this.symbol}/${borrow.symbol}`);
        }

        // Update cache so preview functions read fresh values
        this.cache.assetPrice = snapshot.collateralAssetPrice;
        this.cache.sharePrice = snapshot.sharePrice;
        borrow.cache.assetPrice = snapshot.debtAssetPrice;
        this.market.cache.user.collateral = snapshot.collateralUsd;
        this.market.cache.user.debt = snapshot.debtUsd;

        return snapshot;
    }

    /**
     * Compute slippage BPS for the contract's checkSlippage modifier when
     * leveraging up. Under Curvance's permanent single-oracle architecture
     * with fresh state from _getLeverageSnapshot, the only forced equity
     * loss comes from wei-level share rounding plus possible Redstone price
     * drift between snapshot RPC and tx broadcast — both small constants
     * in absolute terms. We add a small flat buffer; the contract's
     * equity-fraction denominator amplifies it by (L-1)x automatically.
     * The user's swap-level slippage (passed separately to _swapSafe) is
     * unaffected — that's the layer that bounds MEV extraction.
     *
     * Applied uniformly to simple AND vault/native-vault leverage-up paths.
     * Simple path uses the buffer for share-rounding + Redstone drift as
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
    }: ResolveLeverageUpPreviewParams): LeverageUpPreview {
        const leverageState = this.getMarketLeverageState();
        const currentLeverage = leverageState.currentLeverage ?? Decimal(1);
        const currentCollateralInUsd = leverageState.currentCollateralInUsd;
        const depositInAssets = FormatConverter.bigIntToDecimal(depositAssets, this.asset.decimals);
        const depositInUsd = depositAssets > 0n
            ? this.convertTokensToUsd(depositAssets, true)
            : Decimal(0);
        const currentDebt = leverageState.currentDebt;
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
        const feeBps = borrowAssets > 0n
            ? this.setup.feePolicy.getFeeBps({
                operation,
                inputToken: borrow.asset.address,
                outputToken: this.asset.address,
                inputAmount: borrowAssets,
                currentLeverage: feePolicyCurrentLeverage,
                targetLeverage: resolvedTargetLeverage,
            })
            : 0n;
        const feeAssets = borrowAmount.mul(Decimal(Number(feeBps))).div(Decimal(10000));
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

    previewDepositAndLeverage(newLeverage: Decimal, borrow: BorrowableCToken, depositAmount: bigint) {
        return this.resolveLeverageUpPreview({
            operation: 'deposit-and-leverage',
            targetLeverage: newLeverage,
            borrow,
            depositAssets: depositAmount,
        });
    }

    previewLeverageUp(newLeverage: Decimal, borrow: BorrowableCToken, depositAmount?: bigint) {
        if ((depositAmount ?? 0n) > 0n) {
            return this.previewDepositAndLeverage(newLeverage, borrow, depositAmount!);
        }

        return this.resolveLeverageUpPreview({
            operation: 'leverage-up',
            targetLeverage: newLeverage,
            borrow,
        });
    }

    previewLeverageDown(newLeverage: Decimal, currentLeverage: Decimal, borrow?: BorrowableCToken) {
        if(newLeverage.gte(currentLeverage)) {
            throw new Error("New leverage must be less than current leverage");
        }

        if(newLeverage.lt(Decimal(1))) {
            throw new Error("New leverage must be at least 1");
        }


        const leverageState = this.getMarketLeverageState();
        const collateralInUsd = leverageState.currentCollateralInUsd;
        const currentDebt = leverageState.currentDebt;
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
        const feeUsd = collateralAssetReductionUsd.mul(Decimal(Number(feeBps))).div(Decimal(10000));
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
            this.requireSigner();
            const manager = this.getPositionManager(type);

            let calldata: bytes;
            await this._getLeverageSnapshot(borrow);
            const preview = this.previewLeverageUp(newLeverage, borrow);
            const slippage = this._leverageUpSlippage(
                FormatConverter.percentageToBps(slippage_),
                preview.targetLeverage,
            );
            const { borrowAmount, borrowAssets, feeBps, targetLeverage } = preview;

            switch(type) {
                case 'simple': {
                    const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;

                    const { action, quote } = await this.currentChainConfig.dexAgg.quoteAction(
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

            await this._checkPositionManagerApproval(manager);
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
            if(newLeverage.gte(currentLeverage)) {
                if (simulate) return { success: false, error: "New leverage must be less than current leverage" };
                throw new Error("New leverage must be less than current leverage");
            }

            this.requireSigner();

            const config = this.currentChainConfig;
            const slippage = toBps(slippage_);
            const manager = this.getPositionManager(type);
            let calldata: bytes;

            const snapshot = await this._getLeverageSnapshot(borrowToken);
            const { collateralAssetReduction } = this.previewLeverageDown(newLeverage, currentLeverage);
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
                        swapCollateral = debtInCollateral * (10000n + overheadBps) / 10000n;

                        if (swapCollateral > maxTokenCollateral) {
                            swapCollateral = maxTokenCollateral;
                        }
                    } else if (feeBps > 0n) {
                        // Partial deleverage: inflate swap size to compensate
                        // for fee deduction on input. KyberSwap deducts feeBps
                        // from input before swapping, so without compensation
                        // the swap underdelivers and actual leverage is slightly
                        // higher than target.
                        swapCollateral = swapCollateral * 10000n / (10000n - feeBps);
                    }

                    if (!isFullDeleverage && swapCollateral > maxTokenCollateral) {
                        const error = "Selected collateral token does not have enough posted collateral to reach the requested leverage target.";
                        if (simulate) {
                            return { success: false, error };
                        }
                        throw new Error(error);
                    }

                    const { action, quote } = await config.dexAgg.quoteAction(
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

            await this._checkPositionManagerApproval(manager);
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
            if(multiplier.lte(Decimal(1))) {
                if (simulate) return { success: false, error: "Multiplier must be greater than 1" };
                throw new Error("Multiplier must be greater than 1");
            }

            depositAmount = await this.ensureUnderlyingAmount(depositAmount, 'none');
            const manager = this.getPositionManager(type);

            let calldata: bytes;

            const depositAssets = FormatConverter.decimalToBigInt(depositAmount, this.asset.decimals);
            await this._checkTokenApproval(this.getPositionManagerDepositApprovalTarget(manager), depositAssets);
            await this._getLeverageSnapshot(borrow);
            const preview = this.previewDepositAndLeverage(multiplier, borrow, depositAssets);
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

            switch(type) {
                case 'simple': {
                    const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;

                    const { action, quote } = await this.currentChainConfig.dexAgg.quoteAction(
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

            await this._checkPositionManagerApproval(manager);
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

            const isZapping = typeof zap === 'object' && zap.type !== 'none';
            const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
            let zapAssets = depositAssets;
            if (isZapping && (zap as any).inputToken) {
                const isNative = (zap as any).inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
                const zapDecimals = isNative ? 18n : (() => {
                    const inputErc20 = new ERC20(this.provider, (zap as any).inputToken as address, undefined, undefined, this.signer);
                    return inputErc20.decimals ?? inputErc20.contract.decimals();
                })();
                zapAssets = FormatConverter.decimalToBigInt(amount, await zapDecimals);
            }

            const default_calldata = this.getCallData("deposit", [depositAssets, receiver]);
            const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, false, default_calldata);

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

            const isZapping = typeof zap === 'object' && zap.type !== 'none';
            const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
            let zapAssets = depositAssets;
            if (isZapping && (zap as any).inputToken) {
                const isNative = (zap as any).inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
                const zapDecimals = isNative ? 18n : (() => {
                    const inputErc20 = new ERC20(this.provider, (zap as any).inputToken as address, undefined, undefined, this.signer);
                    return inputErc20.decimals ?? inputErc20.contract.decimals();
                })();
                zapAssets = FormatConverter.decimalToBigInt(amount, await zapDecimals);
            }

            const default_calldata = this.getCallData("depositAsCollateral", [depositAssets, receiver]);
            const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, true, default_calldata);

            return this.simulateOracleRoute(calldata, calldata_overrides);
        } catch (error: any) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }

    async zap(assets: bigint, zap: ZapperInstructions, collateralize = false, default_calldata : bytes) {
        let calldata: bytes;
        let calldata_overrides = {};
        let slippage: bigint = 0n;
        let inputToken: address | null = null;
        let type_of_zap: ZapperTypes;

        if(typeof zap == 'object') {
            slippage = BigInt(zap.slippage.mul(BPS).toString());
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
                calldata = await zapper.getSimpleZapCalldata(this, inputToken, this.asset.address, assets, collateralize, slippage);
                const isNativeSimpleZap = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
                calldata_overrides = isNativeSimpleZap ? { value: assets, to: zapper.address } : { to: zapper.address };
                break;
            case 'vault':
                calldata = await zapper.getVaultZapCalldata(this, assets, collateralize);
                calldata_overrides = { to: zapper.address };
                break;
            case 'native-vault':
                calldata = await zapper.getNativeZapCalldata(this, assets, collateralize);
                calldata_overrides = { value: assets, to: zapper.address };
                break;
            case 'native-simple':
                calldata = await zapper.getNativeZapCalldata(this, assets, collateralize, true);
                calldata_overrides = { value: assets, to: zapper.address };
                break;
            default:
                throw new Error("This zap type is not supported: " + type_of_zap);
        }

        return { calldata, calldata_overrides, zapper };
    }

    async deposit(amount: TokenInput, zap: ZapperInstructions = 'none', receiver: address | null = null) {
        amount = await this.ensureUnderlyingAmount(amount, zap);
        const signer = this.requireSigner();
        receiver ??= signer.address as address;
        // When zapping, the swap amount uses input token decimals, but the
        // default deposit calldata uses the deposit token decimals.
        const isZapping = typeof zap === 'object' && zap.type !== 'none';
        const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        let zapAssets = depositAssets;
        if (isZapping && zap.inputToken) {
            if (zap.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
                zapAssets = FormatConverter.decimalToBigInt(amount, 18n);
            } else {
                const inputErc20 = new ERC20(this.provider, zap.inputToken as address, undefined, undefined, this.signer);
                const zapDecimals = inputErc20.decimals ?? await inputErc20.contract.decimals();
                zapAssets = FormatConverter.decimalToBigInt(amount, zapDecimals);
            }
        }
        await this._checkDepositApprovals(zap, depositAssets, zapAssets);

        const default_calldata = this.getCallData("deposit", [depositAssets, receiver]);
        const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, false, default_calldata);

        return this.oracleRoute(calldata, calldata_overrides);
    }

    async depositAsCollateral(amount: Decimal, zap: ZapperInstructions = 'none',  receiver: address | null = null) {
        amount = await this.ensureUnderlyingAmount(amount, zap);
        const signer = this.requireSigner();
        receiver ??= signer.address as address;
        // When zapping, the swap amount uses input token decimals, but collateral
        // cap checks and the default deposit calldata use the deposit token decimals.
        const isZapping = typeof zap === 'object' && zap.type !== 'none';
        const depositAssets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        let zapAssets = depositAssets;
        if (isZapping && zap.inputToken) {
            if (zap.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
                zapAssets = FormatConverter.decimalToBigInt(amount, 18n);
            } else {
                const inputErc20 = new ERC20(this.provider, zap.inputToken as address, undefined, undefined, this.signer);
                const zapDecimals = inputErc20.decimals ?? await inputErc20.contract.decimals();
                zapAssets = FormatConverter.decimalToBigInt(amount, zapDecimals);
            }
        }

        if (!isZapping) {
            const collateralCapError = "There is not enough collateral left in this tokens collateral cap for this deposit.";
            const remainingCollateral = this.getRemainingCollateral(false);
            if(remainingCollateral == 0n) throw new Error(collateralCapError);
            if(remainingCollateral > 0n) {
                const shares = this.virtualConvertToShares(depositAssets, LEVERAGE.SHARES_BUFFER_BPS);
                if(shares > remainingCollateral) {
                    throw new Error(collateralCapError);
                }
            }
        }

        await this._checkDepositApprovals(zap, depositAssets, zapAssets);

        const default_calldata = this.getCallData("depositAsCollateral", [depositAssets, receiver]);
        const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, true, default_calldata);
        return this.oracleRoute(calldata, calldata_overrides);
    }

    async redeem(amount: TokenInput) {
        const signer   = this.requireSigner();
        const receiver = signer.address as address;
        const owner    = signer.address as address;

        const buffer = this.getExecutionDebtBufferTime();
        const balance_avail = await this.balanceOf(signer.address as address);
        const max_shares = await this.maxRedemption(true, buffer);
        const converted_shares = this.convertTokenInputToShares(amount);
        
        let shares = max_shares < converted_shares ? max_shares : converted_shares;
        if(balance_avail - shares <= 10n) {
            shares = balance_avail;
        }

        const calldata = this.getCallData("redeem", [shares, receiver, owner]);
        return this.oracleRoute(calldata);
    }

    async redeemShares(amount: bigint) {
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

    async convertSharesToUsd(tokenAmount: bigint): Promise<USD> {
        tokenAmount = this.virtualConvertToShares(tokenAmount);
        const price = this.getPrice(false, false, false);
        const decimals = this.decimals;

        return FormatConverter.bigIntTokensToUsd(tokenAmount, price, decimals);
    }

    buildMultiCallAction(calldata: bytes, target: address = this.address) {
        return {
            target,
            isPriceUpdate: false,
            data: calldata
        } as MulticallAction;
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
                    token: new ERC20(this.provider, instructions.inputToken, undefined, undefined, this.signer),
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

    private async _checkDepositApprovals(zap: ZapperInstructions, depositAssets: bigint, zapAssets: bigint) {
        const zapType = typeof zap == 'object' ? zap.type : zap;

        if(zapType != 'none') {
            const zapper = this.getZapper(zapType);
            if(!zapper) {
                throw new Error(`No zapper contract found for type '${zapType}' on ${this.symbol}`);
            }
            await this._checkZapperApproval(zapper);
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

    async oracleRoute(calldata: bytes, override: { [key: string]: any } = {}): Promise<TransactionResponse> {
        const signer = this.requireSigner();
        const price_updates = await this.getPriceUpdates();

        if(price_updates.length > 0) {
            const actionTarget = (override.to ?? this.address) as address;
            const token_action = this.buildMultiCallAction(calldata, actionTarget);
            calldata = this.getCallData("multicall", [[...price_updates, token_action]]);
        }

        const tx = await this.executeCallData(calldata, override);
        await this.market.reloadUserData(signer.address as address);

        return tx;
    }

    async simulateOracleRoute(calldata: bytes, override: { [key: string]: any } = {}): Promise<{ success: boolean; error?: string }> {
        const price_updates = await this.getPriceUpdates();

        if(price_updates.length > 0) {
            const actionTarget = (override.to ?? this.address) as address;
            const token_action = this.buildMultiCallAction(calldata, actionTarget);
            calldata = this.getCallData("multicall", [[...price_updates, token_action]]);
        }

        return this.simulateCallData(calldata, override);
    }

    async getPriceUpdates(): Promise<MulticallAction[]> {
        let price_updates = [];
        if(this.adapters.includes(AdaptorTypes.REDSTONE_CORE)) {
            const redstone = await Redstone.buildMultiCallAction(this);
            price_updates.push(redstone);
        }

        return price_updates;
    }
}
