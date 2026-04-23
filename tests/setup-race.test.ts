import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcProvider } from "ethers";
import { Api } from "../src/classes/Api";
import { Market } from "../src/classes/Market";
import { getChainRpcConfig } from "../src/chains";
import { CURVANCE_DAO_FEE_RECEIVER, CURVANCE_FEE_BPS } from "../src/feePolicy";
import {
    configureRetries,
    DEFAULT_RETRY_CONFIG,
    getRpcDebugSnapshot,
    isRetryableReadProvider,
    resetRpcDebugState,
    wrapProviderWithRetries,
} from "../src/retry-provider";
import { all_markets, setup_config, setupChain } from "../src/setup";

function defer<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

test("setupChain only publishes the latest invocation", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;

    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.older.example");
    const newerSetup = setupChain("monad-mainnet", null, "https://api.newer.example");

    rewardsB.resolve({ milestones: {}, incentives: {} });
    const newerResult = await newerSetup;

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const olderResult = await olderSetup;

    assert.equal(setup_config.api_url, "https://api.newer.example");
    assert.equal(setup_config.signer, null);
    assert.equal(setup_config.account, null);
    assert.equal(setup_config.provider, setup_config.readProvider);
    assert.deepEqual(all_markets, newerResult.markets);
    assert.notDeepEqual(all_markets, olderResult.markets);
    assert.equal((newerResult.markets[0] as any).marker, "https://api.newer.example");
    assert.equal((olderResult.markets[0] as any).marker, "https://api.older.example");
});

test("setupChain publishes the newest successful invocation after newer pending setups fail", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;

    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.recover.example");
    const newerSetup = setupChain("monad-mainnet", null, "https://api.fail.example");

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const olderResult = await olderSetup;

    assert.equal(setup_config.api_url, "https://api.recover.example");
    assert.deepEqual(all_markets, olderResult.markets);

    rewardsB.promise.catch(() => undefined);
    rewardsB.reject(new Error("newer setup failed"));
    await assert.rejects(() => newerSetup, /newer setup failed/i);

    assert.equal(setup_config.api_url, "https://api.recover.example");
    assert.deepEqual(all_markets, olderResult.markets);
});

test("setupChain lets a newer success supersede an older success that published while it was pending", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;

    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.temporary.example");
    const newerSetup = setupChain("monad-mainnet", null, "https://api.final.example");

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const olderResult = await olderSetup;

    assert.equal(setup_config.api_url, "https://api.temporary.example");
    assert.deepEqual(all_markets, olderResult.markets);

    rewardsB.resolve({ milestones: {}, incentives: {} });
    const newerResult = await newerSetup;

    assert.equal(setup_config.api_url, "https://api.final.example");
    assert.deepEqual(all_markets, newerResult.markets);
});

test("setupChain preserves call-start order when an older setup validates slowly", async (t) => {
    const validationA = defer<{ chainId: bigint; name: string }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.slow-validation.example", {
        readProvider: {
            getNetwork: async () => validationA.promise,
        } as any,
    });
    const newerResult = await setupChain("monad-mainnet", null, "https://api.fast-validation.example", {
        readProvider: {
            getNetwork: async () => ({ chainId: 143n, name: "monad-mainnet" }),
        } as any,
    });

    assert.equal(setup_config.api_url, "https://api.fast-validation.example");
    assert.deepEqual(all_markets, newerResult.markets);

    validationA.resolve({ chainId: 143n, name: "monad-mainnet" });
    const olderResult = await olderSetup;

    assert.equal((olderResult.markets[0] as any).marker, "https://api.slow-validation.example");
    assert.equal(setup_config.api_url, "https://api.fast-validation.example");
    assert.deepEqual(all_markets, newerResult.markets);
});

test("setupChain keeps signer writes separate from dedicated read transport", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
    } as any;

    let captured: {
        provider: any;
        signer: any;
        account: any;
        setup: typeof setup_config | null;
    } = {
        provider: null,
        signer: null,
        account: null,
        setup: null,
    };

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, provider, signer, account, _milestones, _incentives, setup) => {
        captured = {
            provider,
            signer,
            account,
            setup: setup ?? null,
        };
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example");

    assert.equal(setup_config.signer, fakeSigner);
    assert.equal(setup_config.account, fakeSigner.address);
    assert.equal(setup_config.provider, fakeSigner);
    assert.notEqual(setup_config.readProvider, fakeSigner);
    assert.equal(captured.signer, fakeSigner);
    assert.equal(captured.account, fakeSigner.address);
    assert.equal(captured.setup, setup_config);
    assert.equal(captured.provider, setup_config.readProvider);
    assert.notEqual(captured.provider, fakeSigner);
});

