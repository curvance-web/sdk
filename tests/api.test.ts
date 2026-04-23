import assert from "node:assert/strict";
import test from "node:test";
import { Api } from "../src/classes/Api";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("Api.getRewards degrades to empty rewards when a 200 response has the wrong shape", async () => {
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ broken: true }),
    })) as unknown as typeof fetch;

    const rewards = await Api.getRewards({
        chain: "monad-mainnet",
        api_url: "https://api.curvance.test",
    } as any);

    assert.deepEqual(rewards, {
        milestones: {},
        incentives: {},
    });
});

test("Api.getRewards normalizes reward market keys case-insensitively", async () => {
    const market = "0x00000000000000000000000000000000000000AA";
    const normalizedMarket = market.toLowerCase();
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            milestones: [{
                market,
                tvl: 1,
                multiplier: 2,
                fail_multiplier: 3,
                chain_network: "monad-mainnet",
                start_date: "2026-01-01",
                end_date: "2026-01-02",
                duration_in_days: 1,
            }],
            incentives: [{
                market,
                type: "supply",
                rate: 4,
                description: "reward",
                image: "stars-rewards",
            }],
        }),
    })) as unknown as typeof fetch;

    const rewards = await Api.getRewards({
        chain: "monad-mainnet",
        api_url: "https://api.curvance.test",
    } as any);

    assert.equal(rewards.milestones[normalizedMarket]?.market, market);
    assert.equal(rewards.milestones[market], undefined);
    assert.equal(rewards.incentives[normalizedMarket]?.[0]?.market, market);
    assert.equal(rewards.incentives[market], undefined);
});

test("Api.getRewards filters malformed reward rows from successful responses", async () => {
    const market = "0x00000000000000000000000000000000000000AA";
    const normalizedMarket = market.toLowerCase();
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            milestones: [
                {},
                {
                    market,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 3,
                    chain_network: "monad-mainnet",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                },
            ],
            incentives: [
                { market },
                {
                    market,
                    type: "supply",
                    rate: 4,
                    description: "reward",
                    image: "stars-rewards",
                },
            ],
        }),
    })) as unknown as typeof fetch;

    const rewards = await Api.getRewards({
        chain: "monad-mainnet",
        api_url: "https://api.curvance.test",
    } as any);

    assert.deepEqual(Object.keys(rewards.milestones), [normalizedMarket]);
    assert.equal(rewards.incentives[normalizedMarket]?.length, 1);
    assert.equal(rewards.incentives[normalizedMarket]?.[0]?.image, "stars-rewards");
});

test("Api.fetchNativeYields filters malformed rows from successful responses", async () => {
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            native_apy: [
                { symbol: "WMON", apy: 4.25 },
                { symbol: null, apy: 2 },
                { symbol: "BROKEN", apy: "5" },
            ],
        }),
    })) as unknown as typeof fetch;

    const yields = await Api.fetchNativeYields({
        chain: "monad-mainnet",
        api_url: "https://api.curvance.test",
    } as any);

    assert.deepEqual(yields, [{ symbol: "WMON", apy: 4.25 }]);
});
