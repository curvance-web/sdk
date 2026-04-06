import { Contract } from "ethers";
import { Decimal } from "decimal.js";
import { address, bytes, curvance_provider, curvance_signer, Percentage } from "./types";
import { chains } from "./contracts";
export type ChangeRate = "year" | "month" | "week" | "day";
export type ChainRpcPrefix = keyof typeof chains;
export declare const BPS: bigint;
export declare const BPS_SQUARED: bigint;
export declare const WAD: bigint;
export declare const WAD_BPS: bigint;
export declare const RAY: bigint;
export declare const WAD_SQUARED: bigint;
export declare const WAD_CUBED_BPS_OFFSET: bigint;
export declare const WAD_DECIMAL: Decimal;
export declare const SECONDS_PER_YEAR = 31536000n;
export declare const SECONDS_PER_MONTH = 2592000n;
export declare const SECONDS_PER_WEEK = 604800n;
export declare const SECONDS_PER_DAY = 86400n;
export declare const DEFAULT_SLIPPAGE_BPS = 100n;
export declare const UINT256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
export declare const UINT256_MAX_DECIMAL: Decimal;
export declare const EMPTY_ADDRESS: address;
export declare const NATIVE_ADDRESS: address;
export declare const EMPTY_BYTES: bytes;
export declare function getRateSeconds(rate: ChangeRate): bigint;
export declare function toDecimal(value: bigint, decimals: bigint): Decimal;
export declare function toBps(value: Percentage): bigint;
export declare function fromBpsToWad(value: bigint): bigint;
export declare function toBigInt(value: number | Decimal, decimals: bigint): bigint;
export declare function getChainConfig(): import("./chains").ChainConfig;
export declare function validateProviderAsSigner(provider: curvance_provider): curvance_signer;
export declare function contractSetup<I>(provider: curvance_provider, contractAddress: address, abi: any): Contract & I;
export declare function getContractAddresses(chain: ChainRpcPrefix): {
    CentralRegistry: string;
    OracleManager: string;
    adaptors: {
        ChainlinkAdaptor: string;
        RedstoneClassicAdaptor: string;
        RedstoneCoreAdaptor: string;
    };
    calldataCheckers: {
        RedstoneAdaptorMulticallChecker: string;
        KyberSwapChecker: string;
    };
    zappers: {
        nativeVaultZapper: string;
        vaultZapper: string;
        simpleZapper: string;
    };
    "VaultAggregator-AUSD-sAUSD": string;
    "StaticPriceAggregator-loAZND": string;
    markets: {
        "MUBOND | AUSD": {
            address: string;
            "muBOND-DynamicIRM": string;
            tokens: {
                muBOND: string;
                AUSD: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "loAZND | AUSD": {
            address: string;
            "loAZND-DynamicIRM": string;
            tokens: {
                loAZND: string;
                AUSD: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "ezETH | WETH": {
            address: string;
            "ezETH-DynamicIRM": string;
            tokens: {
                ezETH: string;
                WETH: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "WETH-DynamicIRM": string;
        };
        "shMON | WMON": {
            address: string;
            "shMON-DynamicIRM": string;
            tokens: {
                shMON: string;
                WMON: string;
            };
            plugins: {
                nativeVaultPositionManager: string;
                simplePositionManager: string;
            };
            "WMON-DynamicIRM": string;
        };
        "aprMON | WMON": {
            address: string;
            "aprMON-DynamicIRM": string;
            tokens: {
                aprMON: string;
                WMON: string;
            };
            plugins: {
                nativeVaultPositionManager: string;
                simplePositionManager: string;
            };
            "WMON-DynamicIRM": string;
        };
        "sMON | WMON": {
            address: string;
            "sMON-DynamicIRM": string;
            tokens: {
                sMON: string;
                WMON: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "WMON-DynamicIRM": string;
        };
        "sAUSD | AUSD": {
            address: string;
            "sAUSD-DynamicIRM": string;
            tokens: {
                sAUSD: string;
                AUSD: string;
            };
            plugins: {
                simplePositionManager: string;
                vaultPositionManager: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "earnAUSD | AUSD": {
            address: string;
            "earnAUSD-DynamicIRM": string;
            tokens: {
                earnAUSD: string;
                AUSD: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "WMON | AUSD": {
            address: string;
            "WMON-DynamicIRM": string;
            tokens: {
                WMON: string;
                AUSD: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "WMON | USDC": {
            address: string;
            "WMON-DynamicIRM": string;
            tokens: {
                WMON: string;
                USDC: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "USDC-DynamicIRM": string;
        };
        "WBTC | USDC": {
            address: string;
            "WBTC-DynamicIRM": string;
            tokens: {
                WBTC: string;
                USDC: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "USDC-DynamicIRM": string;
        };
        "WETH | USDC": {
            address: string;
            "WETH-DynamicIRM": string;
            tokens: {
                WETH: string;
                USDC: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "USDC-DynamicIRM": string;
        };
        "gMON | WMON": {
            address: string;
            "gMON-DynamicIRM": string;
            tokens: {
                gMON: string;
                WMON: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "WMON-DynamicIRM": string;
        };
        "syzUSD | AUSD": {
            address: string;
            "syzUSD-DynamicIRM": string;
            tokens: {
                syzUSD: string;
                AUSD: string;
            };
            plugins: {};
            "AUSD-DynamicIRM": string;
        };
        "wsrUSD | AUSD": {
            address: string;
            tokens: {
                wsrUSD: string;
                AUSD: string;
            };
            plugins: {
                simplePositionManager: string;
            };
            "AUSD-DynamicIRM": string;
            "wsrUSD-DynamicIRM": string;
        };
        "YZM | AUSD": {
            address: string;
            plugins: {
                simplePositionManager: string;
            };
            "YZM-DynamicIRM": string;
            tokens: {
                YZM: string;
                AUSD: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "vUSD | AUSD": {
            address: string;
            plugins: {
                simplePositionManager: string;
            };
            "vUSD-DynamicIRM": string;
            tokens: {
                vUSD: string;
                AUSD: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "eBTC | WBTC": {
            address: string;
            plugins: {
                simplePositionManager: string;
            };
            "eBTC-DynamicIRM": string;
            tokens: {
                eBTC: string;
                WBTC: string;
            };
            "WBTC-DynamicIRM": string;
        };
    };
    ProtocolReader: string;
    "CombinedAggregator-ezETH": string;
    "CombinedAggregator-earnAUSD": string;
    DAOTimelock: string;
    "VaultAggregator-USDC-YZM": string;
    "VaultAggregator-AUSD-vUSD": string;
} | {
    CentralRegistry: string;
    OracleManager: string;
    adaptors: {
        ChainlinkAdaptor: string;
        RedstoneClassicAdaptor: string;
        RedstoneCoreAdaptor: string;
    };
    calldataCheckers: {
        RedstoneAdaptorMulticallChecker: string;
    };
    zappers: {
        nativeVaultZapper: string;
        vaultZapper: string;
        simpleZapper: string;
    };
    MockOracle: string;
    USDC: string;
    AUSD: string;
    BTC: string;
    ETH: string;
    Faucet: string;
    markets: {
        "Stable Market": {
            address: string;
            "USDC-DynamicIRM": string;
            tokens: {
                USDC: string;
                AUSD: string;
            };
            "AUSD-DynamicIRM": string;
        };
        "Volatile Market": {
            address: string;
            "BTC-DynamicIRM": string;
            tokens: {
                BTC: string;
                ETH: string;
            };
            "ETH-DynamicIRM": string;
        };
    };
    ProtocolReader: string;
};
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
export type MerklOpportunityLike = {
    apr: number;
    identifier: string;
    tokens: {
        address: string;
    }[];
};
export type ApyOverrides = Record<string, {
    value: number;
}>;
/**
 * Returns the native yield for a token — the rate provided by the asset issuer.
 * When `nativeYield` is nonzero it already includes the interest component,
 * so we return it directly.  Otherwise we fall back to any static APY override.
 */
export declare function getNativeYield(token: {
    nativeYield: number;
    asset: {
        symbol: string;
    };
}, apyOverrides?: ApyOverrides): Decimal;
/**
 * Returns the interest yield — the lending APY earned on Curvance.
 */
export declare function getInterestYield(token: {
    getApy(): Decimal;
}): Decimal;
/**
 * Returns the Merkl incentive APY for a *deposit* token.
 * Matches opportunities whose `tokens` array contains the given address.
 */
export declare function getMerklDepositIncentives(tokenAddress: string, opportunities: MerklOpportunityLike[] | undefined): Decimal;
/**
 * Returns the Merkl incentive APY for a *borrow* token.
 * Matches opportunities whose `identifier` equals the given address.
 */
export declare function getMerklBorrowIncentives(tokenAddress: string, opportunities: MerklOpportunityLike[] | undefined): Decimal;
/**
 * Returns the total deposit APY for a token (native + interest + merkl).
 * When `nativeYield` is nonzero it already includes interest, so we use it directly.
 */
export declare function getDepositApy(token: {
    nativeYield: number;
    getApy(): Decimal;
    asset: {
        symbol: string;
    };
    address: string;
}, opportunities: MerklOpportunityLike[] | undefined, apyOverrides?: ApyOverrides): Decimal;
/**
 * Returns the net borrow cost for a token (borrow rate − merkl incentives).
 * Can be negative when Merkl rewards exceed the borrow rate.
 */
export declare function getBorrowCost(token: {
    getBorrowRate(inPercentage: true): Decimal;
    address: string;
}, opportunities: MerklOpportunityLike[] | undefined): Decimal;
export declare function contractWithGasBuffer<T extends object>(contract: T, bufferPercent?: number): T;
//# sourceMappingURL=helpers.d.ts.map