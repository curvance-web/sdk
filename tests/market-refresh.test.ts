import assert from "node:assert/strict";
import test from "node:test";
import { Market } from "../src/classes/Market";
import { CToken } from "../src/classes/CToken";
import { ProtocolReader } from "../src/classes/ProtocolReader";
import { refreshActiveUserMarkets, refreshActiveUserMarketSummaries } from "../src/setup";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const MARKET_A = "0x00000000000000000000000000000000000000a1";
const MARKET_B = "0x00000000000000000000000000000000000000b2";
const TOKEN_A = "0x00000000000000000000000000000000000000d1";
const TOKEN_B = "0x00000000000000000000000000000000000000d2";
const WAD = 10n ** 18n;

function createMarket(tokenCache: Partial<{
    userAssetBalance: bigint;
    userShareBalance: bigint;
    userUnderlyingBalance: bigint;
    userCollateral: bigint;
    userDebt: bigint;
}> = {}) {
    const market = Object.create(Market.prototype) as Market;
    market.tokens = [{
        cache: {
            userAssetBalance: 0n,
            userShareBalance: 0n,
            userUnderlyingBalance: 0n,
            userCollateral: 0n,
            userDebt: 0n,
            ...tokenCache,
        },
    }] as any;
    return market;
}

function createUserRefreshMarket() {
    const market = Object.create(Market.prototype) as Market;
    market.address = MARKET_A as any;
    market.cache = {
        static: {} as any,
        dynamic: { address: MARKET_A as any, tokens: [] },
        user: {
            address: MARKET_A as any,
            collateral: 1n,
            maxDebt: 2n,
            debt: 3n,
            positionHealth: 4n,
            cooldown: 5n,
            errorCodeHit: false,
            priceStale: false,
            tokens: [],
        },
        deploy: {} as any,
    };

    const token = Object.create(CToken.prototype) as CToken;
    token.address = TOKEN_A as any;
    token.market = market;
    token.cache = {
        address: TOKEN_A as any,
        decimals: 18n,
        asset: {
            address: TOKEN_A as any,
            decimals: 18n,
        },
        userAssetBalance: 10n * WAD,
        userShareBalance: 11n * WAD,
        userUnderlyingBalance: 12n * WAD,
        userCollateral: 13n * WAD,
        userDebt: 14n * WAD,
        liquidationPrice: 15n * WAD,
    } as any;

    market.tokens = [token] as any;

    return { market, token };
}

function createRefreshHelperMarket(address: string, tokenAddress: string, reader: any) {
    const market = Object.create(Market.prototype) as Market;
    market.address = address as any;
    market.account = null;
    market.reader = reader;
    market.cache = {
        static: {} as any,
        dynamic: { address: address as any, tokens: [] },
        user: {
            address: address as any,
            collateral: 0n,
            maxDebt: 0n,
            debt: 0n,
            positionHealth: 0n,
            cooldown: 0n,
            errorCodeHit: false,
            priceStale: false,
            tokens: [],
        },
        deploy: {} as any,
    };

    const token = Object.create(CToken.prototype) as CToken;
    token.address = tokenAddress as any;
    token.market = market;
    token.cache = {
        address: tokenAddress as any,
        decimals: 18n,
        asset: {
            address: tokenAddress as any,
            decimals: 18n,
        },
        userAssetBalance: 0n,
        userShareBalance: 0n,
        userUnderlyingBalance: 0n,
        userCollateral: 0n,
        userDebt: 0n,
        liquidationPrice: 0n,
    } as any;
    market.tokens = [token] as any;

    return market;
}

test("getActiveUserMarkets ignores wallet-only balances", () => {
    const activeDeposit = createMarket({ userAssetBalance: 1n });
    const activeDebt = createMarket({ userDebt: 2n });
    const walletOnly = createMarket({ userUnderlyingBalance: 99n });

    const active = Market.getActiveUserMarkets([activeDeposit, walletOnly, activeDebt]);

    assert.deepEqual(active, [activeDeposit, activeDebt]);
});

