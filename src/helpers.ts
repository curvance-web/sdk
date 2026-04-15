import { Contract, parseUnits } from "ethers";
import { Decimal } from "decimal.js";
import { address, bytes, curvance_provider, curvance_signer, Percentage } from "./types";
import { chains } from "./contracts";
import { setup_config } from "./setup";
import FormatConverter from "./classes/FormatConverter";
import { chain_config } from "./chains";

// Set Decimal.js precision to handle large numbers
Decimal.set({ precision: 50 });

export type ChangeRate = "year" | "month" | "week" | "day";
export type ChainRpcPrefix = keyof typeof chains;

export const BPS = BigInt(1e4);
export const BPS_SQUARED = BigInt(1e8);
export const WAD = BigInt(1e18);
export const WAD_BPS = BigInt(1e22);
export const RAY = BigInt(1e27);
export const WAD_SQUARED = BigInt(1e36);
export const WAD_CUBED_BPS_OFFSET = BigInt(1e50);
export const WAD_DECIMAL = new Decimal(WAD);

export const SECONDS_PER_YEAR = 31_536_000n; // 365 days
export const SECONDS_PER_MONTH = 2_592_000n; // 30 days
export const SECONDS_PER_WEEK = 604_800n; // 7 days
export const SECONDS_PER_DAY = 86_400n // 1 day

export const DEFAULT_SLIPPAGE_BPS = 100n; // 1%

export const UINT256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
export const UINT256_MAX_DECIMAL = Decimal(UINT256_MAX);
export const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000" as address;
export const NATIVE_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as address;
export const EMPTY_BYTES = "0x" as bytes;

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

export function getChainConfig() {
    const chain = setup_config.chain;
    const config = chain_config[chain];
    if (!config) {
        throw new Error(`No configuration found for chain ${chain}`);
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

/**
 * Attempts to estimate gas and add buffer to transaction arguments
 * @param method The contract method to estimate gas for
 * @param args The transaction arguments
 * @param bufferPercent The gas buffer percentage
 * @returns true if gas estimation was successful and added to args
 */
async function tryAddGasBuffer(method: any, args: any[], bufferPercent: number): Promise<boolean> {
    if (!canEstimateGas(method)) {
        return false;
    }

    const estimatedGas = await method.estimateGas(...args);
    const gasLimit = calculateGasWithBuffer(estimatedGas, bufferPercent);

    // Add the gas limit as transaction overrides
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

/**
 * Returns the native yield for a token — the rate provided by the asset issuer.
 * When `nativeYield` is nonzero it already includes the interest component,
 * so we return it directly.  Otherwise we fall back to any static APY override.
 */
export function getNativeYield(
    token: { nativeYield: number; asset: { symbol: string } },
    apyOverrides?: ApyOverrides,
): Decimal {
    if (token.nativeYield !== 0) return new Decimal(token.nativeYield);
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
    if (!opportunities?.length) return new Decimal(0);

    const address = tokenAddress.toLowerCase();

    const relevant = opportunities.filter((opp) =>
        opp.tokens.some((t) => t.address.toLowerCase() === address),
    );

    if (!relevant.length) return new Decimal(0);

    let bestApr = 0;
    for (const opp of relevant) {
        for (const t of opp.tokens) {
            if (t.address.toLowerCase() === address) {
                bestApr = Math.max(bestApr, opp.apr ?? 0);
            }
        }
    }

    return new Decimal(bestApr / 100);
}

/**
 * Returns the Merkl incentive APY for a *borrow* token.
 * Matches opportunities whose `identifier` equals the given address.
 */
export function getMerklBorrowIncentives(
    tokenAddress: string,
    opportunities: MerklOpportunityLike[] | undefined,
): Decimal {
    if (!opportunities?.length) return new Decimal(0);

    const address = tokenAddress.toLowerCase();

    const relevant = opportunities.filter(
        (opp) => opp.identifier.toLowerCase() === address,
    );

    if (!relevant.length) return new Decimal(0);

    const bestApr = relevant.reduce((max, opp) => Math.max(max, opp.apr ?? 0), 0);

    return new Decimal(bestApr / 100);
}

/**
 * Returns the total deposit APY for a token (native + interest + merkl).
 * When `nativeYield` is nonzero it already includes interest, so we use it directly.
 */
export function getDepositApy(
    token: { nativeYield: number; getApy(): Decimal; asset: { symbol: string }; address: string },
    opportunities: MerklOpportunityLike[] | undefined,
    apyOverrides?: ApyOverrides,
): Decimal {
    const base = token.nativeYield !== 0
        ? new Decimal(token.nativeYield)
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

            // Return a wrapped version of the method
            return async (...args: any[]) => {
                try {
                    // Try to add gas buffer before calling the method
                    await tryAddGasBuffer(originalMethod, args, bufferPercent);

                    // Call the original method with potentially modified args
                    return await originalMethod.apply(target, args);
                } catch (error: any) {
                    // Just enhance the original error message with method context
                    error.message = `Contract method '${String(methodName)}' failed: ${error.message}`;
                    throw error;
                }
            };
        }
    });
}