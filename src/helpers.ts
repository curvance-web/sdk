import { Contract, parseUnits } from "ethers";
import { Decimal } from "decimal.js";
import { address, bytes, curvance_provider, curvance_read_provider, curvance_signer, Percentage } from "./types";
import { chains } from "./contracts";
import FormatConverter from "./classes/FormatConverter";

// Set Decimal.js precision to handle large numbers
Decimal.set({ precision: 50 });

export type ChangeRate = "year" | "month" | "week" | "day";
export type ChainRpcPrefix = keyof typeof chains;

export const BPS = 10_000n;
export const BPS_SQUARED = BPS * BPS;
export const WAD = 10n ** 18n;
export const WAD_BPS = WAD * BPS;
export const RAY = 10n ** 27n;
export const WAD_SQUARED = WAD * WAD;
export const WAD_CUBED_BPS_OFFSET = WAD * WAD * WAD / BPS;
export const WAD_DECIMAL = new Decimal(WAD);

export const SECONDS_PER_YEAR = 31_536_000n; // 365 days
export const SECONDS_PER_MONTH = 2_592_000n; // 30 days
export const SECONDS_PER_WEEK = 604_800n; // 7 days
export const SECONDS_PER_DAY = 86_400n // 1 day

export const DEFAULT_SLIPPAGE_BPS = 100n; // 1%
const MAX_SWAP_SLIPPAGE_BPS = 9999n;

export const UINT256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
export const UINT256_MAX_DECIMAL = Decimal(UINT256_MAX);
export const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000" as address;
export const NATIVE_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as address;
export const EMPTY_BYTES = "0x" as bytes;

function getSetupConfig() {
    return (require("./setup") as typeof import("./setup")).setup_config;
}

function getChainConfigMap() {
    return (require("./chains") as typeof import("./chains")).chain_config;
}

export function getRateSeconds(rate: ChangeRate): bigint {
    switch (rate) {
        case "year":
            return SECONDS_PER_YEAR;
        case "month":
            return SECONDS_PER_MONTH;
        case "week":
            return SECONDS_PER_WEEK;
        case "day":
            return SECONDS_PER_DAY;
        default:
            throw new Error(`Unknown rate: ${rate}`);
    }
}

export function toDecimal(value: bigint, decimals: bigint): Decimal {
    return FormatConverter.bigIntToDecimal(value, decimals);
}

export function toBps(value: Percentage): bigint {
    return FormatConverter.percentageToBps(value);
}

export function fromBpsToWad(value: bigint): bigint {
    return FormatConverter.bpsToBpsWad(value);
}

export function toBigInt(value: number | Decimal, decimals: bigint): bigint {
    return FormatConverter.decimalToBigInt(Decimal(value), decimals);
}

/**
 * Amplify a BPS slippage tolerance by `leverageDelta × bpsToAmplify` to
 * compensate for the equity-fraction amplification that the on-chain
 * `checkSlippage` modifier applies to in-op losses on leveraged operations.
 *
 * ## Why this exists
 *
 * `checkSlippage` measures loss as `(valueIn − valueOut) / equity`. On a
 * leveraged swap where `valueIn = equity × L`, the same absolute loss X
 * appears as `X / equity = (X / valueIn) × L` — amplified by `(L−1)` in
 * (L−1)-terms. So any known per-swap loss (Curvance fee deducted before
 * the swap; full-deleverage intentional overshoot) needs the contract-level
 * slippage budget expanded by the amplified amount, otherwise a benign
 * known loss trips the check and reverts the tx.
 *
 * The user's raw `slippage` budget is reserved for VARIABLE in-op losses
 * (DEX impact, oracle drift) — this helper adds the DETERMINISTIC losses
 * on top.
 *
 * ## Call sites
 *
 * Three sites in `CToken.ts` use this:
 *
 *  - `leverageUp` case `'simple'`:     `leverageDelta = newLeverage - 1`,        `bps = feeBps`
 *  - `leverageDown` (simple):          `leverageDelta = full ? currL - 1 :         currL - newL`,
 *                                       `bps = full ? DELEVERAGE_OVERHEAD_BPS + feeBps : feeBps`
 *  - `depositAndLeverage` case simple:  `leverageDelta = multiplier - 1`,          `bps = feeBps`
 *
 * The `leverageDelta` and `bpsToAmplify` arguments preserve the per-site
 * asymmetries: leverageUp/depositAndLeverage pass `newL - 1`; deleverage's
 * full path uses `currL - 1` (the entire leverage range collapses) and its
 * partial path uses `currL - newL` (only the shrunk range swaps). Full
 * deleverage also adds `DELEVERAGE_OVERHEAD_BPS` on top of the fee.
 *
 * ## Not for
 *
 * - `KyberSwap.quoteAction`'s `action.slippage = userSlippage + feeBps` is
 *   a DIFFERENT primitive — swap-layer flat fee absorption for `_swapSafe`,
 *   not `(L−1)`-amplified for `checkSlippage`. Keep that in the adapter.
 * - Borrow-amount sizing in `previewLeverageUp` — that's a fixed-point solve
 *   against LTV, not a slippage-tolerance expansion.
 */
