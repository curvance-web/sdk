import { Contract } from "ethers";
import abi from '../abis/OptimizerReader.json'
import { address, curvance_read_provider } from "../types";

const OPTIMIZER_VIEW_ABI = [
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function exchangeRate() view returns (uint256)",
    "function fee() view returns (uint256)",
    "function getApprovedMarkets() view returns (address[])",
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

export interface OptimizerUserData {
    address: address;
    shareBalance: bigint;
    redeemable: bigint;
}

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
    getOptimizerMarketData(optimizers: address[]): Promise<any[]>;
    getOptimizerUserData(optimizers: address[], account: address): Promise<any[]>;
    optimalRebalance(optimizer: address, slippageBps: bigint): Promise<any>;
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
        try {
            const data = await (this.contract as any).getOptimizerMarketData.staticCall(optimizers);
            return Promise.all(data.map((opt: any) => this.normalizeOptimizerMarketData(opt)));
        } catch (error: any) {
            if (!this.shouldFallbackToViewOnlyOptimizerReads(error)) {
                throw error;
            }

            return Promise.all(optimizers.map((optimizer) => this.getOptimizerMarketDataViewOnly(optimizer)));
        }
    }

    private shouldFallbackToViewOnlyOptimizerReads(error: any): boolean {
        const message = String(error?.shortMessage ?? error?.reason ?? error?.message ?? error);
        return /static|state|write|non-view|call exception|execution reverted/i.test(message);
    }

    private async getOptimizerMarketDataViewOnly(optimizer: address): Promise<OptimizerMarketData> {
        const opt = new Contract(optimizer, OPTIMIZER_VIEW_ABI, this.provider) as any;
        const [asset, totalAssets, sharePrice, performanceFee, markets] = await Promise.all([
            opt.asset(),
            opt.totalAssets(),
            opt.exchangeRate(),
            opt.fee(),
            opt.getApprovedMarkets(),
        ]);

        const marketRows = await Promise.all((markets as address[]).map(async (market) => {
            const cToken = new Contract(market, BORROWABLE_CTOKEN_VIEW_ABI, this.provider) as any;
            const shareBalance = await cToken.balanceOf(optimizer);
            const [allocatedAssets, liquidity] = await Promise.all([
                cToken.convertToAssets(shareBalance),
                cToken.assetsHeld(),
            ]);

            return {
                address: market,
                allocatedAssets: BigInt(allocatedAssets),
                liquidity: BigInt(liquidity),
            };
        }));

        return {
            address: optimizer,
            asset: asset as address,
            totalAssets: BigInt(totalAssets),
            markets: marketRows,
            totalLiquidity: marketRows.reduce((sum, market) => sum + market.liquidity, 0n),
            sharePrice: BigInt(sharePrice),
            performanceFee: BigInt(performanceFee),
            apy: await this.getOptimizerAPY(optimizer),
        };
    }

    private async normalizeOptimizerMarketData(opt: any): Promise<OptimizerMarketData> {
        return {
            address: opt._address,
            asset: opt.asset,
            totalAssets: BigInt(opt.totalAssets),
            markets: opt.markets.map((m: any) => ({
                address: m._address,
                allocatedAssets: BigInt(m.allocatedAssets),
                liquidity: BigInt(m.liquidity)
            })),
            totalLiquidity: BigInt(opt.totalLiquidity),
            sharePrice: BigInt(opt.sharePrice),
            performanceFee: BigInt(opt.performanceFee),
            apy: opt.apy == null ? await this.getOptimizerAPY(opt._address) : BigInt(opt.apy),
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

    async optimalRebalance(
        optimizer: address,
        slippageBps: bigint = 0n,
    ): Promise<{ actions: ReallocationAction[]; bounds: AllocationBound[] }> {
        const data = await this.contract.optimalRebalance(optimizer, slippageBps);
        const actions = data.actions ?? data[0] ?? [];
        const bounds = data.bounds ?? data[1] ?? [];

        return {
            actions: actions.map((action: any) => normalizeReallocationAction(action)),
            bounds: bounds.map((bound: any) => normalizeAllocationBound(bound)),
        };
    }
}
