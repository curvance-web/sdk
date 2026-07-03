import { Contract } from "ethers";
import Decimal from "decimal.js";
import abi from '../abis/OptimizerReader.json'
import { address, curvance_read_provider } from "../types";
import {
    decimalApyToBps,
    getMerklDepositIncentiveBps,
    WAD_DECIMAL,
} from "../helpers";
import type { MerklOpportunityLike } from "../helpers";
import { fetchMerklOpportunities } from "../integrations/merkl";
import type { Market, MarketToken } from "./Market";

function resolveDefaultReadProvider(): curvance_read_provider | undefined {
    return (require("../setup") as typeof import("../setup")).setup_config?.readProvider;
}

function resolveDefaultChainId(): number | undefined {
    return (require("../setup") as typeof import("../setup")).setup_config?.chainId;
}

async function resolveProviderChainId(provider: curvance_read_provider): Promise<number | undefined> {
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new Error(`OptimizerReader: provider returned invalid chainId ${network.chainId.toString()}.`);
    }

    return chainId;
}

export interface OptimizerCTokenData {
    address: address;
    allocatedAssets: bigint;
    liquidity: bigint;
    allocationCap: bigint;
    /** Current allocation relative to the cap-derived max allocation. 10000 = at cap. */
    allocationCapUtilizationBps: bigint;
}

export interface OptimizerMarketData {
    address: address;
    asset: address;
    totalAssets: bigint;
    markets: OptimizerCTokenData[];
    totalLiquidity: bigint;
    sharePrice: bigint;
    exchangeRateHighWatermark: bigint;
    performanceFee: bigint;
    numApprovedMarkets: bigint;
    /** Pre-performance-fee weighted supply APY in WAD (1e18 = 100%). */
    apy: bigint;
}

export interface OptimizerUnderlyingMarketAPY {
    cToken: address;
    market: address | null;
    assetSymbol: string;
    allocatedAssets: bigint;
    allocationWeight: Decimal;
    nativeApy: Decimal;
    merklApy: Decimal;
    totalApy: Decimal;
}

export interface OptimizerAPYBreakdown {
    optimizer: address;
    totalAssets: bigint;
    nativeApy: Decimal;
    merklApy: Decimal;
    averageApy: Decimal;
    markets: OptimizerUnderlyingMarketAPY[];
}

export interface OptimizerMerklIncentiveOptions {
    chainId?: number;
    signal?: AbortSignal;
    opportunities?: MerklOpportunityLike[];
}

export interface OptimizerUserData {
    address: address;
    shareBalance: bigint;
    redeemable: bigint;
}

type MarketTokenWithApy = MarketToken & {
    market?: { address?: address };
    asset?: { symbol?: string };
    incentiveSupplyApy?: Decimal.Value;
    getApy(): Decimal;
};

export interface ReallocationAction {
    cToken: address;
    assetsOrBps: bigint;
}

export interface AllocationBound {
    cToken: address;
    minBps: bigint;
    maxBps: bigint;
}

export interface MarketIncentiveAPYBps {
    cToken: address;
    incentiveAPYBps: bigint;
}

type ReaderMethod<TArgs extends unknown[], TResult> = {
    (...args: TArgs): Promise<TResult>;
    staticCall?: (...args: TArgs) => Promise<TResult>;
};

export const DEFAULT_REBALANCE_CHUNKS = 200n;

export interface IOptimizerReader {
    getOptimizerAPY: ReaderMethod<[address], bigint>;
    getOptimizerMarketData: ReaderMethod<[address[]], any[]>;
    getOptimizerUserData: ReaderMethod<[address[], address], any[]>;
    isBad: ReaderMethod<[address], address[]>;
    multiIsBadCheck: ReaderMethod<[address[]], address[][]>;
    optimalRebalance: ReaderMethod<[address, bigint, bigint], any>;
    optimalRebalanceWithIncentives: ReaderMethod<[address, bigint, bigint, MarketIncentiveAPYBps[]], any>;
}

function normalizeReallocationAction(action: any): ReallocationAction {
    return {
        cToken: action.cToken,
        assetsOrBps: BigInt(action.assetsOrBps ?? action.assets),
    };
}

function normalizeAllocationBound(bound: any): AllocationBound {
    return {
        cToken: bound.cToken,
        minBps: BigInt(bound.minBps),
        maxBps: BigInt(bound.maxBps),
    };
}

