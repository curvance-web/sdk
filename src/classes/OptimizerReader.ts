import { Contract } from "ethers";
import { contractSetup } from "../helpers";
import abi from '../abis/OptimizerReader.json'
import { address, curvance_read_provider } from "../types";
import { setup_config } from "../setup";

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
    getOptimizerMarketData(optimizers: address[]): Promise<any[]>;
    getOptimizerUserData(optimizers: address[], account: address): Promise<any[]>;
    getOptimizerAPY(optimizer: address): Promise<bigint>;
    optimalRebalance(optimizer: address, slippageBps: bigint): Promise<[ReallocationAction[], AllocationBound[]]>;
}

export class OptimizerReader {
    provider: curvance_read_provider;
    address: address;
    contract: Contract & IOptimizerReader;

    constructor(address: address, provider: curvance_read_provider = setup_config.readProvider) {
        this.provider = provider;
        this.address = address;
        this.contract = contractSetup<IOptimizerReader>(provider, address, abi);
    }

    async getOptimizerMarketData(optimizers: address[]): Promise<OptimizerMarketData[]> {
        const data = await this.contract.getOptimizerMarketData(optimizers);
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
            performanceFee: BigInt(opt.performanceFee),
            apy: BigInt(opt.apy)
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

    async getOptimizerAPY(optimizer: address): Promise<bigint> {
        return BigInt(await this.contract.getOptimizerAPY(optimizer));
    }

    async optimalRebalance(optimizer: address, slippageBps: bigint): Promise<{
        actions: ReallocationAction[];
        bounds: AllocationBound[];
    }> {
        const data = await this.contract.optimalRebalance(optimizer, slippageBps);
        return {
            actions: data[0].map((action: any) => ({
                cToken: action.cToken,
                assetsOrBps: BigInt(action.assetsOrBps)
            })),
            bounds:  data[1].map((bound: any) => ({
                cToken: bound.cToken,
                minBps: BigInt(bound.minBps),
                maxBps: BigInt(bound.maxBps)
            }))
        };
    }
}
