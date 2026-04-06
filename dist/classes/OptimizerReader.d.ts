import { Contract } from "ethers";
import { address, curvance_provider } from "../types";
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
export declare class OptimizerReader {
    provider: curvance_provider;
    address: address;
    contract: Contract & IOptimizerReader;
    constructor(address: address, provider?: curvance_provider);
    getOptimizerMarketData(optimizers: address[]): Promise<OptimizerMarketData[]>;
    getOptimizerUserData(optimizers: address[], account: address): Promise<OptimizerUserData[]>;
    optimalDeposit(optimizer: address, assets: bigint): Promise<address>;
    optimalWithdrawal(optimizer: address, assets: bigint): Promise<address>;
    optimalRebalance(optimizer: address): Promise<ReallocationAction[]>;
}
//# sourceMappingURL=OptimizerReader.d.ts.map