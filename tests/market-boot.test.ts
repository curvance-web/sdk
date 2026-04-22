import assert from "node:assert/strict";
import test from "node:test";
import { Api } from "../src/classes/Api";
import { Market } from "../src/classes/Market";

const merklModule = require("../src/integrations/merkl");

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const MARKET_A = "0x00000000000000000000000000000000000000a1";
const MARKET_B = "0x00000000000000000000000000000000000000b2";
const TOKEN_A = "0x00000000000000000000000000000000000000c1";
const TOKEN_B = "0x00000000000000000000000000000000000000c2";

const originalFetchNativeYields = Api.fetchNativeYields;
const originalFetchMerklOpportunities = merklModule.fetchMerklOpportunities;

function createStaticMarket(marketAddress: string, tokenAddress: string) {
    return {
        address: marketAddress as any,
        adapters: [],
        cooldownLength: 1200n,
        tokens: [{
            address: tokenAddress as any,
            name: `Token-${tokenAddress.slice(-2)}`,
            symbol: `TOK${tokenAddress.slice(-1)}`,
            decimals: 18n,
            asset: {
                address: tokenAddress as any,
                name: `Asset-${tokenAddress.slice(-2)}`,
                symbol: `AST${tokenAddress.slice(-1)}`,
                decimals: 18n,
                totalSupply: 100n,
            },
            adapters: [0n, 0n],
            isBorrowable: false,
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

function createDynamicMarket(marketAddress: string, tokenAddress: string, exchangeRate: bigint) {
    return {
        address: marketAddress as any,
        tokens: [{
            address: tokenAddress as any,
            totalSupply: 10n,
            totalAssets: 20n,
            exchangeRate,
            collateral: 3n,
            debt: 4n,
            sharePrice: 5n,
            assetPrice: 6n,
            sharePriceLower: 7n,
            assetPriceLower: 8n,
            borrowRate: 0n,
            predictedBorrowRate: 0n,
            utilizationRate: 0n,
            supplyRate: 0n,
            liquidity: 13n,
        }],
    };
}

function createUserMarket(marketAddress: string, tokenAddress: string, userAssetBalance: bigint) {
    return {
        address: marketAddress as any,
        collateral: 0n,
        maxDebt: 0n,
        debt: 0n,
        positionHealth: 0n,
        cooldown: 1200n,
        errorCodeHit: false,
        priceStale: false,
        tokens: [{
            address: tokenAddress as any,
            userAssetBalance,
            userShareBalance: 0n,
            userUnderlyingBalance: 0n,
            userCollateral: 0n,
            userDebt: 0n,
            liquidationPrice: 0n,
        }],
    };
}

function createSetup() {
    return {
        chain: "monad-mainnet",
        readProvider: {} as any,
        signer: null,
        account: ACCOUNT,
        provider: {} as any,
        approval_protection: false,
        api_url: "https://api.curvance.test",
        feePolicy: {
            getFeeBps: () => 0n,
            feeReceiver: undefined,
        },
        contracts: {
            markets: {
                marketA: { address: MARKET_A, plugins: {} },
                marketB: { address: MARKET_B, plugins: {} },
            },
        },
    };
}

test.afterEach(() => {
    Api.fetchNativeYields = originalFetchNativeYields;
    merklModule.fetchMerklOpportunities = originalFetchMerklOpportunities;
});

test("Market.getAll joins dynamic and user payloads by address during boot", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [
                createStaticMarket(MARKET_A, TOKEN_A),
                createStaticMarket(MARKET_B, TOKEN_B),
            ],
            dynamicMarket: [
                createDynamicMarket(MARKET_B, TOKEN_B, 222n),
                createDynamicMarket(MARKET_A, TOKEN_A, 111n),
            ],
            userData: {
                locks: [],
                markets: [
                    createUserMarket(MARKET_B, TOKEN_B, 22n),
                    createUserMarket(MARKET_A, TOKEN_A, 11n),
                ],
            },
        }),
    } as any;

    const markets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        createSetup() as any,
    );

    assert.equal(markets.length, 2);
    assert.equal(markets[0]?.address, MARKET_A);
    assert.equal(markets[0]?.cache.dynamic.address, MARKET_A);
    assert.equal(markets[0]?.cache.user.address, MARKET_A);
    assert.equal((markets[0]?.tokens[0] as any).cache.exchangeRate, 111n);
    assert.equal((markets[0]?.tokens[0] as any).cache.userAssetBalance, 11n);
    assert.equal(markets[1]?.address, MARKET_B);
    assert.equal(markets[1]?.cache.dynamic.address, MARKET_B);
    assert.equal(markets[1]?.cache.user.address, MARKET_B);
    assert.equal((markets[1]?.tokens[0] as any).cache.exchangeRate, 222n);
    assert.equal((markets[1]?.tokens[0] as any).cache.userAssetBalance, 22n);
});

test("Market.getAll fails clearly when a static market is missing dynamic state", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    await assert.rejects(
        () => Market.getAll(
            reader,
            {} as any,
            {} as any,
            null,
            ACCOUNT as any,
            {},
            {},
            createSetup() as any,
        ),
        /Missing dynamic market data for 0x00000000000000000000000000000000000000a1 during Market\.getAll boot/i,
    );
});

test("Market.hypotheticalLiquidityOf routes through ProtocolReader with the market address", async () => {
    const market = Object.create(Market.prototype) as Market;
    market.address = MARKET_A as any;

    let capturedArgs: unknown[] | null = null;
    market.reader = {
        hypotheticalLiquidityOf: async (...args: unknown[]) => {
            capturedArgs = args;
            return {
                collateral: 1n,
                maxDebt: 2n,
                debt: 3n,
                collateralSurplus: 4n,
                liquidityDeficit: 5n,
                loanSizeError: false,
                oracleError: true,
            };
        },
    } as any;

    const result = await market.hypotheticalLiquidityOf(
        ACCOUNT as any,
        TOKEN_A as any,
        33n,
        44n,
        55n,
    );

    assert.deepEqual(capturedArgs, [
        MARKET_A,
        ACCOUNT,
        TOKEN_A,
        33n,
        44n,
        55n,
    ]);
    assert.deepEqual(result, {
        collateral: 1n,
        maxDebt: 2n,
        debt: 3n,
        collateralSurplus: 4n,
        liquidityDeficit: 5n,
        loanSizeError: false,
        oracleError: true,
    });
});
