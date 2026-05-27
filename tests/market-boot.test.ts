import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { Api } from "../src/classes/Api";
import { Market } from "../src/classes/Market";
import { chain_config } from "../src/chains";
import * as setupModule from "../src/setup";

const merklModule = require("../src/integrations/merkl");

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const MARKET_A = "0x00000000000000000000000000000000000000a1";
const MARKET_B = "0x00000000000000000000000000000000000000b2";
const TOKEN_A = "0x00000000000000000000000000000000000000c1";
const TOKEN_B = "0x00000000000000000000000000000000000000c2";
const TOKEN_C = "0x00000000000000000000000000000000000000c3";

const originalFetchNativeYields = Api.fetchNativeYields;
const originalFetchMerklOpportunities = merklModule.fetchMerklOpportunities;
const originalSetupConfig = (setupModule as any).setup_config;

function assertDecimalString(actual: Decimal | undefined, expected: string, message: string) {
    assert.equal(actual?.toString(), expected, message);
}

function createStaticMarket(marketAddress: string, tokenAddress: string) {
    return {
        address: marketAddress as any,
        adapters: [],
        cooldownLength: 1200n,
        tokens: [{
            address: tokenAddress as any,
            name: `Token-${tokenAddress.slice(-2)}`,
            symbol: `TOK${tokenAddress.slice(-1)}`,
            decimals: 18n,
            asset: {
                address: tokenAddress as any,
                name: `Asset-${tokenAddress.slice(-2)}`,
                symbol: `AST${tokenAddress.slice(-1)}`,
                decimals: 18n,
                totalSupply: 100n,
            },
            adapters: [0n, 0n],
            isBorrowable: false,
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

function createDynamicMarket(marketAddress: string, tokenAddress: string, exchangeRate: bigint) {
    return {
        address: marketAddress as any,
        tokens: [{
            address: tokenAddress as any,
            totalSupply: 10n,
            totalAssets: 20n,
            exchangeRate,
            collateral: 3n,
            debt: 4n,
            sharePrice: 5n,
            assetPrice: 6n,
            sharePriceLower: 7n,
            assetPriceLower: 8n,
            borrowRate: 0n,
            predictedBorrowRate: 0n,
            utilizationRate: 0n,
            supplyRate: 0n,
            liquidity: 13n,
        }],
    };
}

function createUserMarket(marketAddress: string, tokenAddress: string, userAssetBalance: bigint) {
    return {
        address: marketAddress as any,
        collateral: 0n,
        maxDebt: 0n,
        debt: 0n,
        positionHealth: 0n,
        cooldown: 1200n,
        errorCodeHit: false,
        priceStale: false,
        tokens: [{
            address: tokenAddress as any,
            userAssetBalance,
            userShareBalance: 0n,
            userUnderlyingBalance: 0n,
            userCollateral: 0n,
            userDebt: 0n,
            liquidationPrice: 0n,
        }],
    };
}

function createSetup(overrides: Record<string, any> = {}) {
    const chain = overrides.chain ?? "monad-mainnet";
    const chainConfig = chain_config[chain as keyof typeof chain_config];
    const setup = {
        chain,
        chainId: chainConfig.chainId,
        environment: chainConfig.environment,
        assets: {
            native_symbol: chainConfig.native_symbol,
            native_name: chainConfig.native_name,
            wrapped_native: chainConfig.wrapped_native,
            native_vaults: chainConfig.native_vaults.map((vault) => ({ ...vault })),
            vaults: chainConfig.vaults.map((vault) => ({ ...vault })),
            excluded_zap_symbols: [...chainConfig.excluded_zap_symbols],
        },
        services: chainConfig.services,
        readProvider: {} as any,
        signer: null,
        account: ACCOUNT,
        provider: {} as any,
        api_url: "https://api.curvance.test",
        feePolicy: {
            getFeeBps: () => 0n,
            feeReceiver: undefined,
        },
        contracts: {
            markets: {
                marketA: { address: MARKET_A, plugins: {} },
                marketB: { address: MARKET_B, plugins: {} },
            },
        },
    };

    return {
        ...setup,
        ...overrides,
        contracts: overrides.contracts ?? setup.contracts,
    };
}

test.afterEach(() => {
    Api.fetchNativeYields = originalFetchNativeYields;
    merklModule.fetchMerklOpportunities = originalFetchMerklOpportunities;
    (setupModule as any).setup_config = originalSetupConfig;
});

test("Market.getAll joins dynamic and user payloads by address during boot", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [
                createStaticMarket(MARKET_A, TOKEN_A),
                createStaticMarket(MARKET_B, TOKEN_B),
            ],
            dynamicMarket: [
                createDynamicMarket(MARKET_B, TOKEN_B, 222n),
                createDynamicMarket(MARKET_A, TOKEN_A, 111n),
            ],
            userData: {
                locks: [],
                markets: [
                    createUserMarket(MARKET_B, TOKEN_B, 22n),
                    createUserMarket(MARKET_A, TOKEN_A, 11n),
                ],
            },
        }),
    } as any;

    const markets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        createSetup() as any,
    );

    assert.equal(markets.length, 2);
    assert.equal(markets[0]?.address, MARKET_A);
    assert.equal(markets[0]?.cache.dynamic.address, MARKET_A);
    assert.equal(markets[0]?.cache.user.address, MARKET_A);
    assert.equal((markets[0]?.tokens[0] as any).cache.exchangeRate, 111n);
    assert.equal((markets[0]?.tokens[0] as any).cache.userAssetBalance, 11n);
    assert.equal(markets[1]?.address, MARKET_B);
    assert.equal(markets[1]?.cache.dynamic.address, MARKET_B);
    assert.equal(markets[1]?.cache.user.address, MARKET_B);
    assert.equal((markets[1]?.tokens[0] as any).cache.exchangeRate, 222n);
    assert.equal((markets[1]?.tokens[0] as any).cache.userAssetBalance, 22n);
});

