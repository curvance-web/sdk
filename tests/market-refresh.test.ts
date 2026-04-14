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