test("refreshActiveUserMarkets refreshes the requested account before filtering activity", async () => {
    const calls: Array<{ addresses: string[]; account: string }> = [];
    const reader = {
        getMarketStates: async (addresses: string[], account: string) => {
            calls.push({ addresses, account });
            return {
                dynamicMarkets: [
                    { address: MARKET_A, tokens: [] },
                    { address: MARKET_B, tokens: [] },
                ],
                userMarkets: [
                    {
                        address: MARKET_A,
                        collateral: 0n,
                        maxDebt: 0n,
                        debt: 0n,
                        positionHealth: 0n,
                        cooldown: 0n,
                        errorCodeHit: false,
                        priceStale: false,
                        tokens: [{
                            address: TOKEN_A as any,
                            userAssetBalance: 1n,
                            userShareBalance: 0n,
                            userUnderlyingBalance: 0n,
                            userCollateral: 0n,
                            userDebt: 0n,
                            liquidationPrice: 0n,
                        }],
                    },
                    {
                        address: MARKET_B,
                        collateral: 0n,
                        maxDebt: 0n,
                        debt: 0n,
                        positionHealth: 0n,
                        cooldown: 0n,
                        errorCodeHit: false,
                        priceStale: false,
                        tokens: [{
                            address: TOKEN_B as any,
                            userAssetBalance: 0n,
                            userShareBalance: 0n,
                            userUnderlyingBalance: 0n,
                            userCollateral: 0n,
                            userDebt: 0n,
                            liquidationPrice: 0n,
                        }],
                    },
                ],
            };
        },
    };
    const marketA = createRefreshHelperMarket(MARKET_A, TOKEN_A, reader);
    const marketB = createRefreshHelperMarket(MARKET_B, TOKEN_B, reader);

    const refreshed = await refreshActiveUserMarkets(ACCOUNT as any, [marketA, marketB]);

    assert.deepEqual(calls, [{
        addresses: [MARKET_A, MARKET_B],
        account: ACCOUNT,
    }]);
    assert.deepEqual(refreshed, [marketA]);
    assert.equal(marketA.account, ACCOUNT);
    assert.equal(marketB.account, ACCOUNT);
});

test("refreshActiveUserMarketSummaries does not prefilter from stale full-token activity", async () => {
    const calls: Array<{ addresses: string[]; account: string }> = [];
    const reader = {
        getMarketSummaries: async (addresses: string[], account: string) => {
            calls.push({ addresses, account });
            return addresses.map((address) => ({
                address,
                collateral: 0n,
                maxDebt: 0n,
                debt: 0n,
                positionHealth: 0n,
                cooldown: 0n,
                errorCodeHit: false,
                priceStale: false,
            }));
        },
    };
    const marketA = createRefreshHelperMarket(MARKET_A, TOKEN_A, reader);
    const marketB = createRefreshHelperMarket(MARKET_B, TOKEN_B, reader);

    const refreshed = await refreshActiveUserMarketSummaries(ACCOUNT as any, [marketA, marketB]);

    assert.deepEqual(calls, [{
        addresses: [MARKET_A, MARKET_B],
        account: ACCOUNT,
    }]);
    assert.deepEqual(refreshed, [marketA, marketB]);
    assert.equal(marketA.account, ACCOUNT);
    assert.equal(marketA.userDataScope, "summary");
    assert.equal(marketB.account, ACCOUNT);
    assert.equal(marketB.userDataScope, "summary");
});

test("reloadUserMarkets batches addresses and applies responses by address", async () => {
    const calls: Array<{ addresses: string[]; account: string }> = [];
    const applied: Array<{ market: string; dynamic: string; user: string }> = [];

    const reader = {
        getMarketStates: async (addresses: string[], account: string) => {
            calls.push({ addresses, account });
            return {
                dynamicMarkets: [
                    { address: MARKET_B },
                    { address: MARKET_A },
                ],
                userMarkets: [
                    { address: MARKET_B },
                    { address: MARKET_A },
                ],
            };
        },
    } as any;

    const marketA = Object.create(Market.prototype) as Market;
    marketA.address = MARKET_A as any;
    marketA.reader = reader;
    marketA.applyState = ((dynamic: { address: string }, user: { address: string }) => {
        applied.push({ market: MARKET_A, dynamic: dynamic.address, user: user.address });
    }) as any;

    const marketB = Object.create(Market.prototype) as Market;
    marketB.address = MARKET_B as any;
    marketB.reader = reader;
    marketB.applyState = ((dynamic: { address: string }, user: { address: string }) => {
        applied.push({ market: MARKET_B, dynamic: dynamic.address, user: user.address });
    }) as any;

    const refreshed = await Market.reloadUserMarkets([marketA, marketB], ACCOUNT as any);

    assert.equal(refreshed.length, 2);
    assert.deepEqual(calls, [{
        addresses: [MARKET_A, MARKET_B],
        account: ACCOUNT,
    }]);
    assert.deepEqual(applied, [
        { market: MARKET_A, dynamic: MARKET_A, user: MARKET_A },
        { market: MARKET_B, dynamic: MARKET_B, user: MARKET_B },
    ]);
    assert.equal(marketA.account, ACCOUNT);
    assert.equal(marketB.account, ACCOUNT);
});

