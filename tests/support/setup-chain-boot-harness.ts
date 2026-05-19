import type { TestContext } from "node:test";
import { Api, type Incentives, type Milestones } from "../../src/classes/Api";
import {
    ProtocolReader,
    type DynamicMarketData,
    type StaticMarketData,
    type UserMarket,
} from "../../src/classes/ProtocolReader";
import type { SetupConfigSnapshot } from "../../src/setup";
import type { address } from "../../src/types";
import type { MerklOpportunity } from "../../src/integrations/merkl";

const merklModule = require("../../src/integrations/merkl");

type MaybePromise<T> = T | Promise<T>;

export const ARB_SEPOLIA_BOOT_FIXTURE = {
    account: "0x0000000000000000000000000000000000000abc" as address,
    stableMarket: "0x8fe35902B67D81c94CF81fd9a96558e8349215F5" as address,
    usdcCToken: "0x4Fd99EFd43d66F0eF854Ca58Ec0c9b9950514aF3" as address,
    ausdCToken: "0xC9cfa1ABf23F672a0a75eC567cE13619d0062CAD" as address,
    unknownMarket: "0x0000000000000000000000000000000000000bad" as address,
    unknownToken: "0x0000000000000000000000000000000000000d1d" as address,
} as const;

export const MONAD_MAINNET_BOOT_FIXTURE = {
    account: "0x0000000000000000000000000000000000000abc" as address,
    market: "0xa6A2A92F126b79Ee0804845ee6B52899b4491093" as address,
    wmonCToken: "0x1e240E30E51491546deC3aF16B0b4EAC8Dd110D4" as address,
    usdcCToken: "0x8EE9FC28B8Da872c38A496e9dDB9700bb7261774" as address,
    wrappedNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as address,
    usdcAsset: "0x0000000000000000000000000000000000000a11" as address,
} as const;

export const BOOT_DAO_ADDRESS =
    "0x0000000000000000000000000000000000000da0" as address;

export type BootMarketData = Awaited<ReturnType<ProtocolReader["getAllMarketData"]>>;
export type BootReaderContext = {
    account: address | null;
    address: address;
    batchKey: string | null;
};
export type MerklOpportunityParams = {
    action?: string | undefined;
    chainId?: number | undefined;
};

export interface SetupChainBootHarnessOptions {
    marketData: (context: BootReaderContext) => MaybePromise<BootMarketData>;
    rewards?: false | ((setup: SetupConfigSnapshot) => MaybePromise<{
        milestones: Milestones;
        incentives: Incentives;
    }>);
    merkl?: false | ((params: MerklOpportunityParams) => MaybePromise<MerklOpportunity[]>);
    daoAddress?: address | (() => MaybePromise<address>);
    fetch?: (url: string) => MaybePromise<any>;
    captureWarnings?: boolean;
    failOnFetch?: boolean;
}

export interface SetupChainBootHarness {
    rewardsConfigs: Array<{ chain: string; apiUrl: string }>;
    readerContexts: BootReaderContext[];
    merklCalls: MerklOpportunityParams[];
    warnings: string[];
    externalFetchCalls: string[];
}

export function installSetupChainBootHarness(
    t: TestContext,
    options: SetupChainBootHarnessOptions,
): SetupChainBootHarness {
    const originalGetRewards = Api.getRewards;
    const originalGetAllMarketData = ProtocolReader.prototype.getAllMarketData;
    const originalGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    const originalFetchMerklOpportunities = merklModule.fetchMerklOpportunities;
    const originalWarn = console.warn;
    const originalFetch = (globalThis as any).fetch;
    const captureWarnings = options.captureWarnings ?? true;
    const failOnFetch = options.failOnFetch ?? true;

    const harness: SetupChainBootHarness = {
        rewardsConfigs: [],
        readerContexts: [],
        merklCalls: [],
        warnings: [],
        externalFetchCalls: [],
    };

    const rewardsHandler = options.rewards;
    if (rewardsHandler !== false) {
        Api.getRewards = (async (setup) => {
            const resolvedSetup = setup as SetupConfigSnapshot;
            harness.rewardsConfigs.push({
                chain: resolvedSetup.chain,
                apiUrl: resolvedSetup.api_url,
            });
            return rewardsHandler == null
                ? { milestones: {}, incentives: {} }
                : await rewardsHandler(resolvedSetup);
        }) as typeof Api.getRewards;
    }

    ProtocolReader.prototype.getAllMarketData = (async function(
        this: ProtocolReader,
        account: address | null = null,
    ) {
        const context = {
            account,
            address: this.address,
            batchKey: this.batchKey,
        };
        harness.readerContexts.push(context);
        return await options.marketData(context);
    }) as unknown as typeof ProtocolReader.prototype.getAllMarketData;

    ProtocolReader.prototype.getDaoAddress = (async function() {
        if (typeof options.daoAddress === "function") {
            return await options.daoAddress();
        }

        return options.daoAddress ?? BOOT_DAO_ADDRESS;
    }) as unknown as typeof ProtocolReader.prototype.getDaoAddress;

    const merklHandler = options.merkl;
    if (merklHandler !== false) {
        merklModule.fetchMerklOpportunities = async (params: MerklOpportunityParams) => {
            harness.merklCalls.push({
                action: params.action,
                chainId: params.chainId,
            });
            return merklHandler == null ? [] : await merklHandler(params);
        };
    }

    if (captureWarnings) {
        console.warn = (...args: unknown[]) => {
            harness.warnings.push(args.map(String).join(" "));
        };
    }

    if (failOnFetch || options.fetch != null) {
        (globalThis as any).fetch = async (url: unknown) => {
            const urlString = String(url);
            harness.externalFetchCalls.push(urlString);
            if (options.fetch != null) {
                return await options.fetch(urlString);
            }
            throw new Error(`Unexpected external fetch during setupChain boot harness: ${urlString}`);
        };
    }

    t.after(() => {
        Api.getRewards = originalGetRewards;
        ProtocolReader.prototype.getAllMarketData = originalGetAllMarketData;
        ProtocolReader.prototype.getDaoAddress = originalGetDaoAddress;
        merklModule.fetchMerklOpportunities = originalFetchMerklOpportunities;
        if (captureWarnings) {
            console.warn = originalWarn;
        }
        if (failOnFetch || options.fetch != null) {
            (globalThis as any).fetch = originalFetch;
        }
    });

    return harness;
}

