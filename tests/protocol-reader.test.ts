import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { UINT256_MAX } from "../src/helpers";
import protocolReaderAbi from "../src/abis/ProtocolReader.json";
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

function setReaderKeys(
    reader: ProtocolReader,
    readerAddress: string = MARKET,
    namespace: string | null = null,
) {
    (reader as any).address = readerAddress as any;
    (reader as any).batchKey =
        namespace == null ? null : `${namespace}:${readerAddress.toLowerCase()}`;
    (reader as any).staticMarketCacheKey = (reader as any).batchKey;
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

function createRawStaticMarket(
    marketAddress: string = MARKET,
    tokenAddress: string = TOKEN,
) {
    const market = createStaticMarket(marketAddress, tokenAddress);
    const token = market.tokens[0]!;

    return {
        _address: market.address,
        adapters: market.adapters,
        cooldownLength: market.cooldownLength,
        tokens: [{
            _address: token.address,
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals,
            asset: {
                _address: token.asset.address,
                name: token.asset.name,
                symbol: token.asset.symbol,
                decimals: token.asset.decimals,
                totalSupply: token.asset.totalSupply,
            },
            adapters: token.adapters,
            isBorrowable: token.isBorrowable,
            borrowPaused: token.borrowPaused,
            collateralizationPaused: token.collateralizationPaused,
            mintPaused: token.mintPaused,
            collateralCap: token.collateralCap,
            debtCap: token.debtCap,
            isListed: token.isListed,
            collRatio: token.collRatio,
            maxLeverage: token.maxLeverage,
            collReqSoft: token.collReqSoft,
            collReqHard: token.collReqHard,
            liqIncBase: token.liqIncBase,
            liqIncCurve: token.liqIncCurve,
            liqIncMin: token.liqIncMin,
            liqIncMax: token.liqIncMax,
            closeFactorBase: token.closeFactorBase,
            closeFactorCurve: token.closeFactorCurve,
            closeFactorMin: token.closeFactorMin,
            closeFactorMax: token.closeFactorMax,
            irmTargetRate: token.irmTargetRate,
            irmMaxRate: token.irmMaxRate,
            irmTargetUtilization: token.irmTargetUtilization,
            interestFee: token.interestFee,
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
            errorCodeHit: true,
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

test("ProtocolReader ABI exposes targeted refresh methods", () => {
    const functionNames = new Set(
        (protocolReaderAbi as Array<{ type: string; name?: string }>)
            .filter((item) => item.type === "function")
            .map((item) => item.name),
    );

    assert.equal(functionNames.has("getMarketStates"), true);
    assert.equal(functionNames.has("getMarketSummaries"), true);
});

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

test("getStaticMarketData caches static market data within the reader namespace", async () => {
    const reader = createReader();
    let calls = 0;

    setReaderKeys(reader, MARKET, "monad-mainnet");
    reader.contract = {
        getStaticMarketData: async () => {
            calls += 1;
            return [createRawStaticMarket()];
        },
    } as any;

    const first = await reader.getStaticMarketData();
    const second = await reader.getStaticMarketData();

    assert.equal(calls, 1);
    assert.equal(first[0]?.tokens[0]?.asset.totalSupply, 100n);
    assert.deepEqual(second, first);
});

test("getStaticMarketData keeps caches isolated across namespaces", async () => {
    let calls = 0;
    const contract = {
        getStaticMarketData: async () => {
            calls += 1;
            return [createRawStaticMarket()];
        },
    } as any;

    const monadReader = createReader();
    setReaderKeys(monadReader, MARKET, "monad-mainnet");
    monadReader.contract = contract;

    const arbitrumReader = createReader();
    setReaderKeys(arbitrumReader, MARKET, "arbitrum-sepolia");
    arbitrumReader.contract = contract;

    await monadReader.getStaticMarketData();
    await arbitrumReader.getStaticMarketData();

    assert.equal(calls, 2);
});

test("same-chain readers with different providers keep static cache isolated", async () => {
    const providerA = { label: "provider-a" } as any;
    const providerB = { label: "provider-b" } as any;

    let callsA = 0;
    const readerA = new ProtocolReader(MARKET as any, providerA, "monad-mainnet");
    readerA.contract = {
        getStaticMarketData: async () => {
            callsA += 1;
            return [createRawStaticMarket(MARKET, TOKEN)];
        },
    } as any;

    let callsB = 0;
    const readerB = new ProtocolReader(MARKET as any, providerB, "monad-mainnet");
    readerB.contract = {
        getStaticMarketData: async () => {
            callsB += 1;
            return [createRawStaticMarket(MARKET_B, TOKEN_B)];
        },
    } as any;

    const firstA = await readerA.getStaticMarketData();
    const firstB = await readerB.getStaticMarketData();
    const secondA = await readerA.getStaticMarketData();
    const secondB = await readerB.getStaticMarketData();

    assert.notEqual(readerA.batchKey, readerB.batchKey);
    assert.equal(firstA[0]?.address, MARKET);
    assert.equal(firstB[0]?.address, MARKET_B);
    assert.equal(secondA[0]?.address, MARKET);
    assert.equal(secondB[0]?.address, MARKET_B);
    assert.equal(callsA, 1);
    assert.equal(callsB, 1);
});

test("getStaticMarketData forceRefresh bypasses the short-lived cache", async () => {
    const reader = createReader();
    let calls = 0;

    setReaderKeys(reader, MARKET, "monad-mainnet");
    reader.contract = {
        getStaticMarketData: async () => {
            calls += 1;
            return [createRawStaticMarket()];
        },
    } as any;

    await reader.getStaticMarketData();
    await reader.getStaticMarketData({ forceRefresh: true });

    assert.equal(calls, 2);
});

test("connected getAllMarketData reuses cached static market data between boots", async () => {
    const reader = createReader();
    const counters = {
        static: 0,
        combined: 0,
    };

    setReaderKeys(reader, MARKET, "monad-mainnet");
    reader.contract = {
        getStaticMarketData: async () => {
            counters.static += 1;
            return [createRawStaticMarket()];
        },
    } as any;
    reader.getAllDynamicState = async () => {
        counters.combined += 1;
        return {
            dynamicMarket: [createDynamicMarket()],
            userData: createUserData(),
        };
    };

    const first = await reader.getAllMarketData(ACCOUNT as any);
    const second = await reader.getAllMarketData(ACCOUNT as any);

    assert.deepEqual(counters, {
        static: 1,
        combined: 2,
    });
    assert.equal(first.staticMarket[0]?.tokens[0]?.symbol, "TOK");
    assert.equal(second.userData.markets[0]?.tokens[0]?.userDebt, 5n);
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
    assert.equal(data.userData.markets[0]?.errorCodeHit, true);
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
    assert.equal(data.userData.markets[0]?.errorCodeHit, false);
    assert.equal(data.userData.markets[0]?.priceStale, false);
    assert.equal(data.userData.markets[0]?.tokens[0]?.liquidationPrice, 11n);
});

test("getMarketSummaries normalizes market-summary payloads", async () => {
    const reader = createReader();
    reader.contract = {
        getMarketSummaries: async () => ({
            userMarkets: [{
                _address: MARKET,
                collateral: 1n,
                maxDebt: 2n,
                debt: 3n,
                positionHealth: 4n,
                cooldown: 5n,
                errorCodeHit: true,
            }],
        }),
    } as any;

    const data = await reader.getMarketSummaries([MARKET as any], ACCOUNT as any);

    assert.deepEqual(data, [{
        address: MARKET,
        collateral: 1n,
        maxDebt: 2n,
        debt: 3n,
        positionHealth: 4n,
        cooldown: 5n,
        errorCodeHit: true,
        priceStale: true,
    }]);
});

test("getMarketSummaries normalizes direct array payloads", async () => {
    const reader = createReader();
    reader.contract = {
        getMarketSummaries: async () => [{
            _address: MARKET,
            collateral: 1n,
            maxDebt: 2n,
            debt: 3n,
            positionHealth: 4n,
            cooldown: 5n,
            errorCodeHit: false,
        }],
    } as any;

    const data = await reader.getMarketSummaries([MARKET as any], ACCOUNT as any);

    assert.deepEqual(data, [{
        address: MARKET,
        collateral: 1n,
        maxDebt: 2n,
        debt: 3n,
        positionHealth: 4n,
        cooldown: 5n,
        errorCodeHit: false,
        priceStale: false,
    }]);
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
    assert.equal(data.userMarkets[0]?.errorCodeHit, false);
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
    assert.equal(data.userMarkets[0]?.errorCodeHit, true);
    assert.equal(data.userMarkets[0]?.priceStale, true);
    assert.equal(data.userMarkets[0]?.tokens[0]?.userAssetBalance, 6n);
});

test("getMarketSummaries surfaces contract errors when targeted refresh is unavailable", async () => {
    const reader = createReader();
    reader.contract = {
        getMarketSummaries: async () => {
            throw new Error("targeted refresh unavailable");
        },
    } as any;

    await assert.rejects(
        reader.getMarketSummaries([MARKET as any], ACCOUNT as any),
        /targeted refresh unavailable/,
    );
});

test("getMarketStates surfaces contract errors when targeted refresh is unavailable", async () => {
    const reader = createReader();
    reader.contract = {
        getMarketStates: async () => {
            throw new Error("targeted refresh unavailable");
        },
    } as any;
    reader.getDynamicMarketData = async () => {
        throw new Error("legacy fallback must stay dead");
    };
    reader.getUserData = async () => {
        throw new Error("legacy fallback must stay dead");
    };

    await assert.rejects(
        reader.getMarketStates([MARKET as any], ACCOUNT as any),
        /targeted refresh unavailable/,
    );
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

test("hypotheticalRedemptionOf preserves oracleError and the priceStale alias", async () => {
    const reader = createReader();

    reader.contract = {
        hypotheticalRedemptionOf: async () => [11n, 22n, true, true],
    } as any;

    const ctoken = { address: TOKEN } as any;
    const result = await reader.hypotheticalRedemptionOf(ACCOUNT as any, ctoken, 1_000n, 60n);

    assert.deepEqual(result, {
        excess: 11n,
        deficit: 22n,
        isPossible: true,
        oracleError: true,
        priceStale: true,
    });
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
            return [0n, 0n, true, false, false];
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

test("hypotheticalBorrowOf decodes loanSizeError separately from oracleError", async () => {
    const reader = createReader();

    reader.contract = {
        hypotheticalBorrowOf: async () => [11n, 22n, true, true, false],
    } as any;

    const ctoken = { address: TOKEN } as any;
    const result = await reader.hypotheticalBorrowOf(ACCOUNT as any, ctoken, 1_000n, 60n);

    assert.deepEqual(result, {
        excess: 11n,
        deficit: 22n,
        isPossible: true,
        loanSizeError: true,
        oracleError: false,
        priceStale: false,
    });
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
            return [0n, 0n, true, false, false];
        },
    } as any;

    const ctoken = { address: TOKEN } as any;
    await reader.hypotheticalBorrowOf(ACCOUNT as any, ctoken, 1_000n);

    assert.equal(captured.bufferTime, 0n, "default must remain 0n for backward compatibility");
});

test("hypotheticalLeverageOf preserves loanSizeError and oracleError flags", async () => {
    const reader = createReader();

    reader.contract = {
        hypotheticalLeverageOf: async () => [
            1_000_000_000_000_000_000n,
            1_500_000_000_000_000_000n,
            2_000_000_000_000_000_000n,
            4_000_000n,
            true,
            false,
        ],
    } as any;

    const depositToken = {
        address: TOKEN,
        asset: { decimals: 18 },
    } as any;
    const borrowToken = {
        address: TOKEN_B,
        asset: { decimals: 6 },
        decimals: 6,
    } as any;

    const result = await reader.hypotheticalLeverageOf(
        ACCOUNT as any,
        depositToken,
        borrowToken,
        Decimal(5),
    );

    assert.equal(result.currentLeverage.toString(), "1");
    assert.equal(result.adjustMaxLeverage.toString(), "1.5");
    assert.equal(result.maxLeverage.toString(), "2");
    assert.equal(result.maxDebtBorrowable.toString(), "4");
    assert.equal(result.loanSizeError, true);
    assert.equal(result.oracleError, false);
});

test("hypotheticalLiquidityOf forwards the market address and normalizes struct output", async () => {
    const reader = createReader();
    let captured: unknown[] | null = null;

    reader.contract = {
        hypotheticalLiquidityOf: async (...args: unknown[]) => {
            captured = args;
            return {
                result: {
                    collateral: 1n,
                    maxDebt: 2n,
                    debt: 3n,
                    collateralSurplus: 4n,
                    liquidityDeficit: 5n,
                    loanSizeError: true,
                    oracleError: false,
                },
            };
        },
    } as any;

    const result = await reader.hypotheticalLiquidityOf(
        MARKET as any,
        ACCOUNT as any,
        TOKEN as any,
        100n,
        200n,
        300n,
    );

    assert.deepEqual(captured, [
        MARKET,
        ACCOUNT,
        TOKEN,
        100n,
        200n,
        300n,
    ]);
    assert.deepEqual(result, {
        collateral: 1n,
        maxDebt: 2n,
        debt: 3n,
        collateralSurplus: 4n,
        liquidityDeficit: 5n,
        loanSizeError: true,
        oracleError: false,
    });
});

test("maxRedemptionOf forwards bufferTime to the contract call", async () => {
    const reader = createReader();
    let captured: { bufferTime: bigint | null } = { bufferTime: null };

    reader.contract = {
        maxRedemptionOf: async (
            _account: string,
            _ctoken: string,
            bufferTime: bigint,
        ) => {
            captured.bufferTime = bufferTime;
            return [777n, 222n, false];
        },
    } as any;

    const ctoken = { address: TOKEN } as any;
    const result = await reader.maxRedemptionOf(ACCOUNT as any, ctoken, 180n);

    assert.equal(captured.bufferTime, 180n);
    assert.equal(result.maxCollateralizedShares, 777n);
    assert.equal(result.maxUncollateralizedShares, 222n);
    assert.equal(result.errorCodeHit, false);
});

test("maxRedemptionOf defaults bufferTime to 0n when not provided", async () => {
    const reader = createReader();
    let captured: { bufferTime: bigint | null } = { bufferTime: null };

    reader.contract = {
        maxRedemptionOf: async (
            _account: string,
            _ctoken: string,
            bufferTime: bigint,
        ) => {
            captured.bufferTime = bufferTime;
            return [555n, 111n, false];
        },
    } as any;

    const ctoken = { address: TOKEN } as any;
    const result = await reader.maxRedemptionOf(ACCOUNT as any, ctoken);

    assert.equal(captured.bufferTime, 0n);
    assert.equal(result.maxCollateralizedShares, 555n);
    assert.equal(result.maxUncollateralizedShares, 111n);
    assert.equal(result.errorCodeHit, false);
});
