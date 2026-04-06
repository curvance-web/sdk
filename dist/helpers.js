"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_BYTES = exports.NATIVE_ADDRESS = exports.EMPTY_ADDRESS = exports.UINT256_MAX_DECIMAL = exports.UINT256_MAX = exports.DEFAULT_SLIPPAGE_BPS = exports.SECONDS_PER_DAY = exports.SECONDS_PER_WEEK = exports.SECONDS_PER_MONTH = exports.SECONDS_PER_YEAR = exports.WAD_DECIMAL = exports.WAD_CUBED_BPS_OFFSET = exports.WAD_SQUARED = exports.RAY = exports.WAD_BPS = exports.WAD = exports.BPS_SQUARED = exports.BPS = void 0;
exports.getRateSeconds = getRateSeconds;
exports.toDecimal = toDecimal;
exports.toBps = toBps;
exports.fromBpsToWad = fromBpsToWad;
exports.toBigInt = toBigInt;
exports.getChainConfig = getChainConfig;
exports.validateProviderAsSigner = validateProviderAsSigner;
exports.contractSetup = contractSetup;
exports.getContractAddresses = getContractAddresses;
exports.getNativeYield = getNativeYield;
exports.getInterestYield = getInterestYield;
exports.getMerklDepositIncentives = getMerklDepositIncentives;
exports.getMerklBorrowIncentives = getMerklBorrowIncentives;
exports.getDepositApy = getDepositApy;
exports.getBorrowCost = getBorrowCost;
exports.contractWithGasBuffer = contractWithGasBuffer;
const ethers_1 = require("ethers");
const decimal_js_1 = require("decimal.js");
const contracts_1 = require("./contracts");
const setup_1 = require("./setup");
const FormatConverter_1 = __importDefault(require("./classes/FormatConverter"));
const chains_1 = require("./chains");
// Set Decimal.js precision to handle large numbers
decimal_js_1.Decimal.set({ precision: 50 });
exports.BPS = BigInt(1e4);
exports.BPS_SQUARED = BigInt(1e8);
exports.WAD = BigInt(1e18);
exports.WAD_BPS = BigInt(1e22);
exports.RAY = BigInt(1e27);
exports.WAD_SQUARED = BigInt(1e36);
exports.WAD_CUBED_BPS_OFFSET = BigInt(1e50);
exports.WAD_DECIMAL = new decimal_js_1.Decimal(exports.WAD);
exports.SECONDS_PER_YEAR = 31536000n; // 365 days
exports.SECONDS_PER_MONTH = 2592000n; // 30 days
exports.SECONDS_PER_WEEK = 604800n; // 7 days
exports.SECONDS_PER_DAY = 86400n; // 1 day
exports.DEFAULT_SLIPPAGE_BPS = 100n; // 1%
exports.UINT256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
exports.UINT256_MAX_DECIMAL = (0, decimal_js_1.Decimal)(exports.UINT256_MAX);
exports.EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000";
exports.NATIVE_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
exports.EMPTY_BYTES = "0x";
function getRateSeconds(rate) {
    switch (rate) {
        case "year":
            return exports.SECONDS_PER_YEAR;
        case "month":
            return exports.SECONDS_PER_MONTH;
        case "week":
            return exports.SECONDS_PER_WEEK;
        case "day":
            return exports.SECONDS_PER_DAY;
        default:
            throw new Error(`Unknown rate: ${rate}`);
    }
}
function toDecimal(value, decimals) {
    return FormatConverter_1.default.bigIntToDecimal(value, decimals);
}
function toBps(value) {
    return FormatConverter_1.default.percentageToBps(value);
}
function fromBpsToWad(value) {
    return FormatConverter_1.default.bpsToBpsWad(value);
}
function toBigInt(value, decimals) {
    return FormatConverter_1.default.decimalToBigInt((0, decimal_js_1.Decimal)(value), decimals);
}
function getChainConfig() {
    const chain = setup_1.setup_config.chain;
    const config = chains_1.chain_config[chain];
    if (!config) {
        throw new Error(`No configuration found for chain ${chain}`);
    }
    return config;
}
function validateProviderAsSigner(provider) {
    const isSigner = "address" in provider;
    if (!isSigner) {
        throw new Error("Provider is not a signer, therefor this action is not available. Please connect a wallet to execute this action.");
    }
    return provider;
}
function contractSetup(provider, contractAddress, abi) {
    const contract = new ethers_1.Contract(contractAddress, abi, provider);
    if (contract == undefined || contract == null) {
        throw new Error(`Failed to load contract at address ${contractAddress}.`);
    }
    return contractWithGasBuffer(contract);
}
function getContractAddresses(chain) {
    const config = contracts_1.chains[chain];
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
function calculateGasWithBuffer(estimatedGas, bufferPercent) {
    return (estimatedGas * BigInt(100 + bufferPercent)) / BigInt(100);
}
/**
 * Checks if a contract method supports gas estimation
 * @param method The contract method to check
 * @returns true if the method has an estimateGas function
 */
function canEstimateGas(method) {
    return typeof method?.estimateGas === 'function';
}
/**
 * Attempts to estimate gas and add buffer to transaction arguments
 * @param method The contract method to estimate gas for
 * @param args The transaction arguments
 * @param bufferPercent The gas buffer percentage
 * @returns true if gas estimation was successful and added to args
 */
async function tryAddGasBuffer(method, args, bufferPercent) {
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
 * Returns the native yield for a token — the rate provided by the asset issuer.
 * When `nativeYield` is nonzero it already includes the interest component,
 * so we return it directly.  Otherwise we fall back to any static APY override.
 */
function getNativeYield(token, apyOverrides) {
    if (token.nativeYield !== 0)
        return new decimal_js_1.Decimal(token.nativeYield);
    const symbol = token.asset.symbol.toLowerCase();
    return new decimal_js_1.Decimal(apyOverrides?.[symbol]?.value ?? 0);
}
/**
 * Returns the interest yield — the lending APY earned on Curvance.
 */
function getInterestYield(token) {
    return token.getApy();
}
/**
 * Returns the Merkl incentive APY for a *deposit* token.
 * Matches opportunities whose `tokens` array contains the given address.
 */
function getMerklDepositIncentives(tokenAddress, opportunities) {
    if (!opportunities?.length)
        return new decimal_js_1.Decimal(0);
    const address = tokenAddress.toLowerCase();
    const relevant = opportunities.filter((opp) => opp.tokens.some((t) => t.address.toLowerCase() === address));
    if (!relevant.length)
        return new decimal_js_1.Decimal(0);
    let bestApr = 0;
    for (const opp of relevant) {
        for (const t of opp.tokens) {
            if (t.address.toLowerCase() === address) {
                bestApr = Math.max(bestApr, opp.apr ?? 0);
            }
        }
    }
    return new decimal_js_1.Decimal(bestApr / 100);
}
/**
 * Returns the Merkl incentive APY for a *borrow* token.
 * Matches opportunities whose `identifier` equals the given address.
 */
function getMerklBorrowIncentives(tokenAddress, opportunities) {
    if (!opportunities?.length)
        return new decimal_js_1.Decimal(0);
    const address = tokenAddress.toLowerCase();
    const relevant = opportunities.filter((opp) => opp.identifier.toLowerCase() === address);
    if (!relevant.length)
        return new decimal_js_1.Decimal(0);
    const bestApr = relevant.reduce((max, opp) => Math.max(max, opp.apr ?? 0), 0);
    return new decimal_js_1.Decimal(bestApr / 100);
}
/**
 * Returns the total deposit APY for a token (native + interest + merkl).
 * When `nativeYield` is nonzero it already includes interest, so we use it directly.
 */
function getDepositApy(token, opportunities, apyOverrides) {
    const base = token.nativeYield !== 0
        ? new decimal_js_1.Decimal(token.nativeYield)
        : token.getApy().add(new decimal_js_1.Decimal(apyOverrides?.[token.asset.symbol.toLowerCase()]?.value ?? 0));
    const merkl = getMerklDepositIncentives(token.address, opportunities);
    return base.add(merkl);
}
/**
 * Returns the net borrow cost for a token (borrow rate − merkl incentives).
 * Can be negative when Merkl rewards exceed the borrow rate.
 */
function getBorrowCost(token, opportunities) {
    const borrowRate = token.getBorrowRate(true);
    const merkl = getMerklBorrowIncentives(token.address, opportunities);
    return new decimal_js_1.Decimal(borrowRate).sub(merkl);
}
// ---------------------------------------------------------------------------
// Gas helpers
// ---------------------------------------------------------------------------
function contractWithGasBuffer(contract, bufferPercent = 10) {
    return new Proxy(contract, {
        get(target, methodName, receiver) {
            const originalMethod = Reflect.get(target, methodName, receiver);
            // Only wrap functions, skip special properties like populateTransaction
            if (typeof originalMethod !== 'function' || methodName === 'populateTransaction') {
                return originalMethod;
            }
            // Return a wrapped version of the method
            return async (...args) => {
                try {
                    // Try to add gas buffer before calling the method
                    await tryAddGasBuffer(originalMethod, args, bufferPercent);
                    // Call the original method with potentially modified args
                    return await originalMethod.apply(target, args);
                }
                catch (error) {
                    // Just enhance the original error message with method context
                    error.message = `Contract method '${String(methodName)}' failed: ${error.message}`;
                    throw error;
                }
            };
        }
    });
}
//# sourceMappingURL=helpers.js.map