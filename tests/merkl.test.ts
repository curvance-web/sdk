import assert from "node:assert/strict";
import test from "node:test";
import {
    fetchMerklCampaignsBySymbol,
    fetchMerklOpportunities,
    fetchMerklUserRewards,
    filterMerklOpportunitiesByChain,
} from "../src/integrations/merkl";
import type { MerklOpportunity } from "../src/integrations/merkl";
import {
    aggregateMerklAprByToken,
    getBorrowCost,
    getDepositApy,
    getMerklBorrowIncentives,
    getMerklDepositIncentives,
    getNativeYield,
} from "../src/helpers";
import Decimal from "decimal.js";

function assertDecimalString(actual: Decimal | undefined, expected: string, message: string) {
    assert.equal(actual?.toString(), expected, message);
}

function merklOpportunity(overrides: Partial<MerklOpportunity> & Pick<MerklOpportunity, "identifier">): MerklOpportunity {
    const { identifier, ...rest } = overrides;

    return {
        name: identifier,
        apr: 1,
        identifier,
        type: "lend",
        tokens: [],
        ...rest,
    };
}

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

test("fetchMerklOpportunities filters malformed successful rows before returning typed data", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            { name: "bad apr", apr: "12", identifier: "bad-apr", type: "lend", tokens: [] },
            { name: "bad tokens", apr: 1, identifier: "bad-tokens", type: "lend", tokens: {} },
            {
                name: "valid lend",
                apr: 12.5,
                action: "LEND",
                identifier: "valid-lend",
                type: "lend",
                tokens: [
                    { address: "0x00000000000000000000000000000000000000a1", symbol: "MON" },
                    { address: "0x00000000000000000000000000000000000000a2" },
                ],
                rewardsRecord: {
                    id: "record-a",
                    total: 3,
                    breakdowns: [
                        {
                            token: {
                                symbol: "MERKL",
                                address: "0x00000000000000000000000000000000000000b1",
                            },
                            amount: "1",
                        },
                        { token: {} },
                    ],
                },
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklOpportunities({ action: "LEND", chainId: 143 });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.identifier, "valid-lend");
    assert.deepEqual(rows[0]?.tokens, [{
        address: "0x00000000000000000000000000000000000000a1",
        symbol: "MON",
    }, {
        address: "0x00000000000000000000000000000000000000a2",
        symbol: "",
    }]);
    assert.equal(rows[0]?.rewardsRecord?.breakdowns?.length, 1);
});

test("fetchMerklOpportunities keeps chain-filtered rows without metadata and drops explicit wrong-chain rows", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            {
                name: "legacy lend",
                apr: 4,
                action: "LEND",
                identifier: "0x00000000000000000000000000000000000000a1",
                type: "lend",
                tokens: [],
            },
            {
                name: "monad lend",
                apr: 5,
                action: "LEND",
                identifier: "monad-lend",
                type: "lend",
                chain: { id: 143, name: "Monad" },
                tokens: [{ address: "0x00000000000000000000000000000000000000a2" }],
            },
            {
                name: "ethereum lend",
                apr: 6,
                action: "LEND",
                identifier: "ethereum-lend",
                type: "lend",
                computeChainId: 1,
                tokens: [{ address: "0x00000000000000000000000000000000000000a3" }],
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklOpportunities({ action: "LEND", chainId: 143 });

    assert.deepEqual(rows.map((row) => row.identifier), [
        "0x00000000000000000000000000000000000000a1",
        "monad-lend",
    ]);
    assert.equal(rows[1]?.chain?.id, 143);
});

test("filterMerklOpportunitiesByChain preserves metadata-less rows from already chain-scoped fetches", () => {
    const rows = filterMerklOpportunitiesByChain([
        {
            name: "legacy",
            apr: 1,
            identifier: "0x00000000000000000000000000000000000000a1",
            type: "lend",
            tokens: [],
        },
        {
            name: "wrong",
            apr: 1,
            identifier: "wrong",
            type: "lend",
            chainId: 1,
            tokens: [],
        },
    ], 143);

    assert.deepEqual(rows.map((row) => row.identifier), [
        "0x00000000000000000000000000000000000000a1",
    ]);
});