test("setupChain supports user-specific public reads without a signer", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const account = "0x0000000000000000000000000000000000000abc";

    let captured: {
        provider: any;
        signer: any;
        account: any;
        setup: typeof setup_config | null;
    } = {
        provider: null,
        signer: null,
        account: null,
        setup: null,
    };

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, provider, signer, nextAccount, _milestones, _incentives, setup) => {
        captured = {
            provider,
            signer,
            account: nextAccount,
            setup: setup ?? null,
        };
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await setupChain("monad-mainnet", null, "https://api.example", { account: account as any });

    assert.equal(setup_config.signer, null);
    assert.equal(setup_config.account, account);
    assert.equal(setup_config.provider, setup_config.readProvider);
    assert.equal(captured.signer, null);
    assert.equal(captured.account, account);
    assert.equal(captured.provider, setup_config.readProvider);
});

test("setupChain defaults Monad mainnet to the live Curvance fee policy", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await setupChain("monad-mainnet", null, "https://api.example");

    assert.equal(
        setup_config.feePolicy.getFeeBps({
            operation: "zap",
            inputToken: "0x0000000000000000000000000000000000000001" as any,
            outputToken: "0x0000000000000000000000000000000000000002" as any,
            inputAmount: 1n,
            currentLeverage: null,
            targetLeverage: null,
        }),
        CURVANCE_FEE_BPS,
    );
    assert.equal(setup_config.feePolicy.feeReceiver, CURVANCE_DAO_FEE_RECEIVER);
});

test("setupChain wraps explicit read-provider overrides with chain fallbacks", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
    } as any;
    const customReadProvider = new JsonRpcProvider("https://wallet-rpc.example");
    customReadProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const customAccount = fakeSigner.address;

    let captured: {
        provider: any;
        signer: any;
        account: any;
    } = {
        provider: null,
        signer: null,
        account: null,
    };

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, provider, signer, account) => {
        captured = { provider, signer, account };
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example", {
        account: customAccount as any,
        readProvider: customReadProvider,
    });

    const snapshot = getRpcDebugSnapshot();
    const urls = snapshot.endpoints.map((endpoint) => endpoint.url).filter((url): url is string => url != null);
    const monadRpc = getChainRpcConfig("monad-mainnet");

    assert.equal(setup_config.signer, fakeSigner);
    assert.equal(setup_config.account, customAccount);
    assert.notEqual(setup_config.readProvider, customReadProvider);
    assert.ok(isRetryableReadProvider(setup_config.readProvider));
    assert.equal(captured.signer, fakeSigner);
    assert.equal(captured.account, customAccount);
    assert.equal(captured.provider, setup_config.readProvider);
    assert.ok(urls.includes("https://wallet-rpc.example"));
    assert.ok(urls.includes(monadRpc.primary.replace(/\/+$/, "")));
    for (const fallback of monadRpc.fallbacks.map((url) => url.replace(/\/+$/, ""))) {
        assert.ok(urls.includes(fallback));
    }
});

test("setupChain rejects mismatched signer and explicit account", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
    } as any;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => {
        throw new Error("should fail before Market.getAll");
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await assert.rejects(
        () =>
            setupChain("monad-mainnet", fakeSigner, "https://api.example", {
                account: "0x0000000000000000000000000000000000000def" as any,
            }),
        /cannot boot with signer .* and read account/i,
    );
});

test("setupChain re-wraps an already retry-wrapped explicit read provider per invocation", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const baseProvider = new JsonRpcProvider("https://wallet-rpc.example");
    baseProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    const firstWrapped = await (async () => {
        await setupChain("monad-mainnet", null, "https://api.first.example", {
            readProvider: baseProvider,
        });
        return setup_config.readProvider;
    })();

    await setupChain("monad-mainnet", null, "https://api.second.example", {
        readProvider: firstWrapped,
    });

    assert.ok(isRetryableReadProvider(firstWrapped));
    assert.ok(isRetryableReadProvider(setup_config.readProvider));
    assert.notEqual(setup_config.readProvider, firstWrapped);
});