export function createBootStaticMarket(
    marketAddress: address,
    tokens: Array<{ cToken: address; symbol: string; isBorrowable?: boolean; asset?: address }>,
): StaticMarketData {
    return {
        address: marketAddress,
        adapters: [],
        cooldownLength: 1200n,
        tokens: tokens.map((token) => ({
            address: token.cToken,
            name: `Curvance ${token.symbol}`,
            symbol: `c${token.symbol}`,
            decimals: 18n,
            asset: {
                address: token.asset ?? token.cToken,
                name: token.symbol,
                symbol: token.symbol,
                decimals: 18n,
                totalSupply: 100n,
            },
            adapters: [0n, 0n],
            isBorrowable: token.isBorrowable ?? false,
            borrowPaused: false,
            collateralizationPaused: false,
            mintPaused: false,
            collateralCap: 0n,
            debtCap: 0n,
            isListed: true,
            collRatio: 0n,
            maxLeverage: 0n,
            collReqSoft: 0n,
            collReqHard: 0n,
            liqIncBase: 0n,
            liqIncCurve: 0n,
            liqIncMin: 0n,
            liqIncMax: 0n,
            closeFactorBase: 0n,
            closeFactorCurve: 0n,
            closeFactorMin: 0n,
            closeFactorMax: 0n,
            irmTargetRate: 0n,
            irmMaxRate: 0n,
            irmTargetUtilization: 0n,
            interestFee: 0n,
        })),
    };
}

export function createBootDynamicMarket(marketAddress: address, tokenAddresses: address[]): DynamicMarketData {
    return {
        address: marketAddress,
        tokens: tokenAddresses.map((tokenAddress, index) => ({
            address: tokenAddress,
            totalSupply: 10n + BigInt(index),
            totalAssets: 20n + BigInt(index),
            exchangeRate: 1n,
            collateral: 3n,
            debt: 4n,
            sharePrice: 5n,
            assetPrice: 6n,
            sharePriceLower: 7n,
            assetPriceLower: 8n,
            borrowRate: 0n,
            predictedBorrowRate: 0n,
            utilizationRate: 0n,
            supplyRate: 0n,
            liquidity: 13n,
        })),
    };
}

export function createBootUserMarket(marketAddress: address, tokenAddresses: address[]): UserMarket {
    return {
        address: marketAddress,
        collateral: 0n,
        maxDebt: 0n,
        debt: 0n,
        positionHealth: 0n,
        cooldown: 1200n,
        errorCodeHit: false,
        priceStale: false,
        tokens: tokenAddresses.map((tokenAddress, index) => ({
            address: tokenAddress,
            userAssetBalance: 100n + BigInt(index),
            userShareBalance: 0n,
            userUnderlyingBalance: 0n,
            userCollateral: 0n,
            userDebt: 0n,
            liquidationPrice: 0n,
        })),
    };
}

export function createDecimalsReadProvider(chainId: bigint, decimals: bigint = 18n) {
    return {
        async call(tx: { data?: string }) {
            if ((tx.data ?? "").slice(0, 10) !== "0x313ce567") {
                throw new Error(`Unexpected provider call: ${JSON.stringify(tx)}`);
            }

            return `0x${decimals.toString(16).padStart(64, "0")}`;
        },
        async getNetwork() {
            return { chainId, name: `chain-${chainId}` };
        },
        async resolveName(name: string) {
            return name;
        },
    };
}
