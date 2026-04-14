import assert from "node:assert/strict";
import test from "node:test";
import { UINT256_MAX } from "../src/helpers";
import { ProtocolReader, type DynamicMarketData, type StaticMarketData } from "../src/classes/ProtocolReader";

const MARKET = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";

function createReader(): ProtocolReader {
    return Object.create(ProtocolReader.prototype) as ProtocolReader;
}

function createDynamicMarket(): DynamicMarketData {
    return {
        address: MARKET as any,
        tokens: [{
            address: TOKEN as any,
            totalSupply: 10n,
            totalAssets: 20n,
            exchangeRate: 2n,
            collateral: 3n,
            debt: 4n,
            sharePrice: 5n,
            assetPrice: 6n,
            sharePriceLower: 7n,
            assetPriceLower: 8n,
            borrowRate: 9n,
            predictedBorrowRate: 10n,
            utilizationRate: 11n,
            supplyRate: 12n,
            liquidity: 13n,
        }],
    };
}

function createStaticMarket(): StaticMarketData {
    return {
        address: MARKET as any,
        adapters: [],
        cooldownLength: 1200n,
        tokens: [{
            address: TOKEN as any,
            name: "Token",
            symbol: "TOK",
            decimals: 18n,
            asset: {
                address: TOKEN as any,
                name: "Token",
                symbol: "TOK",
                decimals: 18n,
                totalSupply: 100n,
            },
            adapters: [0n, 0n],
            isBorrowable: true,
            borrowPaused: false,
            collateralizationPaused: false,
            mintPaused: false,
            collateralCap: 0n,
            debtCap: 0n,
            isListed: true,
            collRatio: 0n,
            maxLeverage: 0n,
            collReqSoft: 0n,
            collReqHard: 0n,
            liqIncBase: 0n,
            liqIncCurve: 0n,
            liqIncMin: 0n,
            liqIncMax: 0n,
            closeFactorBase: 0n,
            closeFactorCurve: 0n,
            closeFactorMin: 0n,
            closeFactorMax: 0n,
            irmTargetRate: 0n,
            irmMaxRate: 0n,
            irmTargetUtilization: 0n,
            interestFee: 0n,
        }],
    };
}

test("getAllMarketData skips address(0) user reads for public loads", async () => {
    const reader = createReader();
    let allDynamicStateCalls = 0;

    reader.getStaticMarketData = async () => [createStaticMarket()];
    reader.getDynamicMarketData = async () => [createDynamicMarket()];
    reader.getAllDynamicState = async () => {
        allDynamicStateCalls++;
        throw new Error("public reads should not request user state");
    };

    const data = await reader.getAllMarketData(null);

    assert.equal(allDynamicStateCalls, 0);
    assert.equal(data.staticMarket.length, 1);
    assert.equal(data.dynamicMarket.length, 1);
    assert.equal(data.userData.locks.length, 0);
    assert.equal(data.userData.markets[0]?.cooldown, 1200n);
    assert.equal(data.userData.markets[0]?.positionHealth, UINT256_MAX);
    assert.equal(data.userData.markets[0]?.tokens[0]?.liquidationPrice, UINT256_MAX);
});

test("getAllDynamicState normalizes combined market and user payloads", async () => {
    const reader = createReader();
    reader.contract = {
        getAllDynamicState: async () => ({
            market: [{
                _address: MARKET,
                tokens: [{
                    _address: TOKEN,
                    totalSupply: 10n,
                    exchangeRate: 2n,
                    totalAssets: 20n,
                    collateral: 3n,
                    debt: 4n,
                    sharePrice: 5n,
                    assetPrice: 6n,
                    sharePriceLower: 7n,
                    assetPriceLower: 8n,
                    borrowRate: 9n,
                    predictedBorrowRate: 10n,
                    utilizationRate: 11n,
                    supplyRate: 12n,
                    liquidity: 13n,
                }],
            }],
            user: {
                locks: [{ lockIndex: 1n, amount: 2n, unlockTime: 3n }],
                markets: [{
                    _address: MARKET,
                    collateral: 0n,
                    maxDebt: 0n,
                    debt: 0n,
                    positionHealth: UINT256_MAX,
                    cooldown: 1200n,
                    errorCodeHit: true,
                    tokens: [{
                        _address: TOKEN,
                        userAssetBalance: 1n,
                        userShareBalance: 2n,
                        userUnderlyingBalance: 3n,
                        userCollateral: 4n,
                        userDebt: 5n,
                        liquidationPrice: 6n,
                    }],
                }],
            },
        }),
    } as any;

    const data = await reader.getAllDynamicState(MARKET as any);

    assert.equal(data.dynamicMarket[0]?.tokens[0]?.exchangeRate, 2n);
    assert.equal(data.userData.locks[0]?.unlockTime, 3n);
    assert.equal(data.userData.markets[0]?.priceStale, true);
    assert.equal(data.userData.markets[0]?.tokens[0]?.userDebt, 5n);
});

test("getMarketStates normalizes targeted refresh payloads", async () => {
    const reader = createReader();
    reader.contract = {
        getMarketStates: async () => ({
            dynamicMarkets: [{
                _address: MARKET,
                tokens: [{
                    _address: TOKEN,
                    totalSupply: 10n,
                    exchangeRate: 2n,
                    totalAssets: 20n,
                    collateral: 3n,
                    debt: 4n,
                    sharePrice: 5n,
                    assetPrice: 6n,
                    sharePriceLower: 7n,
                    assetPriceLower: 8n,
                    borrowRate: 9n,
                    predictedBorrowRate: 10n,
                    utilizationRate: 11n,
                    supplyRate: 12n,
                    liquidity: 13n,
                }],
            }],
            userMarkets: [{
                _address: MARKET,
                collateral: 1n,
                maxDebt: 2n,
                debt: 3n,
                positionHealth: 4n,
                cooldown: 5n,
                errorCodeHit: false,
                tokens: [{
                    _address: TOKEN,
                    userAssetBalance: 6n,
                    userShareBalance: 7n,
                    userUnderlyingBalance: 8n,
                    userCollateral: 9n,
                    userDebt: 10n,
                    liquidationPrice: 11n,
                }],
            }],
        }),
    } as any;

    const data = await reader.getMarketStates([MARKET as any], MARKET as any);

    assert.equal(data.dynamicMarkets[0]?.tokens[0]?.assetPrice, 6n);
    assert.equal(data.userMarkets[0]?.tokens[0]?.userCollateral, 9n);
    assert.equal(data.userMarkets[0]?.priceStale, false);
});
