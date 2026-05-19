import assert from "node:assert/strict";
import test from "node:test";
import { Api } from "../src/classes/Api";
import { chain_config } from "../src/chains";
import type { ChainRpcPrefix } from "../src/helpers";

const originalFetch = globalThis.fetch;
const API_URL = "https://api.curvance.test";

function createApiConfig(chain: ChainRpcPrefix = "monad-mainnet") {
    return {
        chain,
        chainId: chain_config[chain].chainId,
        services: chain_config[chain].services,
        api_url: API_URL,
    } as any;
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("Api.getRewards degrades to empty rewards when a 200 response has the wrong shape", async () => {
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ broken: true }),
    })) as unknown as typeof fetch;

    const rewards = await Api.getRewards(createApiConfig());

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

    const rewards = await Api.getRewards(createApiConfig());

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
                    tvl: -1,
                    multiplier: 2,
                    fail_multiplier: 3,
                    chain_network: "monad-mainnet",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                },
                {
                    market,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 3,
                    chain_network: "monad-mainnet",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 0,
                },
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
                    rate: -1,
                    description: "negative reward",
                    image: "stars-rewards",
                },
                {
                    market,
                    type: "supply",
                    rate: 6,
                    description: "malformed chain reward",
                    image: "stars-rewards",
                    chain_network: 143,
                },
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

    const rewards = await Api.getRewards(createApiConfig());

    assert.deepEqual(Object.keys(rewards.milestones), [normalizedMarket]);
    assert.equal(rewards.incentives[normalizedMarket]?.length, 1);
    assert.equal(rewards.incentives[normalizedMarket]?.[0]?.image, "stars-rewards");
});

test("Api.getRewards filters milestones by requested chain metadata", async () => {
    const monadMarket = "0x00000000000000000000000000000000000000AA";
    const wrongChainMarket = "0x00000000000000000000000000000000000000BB";
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            milestones: [
                {
                    market: monadMarket,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 0,
                    chain_network: "Monad Mainnet",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                },
                {
                    market: "global",
                    tvl: 2,
                    multiplier: 3,
                    fail_multiplier: 0,
                    chain_network: "monad",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                },
                {
                    market: wrongChainMarket,
                    tvl: 3,
                    multiplier: 4,
                    fail_multiplier: 0,
                    chain_network: "Arbitrum Sepolia",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                },
            ],
            incentives: [],
        }),
    })) as unknown as typeof fetch;

    const rewards = await Api.getRewards(createApiConfig());

    assert.deepEqual(new Set(Object.keys(rewards.milestones)), new Set(["global", monadMarket.toLowerCase()]));
    assert.equal(rewards.milestones[monadMarket.toLowerCase()]?.chain_network, "Monad Mainnet");
    assert.equal(rewards.milestones.global?.chain_network, "monad");
    assert.equal(rewards.milestones[wrongChainMarket.toLowerCase()], undefined);
});

test("Api.getRewards filters incentives by explicit chain metadata without dropping legacy rows", async () => {
    const market = "0x00000000000000000000000000000000000000AB";
    const normalizedMarket = market.toLowerCase();
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            milestones: [],
            incentives: [
                {
                    market,
                    type: "supply",
                    rate: 1,
                    description: "legacy no-chain reward",
                    image: "stars-rewards",
                },
                {
                    market,
                    type: "supply",
                    rate: 2,
                    description: "monad reward",
                    image: "stars-rewards",
                    chain_network: "Monad Mainnet",
                },
                {
                    market,
                    type: "supply",
                    rate: 3,
                    description: "ethereum reward",
                    image: "stars-rewards",
                    chain_network: "Ethereum",
                },
            ],
        }),
    })) as unknown as typeof fetch;

    const rewards = await Api.getRewards(createApiConfig());

    assert.deepEqual(
        rewards.incentives[normalizedMarket]?.map((incentive) => incentive.description),
        ["legacy no-chain reward", "monad reward"],
    );
});

