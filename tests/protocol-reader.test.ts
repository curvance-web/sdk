import assert from "node:assert/strict";
import test from "node:test";
import { UINT256_MAX } from "../src/helpers";
import {
    ProtocolReader,
    __resetProtocolReaderCache,
    type DynamicMarketData,
    type StaticMarketData,
    type UserData,
} from "../src/classes/ProtocolReader";

test.beforeEach(() => {
    __resetProtocolReaderCache();
});

const MARKET = "0x0000000000000000000000000000000000000001";
const MARKET_B = "0x0000000000000000000000000000000000000003";
const TOKEN = "0x0000000000000000000000000000000000000002";
const TOKEN_B = "0x0000000000000000000000000000000000000004";
const ACCOUNT = "0x00000000000000000000000000000000000000aa";

function createReader(): ProtocolReader {
    return Object.create(ProtocolReader.prototype) as ProtocolReader;
}

function createDynamicMarket(
    marketAddress: string = MARKET,
    tokenAddress: string = TOKEN,
): DynamicMarketData {
    return {
        address: marketAddress as any,
        tokens: [{
            address: tokenAddress as any,
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

function createStaticMarket(
    marketAddress: string = MARKET,
    tokenAddress: string = TOKEN,
): StaticMarketData {
    return {
        address: marketAddress as any,
        adapters: [],
        cooldownLength: 1200n,
        tokens: [{
            address: tokenAddress as any,
            name: "Token",
            symbol: "TOK",
            decimals: 18n,
            asset: {
                address: tokenAddress as any,
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

function createUserData(): UserData {
    return {
        locks: [{ lockIndex: 1n, amount: 2n, unlockTime: 3n }],
        markets: [{
            address: MARKET as any,
            collateral: 0n,
            maxDebt: 0n,
            debt: 0n,
            positionHealth: UINT256_MAX,
            cooldown: 1200n,
            priceStale: true,
            tokens: [{
                address: TOKEN as any,
                userAssetBalance: 1n,
                userShareBalance: 2n,
                userUnderlyingBalance: 3n,
                userCollateral: 4n,
                userDebt: 5n,
                liquidationPrice: 6n,
            }],
        }],
    };
}

test("public loads synthesize empty user state from static market data", async () => {
    const reader = createReader();
    const counters = {
        static: 0,
        dynamic: 0,
        combined: 0,
    };

    reader.getStaticMarketData = async () => {
        counters.static += 1;
        return [
            createStaticMarket(MARKET, TOKEN),
            createStaticMarket(MARKET_B, TOKEN_B),
        ];
    };
    reader.getDynamicMarketData = async () => {
        counters.dynamic += 1;
        return [
            createDynamicMarket(MARKET, TOKEN),
            createDynamicMarket(MARKET_B, TOKEN_B),
        ];
    };
    reader.getAllDynamicState = async () => {
        counters.combined += 1;
        throw new Error("public reads should not request user state");
    };

    const data = await reader.getAllMarketData(null);

    assert.deepEqual(counters, {
        static: 1,
        dynamic: 1,
        combined: 0,
    });
    assert.equal(data.staticMarket.length, 2);
    assert.equal(data.dynamicMarket.length, 2);
    assert.equal(data.userData.locks.length, 0);
    assert.equal(data.userData.markets[0]?.cooldown, 1200n);
    assert.equal(data.userData.markets[0]?.positionHealth, UINT256_MAX);
    assert.equal(data.userData.markets[0]?.tokens[0]?.liquidationPrice, UINT256_MAX);
    assert.equal(data.userData.markets[1]?.address, MARKET_B);
    assert.equal(data.userData.markets[1]?.tokens[0]?.address, TOKEN_B);
});

test("account loads use static + combined dynamic state without separate dynamic/user reads", async () => {
    const reader = createReader();
    const counters = {
        static: 0,
        dynamic: 0,
        user: 0,
        combined: 0,
    };

    reader.getStaticMarketData = async () => {
        counters.static += 1;
        return [createStaticMarket()];
    };
    reader.getDynamicMarketData = async () => {
        counters.dynamic += 1;
        throw new Error("connected loads should use getAllDynamicState");
    };
    reader.getUserData = async () => {
        counters.user += 1;
        throw new Error("connected loads should not call getUserData directly");
    };
    reader.getAllDynamicState = async () => {
        counters.combined += 1;
        return {
            dynamicMarket: [createDynamicMarket()],
            userData: createUserData(),
        };
    };

    const data = await reader.getAllMarketData(ACCOUNT as any);

    assert.deepEqual(counters, {
        static: 1,
        dynamic: 0,
        user: 0,
        combined: 1,
    });
    assert.equal(data.dynamicMarket[0]?.tokens[0]?.assetPrice, 6n);
    assert.equal(data.userData.markets[0]?.tokens[0]?.userDebt, 5n);
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

test("getAllDynamicState normalizes tuple payloads from ethers result arrays", async () => {
    const reader = createReader();
    reader.contract = {
        getAllDynamicState: async () => ([
            [{
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
            {
                locks: [{ lockIndex: 9n, amount: 8n, unlockTime: 7n }],
                markets: [{
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
            },
        ]),
    } as any;

    const data = await reader.getAllDynamicState(ACCOUNT as any);

    assert.equal(data.dynamicMarket[0]?.tokens[0]?.totalAssets, 20n);
    assert.equal(data.userData.locks[0]?.lockIndex, 9n);
    assert.equal(data.userData.markets[0]?.priceStale, false);
    assert.equal(data.userData.markets[0]?.tokens[0]?.liquidationPrice, 11n);
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

test("getMarketStates normalizes tuple payloads from ethers result arrays", async () => {
    const reader = createReader();
    reader.contract = {
        getMarketStates: async () => ([
            [{
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
            [{
                _address: MARKET,
                collateral: 1n,
                maxDebt: 2n,
                debt: 3n,
                positionHealth: 4n,
                cooldown: 5n,
                errorCodeHit: true,
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
        ]),
    } as any;

    const data = await reader.getMarketStates([MARKET as any], ACCOUNT as any);

    assert.equal(data.dynamicMarkets[0]?.tokens[0]?.borrowRate, 9n);
    assert.equal(data.userMarkets[0]?.priceStale, true);
    assert.equal(data.userMarkets[0]?.tokens[0]?.userAssetBalance, 6n);
});

test("getMarketStates falls back to legacy calls when the selector is not deployed", async () => {
    const reader = createReader();
    let targetedCalls = 0;
    let dynamicCalls = 0;
    let userCalls = 0;

    reader.contract = {
        getMarketStates: async () => {
            targetedCalls += 1;
            const error: any = new Error("execution reverted (no data present; likely require(false) occurred)");
            error.shortMessage = "execution reverted (no data present; likely require(false) occurred)";
            error.reason = "require(false)";
            error.transaction = {
                data: "0xaa78b4d400000000000000000000000000000000000000000000000000000000",
            };
            throw error;
        },
    } as any;

    reader.getDynamicMarketData = async () => {
        dynamicCalls += 1;
        return [
            createDynamicMarket(MARKET, TOKEN),
            createDynamicMarket(MARKET_B, TOKEN_B),
        ];
    };
    reader.getUserData = async () => {
        userCalls += 1;
        return {
            locks: [],
            markets: [
                createUserData().markets[0]!,
                {
                    address: MARKET_B as any,
                    collateral: 10n,
                    maxDebt: 11n,
                    debt: 12n,
                    positionHealth: 13n,
                    cooldown: 14n,
                    priceStale: false,
                    tokens: [{
                        address: TOKEN_B as any,
                        userAssetBalance: 15n,
                        userShareBalance: 16n,
                        userUnderlyingBalance: 17n,
                        userCollateral: 18n,
                        userDebt: 19n,
                        liquidationPrice: 20n,
                    }],
                },
            ],
        };
    };

    const first = await reader.getMarketStates([MARKET_B as any], ACCOUNT as any);
    const second = await reader.getMarketStates([MARKET as any], ACCOUNT as any);

    assert.equal(targetedCalls, 1);
    assert.equal(dynamicCalls, 2);
    assert.equal(userCalls, 2);
    assert.equal(first.dynamicMarkets[0]?.address, MARKET_B);
    assert.equal(first.userMarkets[0]?.tokens[0]?.userDebt, 19n);
    assert.equal(second.dynamicMarkets[0]?.address, MARKET);
    assert.equal(second.userMarkets[0]?.tokens[0]?.userDebt, 5n);
});

// ---------------------------------------------------------------------------
// bufferTime pass-through: the IProtocolReader interface declares bufferTime
// as a parameter on hypothetical*Of, and sibling wrappers like maxRedemptionOf
// accept an optional bufferTime default. The hypotheticalRedemptionOf /
// hypotheticalBorrowOf wrappers previously hardcoded 0n, which silently
// discards the caller's buffer preference. These tests validate the wrappers
// forward the argument to the contract.
// ---------------------------------------------------------------------------

test("hypotheticalRedemptionOf forwards bufferTime to the contract call", async () => {
    const reader = createReader();
    let captured: { bufferTime: bigint | null } = { bufferTime: null };

    reader.contract = {
        hypotheticalRedemptionOf: async (
            _account: string,
            _ctoken: string,
            _shares: bigint,
            bufferTime: bigint,
        ) => {
            captured.bufferTime = bufferTime;
            return [0n, 0n, true, false];
        },
    } as any;

    const ctoken = { address: TOKEN } as any;
    await (reader as any).hypotheticalRedemptionOf(ACCOUNT, ctoken, 1_000n, 180n);

    assert.equal(
        captured.bufferTime,
        180n,
        "wrapper must forward caller's bufferTime, not hardcode 0n",
    );
});

test("hypotheticalRedemptionOf defaults bufferTime to 0n when not provided", async () => {
    const reader = createReader();
    let captured: { bufferTime: bigint | null } = { bufferTime: null };

    reader.contract = {
        hypotheticalRedemptionOf: async (
            _account: string,
            _ctoken: string,
            _shares: bigint,
            bufferTime: bigint,
        ) => {
            captured.bufferTime = bufferTime;
            return [0n, 0n, true, false];
        },
    } as any;

    const ctoken = { address: TOKEN } as any;
    await reader.hypotheticalRedemptionOf(ACCOUNT as any, ctoken, 1_000n);

    assert.equal(captured.bufferTime, 0n, "default must remain 0n for backward compatibility");
});

test("hypotheticalBorrowOf forwards bufferTime to the contract call", async () => {
    const reader = createReader();
    let captured: { bufferTime: bigint | null } = { bufferTime: null };

    reader.contract = {
        hypotheticalBorrowOf: async (
            _account: string,
            _ctoken: string,
            _assets: bigint,
            bufferTime: bigint,
        ) => {
            captured.bufferTime = bufferTime;
            return [0n, 0n, true, false];
        },
    } as any;

    const ctoken = { address: TOKEN } as any;
    await (reader as any).hypotheticalBorrowOf(ACCOUNT, ctoken, 1_000n, 60n);

    assert.equal(
        captured.bufferTime,
        60n,
        "wrapper must forward caller's bufferTime, not hardcode 0n",
    );
});

test("getMarketStates selector-support probe caches across instances at the same address", async () => {
    // Every setupChain() constructs a fresh ProtocolReader. If selector-support
    // is per-instance, each chain-switch (or re-setup) re-probes — and after
    // the retry-provider's unknown-error cascade fix, one probe costs primary
    // + every fallback provider. Cache by address so the second instance
    // short-circuits straight to the legacy path.
    const PROBE_ADDRESS = "0x00000000000000000000000000000000000000cc";

    const reader1 = createReader();
    (reader1 as any).address = PROBE_ADDRESS;
    let reader1ProbeCount = 0;
    reader1.contract = {
        getMarketStates: async () => {
            reader1ProbeCount += 1;
            const error: any = new Error("execution reverted (no data present; likely require(false) occurred)");
            error.shortMessage = "execution reverted (no data present; likely require(false) occurred)";
            error.reason = "require(false)";
            error.transaction = {
                data: "0xaa78b4d400000000000000000000000000000000000000000000000000000000",
            };
            throw error;
        },
    } as any;
    reader1.getDynamicMarketData = async () => [];
    reader1.getUserData = async () => ({ locks: [], markets: [] });

    await reader1.getMarketStates([], ACCOUNT as any);
    assert.equal(reader1ProbeCount, 1, "first instance probes the contract");

    const reader2 = createReader();
    (reader2 as any).address = PROBE_ADDRESS;
    let reader2ProbeCount = 0;
    reader2.contract = {
        getMarketStates: async () => {
            reader2ProbeCount += 1;
            throw new Error("probe should be cached; contract.getMarketStates must not be called again");
        },
    } as any;
    reader2.getDynamicMarketData = async () => [];
    reader2.getUserData = async () => ({ locks: [], markets: [] });

    await reader2.getMarketStates([], ACCOUNT as any);
    assert.equal(
        reader2ProbeCount,
        0,
        "second instance at same address reuses cached probe result",
    );
});

test("hypotheticalBorrowOf defaults bufferTime to 0n when not provided", async () => {
    const reader = createReader();
    let captured: { bufferTime: bigint | null } = { bufferTime: null };

    reader.contract = {
        hypotheticalBorrowOf: async (
            _account: string,
            _ctoken: string,
            _assets: bigint,
            bufferTime: bigint,
        ) => {
            captured.bufferTime = bufferTime;
            return [0n, 0n, true, false];
        },
    } as any;

    const ctoken = { address: TOKEN } as any;
    await reader.hypotheticalBorrowOf(ACCOUNT as any, ctoken, 1_000n);

    assert.equal(captured.bufferTime, 0n, "default must remain 0n for backward compatibility");
});
