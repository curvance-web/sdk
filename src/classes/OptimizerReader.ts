import { Contract } from "ethers";
import abi from '../abis/OptimizerReader.json'
import { address, curvance_read_provider } from "../types";

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
        const data = await (this.contract as any).getOptimizerMarketData.staticCall(optimizers);
        return data.map((opt: any) => ({
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
            performanceFee: BigInt(opt.performanceFee)
        }));
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
