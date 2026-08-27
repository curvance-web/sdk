import { Contract } from "ethers";
import Decimal from "decimal.js";
import abi from '../abis/OptimizerReader.json'
import { address, curvance_read_provider } from "../types";
import { aggregateMerklAprByToken, toBps, WAD_DECIMAL } from "../helpers";
import {
    fetchMerklOpportunities as fetchMerklOpportunitiesFromApi,
    type MerklOpportunity,
} from "../integrations/merkl";
import type { Market, MarketToken } from "./Market";

function resolveDefaultReadProvider(): curvance_read_provider | undefined {
    return (require("../setup") as typeof import("../setup")).setup_config?.readProvider;
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

/**
 * Annual incentive APY for one optimizer market in contract-scale BPS.
 * The cToken tag keeps the value independent of approved-market ordering.
 */
interface MarketIncentiveAPYBps {
    cToken: address;
    incentiveAPYBps: bigint;
}

type ReaderMethod<TArgs extends unknown[], TResult> = {
    (...args: TArgs): Promise<TResult>;
    staticCall?: (...args: TArgs) => Promise<TResult>;
};

export const DEFAULT_REBALANCE_CHUNKS = 200n;
const MAX_INCENTIVE_APY_BPS = 1_000n;

export interface IOptimizerReader {
    getOptimizerAPY: ReaderMethod<[address], bigint>;
    getOptimizerMarketData: ReaderMethod<[address[]], any[]>;
    getOptimizerUserData: ReaderMethod<[address[], address], any[]>;
    isBad: ReaderMethod<[address], address[]>;
    multiIsBadCheck: ReaderMethod<[address[]], address[][]>;
    optimalRebalance: ReaderMethod<[address, bigint, bigint, MarketIncentiveAPYBps[]], any>;
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

/**
 * Converts Merkl LEND opportunity APRs into the sparse tagged BPS input
 * expected by OptimizerReader.optimalRebalance.
 *
 * Merkl returns `apr` in percentage points (5 means 5%). The SDK's existing
 * aggregator converts that into a fractional Decimal (0.05), and `toBps`
 * converts the fraction into contract-scale BPS (500). Multiple opportunities
 * for the same cToken are summed before conversion.
 */
function buildTaggedMerklIncentives(
    data: OptimizerMarketData,
    opportunities: MerklOpportunity[],
): MarketIncentiveAPYBps[] {
    // Match Market.getAll(): opportunities without an action are treated as
    // supply incentives, while explicit BORROW rows must not affect routing.
    const lendOpportunities = opportunities.filter((opportunity) => (
        opportunity.action == undefined || opportunity.action.toUpperCase() === "LEND"
    ));
    const incentiveApyByToken = aggregateMerklAprByToken(lendOpportunities, "deposit");
    const marketIncentives: MarketIncentiveAPYBps[] = [];

    // Iterate over the authoritative approved markets returned by the reader.
    // This prevents unrelated Merkl opportunities from becoming invalid tags.
    for (const market of data.markets) {
        const incentiveApy = incentiveApyByToken.get(market.address.toLowerCase());
        const incentiveAPYBps = incentiveApy == undefined ? 0n : toBps(incentiveApy);

        // The contract accepts sparse input and assigns zero to omitted markets,
        // so zero-valued tags only increase calldata without changing the plan.
        if (incentiveAPYBps === 0n) continue;

        // Do not clamp untrusted API data. A value above the contract's 10% cap
        // must fail visibly instead of producing a plan with altered economics.
        if (incentiveAPYBps > MAX_INCENTIVE_APY_BPS) {
            throw new Error(
                `OptimizerReader.optimalRebalanceWithIncentives: Merkl incentive APY for ` +
                `${market.address} exceeds ${MAX_INCENTIVE_APY_BPS.toString()} BPS ` +
                `(received ${incentiveAPYBps.toString()} BPS).`,
            );
        }

        marketIncentives.push({
            cToken: market.address,
            incentiveAPYBps,
        });
    }

    return marketIncentives;
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
        // The contract now has one incentive-aware signature. Preserve the
        // existing SDK behavior by explicitly supplying no incentive tags.
        const data = await staticCallOrCall(
            this.contract.optimalRebalance,
            optimizer,
            slippageBps,
            rebalanceChunks,
            [],
        );
        return normalizeRebalanceResult(data);
    }

    /**
     * Builds an incentive-aware rebalance plan from current Merkl LEND data.
     *
     * Merkl is queried for the reader provider's chain. Only opportunities for
     * the optimizer's current approved cTokens are sent to the contract. A
     * thrown transport and non-OK Merkl failures are intentionally surfaced;
     * catching those and silently using zero incentives would make this method
     * indistinguishable from `optimalRebalance`. A valid empty or fully
     * filtered response still produces an ordinary zero-incentive plan.
     */
    async optimalRebalanceWithIncentives(
        optimizer: address,
        slippageBps: bigint = 0n,
        rebalanceChunks: bigint = DEFAULT_REBALANCE_CHUNKS,
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const [data] = await this.getOptimizerMarketData([optimizer]);
        if (data == undefined) {
            throw new Error(
                `OptimizerReader.optimalRebalanceWithIncentives: no data returned for ${optimizer}.`,
            );
        }

        let marketIncentives: MarketIncentiveAPYBps[] = [];
        if (data.markets.length > 0) {
            const network = await this.provider.getNetwork();
            const chainId = network.chainId;
            if (chainId <= 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error(
                    `OptimizerReader.optimalRebalanceWithIncentives: provider returned invalid ` +
                    `chainId ${chainId.toString()}.`,
                );
            }

            // Fetching without an action reuses the chain-scoped opportunity
            // cache populated by Market.getAll; the builder filters to LEND.
            const opportunities = await this.fetchMerklOpportunities(Number(chainId));
            marketIncentives = buildTaggedMerklIncentives(data, opportunities);
        }

        const result = await staticCallOrCall(
            this.contract.optimalRebalance,
            optimizer,
            slippageBps,
            rebalanceChunks,
            marketIncentives,
        );
        return normalizeRebalanceResult(result);
    }

    /** Isolated for deterministic unit tests without weakening the public API. */
    private async fetchMerklOpportunities(chainId: number): Promise<MerklOpportunity[]> {
        return fetchMerklOpportunitiesFromApi({ chainId });
    }
}