test("Market.getAll joins token rows by address within each market", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const staticMarket = createStaticMarket(MARKET_A, TOKEN_A);
    (staticMarket as any).tokens = [
        createStaticMarket(MARKET_A, TOKEN_A).tokens[0],
        createStaticMarket(MARKET_A, TOKEN_B).tokens[0],
    ];

    const dynamicMarket = createDynamicMarket(MARKET_A, TOKEN_A, 111n);
    (dynamicMarket as any).tokens = [
        createDynamicMarket(MARKET_A, TOKEN_B, 222n).tokens[0],
        createDynamicMarket(MARKET_A, TOKEN_A, 111n).tokens[0],
    ];

    const userMarket = createUserMarket(MARKET_A, TOKEN_A, 11n);
    (userMarket as any).tokens = [
        createUserMarket(MARKET_A, TOKEN_B, 22n).tokens[0],
        createUserMarket(MARKET_A, TOKEN_A, 11n).tokens[0],
    ];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [staticMarket],
            dynamicMarket: [dynamicMarket],
            userData: {
                locks: [],
                markets: [userMarket],
            },
        }),
    } as any;

    const markets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        createSetup() as any,
    );

    assert.equal(markets.length, 1);
    assert.equal(markets[0]?.tokens.length, 2);
    assert.equal(markets[0]?.tokens[0]?.address, TOKEN_A);
    assert.equal((markets[0]?.tokens[0] as any).cache.exchangeRate, 111n);
    assert.equal((markets[0]?.tokens[0] as any).cache.userAssetBalance, 11n);
    assert.equal(markets[0]?.tokens[1]?.address, TOKEN_B);
    assert.equal((markets[0]?.tokens[1] as any).cache.exchangeRate, 222n);
    assert.equal((markets[0]?.tokens[1] as any).cache.userAssetBalance, 22n);
});

test("Market.getAll explicit read providers do not inherit ambient signer or account", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const defaultReadProvider = { id: "default" } as any;
    const explicitReadProvider = { id: "explicit" } as any;
    const globalSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: defaultReadProvider,
    } as any;
    let capturedAccount: string | null | undefined;

    (setupModule as any).setup_config = createSetup({
        readProvider: defaultReadProvider,
        signer: globalSigner,
        account: ACCOUNT,
        provider: globalSigner,
    });

    const reader = {
        getAllMarketData: async (account: string | null = null) => {
            capturedAccount = account;
            return {
                staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
                dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
                userData: {
                    locks: [],
                    markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
                },
            };
        },
    } as any;

    const markets = await Market.getAll(reader, {} as any, explicitReadProvider);

    assert.equal(capturedAccount, null);
    assert.equal(markets.length, 1);
    assert.equal(markets[0]?.provider, explicitReadProvider);
    assert.equal(markets[0]?.signer, null);
    assert.equal(markets[0]?.account, null);
});