test("filterMerklOpportunitiesByChain uses explicit chain metadata in precedence order", () => {
    const rows = filterMerklOpportunitiesByChain([
        merklOpportunity({
            identifier: "chain-object-wins",
            chain: { id: 143, name: "Monad" },
            chainId: 1,
        }),
        merklOpportunity({
            identifier: "chain-id",
            chainId: 143,
            computeChainId: 1,
        }),
        merklOpportunity({
            identifier: "compute-chain-id",
            computeChainId: 143,
            distributionChainId: 1,
        }),
        merklOpportunity({
            identifier: "distribution-chain-id",
            distributionChainId: 143,
        }),
        merklOpportunity({
            identifier: "wrong-distribution-chain-id",
            distributionChainId: 1,
        }),
        merklOpportunity({
            identifier: "metadata-less",
        }),
    ], 143);

    assert.deepEqual(rows.map((row) => row.identifier), [
        "chain-object-wins",
        "chain-id",
        "compute-chain-id",
        "distribution-chain-id",
        "metadata-less",
    ]);
});

test("fetchMerklOpportunities does not apply chain filtering when no chainId is requested", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            {
                name: "monad lend",
                apr: 5,
                action: "LEND",
                identifier: "monad-lend",
                type: "lend",
                chain: { id: 143, name: "Monad" },
                tokens: [],
            },
            {
                name: "ethereum lend",
                apr: 6,
                action: "LEND",
                identifier: "ethereum-lend",
                type: "lend",
                chain: { id: 1, name: "Ethereum" },
                tokens: [],
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklOpportunities({ action: "LEND" });

    assert.deepEqual(rows.map((row) => row.identifier), ["monad-lend", "ethereum-lend"]);
});

test("fetchMerklOpportunities drops malformed explicit chain metadata before filtering", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            {
                name: "legacy lend",
                apr: 4,
                action: "LEND",
                identifier: "0x00000000000000000000000000000000000000a1",
                type: "lend",
                tokens: [],
            },
            {
                name: "bad chain lend",
                apr: 5,
                action: "LEND",
                identifier: "bad-chain-lend",
                type: "lend",
                chain: { id: "143", name: "Monad" },
                tokens: [],
            },
            {
                name: "monad lend",
                apr: 6,
                action: "LEND",
                identifier: "monad-lend",
                type: "lend",
                chainId: 143,
                computeChainId: 143,
                distributionChainId: 143,
                tokens: [],
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklOpportunities({ action: "LEND", chainId: 143 });

    assert.deepEqual(rows.map((row) => row.identifier), [
        "0x00000000000000000000000000000000000000a1",
        "monad-lend",
    ]);
    assert.equal(rows[1]?.chainId, 143);
    assert.equal(rows[1]?.computeChainId, 143);
    assert.equal(rows[1]?.distributionChainId, 143);
});

test("fetchMerklOpportunities preserves identifier-only borrow rows", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            {
                name: "borrow WMON",
                apr: 7,
                action: "BORROW",
                identifier: "0x00000000000000000000000000000000000000a1",
                type: "borrow",
                tokens: [],
            },
            {
                name: "borrow sparse WMON",
                apr: 3,
                action: "BORROW",
                identifier: "0x00000000000000000000000000000000000000a1",
                type: "borrow",
            },
            {
                name: "borrow malformed-token WMON",
                apr: 2,
                action: "BORROW",
                identifier: "0x00000000000000000000000000000000000000a1",
                type: "borrow",
                tokens: {},
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklOpportunities({ action: "BORROW", chainId: 143 });

    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0]?.tokens, []);
    assert.deepEqual(rows[1]?.tokens, []);
    assert.deepEqual(rows[2]?.tokens, []);
    assert.equal(getMerklBorrowIncentives("0x00000000000000000000000000000000000000a1", rows).toString(), "0.12");
});

