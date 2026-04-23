import assert from "node:assert/strict";
import test from "node:test";
import { fetchMerklOpportunities } from "../src/integrations/merkl";
import {
    aggregateMerklAprByToken,
    getBorrowCost,
    getDepositApy,
    getMerklBorrowIncentives,
    getMerklDepositIncentives,
    getNativeYield,
} from "../src/helpers";
import Decimal from "decimal.js";

test("fetchMerklOpportunities forwards action and chainId in the request URL", async (t) => {
    const originalFetch = globalThis.fetch;
    let requestedUrl: string | null = null;

    globalThis.fetch = (async (input: string | URL | Request) => {
        requestedUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;

        return {
            ok: true,
            json: async () => [],
        } as Response;
    }) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await fetchMerklOpportunities({ action: "LEND", chainId: 421614 });

    assert.notEqual(requestedUrl, null);
    const url = new URL(requestedUrl!);
    assert.equal(url.searchParams.get("mainProtocolId"), "curvance");
    assert.equal(url.searchParams.get("action"), "LEND");
    assert.equal(url.searchParams.get("chainId"), "421614");
});

test("fetchMerklOpportunities degrades malformed successful responses to no opportunities", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ broken: true }),
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    assert.deepEqual(await fetchMerklOpportunities({ action: "LEND", chainId: 143 }), []);
});

test("aggregateMerklAprByToken rolls duplicate lend opportunities up by token membership", () => {
    const WMON = "0x00000000000000000000000000000000000000a1";
    const AUSD = "0x00000000000000000000000000000000000000a2";

    const apyByToken = aggregateMerklAprByToken([
        {
            identifier: "lend-campaign-1",
            apr: 10,
            tokens: [{ address: WMON }],
        },
        {
            identifier: "lend-campaign-2",
            apr: 15,
            tokens: [{ address: WMON }],
        },
        {
            identifier: "lend-campaign-3",
            apr: 20,
            tokens: [{ address: AUSD }],
        },
        {
            identifier: "lend-campaign-4",
            apr: 5,
            tokens: [{ address: AUSD }],
        },
    ], "deposit");

    assert.equal(apyByToken.size, 2);
    assert.ok(apyByToken.get(WMON.toLowerCase())?.eq(new Decimal(0.25)));
    assert.ok(apyByToken.get(AUSD.toLowerCase())?.eq(new Decimal(0.25)));
});

test("aggregateMerklAprByToken skips malformed rows instead of throwing during boot enrichment", () => {
    const WMON = "0x00000000000000000000000000000000000000a1";

    const apyByToken = aggregateMerklAprByToken([
        null,
        { tokens: {} },
        { identifier: WMON, apr: "not-a-number", tokens: [] },
        {
            identifier: "lend-campaign-1",
            apr: 10,
            tokens: [{ address: WMON }, null, { address: null }],
        },
    ] as any, "deposit");

    assert.equal(apyByToken.size, 1);
    assert.ok(apyByToken.get(WMON.toLowerCase())?.eq(new Decimal(0.10)));
});

test("aggregateMerklAprByToken falls back to identifier when token membership is malformed", () => {
    const WMON = "0x00000000000000000000000000000000000000a1";

    const apyByToken = aggregateMerklAprByToken([
        {
            identifier: WMON,
            apr: 7,
            tokens: {},
        },
    ] as any, "borrow");

    assert.equal(apyByToken.size, 1);
    assert.ok(apyByToken.get(WMON.toLowerCase())?.eq(new Decimal(0.07)));
});

test("Merkl helper APYs match the shared rollup semantics used by market hydration", () => {
    const WMON = "0x00000000000000000000000000000000000000a1";
    const USDC = "0x00000000000000000000000000000000000000a2";
    const lendOpps = [
        {
            identifier: "0xlend-one",
            apr: 10,
            tokens: [{ address: WMON }, { address: USDC }],
        },
        {
            identifier: "0xlend-two",
            apr: 5,
            tokens: [{ address: WMON }],
        },
    ];
    const borrowOpps = [
        {
            identifier: WMON,
            apr: 7,
            tokens: [],
        },
        {
            identifier: WMON.toUpperCase(),
            apr: 3,
            tokens: [{ address: USDC }],
        },
    ];

    assert.ok(getMerklDepositIncentives(WMON, lendOpps).eq(new Decimal(0.15)));
    assert.ok(getMerklDepositIncentives(USDC, lendOpps).eq(new Decimal(0.10)));
    assert.ok(getMerklBorrowIncentives(WMON, borrowOpps).eq(new Decimal(0.10)));

    const depositToken = {
        nativeYield: 0,
        getApy: () => new Decimal(0.02),
        asset: { symbol: "WMON" },
        address: WMON,
    };
    const borrowToken = {
        getBorrowRate: (_inPercentage: true) => new Decimal(0.12),
        address: WMON,
    };

    assert.ok(getDepositApy(depositToken, lendOpps).eq(new Decimal(0.17)));
    assert.ok(getBorrowCost(borrowToken, borrowOpps).eq(new Decimal(0.02)));
});

test("APY helpers read current nativeApy from real SDK-shaped tokens", () => {
    const token = {
        nativeApy: new Decimal("0.04"),
        getApy: () => new Decimal("0.02"),
        asset: { symbol: "WMON" },
        address: "0x00000000000000000000000000000000000000a1",
    };

    assert.ok(getNativeYield(token).eq(new Decimal("0.04")));
    assert.ok(getDepositApy(token, []).eq(new Decimal("0.04")));
});

test("APY helpers fall back to interest plus overrides when nativeApy is absent", () => {
    const token = {
        getApy: () => new Decimal("0.02"),
        asset: { symbol: "WMON" },
        address: "0x00000000000000000000000000000000000000a1",
    };

    assert.ok(getNativeYield(token, { wmon: { value: 0.03 } }).eq(new Decimal("0.03")));
    assert.ok(getDepositApy(token, [], { wmon: { value: 0.03 } }).eq(new Decimal("0.05")));
});