test("setupChain validates a retry-wrapped signer against its primary wallet transport", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletPrimary = new JsonRpcProvider("https://wallet-primary.example");
    walletPrimary.getNetwork = async () => {
        throw new Error("wallet getNetwork timeout");
    };
    const healthyFallback = new JsonRpcProvider("https://healthy-fallback.example");
    healthyFallback.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const wrappedWalletProvider = wrapProviderWithRetries(walletPrimary, healthyFallback);
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: wrappedWalletProvider,
    } as any;

    let rewardsCalls = 0;
    let marketCalls = 0;
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", fakeSigner, "https://api.example"),
        /wallet getNetwork timeout/i,
    );
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain removes fallback origins that duplicate the selected read primary", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const monadRpc = getChainRpcConfig("monad-mainnet");
    const primaryOverride = new JsonRpcProvider(monadRpc.primary);
    primaryOverride.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", null, "https://api.example", {
        readProvider: primaryOverride,
    });

    const primaryUrl = monadRpc.primary.replace(/\/+$/, "");
    const snapshot = getRpcDebugSnapshot();
    const primary = snapshot.endpoints.find((e) => e.role === "primary");
    const fallbackUrls = snapshot.endpoints
        .filter((e) => e.role === "fallback")
        .map((e) => e.url)
        .filter((url): url is string => url != null);

    assert.equal(primary?.url, primaryUrl);
    assert.equal(
        fallbackUrls.filter((url) => url === primaryUrl).length,
        0,
        "selected primary RPC must not also appear as fallback",
    );
    for (const fallback of monadRpc.fallbacks.map((url) => url.replace(/\/+$/, ""))) {
        assert.ok(fallbackUrls.includes(fallback));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallet-primary reads.
//
// When a signer is connected, the wallet's own provider should be the primary
// read source — the SDK's configured chain RPC + fallbacks serve as fallback
// only. This matches the pre-`358d46b` architecture (which explicitly named
// Rabby as the motivating unreliable-wallet case in an inline comment) and
// distributes read load across users' wallet-configured RPCs instead of
// funneling every Curvance user's reads through the single `chain_config`
// primary origin.
//
// Graceful degradation: wallet provider errors → retry wrapper falls through
// to chainReadProvider → chain fallbacks. Users with broken or missing wallet
// RPCs never lose access.
// ─────────────────────────────────────────────────────────────────────────────

test("setupChain uses the wallet's own provider as the read primary when signer has one", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletRpcProvider = new JsonRpcProvider("https://wallet-rpc.example");
    walletRpcProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: walletRpcProvider,
    } as any;

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example");

    const snapshot = getRpcDebugSnapshot();
    const monadRpc = getChainRpcConfig("monad-mainnet");
    const primary = snapshot.endpoints.find((e) => e.role === "primary");
    const fallbackUrls = snapshot.endpoints
        .filter((e) => e.role === "fallback")
        .map((e) => e.url)
        .filter((url): url is string => url != null);

    // Signer is still the write path.
    assert.equal(setup_config.signer, fakeSigner);
    assert.equal(setup_config.account, fakeSigner.address);
    // Read primary is the wallet's own provider — load distributes across users.
    assert.equal(
        primary?.url,
        "https://wallet-rpc.example",
        "wallet's provider must be the read primary when a signer is connected",
    );
    // Chain's configured primary is a fallback (catches wallet RPC failures).
    assert.ok(
        fallbackUrls.includes(monadRpc.primary.replace(/\/+$/, "")),
        "chain primary must be in the fallback chain behind the wallet provider",
    );
    // Chain's configured fallbacks are also in the fallback chain.
    for (const fallback of monadRpc.fallbacks.map((url) => url.replace(/\/+$/, ""))) {
        assert.ok(
            fallbackUrls.includes(fallback),
            `chain fallback ${fallback} must be in the fallback chain`,
        );
    }
});