async function staticCallOrCall<TArgs extends unknown[], TResult>(
    method: ReaderMethod<TArgs, TResult>,
    ...args: TArgs
): Promise<TResult> {
    return method.staticCall == undefined
        ? method(...args)
        : method.staticCall(...args);
}

function normalizeOptimizerMarketData(data: any): OptimizerMarketData {
    const markets = (data.markets ?? data[3] ?? []).map((market: any) => ({
        address: market._address ?? market[0],
        allocatedAssets: BigInt(market.allocatedAssets ?? market[1]),
        liquidity: BigInt(market.liquidity ?? market[2]),
        allocationCap: BigInt(market.allocationCap ?? market[3]),
        allocationCapUtilizationBps: BigInt(market.allocationCapUtilizationBps ?? market[4]),
    }));

    return {
        address: data._address ?? data[0],
        asset: data.asset ?? data[1],
        totalAssets: BigInt(data.totalAssets ?? data[2]),
        markets,
        totalLiquidity: BigInt(data.totalLiquidity ?? data[4]),
        sharePrice: BigInt(data.sharePrice ?? data[5]),
        exchangeRateHighWatermark: BigInt(data.exchangeRateHighWatermark ?? data[6]),
        performanceFee: BigInt(data.performanceFee ?? data[7]),
        numApprovedMarkets: BigInt(data.numApprovedMarkets ?? data[8]),
        apy: BigInt(data.apy ?? data[9]),
    };
}

function normalizeOptimizerUserData(data: any): OptimizerUserData {
    return {
        address: data._address ?? data[0],
        shareBalance: BigInt(data.shareBalance ?? data[1]),
        redeemable: BigInt(data.redeemable ?? data[2]),
    };
}

function normalizeRebalanceResult(data: any): { actions: ReallocationAction[]; bounds: AllocationBound[] } {
    const actions = data.actions ?? data[0] ?? [];
    const bounds = data.bounds ?? data[1] ?? [];

    return {
        actions: actions.map((action: any) => normalizeReallocationAction(action)),
        bounds: bounds.map((bound: any) => normalizeAllocationBound(bound)),
    };
}

function getDefaultMarkets(): Market[] {
    return ((require("../setup") as typeof import("../setup")).all_markets ?? []) as Market[];
}

function buildTokenIndex(markets: Market[]): Map<string, MarketTokenWithApy> {
    const tokens = new Map<string, MarketTokenWithApy>();

    for (const market of markets) {
        for (const token of market.tokens as MarketTokenWithApy[]) {
            const key = token.address.toLowerCase();
            if (!tokens.has(key)) {
                tokens.set(key, token);
            }
        }
    }

    return tokens;
}

function buildMarketIncentiveAPYsBps(
    data: OptimizerMarketData,
    markets: Market[],
): bigint[] {
    const tokenIndex = buildTokenIndex(markets);

    return data.markets.map((marketData) => {
        const token = tokenIndex.get(marketData.address.toLowerCase());
        if (token == undefined) {
            throw new Error(
                `OptimizerReader.optimalRebalanceWithMarketIncentives: approved market ${marketData.address} ` +
                `is not present in the provided SDK markets.`,
            );
        }

        return decimalApyToBps(token.incentiveSupplyApy);
    });
}

function buildTaggedMarketIncentives(
    data: OptimizerMarketData,
    markets: Market[],
): MarketIncentiveAPYBps[] {
    const marketIncentiveAPYsBps = buildMarketIncentiveAPYsBps(data, markets);

    return data.markets.map((marketData, index) => ({
        cToken: marketData.address,
        incentiveAPYBps: marketIncentiveAPYsBps[index] ?? 0n,
    }));
}

function filterMerklLendOpportunities(opportunities: MerklOpportunityLike[]): MerklOpportunityLike[] {
    return opportunities.filter((opportunity) => (
        opportunity.action == undefined ||
        opportunity.action.toUpperCase() === "LEND"
    ));
}

function buildMerklIncentiveAPYsBps(
    data: OptimizerMarketData,
    opportunities: MerklOpportunityLike[],
): bigint[] {
    const lendOpportunities = filterMerklLendOpportunities(opportunities);

    return data.markets.map((marketData) => (
        getMerklDepositIncentiveBps(marketData.address, lendOpportunities)
    ));
}

function buildTaggedMerklIncentives(
    data: OptimizerMarketData,
    opportunities: MerklOpportunityLike[],
): MarketIncentiveAPYBps[] {
    const marketIncentiveAPYsBps = buildMerklIncentiveAPYsBps(data, opportunities);

    return data.markets.map((marketData, index) => ({
        cToken: marketData.address,
        incentiveAPYBps: marketIncentiveAPYsBps[index] ?? 0n,
    }));
}

