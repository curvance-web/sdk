import { Contract, TransactionResponse } from "ethers";
import { address, curvance_provider, Percentage, TokenInput, USD, USD_WAD } from "../types";
import { CToken, ICToken, ZapperInstructions } from "./CToken";
import { DynamicMarketToken, StaticMarketToken, UserMarketToken } from "./ProtocolReader";
import { Market } from "./Market";
import { ChangeRate } from "../helpers";
import Decimal from "decimal.js";
export interface IBorrowableCToken extends ICToken {
    borrow(amount: bigint, receiver: address): Promise<TransactionResponse>;
    repay(amount: bigint): Promise<TransactionResponse>;
    interestFee(): Promise<bigint>;
    marketOutstandingDebt(): Promise<bigint>;
    debtBalance(account: address): Promise<bigint>;
    IRM(): Promise<address>;
}
export interface IDynamicIRM {
    ADJUSTMENT_RATE(): Promise<bigint>;
    linkedToken(): Promise<address>;
    borrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    predictedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    supplyRate(assetsHeld: bigint, debt: bigint, interestFee: bigint): Promise<bigint>;
    adjustedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    utilizationRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
}
export declare class BorrowableCToken extends CToken {
    contract: Contract & IBorrowableCToken;
    constructor(provider: curvance_provider, address: address, cache: StaticMarketToken & DynamicMarketToken & UserMarketToken, market: Market);
    getLiquidity(inUSD: true): USD;
    getLiquidity(inUSD: false): USD_WAD;
    getPredictedBorrowRate(inPercentage: true): Percentage;
    getPredictedBorrowRate(inPercentage: false): bigint;
    getUtilizationRate(inPercentage: true): Percentage;
    getUtilizationRate(inPercentage: false): bigint;
    borrowChange(amount: USD, rateType: ChangeRate): Decimal;
    getMaxBorrowable(): Promise<TokenInput>;
    getMaxBorrowable(inUSD: false): Promise<TokenInput>;
    getMaxBorrowable(inUSD: true): Promise<USD>;
    depositAsCollateral(amount: TokenInput, zap?: ZapperInstructions, receiver?: address | null): Promise<TransactionResponse>;
    postCollateral(amount: TokenInput): Promise<TransactionResponse>;
    hypotheticalBorrowOf(amount: TokenInput): Promise<{
        excess: bigint;
        deficit: bigint;
        isPossible: boolean;
        priceStale: boolean;
    }>;
    fetchDebt(inUSD: true): Promise<USD>;
    fetchDebt(inUSD: false): Promise<bigint>;
    borrow(amount: TokenInput, receiver?: address | null): Promise<TransactionResponse>;
    dynamicIRM(): Promise<Contract & IDynamicIRM>;
    fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove'): Promise<Percentage>;
    fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage: false): Promise<bigint>;
    fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage: true): Promise<Percentage>;
    fetchDebtBalanceAtTimestamp(): Promise<USD>;
    fetchDebtBalanceAtTimestamp(timestamp: bigint): Promise<USD>;
    fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: true): Promise<USD>;
    fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: false): Promise<bigint>;
    fetchBorrowRate(): Promise<bigint>;
    fetchPredictedBorrowRate(): Promise<bigint>;
    fetchUtilizationRate(): Promise<bigint>;
    fetchSupplyRate(): Promise<bigint>;
    fetchLiquidity(): Promise<bigint>;
    repay(amount: TokenInput): Promise<TransactionResponse>;
    fetchInterestFee(): Promise<bigint>;
    marketOutstandingDebt(): Promise<bigint>;
    debtBalance(account: address): Promise<bigint>;
}
//# sourceMappingURL=BorrowableCToken.d.ts.map