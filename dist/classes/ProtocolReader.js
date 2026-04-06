"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProtocolReader = exports.AdaptorTypes = void 0;
const helpers_1 = require("../helpers");
const ProtocolReader_json_1 = __importDefault(require("../abis/ProtocolReader.json"));
const setup_1 = require("../setup");
const FormatConverter_1 = __importDefault(require("./FormatConverter"));
exports.AdaptorTypes = {
    CHAINLINK: 4146809896196834135992027840844413263297648946195754575888528621153937239424n,
    REDSTONE_CLASSIC: 112276167558285217273674630712820450209078260760085898814947528017380798039930n,
    REDSTONE_CORE: 2n,
    MOCK: 1337n
};
class ProtocolReader {
    provider;
    address;
    contract;
    constructor(address, provider = setup_1.setup_config.provider) {
        this.provider = provider;
        this.address = address;
        this.contract = (0, helpers_1.contractSetup)(provider, address, ProtocolReader_json_1.default);
    }
    async getAllMarketData(account, use_api = true) {
        const all = await Promise.all([
            this.getStaticMarketData(use_api),
            this.getDynamicMarketData(use_api),
            this.getUserData(account)
        ]);
        return {
            staticMarket: all[0],
            dynamicMarket: all[1],
            userData: all[2]
        };
    }
    async maxRedemptionOf(account, ctoken, bufferTime = 0n) {
        const data = await this.contract.maxRedemptionOf(account, ctoken.address, bufferTime);
        return {
            maxCollateralizedShares: BigInt(data[0]),
            maxUncollateralizedShares: BigInt(data[1]),
            errorCodeHit: data[2]
        };
    }
    async hypotheticalRedemptionOf(account, ctoken, shares) {
        const data = await this.contract.hypotheticalRedemptionOf(account, ctoken.address, shares, 0n);
        return {
            excess: BigInt(data[0]),
            deficit: BigInt(data[1]),
            isPossible: data[2],
            priceStale: data[3]
        };
    }
    async hypotheticalBorrowOf(account, ctoken, assets) {
        const data = await this.contract.hypotheticalBorrowOf(account, ctoken.address, assets, 0n);
        return {
            excess: BigInt(data[0]),
            deficit: BigInt(data[1]),
            isPossible: data[2],
            priceStale: data[3]
        };
    }
    async getPositionHealth(market, account, ctoken, borrowableCToken, isDeposit, collateralAssets, isRepayment, debtAssets, bufferTime) {
        const data = await this.contract.getPositionHealth(market, account, ctoken, borrowableCToken, isDeposit, collateralAssets, isRepayment, debtAssets, bufferTime);
        return {
            positionHealth: BigInt(data[0]),
            errorCodeHit: data[1]
        };
    }
    async getDynamicMarketData(use_api = true) {
        // TODO: Implement API call
        const data = await this.contract.getDynamicMarketData();
        const typedData = data.map((market) => ({
            address: market._address,
            tokens: market.tokens.map((token) => ({
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
    async getUserData(account) {
        const data = await this.contract.getUserData(account);
        const typedData = {
            locks: data.locks.map((lock) => ({
                lockIndex: BigInt(lock.lockIndex),
                amount: BigInt(lock.amount),
                unlockTime: BigInt(lock.unlockTime)
            })),
            markets: data.markets.map((market) => ({
                address: market._address,
                collateral: BigInt(market.collateral),
                maxDebt: BigInt(market.maxDebt),
                debt: BigInt(market.debt),
                positionHealth: BigInt(market.positionHealth),
                cooldown: BigInt(market.cooldown),
                priceStale: market.priceStale,
                tokens: market.tokens.map((token) => ({
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
    async previewAssetImpact(user, collateral_ctoken, debt_ctoken, deposit_amount, borrow_amount) {
        const data = await this.contract.previewAssetImpact(user, collateral_ctoken, debt_ctoken, deposit_amount, borrow_amount);
        return {
            supply: BigInt(data[0]),
            borrow: BigInt(data[1])
        };
    }
    async hypotheticalLeverageOf(account, depositCToken, borrowableCToken, deposit_amount) {
        const assets = FormatConverter_1.default.decimalToBigInt(deposit_amount, depositCToken.asset.decimals);
        const [currentLeverage, adjustMaxLeverage, maxLeverage, maxDebtBorrowable] = await this.contract.hypotheticalLeverageOf(account, depositCToken.address, borrowableCToken.address, assets, 0n);
        return {
            currentLeverage: FormatConverter_1.default.bigIntToDecimal(currentLeverage, 18),
            adjustMaxLeverage: FormatConverter_1.default.bigIntToDecimal(adjustMaxLeverage, 18),
            maxLeverage: FormatConverter_1.default.bigIntToDecimal(maxLeverage, 18),
            maxDebtBorrowable: FormatConverter_1.default.bigIntToDecimal(maxDebtBorrowable, borrowableCToken.decimals),
        };
    }
    async marketMultiCooldown(markets, account) {
        return await this.contract.marketMultiCooldown(markets, account);
    }
    async debtBalanceAtTimestamp(account, borrowableCtoken, timestamp) {
        return await this.contract.debtBalanceAtTimestamp(account, borrowableCtoken, timestamp);
    }
    async getStaticMarketData(use_api = true) {
        // TODO: Implement API call
        const data = await this.contract.getStaticMarketData();
        const typedData = data.map((market) => ({
            address: market._address,
            adapters: market.adapters,
            cooldownLength: market.cooldownLength,
            tokens: market.tokens.map((token) => ({
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
exports.ProtocolReader = ProtocolReader;
//# sourceMappingURL=ProtocolReader.js.map