export class OptimizerReader {
    provider: curvance_read_provider;
    address: address;
    contract: Contract & IOptimizerReader;

    constructor(address: address, provider?: curvance_read_provider) {
        const resolvedProvider = provider ?? resolveDefaultReadProvider();
        if (resolvedProvider == undefined) {
            throw new Error(
                `Read provider is not configured for OptimizerReader ${address}. ` +
                `Pass a provider explicitly or initialize setupChain() first.`
            );
        }

        this.provider = resolvedProvider;
        this.address = address;
        this.contract = new Contract(address, abi, resolvedProvider) as Contract & IOptimizerReader;
    }

    async getOptimizerAPY(optimizer: address): Promise<bigint> {
        return BigInt(await staticCallOrCall(this.contract.getOptimizerAPY, optimizer));
    }

    async getOptimizerMarketData(optimizers: address[]): Promise<OptimizerMarketData[]> {
        const data = await staticCallOrCall(this.contract.getOptimizerMarketData, optimizers);
        return data.map((optimizerData: any) => normalizeOptimizerMarketData(optimizerData));
    }

    /**
     * Returns the optimizer APY model plus weighted Merkl LEND rewards.
     *
     * The native optimizer APY comes from `getOptimizerMarketData().apy`, which
     * mirrors the on-chain reader's weighted supply APY. Per-market Merkl APYs
     * come from SDK market tokens hydrated during `Market.getAll`/`setupChain`.
     */
    async getOptimizerAPYBreakdown(
        optimizer: address,
        markets: Market[] = getDefaultMarkets(),
    ): Promise<OptimizerAPYBreakdown> {
        const [data] = await this.getOptimizerMarketData([optimizer]);
        if (data == undefined) {
            throw new Error(`OptimizerReader.getOptimizerAPYBreakdown: no data returned for ${optimizer}.`);
        }

        const tokenIndex = buildTokenIndex(markets);
        const totalAssetsDecimal = new Decimal(data.totalAssets.toString());
        const nativeApy = new Decimal(data.apy.toString()).div(WAD_DECIMAL);
        let merklApy = new Decimal(0);
        const rows: OptimizerUnderlyingMarketAPY[] = [];

        for (const marketData of data.markets) {
            const token = tokenIndex.get(marketData.address.toLowerCase());
            if (token == undefined) {
                throw new Error(
                    `OptimizerReader.getOptimizerAPYBreakdown: approved market ${marketData.address} ` +
                    `is not present in the provided SDK markets.`,
                );
            }

            const allocationWeight = data.totalAssets === 0n
                ? new Decimal(0)
                : new Decimal(marketData.allocatedAssets.toString()).div(totalAssetsDecimal);
            const tokenNativeApy = token.getApy();
            const tokenMerklApy = new Decimal(token.incentiveSupplyApy ?? 0);
            merklApy = merklApy.add(tokenMerklApy.mul(allocationWeight));

            rows.push({
                cToken: marketData.address,
                market: token.market?.address ?? null,
                assetSymbol: token.asset?.symbol ?? marketData.address,
                allocatedAssets: marketData.allocatedAssets,
                allocationWeight,
                nativeApy: tokenNativeApy,
                merklApy: tokenMerklApy,
                totalApy: tokenNativeApy.add(tokenMerklApy),
            });
        }

        return {
            optimizer: data.address,
            totalAssets: data.totalAssets,
            nativeApy,
            merklApy,
            averageApy: nativeApy.add(merklApy),
            markets: rows,
        };
    }

    async getOptimizerUserData(optimizers: address[], account: address): Promise<OptimizerUserData[]> {
        const data = await staticCallOrCall(this.contract.getOptimizerUserData, optimizers, account);
        return data.map((opt: any) => normalizeOptimizerUserData(opt));
    }

    async isBad(optimizer: address): Promise<address[]> {
        const markets = await this.contract.isBad(optimizer);
        return markets.map((market: any) => market as address);
    }

    async multiIsBadCheck(optimizers: address[]): Promise<address[][]> {
        const markets = await this.contract.multiIsBadCheck(optimizers);
        return markets.map((row: any[]) => row.map((market: any) => market as address));
    }