test("fetchMerklUserRewards filters malformed successful rows before returning typed data", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            { chain: { id: "bad", name: "Broken" }, rewards: [] },
            {
                chain: { id: 143, name: "Monad" },
                rewards: [
                    {
                        distributionChainId: 143,
                        root: "0xroot",
                        recipient: "0xrecipient",
                        amount: "100",
                        claimed: "0",
                        token: {
                            symbol: "MON",
                            address: "0x0000000000000000000000000000000000000001",
                            chainId: 143,
                            decimals: 18,
                        },
                        breakdowns: [
                            { campaignId: "campaign-a", amount: "100", claimed: "0" },
                            { campaignId: 123, amount: "100", claimed: "0" },
                        ],
                    },
                    {
                        distributionChainId: 143,
                        root: "0xroot",
                        recipient: "0xrecipient",
                        amount: "100",
                        claimed: "0",
                        token: { symbol: "MON" },
                    },
                ],
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklUserRewards({
        wallet: "0x00000000000000000000000000000000000000aa",
        chainId: 143,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.chain.id, 143);
    assert.equal(rows[0]?.rewards.length, 1);
    assert.equal(rows[0]?.rewards[0]?.breakdowns?.length, 1);
});

test("fetchMerklUserRewards drops mixed-chain reward groups from successful responses", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            {
                chain: { id: 143, name: "Monad" },
                rewards: [],
            },
            {
                chain: { id: 1, name: "Ethereum" },
                rewards: [],
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklUserRewards({
        wallet: "0x00000000000000000000000000000000000000aa",
        chainId: 143,
    });

    assert.deepEqual(rows.map((row) => row.chain.id), [143]);
});

test("fetchMerklUserRewards normalizes reward rows before strict chain filtering", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            {
                chain: { id: 1, name: "Ethereum" },
                rewards: [
                    {
                        distributionChainId: 1,
                        root: "0xethroot",
                        recipient: "0xrecipient",
                        amount: "100",
                        claimed: "0",
                        token: {
                            symbol: "ETH",
                            address: "0x0000000000000000000000000000000000000001",
                            chainId: 1,
                            decimals: 18,
                        },
                    },
                ],
            },
            {
                chain: { id: 143, name: "Monad" },
                rewards: [
                    {
                        distributionChainId: 143,
                        root: "0xmonadroot",
                        recipient: "0xrecipient",
                        amount: "200",
                        claimed: "25",
                        token: {
                            symbol: "MON",
                            address: "0x0000000000000000000000000000000000000002",
                            chainId: 143,
                            decimals: 18,
                        },
                    },
                    {
                        distributionChainId: 143,
                        root: "0xbadroot",
                        recipient: "0xrecipient",
                        amount: "300",
                        claimed: "0",
                        token: { symbol: "BROKEN" },
                    },
                ],
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const rows = await fetchMerklUserRewards({
        wallet: "0x00000000000000000000000000000000000000aa",
        chainId: 143,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.chain.name, "Monad");
    assert.equal(rows[0]?.rewards.length, 1);
    assert.equal(rows[0]?.rewards[0]?.root, "0xmonadroot");
});

test("fetchMerklUserRewards degrades malformed successful bodies to no rewards", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ rewards: [] }),
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    assert.deepEqual(await fetchMerklUserRewards({
        wallet: "0x00000000000000000000000000000000000000aa",
        chainId: 143,
    }), []);
});

test("fetchMerklCampaignsBySymbol filters malformed successful campaign rows", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
            {
                id: "campaign-a",
                campaignId: "campaign-a",
                computeChainId: 143,
                distributionChainId: 143,
                chain: { id: 143, name: "Monad" },
                rewardToken: {
                    symbol: "MON",
                    address: "0x0000000000000000000000000000000000000001",
                    chainId: 143,
                    decimals: 18,
                },
            },
            {
                id: "campaign-b",
                campaignId: "campaign-b",
                computeChainId: 143,
                distributionChainId: 143,
                chain: { id: 143, name: "Monad" },
                rewardToken: { symbol: "MON" },
            },
            {
                id: "campaign-c",
                campaignId: "campaign-c",
                computeChainId: 143,
                distributionChainId: 143,
                chain: { id: 143, name: "Monad" },
                distributionChain: { id: "bad", name: "Broken" },
                rewardToken: {
                    symbol: "MON",
                    address: "0x0000000000000000000000000000000000000001",
                    chainId: 143,
                    decimals: 18,
                },
            },
        ],
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const campaigns = await fetchMerklCampaignsBySymbol({ tokenSymbol: "MON" });

    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0]?.id, "campaign-a");
});