test("Market.getAll default context still captures ambient signer and account", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const defaultReadProvider = { id: "default" } as any;
    const globalSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: defaultReadProvider,
    } as any;
    let capturedAccount: string | null | undefined;

    (setupModule as any).setup_config = createSetup({
        readProvider: defaultReadProvider,
        signer: globalSigner,
        account: ACCOUNT,
        provider: globalSigner,
    });

    const reader = {
        getAllMarketData: async (account: string | null = null) => {
            capturedAccount = account;
            return {
                staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
                dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
                userData: {
                    locks: [],
                    markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
                },
            };
        },
    } as any;

    const markets = await Market.getAll(reader, {} as any);

    assert.equal(capturedAccount, ACCOUNT);
    assert.equal(markets.length, 1);
    assert.equal(markets[0]?.provider, defaultReadProvider);
    assert.equal(markets[0]?.signer, globalSigner);
    assert.equal(markets[0]?.account, ACCOUNT);
});

test("Market.getAll fails clearly when token rows drift within a market", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const staticMarket = createStaticMarket(MARKET_A, TOKEN_A);
    (staticMarket as any).tokens = [
        createStaticMarket(MARKET_A, TOKEN_A).tokens[0],
        createStaticMarket(MARKET_A, TOKEN_B).tokens[0],
    ];

    const dynamicMarket = createDynamicMarket(MARKET_A, TOKEN_A, 111n);
    (dynamicMarket as any).tokens = [
        createDynamicMarket(MARKET_A, TOKEN_A, 111n).tokens[0],
        createDynamicMarket(MARKET_A, TOKEN_C, 333n).tokens[0],
    ];

    const userMarket = createUserMarket(MARKET_A, TOKEN_A, 11n);
    (userMarket as any).tokens = [
        createUserMarket(MARKET_A, TOKEN_A, 11n).tokens[0],
        createUserMarket(MARKET_A, TOKEN_B, 22n).tokens[0],
    ];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [staticMarket],
            dynamicMarket: [dynamicMarket],
            userData: {
                locks: [],
                markets: [userMarket],
            },
        }),
    } as any;

    await assert.rejects(
        () => Market.getAll(
            reader,
            {} as any,
            {} as any,
            null,
            ACCOUNT as any,
            {},
            {},
            createSetup() as any,
        ),
        /Missing dynamic token data for 0x00000000000000000000000000000000000000c2 in market 0x00000000000000000000000000000000000000a1 during Market boot/i,
    );
});

test("Market.getAll fails clearly when a static market is missing dynamic state", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    await assert.rejects(
        () => Market.getAll(
            reader,
            {} as any,
            {} as any,
            null,
            ACCOUNT as any,
            {},
            {},
            createSetup() as any,
        ),
        /Missing dynamic market data for 0x00000000000000000000000000000000000000a1 during Market\.getAll boot/i,
    );
});

test("Market.getAll fails production boot when deploy metadata is missing", async (t) => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];
    const setup = createSetup({ contracts: { markets: {} } });
    const originalEnvironment = chain_config["monad-mainnet"].environment;
    (chain_config["monad-mainnet"] as any).environment = "testnet";
    t.after(() => {
        (chain_config["monad-mainnet"] as any).environment = originalEnvironment;
    });

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    await assert.rejects(
        () => Market.getAll(
            reader,
            {} as any,
            {} as any,
            null,
            ACCOUNT as any,
            {},
            {},
            setup as any,
        ),
        /Missing deployment metadata for market .* during monad-mainnet production setup/i,
    );
});

test("Market.getAll rejects duplicate market identity rows before boot", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const cases = [
        {
            name: "static",
            staticMarket: [
                createStaticMarket(MARKET_A, TOKEN_A),
                createStaticMarket(MARKET_A, TOKEN_A),
            ],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userMarkets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            pattern: /Duplicate static market address/i,
        },
        {
            name: "dynamic",
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [
                createDynamicMarket(MARKET_A, TOKEN_A, 111n),
                createDynamicMarket(MARKET_A, TOKEN_A, 222n),
            ],
            userMarkets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            pattern: /Duplicate dynamic market address/i,
        },
        {
            name: "user",
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userMarkets: [
                createUserMarket(MARKET_A, TOKEN_A, 11n),
                createUserMarket(MARKET_A, TOKEN_A, 22n),
            ],
            pattern: /Duplicate user market address/i,
        },
    ];

    for (const entry of cases) {
        const reader = {
            getAllMarketData: async () => ({
                staticMarket: entry.staticMarket,
                dynamicMarket: entry.dynamicMarket,
                userData: {
                    locks: [],
                    markets: entry.userMarkets,
                },
            }),
        } as any;

        await assert.rejects(
            () => Market.getAll(
                reader,
                {} as any,
                {} as any,
                null,
                ACCOUNT as any,
                {},
                {},
                createSetup() as any,
            ),
            entry.pattern,
            entry.name,
        );
    }
});

