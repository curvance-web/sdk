import { Contract } from "ethers";
import { address, curvance_provider, TokenInput, TypeBPS } from "../types";
import Decimal from "decimal.js";
import { MarketToken } from "./Market";
import { BorrowableCToken } from "./BorrowableCToken";
import { CToken } from "./CToken";
export declare const AdaptorTypes: {
    CHAINLINK: bigint;
    REDSTONE_CLASSIC: bigint;
    REDSTONE_CORE: bigint;
    MOCK: bigint;
};
export interface StaticMarketAsset {
    address: address;
    name: string;
    symbol: string;
    decimals: bigint;
    totalSupply: bigint;
    balance?: bigint;
    image?: string;
    price?: Decimal;
}
export interface StaticMarketToken {
    address: address;
    asset: StaticMarketAsset;
    name: string;
    symbol: string;
    decimals: bigint;
    adapters: [bigint, bigint];
    isBorrowable: boolean;
    borrowPaused: boolean;
    collateralizationPaused: boolean;
    mintPaused: boolean;
    collateralCap: bigint;
    debtCap: bigint;
    isListed: boolean;
    collRatio: TypeBPS;
    maxLeverage: TypeBPS;
    collReqSoft: TypeBPS;
    collReqHard: TypeBPS;
    liqIncBase: TypeBPS;
    liqIncCurve: TypeBPS;
    liqIncMin: TypeBPS;
    liqIncMax: TypeBPS;
    closeFactorBase: TypeBPS;
    closeFactorCurve: TypeBPS;
    closeFactorMin: TypeBPS;
    closeFactorMax: TypeBPS;
    irmTargetRate: bigint;
    irmMaxRate: bigint;
    irmTargetUtilization: bigint;
    interestFee: TypeBPS;
}
export interface StaticMarketData {
    address: address;
    adapters: bigint[];
    cooldownLength: bigint;
    tokens: StaticMarketToken[];
}
export interface DynamicMarketToken {
    address: address;
    exchangeRate: bigint;
    totalSupply: bigint;
    totalAssets: bigint;
    collateral: bigint;
    debt: bigint;
    sharePrice: bigint;
    assetPrice: bigint;
    sharePriceLower: bigint;
    assetPriceLower: bigint;
    borrowRate: bigint;
    predictedBorrowRate: bigint;
    utilizationRate: bigint;
    supplyRate: bigint;
    liquidity: bigint;
}
export interface DynamicMarketData {
    address: address;
    tokens: DynamicMarketToken[];
}
export interface UserMarketToken {
    address: address;
    userAssetBalance: bigint;
    userShareBalance: bigint;
    userUnderlyingBalance: bigint;
    userCollateral: bigint;
    userDebt: bigint;
    liquidationPrice: bigint;
}
export interface UserMarket {
    address: address;
    collateral: bigint;
    maxDebt: bigint;
    debt: bigint;
    positionHealth: bigint;
    cooldown: bigint;
    priceStale: boolean;
    tokens: UserMarketToken[];
}
export interface UserLock {
    lockIndex: bigint;
    amount: bigint;
    unlockTime: bigint;
}
export interface UserData {
    locks: UserLock[];
    markets: UserMarket[];
}
export interface IProtocolReader {
    getUserData(account: address): Promise<UserData>;
    getDynamicMarketData(): Promise<DynamicMarketData[]>;
    getStaticMarketData(): Promise<StaticMarketData[]>;
    marketMultiCooldown(markets: address[], account: address): Promise<bigint[]>;
    previewAssetImpact(user: address, collateral_ctoken: address, debt_ctoken: address, new_collateral: bigint, new_debt: bigint): Promise<[bigint, bigint]>;
    hypotheticalLeverageOf(account: address, depositCToken: address, borrowCToken: address, assets: bigint, bufferTime: bigint): Promise<[bigint, bigint, bigint, bigint]>;
    getPositionHealth(market: address, account: address, ctoken: address, borrowableCToken: address, isDeposit: boolean, collateralAssets: bigint, isRepayment: boolean, debtAssets: bigint, bufferTime: bigint): Promise<[bigint, boolean]>;
    hypotheticalRedemptionOf(account: address, ctoken: address, redeemShares: bigint, bufferTime: bigint): Promise<[bigint, bigint, boolean, boolean]>;
    hypotheticalBorrowOf(account: address, borrowableCToken: address, borrowAssets: bigint, bufferTime: bigint): Promise<[bigint, bigint, boolean, boolean]>;
    maxRedemptionOf(account: address, ctoken: address, bufferTime: bigint): Promise<[bigint, bigint, boolean]>;
    debtBalanceAtTimestamp(account: address, borrowableCtoken: address, timestamp: bigint): Promise<bigint>;
}
export declare class ProtocolReader {
    provider: curvance_provider;
    address: address;
    contract: Contract & IProtocolReader;
    constructor(address: address, provider?: curvance_provider);
    getAllMarketData(account: address, use_api?: boolean): Promise<{
        staticMarket: StaticMarketData[];
        dynamicMarket: DynamicMarketData[];
        userData: UserData;
    }>;
    maxRedemptionOf(account: address, ctoken: CToken, bufferTime?: bigint): Promise<{
        maxCollateralizedShares: bigint;
        maxUncollateralizedShares: bigint;
        errorCodeHit: boolean;
    }>;
    hypotheticalRedemptionOf(account: address, ctoken: CToken, shares: bigint): Promise<{
        excess: bigint;
        deficit: bigint;
        isPossible: boolean;
        priceStale: boolean;
    }>;
    hypotheticalBorrowOf(account: address, ctoken: BorrowableCToken, assets: bigint): Promise<{
        excess: bigint;
        deficit: bigint;
        isPossible: boolean;
        priceStale: boolean;
    }>;
    getPositionHealth(market: address, account: address, ctoken: address, borrowableCToken: address, isDeposit: boolean, collateralAssets: bigint, isRepayment: boolean, debtAssets: bigint, bufferTime: bigint): Promise<{
        positionHealth: bigint;
        errorCodeHit: boolean;
    }>;
    getDynamicMarketData(use_api?: boolean): Promise<DynamicMarketData[]>;
    getUserData(account: address): Promise<UserData>;
    previewAssetImpact(user: address, collateral_ctoken: address, debt_ctoken: address, deposit_amount: bigint, borrow_amount: bigint): Promise<{
        supply: bigint;
        borrow: bigint;
    }>;
    hypotheticalLeverageOf(account: address, depositCToken: MarketToken, borrowableCToken: MarketToken, deposit_amount: TokenInput): Promise<{
        currentLeverage: Decimal;
        adjustMaxLeverage: Decimal;
        maxLeverage: Decimal;
        maxDebtBorrowable: Decimal;
    }>;
    marketMultiCooldown(markets: address[], account: address): Promise<bigint[]>;
    debtBalanceAtTimestamp(account: address, borrowableCtoken: address, timestamp: bigint): Promise<bigint>;
    getStaticMarketData(use_api?: boolean): Promise<StaticMarketData[]>;
}
//# sourceMappingURL=ProtocolReader.d.ts.map