export function amplifyContractSlippage(
    baseSlippage: bigint,
    leverageDelta: Decimal,
    bpsToAmplify: bigint,
): bigint {
    if (bpsToAmplify === 0n) return baseSlippage;
    const expansion = leverageDelta.mul(Number(bpsToAmplify)).ceil().toFixed(0);
    return baseSlippage + BigInt(expansion);
}

/**
 * Compute the swap-layer slippage tolerance (in WAD-BPS form) for the
 * `Swap.slippage` field passed through `CalldataChecker._swapSafe`.
 *
 * Semantics: `_swapSafe` measures `(valueIn − valueOut) / valueIn` on the
 * swap leg itself — NOT equity-fraction (that's the contract-level
 * `checkSlippage` modifier one layer up; see `amplifyContractSlippage`).
 * When a DEX aggregator deducts a currency_in fee before executing the
 * swap, the on-chain path sees `valueIn = full input` but receives only
 * `valueOut = swap_out_post_fee`, so the fee appears to `_swapSafe` as
 * swap slippage. Expand the tolerance here to absorb the known fee so the
 * user's raw slippage budget stays reserved for variable in-op losses
 * (pool-fee tier variance, DEX price impact, oracle drift).
 *
 * ## Symmetry across DEX aggregators
 *
 * Every aggregator adapter that charges `CURVANCE_FEE_BPS` via a
 * currency_in deduction must route its `quoteAction` through this helper
 * so the on-chain behavior is uniform. Currently used by:
 *
 *  - `KyberSwap.quoteAction` (explicit `currency_in` + `isInBps` params)
 *  - `Kuru.quoteAction` (referrer-style fee deduction, per Kuru docs
 *    mirroring KyberSwap's currency_in semantics)
 *
 * An aggregator that paid fees out-of-band (e.g., signed RFQ with fill-
 * price already netted) would NOT use this helper — its `_swapSafe` sees
 * no fee-induced loss. Gas-rebate models (negative fee) also skip.
 *
 * ## Return value
 *
 * BPS converted to WAD form via `FormatConverter.bpsToBpsWad`. Zero input
 * (both userSlippage and feeBps are zero / undefined) returns `0n` without
 * the conversion — preserves the historical zero-guard behavior of both
 * adapters.
 *
 * @param userSlippage User's slippage tolerance in BPS (e.g., 100n = 1%)
 * @param feeBps Aggregator's currency_in fee in BPS (e.g., CURVANCE_FEE_BPS = 4n).
 *               Undefined / 0n / negative all produce no expansion.
 * @returns WAD-BPS slippage for the `Swap.slippage` struct field
 */
export function toContractSwapSlippage(userSlippage: bigint, feeBps?: bigint): bigint {
    const effective = feeBps && feeBps > 0n ? userSlippage + feeBps : userSlippage;
    if (effective < 0n || effective > MAX_SWAP_SLIPPAGE_BPS) {
        throw new Error(`Swap slippage out of range (0-9999 BPS): ${effective}`);
    }
    return effective ? FormatConverter.bpsToBpsWad(effective) : 0n;
}

export function getChainConfig(chain?: ChainRpcPrefix) {
    const resolvedChain = chain ?? getSetupConfig()?.chain;
    if (!resolvedChain) {
        throw new Error(
            "Chain is not configured. Pass a chain explicitly or initialize setupChain() first.",
        );
    }

    const config = getChainConfigMap()[resolvedChain];
    if (!config) {
        throw new Error(`No configuration found for chain ${resolvedChain}`);
    }
    return config;
}