test("Market.getAll rejects duplicate token rows inside one market", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];

    const staticMarket = createStaticMarket(MARKET_A, TOKEN_A);
    (staticMarket as any).tokens = [
        createStaticMarket(MARKET_A, TOKEN_A).tokens[0],
        createStaticMarket(MARKET_A, TOKEN_A).tokens[0],
    ];

    const dynamicMarket = createDynamicMarket(MARKET_A, TOKEN_A, 111n);
    (dynamicMarket as any).tokens = [
        createDynamicMarket(MARKET_A, TOKEN_A, 111n).tokens[0],
        createDynamicMarket(MARKET_A, TOKEN_B, 222n).tokens[0],
    ];

    const userMarket = createUserMarket(MARKET_A, TOKEN_A, 11n);
    (userMarket as any).tokens = [
        createUserMarket(MARKET_A, TOKEN_A, 11n).tokens[0],
        createUserMarket(MARKET_A, TOKEN_B, 22n).tokens[0],
    ];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [staticMarket],
            dynamicMarket: [dynamicMarket],
            userData: {
                locks: [],
                markets: [userMarket],
            },
        }),
    } as any;

    await assert.rejects(
        () => Market.getAll(
            reader,
            {} as any,
            {} as any,
            null,
            ACCOUNT as any,
            {},
            {},
            createSetup() as any,
        ),
        /Duplicate static token row in market .* address/i,
    );
});

test("Market.getAll joins rewards by market address case-insensitively", async () => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = async () => [];
    const milestone = {
        market: MARKET_A.toUpperCase() as any,
        tvl: 1,
        multiplier: 2,
        fail_multiplier: 3,
        chain_network: "monad-mainnet",
        start_date: "2026-01-01",
        end_date: "2026-01-02",
        duration_in_days: 1,
    };
    const incentive = {
        market: MARKET_A.toUpperCase() as any,
        type: "supply",
        rate: 4,
        description: "reward",
        image: "stars-rewards",
    };

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    const markets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        { [MARKET_A.toUpperCase()]: milestone },
        { [MARKET_A.toUpperCase()]: [incentive] },
        createSetup() as any,
    );

    assert.equal(markets[0]?.milestone, milestone);
    assert.deepEqual(markets[0]?.incentives, [incentive]);
});

test("Market.getAll forwards setup snapshot chainId to Merkl and aggregates duplicate opportunities during boot", async (t) => {
    Api.fetchNativeYields = async () => [];
    const setup = createSetup();
    const originalChainId = chain_config["monad-mainnet"].chainId;
    const merklCalls: Array<{ action: string | undefined; chainId: number | undefined }> = [];
    merklModule.fetchMerklOpportunities = async (params: { action?: string; chainId?: number }) => {
        merklCalls.push({ action: params.action, chainId: params.chainId });

        if (params.action === "LEND") {
            return [
                {
                    identifier: MARKET_A,
                    apr: 12,
                    name: "lend-first",
                    type: "merkl",
                    tokens: [{ address: TOKEN_A, symbol: "TOKA" }],
                },
                {
                    identifier: MARKET_B,
                    apr: 34,
                    name: "lend-second",
                    type: "merkl",
                    tokens: [{ address: TOKEN_A.toUpperCase(), symbol: "TOKA" }],
                },
            ];
        }

        return [
            { identifier: TOKEN_A, apr: 5, name: "borrow-first", type: "merkl", tokens: [] },
            { identifier: TOKEN_A.toUpperCase(), apr: 7, name: "borrow-second", type: "merkl", tokens: [] },
        ];
    };
    (chain_config["monad-mainnet"] as any).chainId = 999_999;
    t.after(() => {
        (chain_config["monad-mainnet"] as any).chainId = originalChainId;
    });

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    const markets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        setup as any,
    );

    const token = markets[0]?.tokens[0] as any;
    assert.deepEqual(merklCalls, [
        { action: "LEND", chainId: 143 },
        { action: "BORROW", chainId: 143 },
    ]);
    assertDecimalString(token.incentiveSupplyApy, "0.46", "boot should attach summed supply incentive APY");
    assertDecimalString(token.incentiveBorrowApy, "0.12", "boot should attach summed borrow incentive APY");
});

