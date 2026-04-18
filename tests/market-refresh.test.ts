import assert from "node:assert/strict";
import test from "node:test";
import { Market } from "../src/classes/Market";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const MARKET_A = "0x00000000000000000000000000000000000000a1";
const MARKET_B = "0x00000000000000000000000000000000000000b2";

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

test("getActiveUserMarkets ignores wallet-only balances", () => {
    const activeDeposit = createMarket({ userAssetBalance: 1n });
    const activeDebt = createMarket({ userDebt: 2n });
    const walletOnly = createMarket({ userUnderlyingBalance: 99n });

    const active = Market.getActiveUserMarkets([activeDeposit, walletOnly, activeDebt]);

    assert.deepEqual(active, [activeDeposit, activeDebt]);
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
            priceStale: false,
            tokens: [{ address: TOKEN_A as any, userCollateral: 50n } as any],
        },
    );

    assert.equal((market.tokens[0] as any).cache.exchangeRate, 999n, "TOKEN_A dynamic overlay");
    assert.equal((market.tokens[0] as any).cache.userCollateral, 50n, "TOKEN_A user overlay");
    assert.equal((market.tokens[1] as any).cache.exchangeRate, 200n, "TOKEN_B dynamic preserved");
    assert.equal((market.tokens[1] as any).cache.userCollateral, 7n, "TOKEN_B user preserved");
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
