import { Contract } from "ethers";
import { contractSetup, toDecimal, WAD } from "../helpers";
import abi from '../abis/ProtocolReader.json'
import { address, curvance_provider, TokenInput, TypeBPS } from "../types";
import Decimal from "decimal.js";
import { setup_config } from "../setup";
import { MarketToken } from "./Market";
import { BorrowableCToken } from "./BorrowableCToken";
import { CToken } from "./CToken";
import FormatConverter from "./FormatConverter";

export const AdaptorTypes = {
    CHAINLINK: 4146809896196834135992027840844413263297648946195754575888528621153937239424n,
    REDSTONE_CLASSIC: 112276167558285217273674630712820450209078260760085898814947528017380798039930n,
    REDSTONE_CORE: 2n,
    MOCK: 1337n
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
    tokens: UserMarketToken[]
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
    hypotheticalLeverageOf(account: address, depositCToken: address, borrowCToken: address, assets: bigint, bufferTime: bigint): Promise<[ bigint, bigint, bigint, bigint ]>;
    getPositionHealth(market: address, account: address, ctoken: address, borrowableCToken: address, isDeposit: boolean, collateralAssets: bigint, isRepayment: boolean, debtAssets: bigint, bufferTime: bigint): Promise<[bigint, boolean]>;
    hypotheticalRedemptionOf(account: address, ctoken: address, redeemShares: bigint, bufferTime: bigint): Promise<[bigint, bigint, boolean, boolean]>;
    hypotheticalBorrowOf(account: address, borrowableCToken: address, borrowAssets: bigint, bufferTime: bigint): Promise<[bigint, bigint, boolean, boolean]>;
    maxRedemptionOf(account: address, ctoken: address, bufferTime: bigint): Promise<[bigint, bigint, boolean]>;
    debtBalanceAtTimestamp(account: address, borrowableCtoken: address, timestamp: bigint): Promise<bigint>;
    getBalancesOf(tokens: address[], account: address): Promise<bigint[]>;
}

export class ProtocolReader {
    provider: curvance_provider;
    address: address;
    contract: Contract & IProtocolReader;

    constructor(address: address, provider: curvance_provider = setup_config.provider) {
        this.provider = provider;
        this.address = address;
        this.contract = contractSetup<IProtocolReader>(provider, address, abi);
    }

    async getAllMarketData(account: address, use_api = true) {
        const all = await Promise.all([
            this.getStaticMarketData(use_api),
            this.getDynamicMarketData(use_api),
            this.getUserData(account)
        ])

        return {
            staticMarket : all[0],
            dynamicMarket: all[1],
            userData     : all[2]
        }
    }

    async maxRedemptionOf(account: address, ctoken: CToken, bufferTime: bigint = 0n) {
        const data = await this.contract.maxRedemptionOf(account, ctoken.address, bufferTime);
        return {
            maxCollateralizedShares: BigInt(data[0]),
            maxUncollateralizedShares: BigInt(data[1]),
            errorCodeHit: data[2]
        };
    }

    async hypotheticalRedemptionOf(account: address, ctoken: CToken, shares: bigint) {
        const data = await this.contract.hypotheticalRedemptionOf(account, ctoken.address, shares, 0n);
        return {
            excess: BigInt(data[0]),
            deficit: BigInt(data[1]),
            isPossible: data[2],
            priceStale: data[3]
        }
    }

    async hypotheticalBorrowOf(account: address, ctoken: BorrowableCToken, assets: bigint) {
        const data = await this.contract.hypotheticalBorrowOf(account, ctoken.address, assets, 0n);
        return {
            excess: BigInt(data[0]),
            deficit: BigInt(data[1]),
            isPossible: data[2],
            priceStale: data[3]
        }
    }

    async getPositionHealth(
        market: address,
        account: address,
        ctoken: address,
        borrowableCToken: address,
        isDeposit: boolean,
        collateralAssets: bigint,
        isRepayment: boolean,
        debtAssets: bigint,
        bufferTime: bigint
    ) {
        const data = await this.contract.getPositionHealth(market, account, ctoken, borrowableCToken, isDeposit, collateralAssets, isRepayment, debtAssets, bufferTime);
        return {
            positionHealth: BigInt(data[0]),
            errorCodeHit: data[1]
        }
    }

    async getDynamicMarketData(use_api = true) {
        // TODO: Implement API call
        const data = await this.contract.getDynamicMarketData();
        const typedData: DynamicMarketData[] = data.map((market: any) => ({
            address: market._address,
            tokens: market.tokens.map((token: any) => ({
                address: token._address,
                totalSupply: BigInt(token.totalSupply),
                totalAssets: BigInt(token.totalAssets),
                exchangeRate: BigInt(token.exchangeRate),
                collateral: BigInt(token.collateral),
                debt: BigInt(token.debt),
                sharePrice: BigInt(token.sharePrice),
                assetPrice: BigInt(token.assetPrice),
                sharePriceLower: BigInt(token.sharePriceLower),
                assetPriceLower: BigInt(token.assetPriceLower),
                borrowRate: BigInt(token.borrowRate),
                predictedBorrowRate: BigInt(token.predictedBorrowRate),
                utilizationRate: BigInt(token.utilizationRate),
                supplyRate: BigInt(token.supplyRate),
                liquidity: BigInt(token.liquidity)
            }))
        }));

        return typedData;

    }