test("Market.getAll consumes Merkl chain filtering through the real opportunity fetch path", async (t) => {
    Api.fetchNativeYields = async () => [];
    merklModule.fetchMerklOpportunities = originalFetchMerklOpportunities;
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
        const requestedUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
        requestedUrls.push(requestedUrl);

        const url = new URL(requestedUrl);
        const action = url.searchParams.get("action");
        const body = action === "LEND"
            ? [
                {
                    identifier: "monad-lend",
                    apr: 10,
                    name: "monad-lend",
                    type: "merkl",
                    action: "LEND",
                    chain: { id: 143, name: "Monad" },
                    chainId: 143,
                    computeChainId: 143,
                    distributionChainId: 143,
                    tokens: [{ address: TOKEN_A, symbol: "TOKA" }],
                },
                {
                    identifier: TOKEN_A,
                    apr: 5,
                    name: "metadata-less-lend",
                    type: "merkl",
                    tokens: [],
                },
                {
                    identifier: "wrong-chain-lend",
                    apr: 100,
                    name: "wrong-chain-lend",
                    type: "merkl",
                    chainId: 421614,
                    tokens: [{ address: TOKEN_A, symbol: "TOKA" }],
                },
                {
                    identifier: "conflicting-lend",
                    apr: 200,
                    name: "conflicting-lend",
                    type: "merkl",
                    chain: { id: 143, name: "Monad" },
                    distributionChainId: 421614,
                    tokens: [{ address: TOKEN_A, symbol: "TOKA" }],
                },
                {
                    identifier: "malformed-chain-lend",
                    apr: 300,
                    name: "malformed-chain-lend",
                    type: "merkl",
                    chainId: "143",
                    tokens: [{ address: TOKEN_A, symbol: "TOKA" }],
                },
                {
                    identifier: "wrong-action-lend",
                    apr: 400,
                    name: "wrong-action-lend",
                    type: "merkl",
                    action: "BORROW",
                    chainId: 143,
                    tokens: [{ address: TOKEN_A, symbol: "TOKA" }],
                },
            ]
            : [
                {
                    identifier: TOKEN_A,
                    apr: 2,
                    name: "monad-borrow",
                    type: "merkl",
                    action: "BORROW",
                    chainId: 143,
                    computeChainId: 143,
                    distributionChainId: 143,
                    tokens: [],
                },
                {
                    identifier: TOKEN_A.toUpperCase(),
                    apr: 3,
                    name: "metadata-less-borrow",
                    type: "merkl",
                    tokens: [],
                },
                {
                    identifier: TOKEN_A,
                    apr: 100,
                    name: "wrong-chain-borrow",
                    type: "merkl",
                    chainId: 1,
                    tokens: [],
                },
                {
                    identifier: TOKEN_A,
                    apr: 200,
                    name: "conflicting-borrow",
                    type: "merkl",
                    chainId: 143,
                    computeChainId: 1,
                    tokens: [],
                },
                {
                    identifier: TOKEN_A,
                    apr: 300,
                    name: "malformed-chain-borrow",
                    type: "merkl",
                    distributionChainId: "143",
                    tokens: [],
                },
                {
                    identifier: TOKEN_A,
                    apr: 400,
                    name: "wrong-action-borrow",
                    type: "merkl",
                    action: "LEND",
                    chainId: 143,
                    tokens: [],
                },
            ];

        return {
            ok: true,
            json: async () => body,
        } as Response;
    }) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    const markets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        createSetup() as any,
    );

    const requestsByAction = new Map(
        requestedUrls.map((request) => {
            const url = new URL(request);
            return [url.searchParams.get("action"), url] as const;
        }),
    );
    assert.equal(requestsByAction.get("LEND")?.searchParams.get("chainId"), "143");
    assert.equal(requestsByAction.get("BORROW")?.searchParams.get("chainId"), "143");

    const token = markets[0]?.tokens[0] as any;
    assertDecimalString(token.incentiveSupplyApy, "0.15", "boot should exclude wrong/conflicting-chain lend APY");
    assertDecimalString(token.incentiveBorrowApy, "0.05", "boot should exclude wrong/conflicting-chain borrow APY");
});

