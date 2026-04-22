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