test("reloadUserData binds the refreshed account for downstream helpers", async () => {
    const { market } = createUserRefreshMarket();

    market.account = null;
    market.reader = {
        getMarketStates: async () => ({
            dynamicMarkets: [{ address: MARKET_A, tokens: [] }],
            userMarkets: [{
                address: MARKET_A,
                collateral: 31n,
                maxDebt: 32n,
                debt: 33n,
                positionHealth: 34n,
                cooldown: 35n,
                errorCodeHit: false,
                priceStale: false,
                tokens: [{
                    address: TOKEN_A as any,
                    userAssetBalance: 20n * WAD,
                    userShareBalance: 21n * WAD,
                    userUnderlyingBalance: 22n * WAD,
                    userCollateral: 23n * WAD,
                    userDebt: 24n * WAD,
                    liquidationPrice: 25n * WAD,
                }],
            }],
        }),
    } as any;

    await market.reloadUserData(ACCOUNT as any);

    assert.equal(market.account, ACCOUNT);
});

test("reloadUserSummary binds the refreshed account for downstream helpers", async () => {
    const { market } = createUserRefreshMarket();

    market.account = null;
    market.reader = {
        getMarketSummaries: async () => ([{
            address: MARKET_A,
            collateral: 31n,
            maxDebt: 32n,
            debt: 33n,
            positionHealth: 34n,
            cooldown: 35n,
            errorCodeHit: false,
            priceStale: false,
        }]),
    } as any;

    await market.reloadUserSummary(ACCOUNT as any);

    assert.equal(market.account, ACCOUNT);
    assert.equal(market.userDataScope, "summary");
});

test("reloadUserMarkets keeps same-chain readers with different providers separate", async () => {
    const calls: string[] = [];

    const readerA = new ProtocolReader(MARKET_A as any, { label: "provider-a" } as any, "monad-mainnet");
    readerA.getMarketStates = (async () => {
        calls.push("A");
        return {
            dynamicMarkets: [{ address: MARKET_A }],
            userMarkets: [{ address: MARKET_A }],
        };
    }) as any;

    const readerB = new ProtocolReader(MARKET_A as any, { label: "provider-b" } as any, "monad-mainnet");
    readerB.getMarketStates = (async () => {
        calls.push("B");
        return {
            dynamicMarkets: [{ address: MARKET_B }],
            userMarkets: [{ address: MARKET_B }],
        };
    }) as any;

    const marketA = Object.create(Market.prototype) as Market;
    marketA.address = MARKET_A as any;
    marketA.reader = readerA as any;
    marketA.applyState = (() => undefined) as any;

    const marketB = Object.create(Market.prototype) as Market;
    marketB.address = MARKET_B as any;
    marketB.reader = readerB as any;
    marketB.applyState = (() => undefined) as any;

    await Market.reloadUserMarkets([marketA, marketB], ACCOUNT as any);

    assert.notEqual(readerA.batchKey, readerB.batchKey);
    assert.deepEqual(calls, ["A", "B"]);
});

test("applyState preserves prior token cache when dynamic data omits a token", () => {
    // Regression guard: applyState merges new cache fields via object spread,
    // so a token absent from `dynamicData.tokens` (or `userData.tokens`) keeps
    // its prior cache intact rather than being zeroed. Consumers rely on this
    // for "partial refresh" scenarios.
    const TOKEN_A = "0x000000000000000000000000000000000000000a";
    const TOKEN_B = "0x000000000000000000000000000000000000000b";

    const market = Object.create(Market.prototype) as Market;
    market.address = MARKET_A as any;
    market.cache = {
        static: {} as any,
        dynamic: { address: MARKET_A as any, tokens: [] },
        user: {
            address: MARKET_A as any,
            collateral: 0n,
            maxDebt: 0n,
            debt: 0n,
            positionHealth: 0n,
            cooldown: 0n,
            errorCodeHit: false,
            priceStale: false,
            tokens: [],
        },
        deploy: {} as any,
    };
    market.tokens = [
        { address: TOKEN_A, cache: { exchangeRate: 100n, userCollateral: 5n } },
        { address: TOKEN_B, cache: { exchangeRate: 200n, userCollateral: 7n } },
    ] as any;

    // Dynamic response only returns TOKEN_A. TOKEN_B must retain its prior cache.
    market.applyState(
        {
            address: MARKET_A as any,
            tokens: [{ address: TOKEN_A as any, exchangeRate: 999n } as any],
        },
        {
            address: MARKET_A as any,
            collateral: 0n,
            maxDebt: 0n,
            debt: 0n,
            positionHealth: 0n,
            cooldown: 0n,
            errorCodeHit: false,
            priceStale: false,
            tokens: [{ address: TOKEN_A as any, userCollateral: 50n } as any],
        },
    );

    assert.equal((market.tokens[0] as any).cache.exchangeRate, 999n, "TOKEN_A dynamic overlay");
    assert.equal((market.tokens[0] as any).cache.userCollateral, 50n, "TOKEN_A user overlay");
    assert.equal((market.tokens[1] as any).cache.exchangeRate, 200n, "TOKEN_B dynamic preserved");
    assert.equal((market.tokens[1] as any).cache.userCollateral, 7n, "TOKEN_B user preserved");
});