    async getUserData(account: address) {
        const data = await this.contract.getUserData(account);

        const typedData: UserData = {
            locks: data.locks.map((lock: any) => ({
                lockIndex: BigInt(lock.lockIndex),
                amount: BigInt(lock.amount),
                unlockTime: BigInt(lock.unlockTime)
            })),
            markets: data.markets.map((market: any) => ({
                address: market._address,
                collateral: BigInt(market.collateral),
                maxDebt: BigInt(market.maxDebt),
                debt: BigInt(market.debt),
                positionHealth: BigInt(market.positionHealth),
                cooldown: BigInt(market.cooldown),
                priceStale: market.priceStale,
                tokens: market.tokens.map((token: any) => ({
                    address: token._address,
                    userAssetBalance: BigInt(token.userAssetBalance),
                    userShareBalance: BigInt(token.userShareBalance),
                    userUnderlyingBalance: BigInt(token.userUnderlyingBalance),
                    userCollateral: BigInt(token.userCollateral),
                    userDebt: BigInt(token.userDebt),
                    liquidationPrice: BigInt(token.liquidationPrice)
                }))
            }))
        };

        return typedData;
    }

    async previewAssetImpact(user: address, collateral_ctoken: address, debt_ctoken: address, deposit_amount: bigint, borrow_amount: bigint) {
        const data = await this.contract.previewAssetImpact(user, collateral_ctoken, debt_ctoken, deposit_amount, borrow_amount );
        return {
            supply: BigInt(data[0]),
            borrow: BigInt(data[1])
        };
    }

    async hypotheticalLeverageOf(account: address, depositCToken: MarketToken, borrowableCToken: MarketToken, deposit_amount: TokenInput) {
        const assets = FormatConverter.decimalToBigInt(deposit_amount, depositCToken.asset.decimals);
        const [
            currentLeverage,
            adjustMaxLeverage,
            maxLeverage,
            maxDebtBorrowable
        ] = await this.contract.hypotheticalLeverageOf(account, depositCToken.address, borrowableCToken.address, assets, 0n);

        return {
            currentLeverage: FormatConverter.bigIntToDecimal(currentLeverage, 18),
            adjustMaxLeverage: FormatConverter.bigIntToDecimal(adjustMaxLeverage, 18),
            maxLeverage: FormatConverter.bigIntToDecimal(maxLeverage, 18),
            maxDebtBorrowable: FormatConverter.bigIntToDecimal(maxDebtBorrowable, borrowableCToken.decimals),
        };
    }

    async marketMultiCooldown(markets: address[], account: address) {
        return await this.contract.marketMultiCooldown(markets, account);
    }

    async debtBalanceAtTimestamp(account: address, borrowableCtoken: address, timestamp: bigint) {
        return await this.contract.debtBalanceAtTimestamp(account, borrowableCtoken, timestamp);
    }

    async getBalancesOf(tokens: address[], account: address) {
        return await this.contract.getBalancesOf(tokens, account);
    }

    async getStaticMarketData(use_api = true) {
        // TODO: Implement API call
        const data = await this.contract.getStaticMarketData();

        const typedData: StaticMarketData[] = data.map((market: any) => ({
            address: market._address,
            adapters: market.adapters,
            cooldownLength: market.cooldownLength,
            tokens: market.tokens.map((token: any) => ({
                address: token._address,
                name: token.name,
                symbol: token.symbol,
                decimals: BigInt(token.decimals),
                asset: {
                    address: token.asset._address,
                    name: token.asset.name,
                    symbol: token.asset.symbol,
                    decimals: BigInt(token.asset.decimals),
                    totalSupply: BigInt(token.asset.totalSupply)
                },
                adapters: [BigInt(token.adapters[0]), BigInt(token.adapters[1])],
                isBorrowable: token.isBorrowable,
                borrowPaused: token.borrowPaused,
                collateralizationPaused: token.collateralizationPaused,
                mintPaused: token.mintPaused,
                collateralCap: BigInt(token.collateralCap),
                debtCap: BigInt(token.debtCap),
                isListed: token.isListed,
                collRatio: BigInt(token.collRatio),
                maxLeverage: BigInt(token.maxLeverage),
                collReqSoft: BigInt(token.collReqSoft),
                collReqHard: BigInt(token.collReqHard),
                liqIncBase: BigInt(token.liqIncBase),
                liqIncCurve: BigInt(token.liqIncCurve),
                liqIncMin: BigInt(token.liqIncMin),
                liqIncMax: BigInt(token.liqIncMax),
                closeFactorBase: BigInt(token.closeFactorBase),
                closeFactorCurve: BigInt(token.closeFactorCurve),
                closeFactorMin: BigInt(token.closeFactorMin),
                closeFactorMax: BigInt(token.closeFactorMax),
                irmTargetRate: BigInt(token.irmTargetRate),
                irmMaxRate: BigInt(token.irmMaxRate),
                irmTargetUtilization: BigInt(token.irmTargetUtilization),
                interestFee: BigInt(token.interestFee)
            }))
        }));
        return typedData;
    }
}