test("setupChain falls back to chain provider when the signer has no .provider", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSignerNoProvider = {
        address: "0x000000000000000000000000000000000000dEaD",
        // no .provider — defensive path for Wallet signers constructed without
        // a connected provider, or any non-standard signer implementation.
    } as any;

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSignerNoProvider, "https://api.example");

    const snapshot = getRpcDebugSnapshot();
    const monadRpc = getChainRpcConfig("monad-mainnet");
    const primary = snapshot.endpoints.find((e) => e.role === "primary");

    assert.equal(setup_config.signer, fakeSignerNoProvider);
    assert.equal(
        primary?.url,
        monadRpc.primary.replace(/\/+$/, ""),
        "signer without .provider must degrade to chain primary",
    );
});

test("explicit readProvider option wins over the signer's own provider", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletRpcProvider = new JsonRpcProvider("https://wallet-rpc.example");
    walletRpcProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: walletRpcProvider,
    } as any;
    const overrideProvider = new JsonRpcProvider("https://override-rpc.example");
    overrideProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example", {
        readProvider: overrideProvider,
    });

    const snapshot = getRpcDebugSnapshot();
    const primary = snapshot.endpoints.find((e) => e.role === "primary");
    const fallbackUrls = snapshot.endpoints
        .filter((e) => e.role === "fallback")
        .map((e) => e.url)
        .filter((url): url is string => url != null);

    // Explicit option wins — wallet's provider is ignored for reads.
    assert.equal(
        primary?.url,
        "https://override-rpc.example",
        "explicit readProvider option must take precedence over signer.provider",
    );
    assert.ok(
        !fallbackUrls.includes("https://wallet-rpc.example"),
        "wallet's provider must not appear in the fallback chain when an explicit override was given",
    );
});

test("setupChain fails fast when an explicit read provider is connected to a different chain", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const wrongReadProvider = new JsonRpcProvider("https://wrong-chain.example");
    wrongReadProvider.getNetwork = async () => ({ chainId: 421614n, name: "arb-sepolia" } as any);

    let rewardsCalls = 0;
    let marketCalls = 0;
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.example", {
            readProvider: wrongReadProvider,
        }),
        /Read provider is connected to chainId 421614 but setupChain\('monad-mainnet'\) expects 143\./i,
    );
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain times out a hanging explicit readProvider during chain validation", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const hangingReadProvider = new JsonRpcProvider("https://hanging-rpc.example");
    hangingReadProvider.getNetwork = async () => new Promise(() => undefined);

    let rewardsCalls = 0;
    let marketCalls = 0;
    configureRetries({
        ...DEFAULT_RETRY_CONFIG,
        maxRetries: 0,
        baseDelay: 0,
        maxDelay: 0,
        timeoutMs: 25,
    });
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        configureRetries(DEFAULT_RETRY_CONFIG);
        resetRpcDebugState();
    });

    const startedAt = Date.now();
    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.example", {
            readProvider: hangingReadProvider,
        }),
        /Read provider getNetwork: timeout after 25ms/i,
    );

    assert.ok(Date.now() - startedAt < 500, "chain validation should use the configured read timeout");
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain treats timeoutMs=0 as timeout disabled during chain validation", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const slowReadProvider = new JsonRpcProvider("https://slow-rpc.example");
    slowReadProvider.getNetwork = async () => new Promise((resolve) => {
        setTimeout(() => resolve({ chainId: 143n, name: "monad-mainnet" } as any), 10);
    });

    let rewardsCalls = 0;
    let marketCalls = 0;
    configureRetries({
        ...DEFAULT_RETRY_CONFIG,
        maxRetries: 0,
        baseDelay: 0,
        maxDelay: 0,
        timeoutMs: 0,
    });
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        configureRetries(DEFAULT_RETRY_CONFIG);
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", null, "https://api.example", {
        readProvider: slowReadProvider,
    });

    assert.equal(rewardsCalls, 1);
    assert.equal(marketCalls, 1);
});

test("setupChain fails fast when the signer provider is connected to a different chain", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletRpcProvider = new JsonRpcProvider("https://wallet-rpc.example");
    walletRpcProvider.getNetwork = async () => ({ chainId: 421614n, name: "arb-sepolia" } as any);

    const overrideProvider = new JsonRpcProvider("https://override-rpc.example");
    overrideProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: walletRpcProvider,
    } as any;

    let rewardsCalls = 0;
    let marketCalls = 0;

    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", fakeSigner, "https://api.example", {
            readProvider: overrideProvider,
        }),
        /Signer provider is connected to chainId 421614 but setupChain\('monad-mainnet'\) expects 143\./i,
    );
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});