test("fetchMerklCampaignsBySymbol degrades malformed successful bodies to no campaigns", async (t) => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ campaigns: [] }),
    } as Response)) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    assert.deepEqual(await fetchMerklCampaignsBySymbol({ tokenSymbol: "MON" }), []);
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
    assertDecimalString(apyByToken.get(WMON.toLowerCase()), "0.25", "WMON deposit APY should sum duplicate campaigns");
    assertDecimalString(apyByToken.get(AUSD.toLowerCase()), "0.25", "AUSD deposit APY should sum duplicate campaigns");
});

test("aggregateMerklAprByToken composes with chain-filtered Merkl opportunities", () => {
    const WMON = "0x00000000000000000000000000000000000000a1";

    const filtered = filterMerklOpportunitiesByChain([
        merklOpportunity({
            identifier: "monad-lend",
            apr: 10,
            chain: { id: 143, name: "Monad" },
            tokens: [{ address: WMON, symbol: "WMON" }],
        }),
        merklOpportunity({
            identifier: "legacy-lend",
            apr: 5,
            tokens: [{ address: WMON, symbol: "WMON" }],
        }),
        merklOpportunity({
            identifier: "ethereum-lend",
            apr: 100,
            chainId: 1,
            tokens: [{ address: WMON, symbol: "WMON" }],
        }),
    ], 143);

    const apyByToken = aggregateMerklAprByToken(filtered, "deposit");

    assert.deepEqual(filtered.map((row) => row.identifier), ["monad-lend", "legacy-lend"]);
    assertDecimalString(apyByToken.get(WMON.toLowerCase()), "0.15", "wrong-chain APY should not be counted");
    assert.equal(getMerklDepositIncentives(WMON, filtered).toString(), "0.15");
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
    assertDecimalString(apyByToken.get(WMON.toLowerCase()), "0.1", "malformed rows should be skipped while valid WMON APY remains");
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
    assertDecimalString(apyByToken.get(WMON.toLowerCase()), "0.07", "borrow APY should fall back to identifier when token membership is malformed");
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

    assert.equal(getMerklDepositIncentives(WMON, lendOpps).toString(), "0.15");
    assert.equal(getMerklDepositIncentives(USDC, lendOpps).toString(), "0.1");
    assert.equal(getMerklBorrowIncentives(WMON, borrowOpps).toString(), "0.1");

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

    assert.equal(getDepositApy(depositToken, lendOpps).toString(), "0.17");
    assert.equal(getBorrowCost(borrowToken, borrowOpps).toString(), "0.02");
});

test("APY helpers read current nativeApy from real SDK-shaped tokens", () => {
    const token = {
        nativeApy: new Decimal("0.04"),
        getApy: () => new Decimal("0.02"),
        asset: { symbol: "WMON" },
        address: "0x00000000000000000000000000000000000000a1",
    };

    assert.equal(getNativeYield(token).toString(), "0.04");
    assert.equal(getDepositApy(token, []).toString(), "0.04");
});

test("APY helpers fall back to interest plus overrides when nativeApy is absent", () => {
    const token = {
        getApy: () => new Decimal("0.02"),
        asset: { symbol: "WMON" },
        address: "0x00000000000000000000000000000000000000a1",
    };

    assert.equal(getNativeYield(token, { wmon: { value: 0.03 } }).toString(), "0.03");
    assert.equal(getDepositApy(token, [], { wmon: { value: 0.03 } }).toString(), "0.05");
});