export function validateProviderAsSigner(provider: curvance_provider) {
    const isSigner = "address" in provider;

    if(!isSigner) {
        throw new Error("Provider is not a signer, therefor this action is not available. Please connect a wallet to execute this action.");
    }

    return provider as curvance_signer;
}

export function requireSigner(signer: curvance_signer | null | undefined): curvance_signer {
    if (!signer) {
        throw new Error("Provider is not a signer, therefor this action is not available. Please connect a wallet to execute this action.");
    }

    return signer;
}

export function requireAccount(
    account: address | null | undefined,
    signer: curvance_signer | null | undefined = null,
): address {
    if (account) {
        return account;
    }

    return requireSigner(signer).address as address;
}

export function resolveReadProvider(
    provider: curvance_provider,
    context: string,
): curvance_read_provider {
    if (!("address" in provider)) {
        return provider as curvance_read_provider;
    }

    const signerProvider = provider.provider as curvance_read_provider | null | undefined;
    if (signerProvider != null) {
        return signerProvider;
    }

    const defaultReadProvider = getSetupConfig()?.readProvider as curvance_read_provider | undefined;
    if (defaultReadProvider != null) {
        return defaultReadProvider;
    }

    throw new Error(
        `Read provider is not configured for ${context}. ` +
        `Pass a read provider explicitly, use a signer with .provider, or initialize setupChain() first.`,
    );
}

export function contractSetup<I>(provider: curvance_provider, contractAddress: address, abi: any): Contract & I {
    const contract = new Contract(contractAddress, abi, provider);
    if(contract == undefined || contract == null) {
        throw new Error(`Failed to load contract at address ${contractAddress}.`);
    }
    return contractWithGasBuffer(contract) as Contract & I;
}

export function getContractAddresses(chain: ChainRpcPrefix) {
    const config = chains[chain];

    if (!config) {
        throw new Error(`No configuration found for chain ${chain}`);
    }

    return config;
}

/**
 * Calculates the gas limit with a buffer percentage added
 * @param estimatedGas The original gas estimate from ethers
 * @param bufferPercent The percentage buffer to add (e.g., 20 for 20%)
 * @returns The gas limit with buffer applied
 */
function calculateGasWithBuffer(estimatedGas: bigint, bufferPercent: number): bigint {
    return (estimatedGas * BigInt(100 + bufferPercent)) / BigInt(100);
}

/**
 * Checks if a contract method supports gas estimation
 * @param method The contract method to check
 * @returns true if the method has an estimateGas function
 */
function canEstimateGas(method: any): boolean {
    return typeof method?.estimateGas === 'function';
}

function supportsGasOverrides(contract: any, methodName: string | symbol): boolean {
    if (typeof methodName !== "string") {
        return false;
    }

    try {
        const fragment = contract?.interface?.getFunction(methodName);
        const stateMutability = fragment?.stateMutability;
        return stateMutability !== "view" && stateMutability !== "pure";
    } catch {
        return false;
    }
}

function getContractMethodInputCount(contract: any, methodName: string | symbol): number | null {
    if (typeof methodName !== "string") {
        return null;
    }

    try {
        const fragment = contract?.interface?.getFunction(methodName);
        const inputs = fragment?.inputs;
        return Array.isArray(inputs) ? inputs.length : null;
    } catch {
        return null;
    }
}

/**
 * Attempts to estimate gas and add buffer to transaction arguments
 * @param method The contract method to estimate gas for
 * @param args The transaction arguments
 * @param bufferPercent The gas buffer percentage
 * @returns true if gas estimation was successful and added to args
 */
async function tryAddGasBuffer(method: any, args: any[], bufferPercent: number, inputCount: number | null): Promise<boolean> {
    if (!canEstimateGas(method)) {
        return false;
    }

    const estimatedGas = await method.estimateGas(...args);
    const gasLimit = calculateGasWithBuffer(estimatedGas, bufferPercent);

    if (inputCount != null && args.length > inputCount) {
        args[args.length - 1] = {
            ...args[args.length - 1],
            gasLimit,
        };
        return true;
    }

    args.push({ gasLimit });
    return true;
}

