import { Contract } from "ethers";
import { contractSetup } from "../helpers";
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
    assets: bigint;
}

export interface IOptimizerReader {
    getOptimizerMarketData(optimizers: address[]): Promise<any[]>;
    getOptimizerUserData(optimizers: address[], account: address): Promise<any[]>;
    optimalDeposit(optimizer: address, assets: bigint): Promise<address>;
    optimalWithdrawal(optimizer: address, assets: bigint): Promise<address>;
    optimalRebalance(optimizer: address): Promise<any[]>;
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
        this.contract = contractSetup<IOptimizerReader>(resolvedProvider, address, abi);
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

    async optimalDeposit(optimizer: address, assets: bigint): Promise<address> {
        return await this.contract.optimalDeposit(optimizer, assets);
    }

    async optimalWithdrawal(optimizer: address, assets: bigint): Promise<address> {
        return await this.contract.optimalWithdrawal(optimizer, assets);
    }

    async optimalRebalance(optimizer: address): Promise<ReallocationAction[]> {
        const data = await this.contract.optimalRebalance(optimizer);
        return data.map((action: any) => ({
            cToken: action.cToken,
            assets: BigInt(action.assets)
        }));
    }
}
