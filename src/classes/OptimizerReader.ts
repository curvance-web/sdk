import { Contract } from "ethers";
import Decimal from "decimal.js";
import abi from '../abis/OptimizerReader.json'
import { address, curvance_read_provider } from "../types";
import { BPS, WAD, WAD_DECIMAL } from "../helpers";
import type { Market, MarketToken } from "./Market";

const OPTIMIZER_VIEW_ABI = [
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function exchangeRate() view returns (uint256)",
    "function fee() view returns (uint256)",
    "function getApprovedMarkets() view returns (address[])",
    "function allocationCaps(address cToken) view returns (uint256)",
] as const;

const BORROWABLE_CTOKEN_VIEW_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "function assetsHeld() view returns (uint256)",
] as const;

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
    performanceFee: bigint;
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

export interface IOptimizerReader {
    getOptimizerAPY(optimizer: address): Promise<bigint>;
    getOptimizerUserData(optimizers: address[], account: address): Promise<any[]>;
    assetsAtTimestamp(account: address, cToken: address, timestamp: bigint): Promise<bigint>;
    isBad(optimizer: address): Promise<address[]>;
    multiIsBadCheck(optimizers: address[]): Promise<address[][]>;
    optimalRebalance(optimizer: address, slippageBps: bigint): Promise<any>;
    optimalRebalanceAt(optimizer: address, slippageBps: bigint, timestamp: bigint): Promise<any>;
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

function calculateAllocationCapUtilizationBps(
    totalAssets: bigint,
    allocatedAssets: bigint,
    allocationCap: bigint,
): bigint {
    const maxAllocation = (totalAssets * allocationCap) / WAD;
    return maxAllocation === 0n ? 0n : (allocatedAssets * BPS) / maxAllocation;
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
        return BigInt(await this.contract.getOptimizerAPY(optimizer));
    }

    async getOptimizerMarketData(optimizers: address[]): Promise<OptimizerMarketData[]> {
        return Promise.all(optimizers.map(async (optimizer) => {
            const opt = new Contract(optimizer, OPTIMIZER_VIEW_ABI, this.provider) as any;
            const [asset, totalAssets, sharePrice, performanceFee, markets] = await Promise.all([
                opt.asset(),
                opt.totalAssets(),
                opt.exchangeRate(),
                opt.fee(),
                opt.getApprovedMarkets(),
            ]);
            const totalAssetsBig = BigInt(totalAssets);

            const marketRows = await Promise.all((markets as address[]).map(async (market) => {
                const cToken = new Contract(market, BORROWABLE_CTOKEN_VIEW_ABI, this.provider) as any;
                const [shareBalance, allocationCap] = await Promise.all([
                    cToken.balanceOf(optimizer),
                    opt.allocationCaps(market),
                ]);
                const [allocatedAssets, liquidity] = await Promise.all([
                    cToken.convertToAssets(shareBalance),
                    cToken.assetsHeld(),
                ]);
                const allocatedAssetsBig = BigInt(allocatedAssets);
                const allocationCapBig = BigInt(allocationCap);

                return {
                    address: market,
                    allocatedAssets: allocatedAssetsBig,
                    liquidity: BigInt(liquidity),
                    allocationCap: allocationCapBig,
                    allocationCapUtilizationBps: calculateAllocationCapUtilizationBps(
                        totalAssetsBig,
                        allocatedAssetsBig,
                        allocationCapBig,
                    ),
                };
            }));

            return {
                address: optimizer,
                asset: asset as address,
                totalAssets: totalAssetsBig,
                markets: marketRows,
                totalLiquidity: marketRows.reduce((sum, market) => sum + market.liquidity, 0n),
                sharePrice: BigInt(sharePrice),
                performanceFee: BigInt(performanceFee),
                apy: await this.getOptimizerAPY(optimizer),
            };
        }));
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
        const data = await this.contract.getOptimizerUserData(optimizers, account);
        return data.map((opt: any) => ({
            address: opt._address,
            shareBalance: BigInt(opt.shareBalance),
            redeemable: BigInt(opt.redeemable)
        }));
    }

    async assetsAtTimestamp(account: address, cToken: address, timestamp: bigint): Promise<bigint> {
        return BigInt(await this.contract.assetsAtTimestamp(account, cToken, timestamp));
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
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const data = await this.contract.optimalRebalance(optimizer, slippageBps);
        return normalizeRebalanceResult(data);
    }

    async optimalRebalanceAt(
        optimizer: address,
        slippageBps: bigint,
        timestamp: bigint,
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const data = await this.contract.optimalRebalanceAt(optimizer, slippageBps, timestamp);
        return normalizeRebalanceResult(data);
    }
}
