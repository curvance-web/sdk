const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");
const sdk = require("../dist/index.js");
const { Api } = require("../dist/classes/Api.js");
const { Market } = require("../dist/classes/Market.js");
const { ProtocolReader } = require("../dist/classes/ProtocolReader.js");
const repoRoot = path.join(__dirname, "..");

const TOKEN_IN = "0x0000000000000000000000000000000000000001";
const TOKEN_OUT = "0x0000000000000000000000000000000000000002";
const WALLET = "0x0000000000000000000000000000000000000003";
const FEE_RECEIVER = "0x0000000000000000000000000000000000000004";

function jsonResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
            return body;
        },
    };
}

async function withMockedKyberFetch(kyber, calldata, run) {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = async () => {
        calls++;

        if (calls === 1) {
            return jsonResponse({
                message: "OK",
                data: {
                    routeSummary: {
                        tokenIn: TOKEN_IN,
                        tokenOut: TOKEN_OUT,
                        amountIn: "1000",
                        amountOut: "1000",
                        extraFee: {
                            feeAmount: "0",
                            chargeFeeBy: "",
                            isInBps: true,
                            feeReceiver: FEE_RECEIVER,
                        },
                        route: [],
                    },
                    routerAddress: kyber.router,
                },
                requestId: "routes",
            });
        }

        return jsonResponse({
            code: 0,
            message: "OK",
            data: {
                amountIn: "1000",
                amountInUsd: "1",
                amountOut: "1000",
                amountOutUsd: "1",
                gas: "0",
                gasUsd: "0",
                additionalCostUsd: "0",
                additionalCostMessage: "",
                outputChange: {
                    amount: "0",
                    percent: 0,
                    level: 0,
                },
                data: calldata,
                routerAddress: kyber.router,
                transactionValue: "0",
            },
            requestId: "build",
        });
    };

    try {
        const result = await run();
        assert.equal(calls, 2, "Kyber quote should use route and build fetches");
        return result;
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function withMockedFetch(body, run) {
    const originalFetch = globalThis.fetch;
    const urls = [];

    globalThis.fetch = async (input) => {
        urls.push(String(input));
        return jsonResponse(body);
    };

    try {
        return await run(urls);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function npmPackInvocation(packDir) {
    const npmCliCandidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter(Boolean);
    const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));

    if (npmCli) {
        return {
            command: process.execPath,
            args: [npmCli, "pack", "--json", "--pack-destination", packDir],
        };
    }

    return {
        command: "npm",
        args: ["pack", "--json", "--pack-destination", packDir],
    };
}

function withPackedPackage(run) {
    const packDir = mkdtempSync(path.join(tmpdir(), "curvance-sdk-pack-"));

    try {
        const invocation = npmPackInvocation(packDir);
        const output = execFileSync(
            invocation.command,
            invocation.args,
            {
                cwd: repoRoot,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        const [pack] = JSON.parse(output);
        const tarball = path.join(packDir, pack.filename);
        execFileSync("tar", ["-xzf", tarball, "-C", packDir], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });

        return run({
            files: new Set(pack.files.map((file) => file.path.replace(/\\/g, "/"))),
            packageRoot: path.join(packDir, "package"),
        });
    } finally {
        rmSync(packDir, { recursive: true, force: true });
    }
}

class SignerBackedCalldata extends sdk.Calldata {
    constructor(signer) {
        super();
        this.signer = signer;
        this.address = "0x00000000000000000000000000000000000000cc";
        this.contract = {
            interface: {
                encodeFunctionData() {
                    return "0x1234";
                },
            },
        };
    }
}

async function main() {
    let packedSdk;
    const packedFiles = withPackedPackage(({ files, packageRoot }) => {
        const previousNodePath = process.env.NODE_PATH;
        process.env.NODE_PATH = [
            path.join(repoRoot, "node_modules"),
            previousNodePath,
        ].filter(Boolean).join(path.delimiter);
        Module._initPaths();
        try {
            packedSdk = require(packageRoot);
        } finally {
            process.env.NODE_PATH = previousNodePath;
            Module._initPaths();
        }
        return files;
    });
    assert.ok(packedFiles.has("dist/index.js"), "package tarball should include built root entry");
    assert.ok(packedFiles.has("dist/chains/services.js"), "package tarball should include built chain service config");
    assert.ok(packedFiles.has("dist/chains/services.d.ts"), "package tarball should include chain service config types");
    assert.ok(packedFiles.has("README.md"), "package tarball should include README");
    assert.equal(
        [...packedFiles].some((file) => /(^|\/)Kuru\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(file)),
        false,
        "package tarball must not include stale deprecated Kuru artifacts",
    );

    assert.equal(typeof sdk.setupChain, "function", "dist should export setupChain");
    assert.equal(typeof sdk.Calldata, "function", "dist should export Calldata");
    assert.equal(typeof sdk.OptimizerReader, "function", "dist should export OptimizerReader");
    assert.equal(typeof sdk.LendingOptimizer, "function", "dist should export LendingOptimizer");
    assert.equal(typeof sdk.PositionManager, "function", "dist should export PositionManager");
    assert.equal(typeof sdk.Zapper, "function", "dist should export Zapper");
    assert.equal(typeof sdk.NativeToken, "function", "dist should export NativeToken");
    assert.equal(typeof sdk.Api, "function", "dist should export Api reward helpers and types");
    assert.equal(typeof sdk.KyberSwap, "function", "dist should export KyberSwap");
    assert.equal(typeof sdk.MultiDexAgg, "function", "dist should export MultiDexAgg");
    assert.equal(typeof sdk.NO_FEE_POLICY?.getFeeBps, "function", "dist should export NO_FEE_POLICY");
    assert.equal("Kuru" in sdk, false, "dist should not export deprecated Kuru support");
    assert.equal(typeof sdk.leverage.calculateBorrowAmount, "function", "dist should export leverage namespace");
    assert.equal(typeof sdk.borrow.calculateMaxBorrow, "function", "dist should export borrow namespace");
    assert.equal(typeof sdk.collateral.calculateExchangeRate, "function", "dist should export collateral namespace");
    assert.equal(typeof sdk.health.formatHealthFactor, "function", "dist should export health namespace");
    assert.equal(typeof sdk.amounts.normalizeAmountString, "function", "dist should export amounts namespace");
    assert.equal(typeof packedSdk.setupChain, "function", "packed package root should export setupChain");
    assert.equal(typeof packedSdk.KyberSwap, "function", "packed package root should export KyberSwap");
    assert.equal(
        packedSdk.chain_config["monad-mainnet"].services.dexAggregators.kyberSwap.router,
        sdk.chain_config["monad-mainnet"].services.dexAggregators.kyberSwap.router,
        "packed package root should resolve built chain services through package main",
    );

    assert.throws(
        () => new sdk.Zapper(
            "0x00000000000000000000000000000000000000b1",
            { address: WALLET },
            "simple",
            {
                chain: "monad-mainnet",
                feePolicy: sdk.NO_FEE_POLICY,
                assets: {
                    native_symbol: "MON",
                    native_name: "Monad",
                    wrapped_native: sdk.chain_config["monad-mainnet"].wrapped_native,
                    native_vaults: [],
                    vaults: [],
                },
            },
        ),
        /requires a setup-bound DEX aggregator/i,
        "dist Zapper should fail closed instead of falling back to mutable chain config",
    );

    const explicitNative = new sdk.NativeToken(
        "monad-mainnet",
        {},
        undefined,
        null,
        null,
        {
            native_symbol: "SMON",
            native_name: "Snapshot MON",
        },
    );
    assert.equal(explicitNative.symbol, "SMON");
    assert.equal(explicitNative.name, "Snapshot MON");

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const originalGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    let monadSetupSnapshot;
    try {
        Api.getRewards = async () => ({ milestones: {}, incentives: {} });
        Market.getAll = async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => [
            { setup },
        ];
        ProtocolReader.prototype.getDaoAddress = async () => FEE_RECEIVER;

        const setupResult = await sdk.setupChain("arb-sepolia", null, "https://api.dist-smoke.example");
        assert.equal(setupResult.chain, "arb-sepolia");
        assert.equal(setupResult.chainId, 421614);
        assert.equal(setupResult.setupConfigSnapshot.chain, "arb-sepolia");
        assert.equal(setupResult.setupConfigSnapshot.chainId, 421614);
        assert.equal(setupResult.setupConfigSnapshot.environment, "testnet");
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot), true);
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.contracts), true);
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.assets), true);
        assert.notEqual(
            setupResult.setupConfigSnapshot.assets.native_vaults,
            sdk.chain_config["arb-sepolia"].native_vaults,
            "setup snapshot should clone chain asset arrays instead of sharing exported chain config",
        );
        assert.deepEqual(setupResult.setupConfigSnapshot.assets, {
            native_symbol: sdk.chain_config["arb-sepolia"].native_symbol,
            native_name: sdk.chain_config["arb-sepolia"].native_name,
            wrapped_native: sdk.chain_config["arb-sepolia"].wrapped_native,
            native_vaults: [...sdk.chain_config["arb-sepolia"].native_vaults],
            vaults: [...sdk.chain_config["arb-sepolia"].vaults],
        });
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.services), true);
        assert.notEqual(
            setupResult.setupConfigSnapshot.services,
            sdk.chain_config["arb-sepolia"].services,
            "setup snapshot should clone service policy instead of freezing the exported chain config",
        );
        assert.deepEqual(setupResult.setupConfigSnapshot.services.curvanceApi, {
            rewardsSlug: "arb-sepolia",
            rewardChainAliases: ["arbitrum-sepolia"],
            nativeYieldSlug: null,
            suppressedNativeYieldSymbols: [],
        });
        assert.deepEqual(setupResult.setupConfigSnapshot.services.dexAggregators, {
            kyberSwap: null,
        });
        assert.equal(setupResult.markets[0].setup, setupResult.setupConfigSnapshot);

        const monadSetupResult = await sdk.setupChain("monad-mainnet", null, "https://api.dist-smoke.example", {
            feePolicy: sdk.flatFeePolicy({
                bps: sdk.CURVANCE_FEE_BPS,
                feeReceiver: FEE_RECEIVER,
                chain: "monad-mainnet",
            }),
        });
        assert.equal(monadSetupResult.chain, "monad-mainnet");
        assert.equal(monadSetupResult.chainId, 143);
        assert.equal(monadSetupResult.setupConfigSnapshot.chain, "monad-mainnet");
        assert.equal(monadSetupResult.setupConfigSnapshot.chainId, 143);
        assert.equal(monadSetupResult.setupConfigSnapshot.environment, "production-mainnet");
        assert.equal(Object.isFrozen(monadSetupResult.setupConfigSnapshot.assets), true);
        assert.notEqual(
            monadSetupResult.setupConfigSnapshot.assets.native_vaults,
            sdk.chain_config["monad-mainnet"].native_vaults,
            "Monad setup snapshot should clone native vault arrays instead of sharing exported chain config",
        );
        assert.deepEqual(monadSetupResult.setupConfigSnapshot.assets, {
            native_symbol: sdk.chain_config["monad-mainnet"].native_symbol,
            native_name: sdk.chain_config["monad-mainnet"].native_name,
            wrapped_native: sdk.chain_config["monad-mainnet"].wrapped_native,
            native_vaults: [...sdk.chain_config["monad-mainnet"].native_vaults],
            vaults: [...sdk.chain_config["monad-mainnet"].vaults],
        });
        assert.deepEqual(monadSetupResult.setupConfigSnapshot.services.curvanceApi, {
            rewardsSlug: "monad-mainnet",
            rewardChainAliases: ["monad"],
            nativeYieldSlug: "monad",
            suppressedNativeYieldSymbols: ["USDC"],
        });
        assert.deepEqual(
            monadSetupResult.setupConfigSnapshot.services.dexAggregators.kyberSwap,
            sdk.chain_config["monad-mainnet"].services.dexAggregators.kyberSwap,
        );
        assert.notEqual(
            monadSetupResult.dexAgg,
            sdk.chain_config["monad-mainnet"].dexAgg,
            "Monad setup should return a context-bound DEX aggregator instead of the exported singleton",
        );
        assert.equal(monadSetupResult.markets[0].setup, monadSetupResult.setupConfigSnapshot);
        monadSetupSnapshot = monadSetupResult.setupConfigSnapshot;
    } finally {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = originalGetDaoAddress;
    }

    const originalMonadRewardsSlug = sdk.chain_config["monad-mainnet"].services.curvanceApi.rewardsSlug;
    const originalMonadNativeYieldSlug = sdk.chain_config["monad-mainnet"].services.curvanceApi.nativeYieldSlug;
    try {
        sdk.chain_config["monad-mainnet"].services.curvanceApi.rewardsSlug = "moved-dist-monad";
        sdk.chain_config["monad-mainnet"].services.curvanceApi.nativeYieldSlug = "moved-dist-native";

        await withMockedFetch(
            {
                milestones: [{
                    market: TOKEN_IN,
                    tvl: 1,
                    multiplier: 2,
                    fail_multiplier: 0,
                    chain_network: "monad-mainnet",
                    start_date: "2026-01-01",
                    end_date: "2026-01-02",
                    duration_in_days: 1,
                }],
                incentives: [{
                    market: TOKEN_IN,
                    type: "supply",
                    rate: 4,
                    description: "dist reward",
                    image: "stars-rewards",
                }],
            },
            async (urls) => {
                const rewards = await Api.getRewards(monadSetupSnapshot);

                assert.deepEqual(urls, [
                    "https://api.dist-smoke.example/v1/rewards/active/monad-mainnet",
                ]);
                assert.equal(rewards.milestones[TOKEN_IN]?.chain_network, "monad-mainnet");
                assert.equal(rewards.incentives[TOKEN_IN]?.[0]?.description, "dist reward");
            },
        );

        await withMockedFetch(
            {
                native_apy: [{ symbol: "WMON", apy: 3.14 }],
            },
            async (urls) => {
                const yields = await Api.fetchNativeYields(monadSetupSnapshot);

                assert.deepEqual(urls, [
                    "https://api.dist-smoke.example/v1/monad/native_apy",
                ]);
                assert.deepEqual(yields, [{ symbol: "WMON", apy: 3.14 }]);
            },
        );

        await withMockedFetch(
            [
                {
                    identifier: "dist-monad-lend",
                    apr: 10,
                    name: "dist-monad-lend",
                    type: "merkl",
                    action: "LEND",
                    chain: { id: 143, name: "Monad" },
                    chainId: 143,
                    computeChainId: 143,
                    distributionChainId: 143,
                    tokens: [{ address: TOKEN_IN, symbol: "WMON" }],
                },
                {
                    identifier: TOKEN_IN,
                    apr: 5,
                    name: "dist-metadata-less-lend",
                    type: "merkl",
                    tokens: [],
                },
                {
                    identifier: "dist-conflicting-lend",
                    apr: 100,
                    name: "dist-conflicting-lend",
                    type: "merkl",
                    chain: { id: 143, name: "Monad" },
                    distributionChainId: 1,
                    tokens: [{ address: TOKEN_IN, symbol: "WMON" }],
                },
                {
                    identifier: "dist-malformed-lend",
                    apr: 200,
                    name: "dist-malformed-lend",
                    type: "merkl",
                    chainId: "143",
                    tokens: [{ address: TOKEN_IN, symbol: "WMON" }],
                },
                {
                    identifier: "dist-wrong-action-lend",
                    apr: 300,
                    name: "dist-wrong-action-lend",
                    type: "merkl",
                    action: "BORROW",
                    chainId: 143,
                    tokens: [{ address: TOKEN_IN, symbol: "WMON" }],
                },
            ],
            async (urls) => {
                const opportunities = await packedSdk.fetchMerklOpportunities({ action: "LEND", chainId: 143 });

                assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("chainId")), ["143"]);
                assert.deepEqual(
                    opportunities.map((opportunity) => opportunity.identifier),
                    ["dist-monad-lend", TOKEN_IN],
                    "packed Merkl helper should reject conflicting or malformed explicit chain metadata",
                );
            },
        );
    } finally {
        sdk.chain_config["monad-mainnet"].services.curvanceApi.rewardsSlug = originalMonadRewardsSlug;
        sdk.chain_config["monad-mainnet"].services.curvanceApi.nativeYieldSlug = originalMonadNativeYieldSlug;
    }

    assert.equal(
        "optimalDeposit" in sdk.OptimizerReader.prototype,
        false,
        "dist should not expose removed OptimizerReader.optimalDeposit",
    );
    assert.equal(
        "optimalWithdrawal" in sdk.OptimizerReader.prototype,
        false,
        "dist should not expose removed OptimizerReader.optimalWithdrawal",
    );
    const optimizerReaderDist = readFileSync(
        path.join(__dirname, "..", "dist", "classes", "OptimizerReader.js"),
        "utf8",
    );
    assert.match(
        optimizerReaderDist,
        /function exchangeRate\(\) view returns \(uint256\)/,
        "dist OptimizerReader fallback ABI should use view-only exchangeRate",
    );
    assert.doesNotMatch(
        optimizerReaderDist,
        /exchangeRateUpdated/,
        "dist OptimizerReader fallback must not call non-view exchangeRateUpdated",
    );

    const calls = [];
    const signer = {
        address: "0x00000000000000000000000000000000000000aa",
        async sendTransaction(tx) {
            calls.push({ kind: "send", tx });
            return { hash: "0xlegacy" };
        },
        async call(tx) {
            calls.push({ kind: "call", tx });
            return "0x";
        },
    };

    const calldata = new SignerBackedCalldata(signer);
    const tx = await calldata.executeCallData("0x1234");
    assert.equal(tx.hash, "0xlegacy");

    const simulation = await calldata.simulateCallData("0x1234");
    assert.deepEqual(simulation, { success: true });

    assert.equal(calls.length, 2, "expected one send and one call through the signer path");
    assert.deepEqual(calls[0], {
        kind: "send",
        tx: {
            to: "0x00000000000000000000000000000000000000cc",
            data: "0x1234",
        },
    });
    assert.deepEqual(calls[1], {
        kind: "call",
        tx: {
            to: "0x00000000000000000000000000000000000000cc",
            data: "0x1234",
            from: signer.address,
        },
    });

    const kyber = new sdk.KyberSwap(FEE_RECEIVER);
    await assert.rejects(
        () => withMockedKyberFetch(
            kyber,
            "0x12345678",
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
        ),
        /KyberSwap calldata selector=0x12345678, expected 0xe21fd0e9/,
        "dist KyberSwap quote should fail closed on malformed current-router calldata",
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