/**
 * Wraps a contract instance so all write actions automatically add a gas buffer.
 *
 * How it works:
 * 1. Creates a proxy around the contract
 * 2. Intercepts all function calls
 * 3. For contract methods that support it, estimates gas usage
 * 4. Adds the specified buffer percentage to the gas limit
 * 5. Calls the original method with the buffered gas limit
 *
 * @param contract The ethers contract instance to wrap
 * @param bufferPercent The percentage buffer to add (default 10%)
 * @returns The same contract but with automatic gas buffering
 */
// ---------------------------------------------------------------------------
// Yield calculation helpers
// ---------------------------------------------------------------------------

export type MerklOpportunityLike = {
    apr: number;
    identifier: string;
    tokens: { address: string }[];
};

export type ApyOverrides = Record<string, { value: number }>;
export type MerklMatchMode = "deposit" | "borrow";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null;
}

function normalizeMerklTokenKey(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

function getMerklOpportunityTokenKeys(
    opportunity: unknown,
    mode: MerklMatchMode,
): string[] {
    if (!isRecord(opportunity)) {
        return [];
    }

    const tokens = Array.isArray(opportunity.tokens) ? opportunity.tokens : [];
    const tokenKeys = Array.from(
        new Set(
            tokens
                .map((token) => isRecord(token) ? normalizeMerklTokenKey(token.address) : null)
                .filter((value): value is string => value != null),
        ),
    );
    const identifierKey = normalizeMerklTokenKey(opportunity.identifier);

    if (mode === "borrow") {
        if (identifierKey != null) {
            return [identifierKey];
        }

        return tokenKeys;
    }

    if (tokenKeys.length > 0) {
        return tokenKeys;
    }

    return identifierKey != null ? [identifierKey] : [];
}

function getMerklOpportunityApr(opportunity: unknown): Decimal | null {
    if (!isRecord(opportunity)) {
        return null;
    }

    const { apr } = opportunity;
    if (typeof apr !== "number" && typeof apr !== "string" && typeof apr !== "bigint") {
        return null;
    }

    try {
        const parsed = new Decimal(typeof apr === "bigint" ? apr.toString() : apr);
        return parsed.isFinite() && parsed.greaterThan(0) ? parsed : null;
    } catch {
        return null;
    }
}

export function aggregateMerklAprByToken(
    opportunities: unknown[] | undefined,
    mode: MerklMatchMode,
): Map<string, Decimal> {
    const totals = new Map<string, Decimal>();

    for (const opportunity of opportunities ?? []) {
        const apr = getMerklOpportunityApr(opportunity);
        if (apr == null) {
            continue;
        }

        for (const tokenKey of getMerklOpportunityTokenKeys(opportunity, mode)) {
            const current = totals.get(tokenKey) ?? new Decimal(0);
            totals.set(tokenKey, current.add(apr.div(100)));
        }
    }

    return totals;
}

export function getMerklTokenIncentiveApy(
    tokenAddress: string,
    opportunities: MerklOpportunityLike[] | undefined,
    mode: MerklMatchMode,
): Decimal {
    const tokenKey = normalizeMerklTokenKey(tokenAddress);
    if (tokenKey == null) {
        return new Decimal(0);
    }

    return aggregateMerklAprByToken(opportunities, mode).get(tokenKey) ?? new Decimal(0);
}

/**
 * Returns the native yield for a token — the rate provided by the asset issuer.
 * When `nativeApy` is nonzero it already includes the interest component,
 * so we return it directly.  Otherwise we fall back to any static APY override.
 */
type NativeYieldTokenLike = {
    nativeApy?: Decimal.Value | null;
    nativeYield?: Decimal.Value | null;
    asset: { symbol: string };
};

function getTokenNativeApy(token: NativeYieldTokenLike): Decimal {
    return new Decimal(token.nativeApy ?? token.nativeYield ?? 0);
}

// Real CToken instances expose nativeApy; nativeYield remains accepted for older helper-shaped objects.
export function getNativeYield(
    token: NativeYieldTokenLike,
    apyOverrides?: ApyOverrides,
): Decimal {
    const nativeApy = getTokenNativeApy(token);
    if (!nativeApy.isZero()) return nativeApy;
    const symbol = token.asset.symbol.toLowerCase();
    return new Decimal(apyOverrides?.[symbol]?.value ?? 0);
}

/**
 * Returns the interest yield — the lending APY earned on Curvance.
 */
export function getInterestYield(
    token: { getApy(): Decimal },
): Decimal {
    return token.getApy();
}

/**
 * Returns the Merkl incentive APY for a *deposit* token.
 * Matches opportunities whose `tokens` array contains the given address.
 */
export function getMerklDepositIncentives(
    tokenAddress: string,
    opportunities: MerklOpportunityLike[] | undefined,
): Decimal {
    return getMerklTokenIncentiveApy(tokenAddress, opportunities, "deposit");
}

/**
 * Returns the Merkl incentive APY for a *borrow* token.
 * Matches opportunities whose `identifier` equals the given address.
 */
export function getMerklBorrowIncentives(
    tokenAddress: string,
    opportunities: MerklOpportunityLike[] | undefined,
): Decimal {
    return getMerklTokenIncentiveApy(tokenAddress, opportunities, "borrow");
}

/**
 * Returns the total deposit APY for a token (native + interest + merkl).
 * When `nativeYield` is nonzero it already includes interest, so we use it directly.
 */
export function getDepositApy(
    token: NativeYieldTokenLike & { getApy(): Decimal; address: string },
    opportunities: MerklOpportunityLike[] | undefined,
    apyOverrides?: ApyOverrides,
): Decimal {
    const nativeApy = getTokenNativeApy(token);
    const base = !nativeApy.isZero()
        ? nativeApy
        : token.getApy().add(new Decimal(apyOverrides?.[token.asset.symbol.toLowerCase()]?.value ?? 0));
    const merkl = getMerklDepositIncentives(token.address, opportunities);
    return base.add(merkl);
}

/**
 * Returns the net borrow cost for a token (borrow rate − merkl incentives).
 * Can be negative when Merkl rewards exceed the borrow rate.
 */
export function getBorrowCost(
    token: { getBorrowRate(inPercentage: true): Decimal; address: string },
    opportunities: MerklOpportunityLike[] | undefined,
): Decimal {
    const borrowRate = token.getBorrowRate(true);
    const merkl = getMerklBorrowIncentives(token.address, opportunities);
    return new Decimal(borrowRate).sub(merkl);
}

// ---------------------------------------------------------------------------
// Gas helpers
// ---------------------------------------------------------------------------

export function contractWithGasBuffer<T extends object>(contract: T, bufferPercent = 10): T {
    return new Proxy(contract, {
        get(target, methodName, receiver) {
            const originalMethod = Reflect.get(target, methodName, receiver);

            // Only wrap functions, skip special properties like populateTransaction
            if (typeof originalMethod !== 'function' || methodName === 'populateTransaction') {
                return originalMethod;
            }

            const wrappedMethod = async (...args: any[]) => {
                try {
                    // Gas estimation is only useful on state-changing methods.
                    // Estimating read-only functions adds an unnecessary RPC round-trip
                    // and breaks fork tests when estimateGas is restricted or slow.
                    if (supportsGasOverrides(target, methodName)) {
                        await tryAddGasBuffer(
                            originalMethod,
                            args,
                            bufferPercent,
                            getContractMethodInputCount(target, methodName),
                        );
                    }

                    // Call the original method with potentially modified args
                    return await originalMethod.apply(target, args);
                } catch (error: any) {
                    // Just enhance the original error message with method context
                    error.message = `Contract method '${String(methodName)}' failed: ${error.message}`;
                    throw error;
                }
            };

            return new Proxy(wrappedMethod, {
                get(methodTarget, property, methodReceiver) {
                    if (property in methodTarget) {
                        return Reflect.get(methodTarget, property, methodReceiver);
                    }

                    const value = Reflect.get(originalMethod as any, property, originalMethod);
                    return typeof value === "function" ? value.bind(originalMethod) : value;
                },
                has(methodTarget, property) {
                    return property in methodTarget || property in originalMethod;
                },
                ownKeys(methodTarget) {
                    return [...new Set([
                        ...Reflect.ownKeys(methodTarget),
                        ...Reflect.ownKeys(originalMethod),
                    ])];
                },
                getOwnPropertyDescriptor(methodTarget, property) {
                    return (
                        Reflect.getOwnPropertyDescriptor(methodTarget, property) ??
                        Reflect.getOwnPropertyDescriptor(originalMethod, property)
                    );
                },
            });
        }
    });
}