test("summary-only user refresh invalidates token user getters until a full user refresh arrives", () => {
    const { market, token } = createUserRefreshMarket();

    market.applyUserSummary({
        address: MARKET_A as any,
        collateral: 21n,
        maxDebt: 22n,
        debt: 23n,
        positionHealth: 24n,
        cooldown: 25n,
        errorCodeHit: false,
        priceStale: false,
    });

    assert.equal(market.userDataScope, "summary");
    assert.throws(
        () => token.getUserCollateral(false),
        /summary-only refresh on market/i,
    );
    assert.throws(
        () => token.getUserDebt(false),
        /Call market\.reloadUserData\(account\) or Market\.reloadUserMarkets/i,
    );

    market.applyState(
        {
            address: MARKET_A as any,
            tokens: [],
        },
        {
            address: MARKET_A as any,
            collateral: 31n,
            maxDebt: 32n,
            debt: 33n,
            positionHealth: 34n,
            cooldown: 35n,
            errorCodeHit: false,
            priceStale: false,
            tokens: [{
                address: TOKEN_A as any,
                userAssetBalance: 20n * WAD,
                userShareBalance: 21n * WAD,
                userUnderlyingBalance: 22n * WAD,
                userCollateral: 23n * WAD,
                userDebt: 24n * WAD,
                liquidationPrice: 25n * WAD,
            } as any],
        } as any,
    );

    assert.equal(market.userDataScope, "full");
    assert.equal(token.getUserCollateral(false).toString(), "23");
    assert.equal(token.getUserDebt(false).toString(), "24");
    assert.equal(token.liquidationPrice?.toString(), "25");
});

test("summary-only user refresh rejects market-level getters that depend on token user cache", () => {
    const market = createMarket({ userAssetBalance: 1n, userDebt: 2n });
    market.address = MARKET_A as any;
    market.cache = {
        static: {} as any,
        dynamic: {} as any,
        user: {
            address: MARKET_A as any,
            collateral: 11n,
            maxDebt: 12n,
            debt: 13n,
            positionHealth: 14n,
            cooldown: 15n,
            errorCodeHit: false,
            priceStale: false,
            tokens: [],
        },
        deploy: {} as any,
    };

    market.applyUserSummary({
        address: MARKET_A as any,
        collateral: 21n,
        maxDebt: 22n,
        debt: 23n,
        positionHealth: 24n,
        cooldown: 25n,
        errorCodeHit: false,
        priceStale: false,
    });

    assert.throws(() => market.userDeposits, /summary-only refresh/i);
    assert.throws(() => market.userNet, /summary-only refresh/i);
    assert.throws(() => market.getBorrowableCTokens(), /summary-only refresh/i);
    assert.throws(() => market.getUserDepositsChange("day"), /summary-only refresh/i);
    assert.throws(() => market.getUserDebtChange("day"), /summary-only refresh/i);
    assert.throws(() => market.getUserNetChange("day"), /summary-only refresh/i);
});

test("summary-only user refresh fail-closes user-activity helpers", () => {
    const market = createMarket({ userAssetBalance: 1n, userDebt: 2n });
    market.address = MARKET_A as any;
    Object.defineProperty(market, "userDataScope", {
        value: "summary",
        configurable: true,
    });

    assert.throws(() => market.hasUserActivity(), /summary-only refresh/i);
    assert.throws(() => Market.getActiveUserMarkets([market]), /summary-only refresh/i);
});

test("getSnapshots runs token queries concurrently and preserves order", async () => {
    // Sequential awaits inside a for-loop serialize N independent RPC calls.
    // Each ctoken.getSnapshot is an independent view call with no dependency
    // on sibling tokens; we can (and must) dispatch them in parallel.
    let active = 0;
    let maxActive = 0;
    const makeStubToken = (label: string) => ({
        getSnapshot: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 15));
            active -= 1;
            return { label } as any;
        },
    });

    const market = Object.create(Market.prototype) as Market;
    market.tokens = [
        makeStubToken("a"),
        makeStubToken("b"),
        makeStubToken("c"),
    ] as any;

    const snapshots = await market.getSnapshots(ACCOUNT as any);

    assert.equal(snapshots.length, 3, "one snapshot per token");
    assert.deepEqual(
        snapshots.map((snap: any) => snap.label),
        ["a", "b", "c"],
        "snapshots must preserve tokens[] ordering",
    );
    assert.ok(
        maxActive > 1,
        `expected concurrent dispatch, observed maxActive=${maxActive}`,
    );
});