test("Api.getRewards accepts Arbitrum Sepolia milestone aliases", async () => {
    const market = "0x00000000000000000000000000000000000000CC";
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            milestones: [{
                market,
                tvl: 1,
                multiplier: 2,
                fail_multiplier: 0,
                chain_network: "Arbitrum Sepolia",
                start_date: "2026-01-01",
                end_date: "2026-01-02",
                duration_in_days: 1,
            }],
            incentives: [],
        }),
    })) as unknown as typeof fetch;

    const rewards = await Api.getRewards(createApiConfig("arb-sepolia"));

    assert.deepEqual(Object.keys(rewards.milestones), [market.toLowerCase()]);
});

test("Api.getRewards resolves reward aliases from chain config for minimal public configs", async () => {
    const market = "0x00000000000000000000000000000000000000CD";
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
            json: async () => ({
                milestones: [{
                    market,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 0,
                    chain_network: "Arbitrum Sepolia",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                }],
                incentives: [],
            }),
        } as Response;
    }) as typeof fetch;

    const rewards = await Api.getRewards({
        chain: "arb-sepolia",
        api_url: API_URL,
    } as any);

    assert.equal(requestedUrl, `${API_URL}/v1/rewards/active/${chain_config["arb-sepolia"].services.curvanceApi.rewardsSlug}`);
    assert.deepEqual(Object.keys(rewards.milestones), [market.toLowerCase()]);
});

test("Api.getRewards rejects invalid public api_url before fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("invalid api_url should not fetch");
    }) as unknown as typeof fetch;

    await assert.rejects(
        () => Api.getRewards({
            chain: "monad-mainnet",
            api_url: "http://insecure.local",
        } as any),
        /Api\.getRewards: api_url must use HTTPS/i,
    );
    assert.equal(fetchCalls, 0);
});

test("Api.getRewards uses setup snapshot reward slug after chain config moves", async (t) => {
    const originalSlug = chain_config["monad-mainnet"].services.curvanceApi.rewardsSlug;
    const market = "0x00000000000000000000000000000000000000CE";
    let requestedUrl: string | null = null;
    const snapshotConfig = {
        chain: "monad-mainnet",
        api_url: API_URL,
        services: {
            curvanceApi: {
                ...chain_config["monad-mainnet"].services.curvanceApi,
                rewardChainAliases: [...chain_config["monad-mainnet"].services.curvanceApi.rewardChainAliases],
                suppressedNativeYieldSymbols: [...chain_config["monad-mainnet"].services.curvanceApi.suppressedNativeYieldSymbols],
                rewardsSlug: "snapshot-monad",
            },
        },
    };

    (chain_config["monad-mainnet"].services.curvanceApi as any).rewardsSlug = "moved-monad";
    t.after(() => {
        (chain_config["monad-mainnet"].services.curvanceApi as any).rewardsSlug = originalSlug;
    });

    globalThis.fetch = (async (input: string | URL | Request) => {
        requestedUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;

        return {
            ok: true,
            json: async () => ({
                milestones: [{
                    market,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 0,
                    chain_network: "monad",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                }],
                incentives: [],
            }),
        } as Response;
    }) as typeof fetch;

    const rewards = await Api.getRewards(snapshotConfig as any);

    assert.equal(requestedUrl, `${API_URL}/v1/rewards/active/snapshot-monad`);
    assert.deepEqual(Object.keys(rewards.milestones), [market.toLowerCase()]);
});

test("Api.getRewards accepts every configured reward alias from chain config", async () => {
    const cases = Object.entries(chain_config).flatMap(([chain, config]) => (
        [chain, ...config.services.curvanceApi.rewardChainAliases].map((alias) => ({
            chain: chain as ChainRpcPrefix,
            alias,
        }))
    ));

    let caseIndex = 0;
    for (const { chain, alias } of cases) {
        caseIndex += 1;
        const market = `0x${caseIndex.toString(16).padStart(40, "0")}`;
        globalThis.fetch = (async () => ({
            ok: true,
            json: async () => ({
                milestones: [{
                    market,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 0,
                    chain_network: alias,
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                }],
                incentives: [],
            }),
        })) as unknown as typeof fetch;

        const rewards = await Api.getRewards(createApiConfig(chain));

        assert.deepEqual(
            Object.keys(rewards.milestones),
            [market.toLowerCase()],
            `${chain} should accept configured reward alias ${alias}`,
        );
    }
});