    async optimalRebalance(
        optimizer: address,
        slippageBps: bigint = 0n,
        rebalanceChunks: bigint = DEFAULT_REBALANCE_CHUNKS,
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const data = await staticCallOrCall(this.contract.optimalRebalance, optimizer, slippageBps, rebalanceChunks);
        return normalizeRebalanceResult(data);
    }

    async optimalRebalanceWithTaggedMarketIncentives(
        optimizer: address,
        marketIncentives: MarketIncentiveAPYBps[],
        slippageBps: bigint = 0n,
        rebalanceChunks: bigint = DEFAULT_REBALANCE_CHUNKS,
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const data = await staticCallOrCall(
            this.contract.optimalRebalanceWithIncentives,
            optimizer,
            slippageBps,
            rebalanceChunks,
            marketIncentives,
        );
        return normalizeRebalanceResult(data);
    }

    async optimalRebalanceWithIncentives(
        optimizer: address,
        slippageBps: bigint = 0n,
        rebalanceChunks: bigint = DEFAULT_REBALANCE_CHUNKS,
        options: OptimizerMerklIncentiveOptions = {},
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const marketIncentives = await this.getOptimizerMerklMarketIncentivesBps(optimizer, options);
        return this.optimalRebalanceWithTaggedMarketIncentives(
            optimizer,
            marketIncentives,
            slippageBps,
            rebalanceChunks,
        );
    }

    async optimalRebalanceWithMarketIncentives(
        optimizer: address,
        markets: Market[] = getDefaultMarkets(),
        slippageBps: bigint = 0n,
        rebalanceChunks: bigint = DEFAULT_REBALANCE_CHUNKS,
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const [data] = await this.getOptimizerMarketData([optimizer]);
        if (data == undefined) {
            throw new Error(`OptimizerReader.optimalRebalanceWithMarketIncentives: no data returned for ${optimizer}.`);
        }

        const marketIncentives = buildTaggedMarketIncentives(data, markets);
        return this.optimalRebalanceWithTaggedMarketIncentives(
            optimizer,
            marketIncentives,
            slippageBps,
            rebalanceChunks,
        );
    }

    async getOptimizerMerklMarketIncentivesBps(
        optimizer: address,
        options: OptimizerMerklIncentiveOptions = {},
    ): Promise<MarketIncentiveAPYBps[]> {
        const [data] = await this.getOptimizerMarketData([optimizer]);
        if (data == undefined) {
            throw new Error(`OptimizerReader.getOptimizerMerklMarketIncentivesBps: no data returned for ${optimizer}.`);
        }

        const opportunities = options.opportunities ?? await this.fetchMerklLendOpportunities(options);
        return buildTaggedMerklIncentives(data, opportunities);
    }

    async getOptimizerMerklIncentiveAPYsBps(
        optimizer: address,
        options: OptimizerMerklIncentiveOptions = {},
    ): Promise<bigint[]> {
        const marketIncentives = await this.getOptimizerMerklMarketIncentivesBps(optimizer, options);
        return marketIncentives.map((marketIncentive) => marketIncentive.incentiveAPYBps);
    }

    async optimalRebalanceWithMerklIncentives(
        optimizer: address,
        slippageBps: bigint = 0n,
        rebalanceChunks: bigint = DEFAULT_REBALANCE_CHUNKS,
        options: OptimizerMerklIncentiveOptions = {},
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        return this.optimalRebalanceWithIncentives(
            optimizer,
            slippageBps,
            rebalanceChunks,
            options,
        );
    }

    private async fetchMerklLendOpportunities(
        options: OptimizerMerklIncentiveOptions,
    ): Promise<MerklOpportunityLike[]> {
        let chainId = options.chainId;
        if (chainId == undefined) {
            try {
                chainId = await resolveProviderChainId(this.provider);
            } catch (error) {
                chainId = resolveDefaultChainId();
                if (chainId == undefined) {
                    throw error;
                }
            }
        }
        if (chainId == undefined) {
            chainId = resolveDefaultChainId();
        }
        if (chainId == undefined) {
            throw new Error(
                `OptimizerReader.getOptimizerMerklMarketIncentivesBps: chainId is required. ` +
                `Pass options.chainId, initialize setupChain(), or use a provider with getNetwork().`,
            );
        }

        const params: {
            action: "LEND";
            chainId: number;
            signal?: AbortSignal;
        } = {
            action: "LEND",
            chainId,
        };
        if (options.signal != undefined) {
            params.signal = options.signal;
        }

        return fetchMerklOpportunities(params);
    }
}