test("Market.getAll scopes native-yield USDC suppression to Monad", async () => {
    merklModule.fetchMerklOpportunities = async () => [];
    Api.fetchNativeYields = async () => [{ symbol: "USDC", apy: 5 }];

    const staticMarket = createStaticMarket(MARKET_A, TOKEN_A);
    (staticMarket.tokens[0] as any).asset.symbol = "USDC";

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [staticMarket],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    const monadMarkets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        createSetup({ chain: "monad-mainnet" }) as any,
    );
    const arbMarkets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        createSetup({ chain: "arb-sepolia" }) as any,
    );

    assertDecimalString((monadMarkets[0]?.tokens[0] as any).nativeApy, "0", "Monad USDC native yield remains suppressed");
    assertDecimalString((arbMarkets[0]?.tokens[0] as any).nativeApy, "0.05", "Non-Monad USDC native yield must not inherit Monad suppression");
});

test("Market.getAll rejects duplicate native-yield symbols before ambiguous hydration", async () => {
    merklModule.fetchMerklOpportunities = async () => [];
    Api.fetchNativeYields = async () => [
        { symbol: "WMON", apy: 5 },
        { symbol: "wmon", apy: 10 },
    ];

    const staticMarket = createStaticMarket(MARKET_A, TOKEN_A);
    (staticMarket.tokens[0] as any).asset.symbol = "WMON";
    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [staticMarket],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    await assert.rejects(
        () => Market.getAll(
            reader,
            {} as any,
            {} as any,
            null,
            ACCOUNT as any,
            {},
            {},
            createSetup() as any,
        ),
        /Duplicate native-yield symbol wmon/i,
    );
});

test("Market.getAll treats disabled native-yield service as graceful empty enrichment", async (t) => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    let fetchCalls = 0;
    let errorCalls = 0;

    t.after(() => {
        globalThis.fetch = originalFetch;
        console.error = originalError;
    });

    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("disabled native yield should not fetch");
    }) as unknown as typeof fetch;
    console.error = () => {
        errorCalls += 1;
    };
    merklModule.fetchMerklOpportunities = async () => [];

    const reader = {
        getAllMarketData: async () => ({
            staticMarket: [createStaticMarket(MARKET_A, TOKEN_A)],
            dynamicMarket: [createDynamicMarket(MARKET_A, TOKEN_A, 111n)],
            userData: {
                locks: [],
                markets: [createUserMarket(MARKET_A, TOKEN_A, 11n)],
            },
        }),
    } as any;

    const markets = await Market.getAll(
        reader,
        {} as any,
        {} as any,
        null,
        ACCOUNT as any,
        {},
        {},
        createSetup({ chain: "arb-sepolia", api_url: null }) as any,
    );

    assert.equal(markets.length, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(errorCalls, 0);
    assertDecimalString((markets[0]?.tokens[0] as any).nativeApy, "0", "disabled native-yield service should hydrate as zero APY");
});

test("Market.hypotheticalLiquidityOf routes through ProtocolReader with the market address", async () => {
    const market = Object.create(Market.prototype) as Market;
    market.address = MARKET_A as any;

    let capturedArgs: unknown[] | null = null;
    market.reader = {
        hypotheticalLiquidityOf: async (...args: unknown[]) => {
            capturedArgs = args;
            return {
                collateral: 1n,
                maxDebt: 2n,
                debt: 3n,
                collateralSurplus: 4n,
                liquidityDeficit: 5n,
                loanSizeError: false,
                oracleError: true,
            };
        },
    } as any;

    const result = await market.hypotheticalLiquidityOf(
        ACCOUNT as any,
        TOKEN_A as any,
        33n,
        44n,
        55n,
    );

    assert.deepEqual(capturedArgs, [
        MARKET_A,
        ACCOUNT,
        TOKEN_A,
        33n,
        44n,
        55n,
    ]);
    assert.deepEqual(result, {
        collateral: 1n,
        maxDebt: 2n,
        debt: 3n,
        collateralSurplus: 4n,
        liquidityDeficit: 5n,
        loanSizeError: false,
        oracleError: true,
    });
});