test("Api.getRewards rejects aliases configured only for other chains", async () => {
    for (const [chain, config] of Object.entries(chain_config)) {
        const otherAliases = Object.entries(chain_config)
            .filter(([otherChain]) => otherChain !== chain)
            .flatMap(([otherChain, otherConfig]) => [
                otherChain,
                ...otherConfig.services.curvanceApi.rewardChainAliases,
            ]);

        if (otherAliases.length === 0) {
            continue;
        }

        globalThis.fetch = (async () => ({
            ok: true,
            json: async () => ({
                milestones: otherAliases.map((alias, index) => ({
                    market: `0x${(index + 1).toString(16).padStart(40, "0")}`,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 0,
                    chain_network: alias,
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                })),
                incentives: [],
            }),
        })) as unknown as typeof fetch;

        const rewards = await Api.getRewards(createApiConfig(chain as ChainRpcPrefix));

        assert.deepEqual(
            rewards.milestones,
            {},
            `${chain} must not accept reward aliases from other configured chains`,
        );
    }
});

test("Api.getRewards degrades non-OK responses even when the body is valid-shaped", async () => {
    const market = "0x00000000000000000000000000000000000000AA";
    globalThis.fetch = (async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
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

    const rewards = await Api.getRewards(createApiConfig());

    assert.deepEqual(rewards, {
        milestones: {},
        incentives: {},
    });
});

test("Api.fetchNativeYields filters malformed rows from successful responses", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string) => {
        requestedUrl = url;
        return {
            ok: true,
            json: async () => ({
                native_apy: [
                    { symbol: "WMON", apy: 4.25 },
                    { symbol: "NEGATIVE", apy: -0.01 },
                    { symbol: null, apy: 2 },
                    { symbol: "BROKEN", apy: "5" },
                ],
            }),
        };
    }) as unknown as typeof fetch;

    const yields = await Api.fetchNativeYields(createApiConfig());

    assert.deepEqual(yields, [{ symbol: "WMON", apy: 4.25 }]);
    assert.equal(requestedUrl, `${API_URL}/v1/monad/native_apy`);
});

test("Api.fetchNativeYields resolves native yield slug from chain config for minimal public configs", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string) => {
        requestedUrl = url;
        return {
            ok: true,
            json: async () => ({
                native_apy: [{ symbol: "WMON", apy: 4.25 }],
            }),
        };
    }) as unknown as typeof fetch;

    const yields = await Api.fetchNativeYields({
        chain: "monad-mainnet",
        api_url: API_URL,
    } as any);

    assert.deepEqual(yields, [{ symbol: "WMON", apy: 4.25 }]);
    assert.equal(requestedUrl, `${API_URL}/v1/monad/native_apy`);
});

test("Api.fetchNativeYields rejects invalid public api_url before fetch when enabled", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("invalid api_url should not fetch");
    }) as unknown as typeof fetch;

    await assert.rejects(
        () => Api.fetchNativeYields({
            chain: "monad-mainnet",
            api_url: "javascript:alert(1)",
        } as any),
        /Api\.fetchNativeYields: api_url must use HTTPS/i,
    );
    assert.equal(fetchCalls, 0);
});

test("Api.fetchNativeYields returns empty without fetch when native yield is disabled", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("disabled native yield should not fetch");
    }) as unknown as typeof fetch;

    const yields = await Api.fetchNativeYields(createApiConfig("arb-sepolia"));

    assert.deepEqual(yields, []);
    assert.equal(fetchCalls, 0);
});

test("Api.fetchNativeYields disabled chains do not require an API URL", async (t) => {
    const originalError = console.error;
    let fetchCalls = 0;
    let errorCalls = 0;
    t.after(() => {
        console.error = originalError;
    });

    console.error = () => {
        errorCalls += 1;
    };
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("disabled native yield should not fetch");
    }) as unknown as typeof fetch;

    const yields = await Api.fetchNativeYields({
        ...createApiConfig("arb-sepolia"),
        api_url: null,
    });

    assert.deepEqual(yields, []);
    assert.equal(fetchCalls, 0);
    assert.equal(errorCalls, 0);
});

test("Api.fetchNativeYields degrades non-OK responses even when the body is valid-shaped", async () => {
    globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({
            native_apy: [{ symbol: "WMON", apy: 4.25 }],
        }),
    })) as unknown as typeof fetch;

    const yields = await Api.fetchNativeYields(createApiConfig());

    assert.deepEqual(yields, []);
});
