const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");
const Decimal = require("decimal.js");
const { Interface } = require("ethers");
const sdk = require("../dist/index.js");
const repoRoot = path.join(__dirname, "..");

const TOKEN_IN = "0x0000000000000000000000000000000000000001";
const TOKEN_OUT = "0x0000000000000000000000000000000000000002";
const WALLET = "0x0000000000000000000000000000000000000003";
const FEE_RECEIVER = "0x0000000000000000000000000000000000000004";
const MONAD_MARKET = "0xa6A2A92F126b79Ee0804845ee6B52899b4491093";
const MONAD_WMON_CTOKEN = "0x1e240E30E51491546deC3aF16B0b4EAC8Dd110D4";
const MONAD_USDC_CTOKEN = "0x8EE9FC28B8Da872c38A496e9dDB9700bb7261774";

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

function getProxiedMerklUrl(fetchUrl) {
    const proxyUrl = new URL(fetchUrl);
    assert.equal(proxyUrl.origin, "https://api2.curvance.com");
    assert.equal(proxyUrl.pathname, "/merkl/proxy");
    const merklUrl = proxyUrl.searchParams.get("url");
    assert.ok(merklUrl);
    return new URL(merklUrl);
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

function createPackedSnapshotMarket(packedSdk, { address, chain, chainId, name }) {
    const market = Object.create(packedSdk.Market.prototype);
    market.address = address;
    market.account = WALLET;
    market.setup = { chain, chainId };
    market.userDataScope = "full";
    market.tokens = [{
        address: TOKEN_IN,
        symbol: name,
        isBorrowable: true,
        getUserAssetBalance: () => Decimal(10),
        getUserCollateral: () => Decimal(4),
        getUserCollateralAssets: () => Decimal(4),
        getUserDebt: () => Decimal(2),
        getPrice: () => Decimal(1),
        getApy: () => Decimal(0.05),
        getBorrowRate: () => Decimal(0.08),
    }];
    Object.defineProperty(market, "name", {
        value: name,
        configurable: true,
    });
    Object.defineProperty(market, "positionHealth", {
        value: Decimal(1.25),
        configurable: true,
    });
    Object.defineProperty(market, "userDeposits", {
        value: Decimal(10),
        configurable: true,
    });
    Object.defineProperty(market, "userDebt", {
        value: Decimal(2),
        configurable: true,
    });
    Object.defineProperty(market, "userNet", {
        value: Decimal(8),
        configurable: true,
    });
    market.getUserDepositsChange = () => Decimal(0.5);
    market.getUserDebtChange = () => Decimal(0.1);
    return market;
}

function createPackedRefreshMarket(packedSdk, {
    address,
    tokenAddress,
    reader,
    setup,
    userAssetBalance = 0n,
    userShareBalance = 0n,
    userCollateral = 0n,
    userDebt = 0n,
}) {
    const market = Object.create(packedSdk.Market.prototype);
    market.address = address;
    market.account = null;
    market.reader = reader;
    market.setup = setup;
    market.cache = {
        static: {
            address,
            adapters: [],
            cooldownLength: 1200n,
            tokens: [{ address: tokenAddress }],
        },
        dynamic: createPackedRefreshDynamicMarket(address, tokenAddress),
        user: createPackedRefreshUserMarket(address, tokenAddress, {}),
        deploy: {},
    };

    const token = Object.create(packedSdk.CToken.prototype);
    token.address = tokenAddress;
    token.market = market;
    token.cache = {
        address: tokenAddress,
        decimals: 18n,
        asset: {
            address: tokenAddress,
            decimals: 18n,
        },
        userAssetBalance,
        userShareBalance,
        userUnderlyingBalance: 0n,
        userCollateral,
        userDebt,
        liquidationPrice: 0n,
    };
    market.tokens = [token];

    return market;
}

function createPackedRefreshDynamicMarket(address, tokenAddress) {
    return {
        address,
        tokens: [{
            address: tokenAddress,
            totalSupply: 10n,
            totalAssets: 11n,
            exchangeRate: 1n,
            collateral: 2n,
            debt: 3n,
            sharePrice: 4n,
            assetPrice: 5n,
            sharePriceLower: 6n,
            assetPriceLower: 7n,
            borrowRate: 0n,
            predictedBorrowRate: 0n,
            utilizationRate: 0n,
            supplyRate: 0n,
            liquidity: 8n,
        }],
    };
}

function createPackedRefreshUserMarket(address, tokenAddress, {
    userAssetBalance = 0n,
    userShareBalance = 0n,
    userCollateral = 0n,
    userDebt = 0n,
} = {}) {
    return {
        address,
        collateral: userCollateral,
        maxDebt: userDebt * 2n,
        debt: userDebt,
        positionHealth: userDebt > 0n ? 2n : 0n,
        cooldown: 1200n,
        errorCodeHit: false,
        priceStale: false,
        tokens: [{
            address: tokenAddress,
            userAssetBalance,
            userShareBalance,
            userUnderlyingBalance: 0n,
            userCollateral,
            userDebt,
            liquidationPrice: userDebt > 0n ? 9n : 0n,
        }],
    };
}

function createPackedRefreshUserSummary(address, {
    collateral = 0n,
    maxDebt = 0n,
    debt = 0n,
} = {}) {
    return {
        address,
        collateral,
        maxDebt,
        debt,
        positionHealth: debt > 0n ? 3n : 0n,
        cooldown: 1200n,
        errorCodeHit: false,
        priceStale: false,
    };
}

function createPackedRouteToken(packedSdk, {
    assetSymbol,
    excludedZapSymbols,
}) {
    const token = Object.create(packedSdk.CToken.prototype);
    const routeTestState = { availableTokenCalls: 0 };
    token.address = TOKEN_IN;
    token.routeTestState = routeTestState;
    token.provider = {
        getBalance: async () => 0n,
    };
    token.cache = {
        address: TOKEN_IN,
        name: `Curvance ${assetSymbol}`,
        symbol: `c${assetSymbol}`,
        decimals: 18n,
        asset: {
            address: TOKEN_IN,
            name: assetSymbol,
            symbol: assetSymbol,
            decimals: 18n,
        },
    };
    token.market = {
        signer: null,
        account: WALLET,
        plugins: {
            simplePositionManager: TOKEN_OUT,
        },
        dexAgg: {
            router: TOKEN_OUT,
            getAvailableTokens: async () => {
                routeTestState.availableTokenCalls += 1;
                return [{
                    interface: {
                        address: TOKEN_OUT,
                        decimals: 18n,
                        symbol: "USDC",
                        name: "USD Coin",
                    },
                    type: "simple",
                    quote: async () => ({
                        minOut_raw: 1n,
                        output_raw: 2n,
                        minOut: Decimal(1),
                        output: Decimal(2),
                    }),
                }];
            },
        },
        setup: {
            chain: "monad-mainnet",
            contracts: {
                OracleManager: FEE_RECEIVER,
                zappers: {
                    simpleZapper: TOKEN_OUT,
                },
            },
            assets: {
                native_symbol: "MON",
                native_name: "Monad",
                wrapped_native: packedSdk.chain_config["monad-mainnet"].wrapped_native,
                native_vaults: [],
                vaults: [],
                excluded_zap_symbols: excludedZapSymbols,
            },
        },
    };
    token.isWrappedNative = false;
    token.isNativeVault = false;
    token.isVault = false;
    token.refreshRouteCapabilities();
    return token;
}

function createPackedKyberContextMarket(symbol, assetAddress) {
    return {
        tokens: [{
            name: `Token ${symbol}`,
            symbol,
            getAsset: () => ({
                address: assetAddress,
                name: `Token ${symbol}`,
                symbol,
                decimals: 18n,
            }),
        }],
    };
}

function createPackedDecimalsReadProvider(chainId, decimals = 18n) {
    return {
        async call(tx) {
            if ((tx.data ?? "").slice(0, 10) !== "0x313ce567") {
                throw new Error(`Unexpected packed decimals provider call: ${JSON.stringify(tx)}`);
            }

            return `0x${decimals.toString(16).padStart(64, "0")}`;
        },
        async getNetwork() {
            return { chainId, name: `chain-${chainId}` };
        },
        async resolveName(name) {
            return name;
        },
    };
}

function createPackedBootStaticMarket(packedSdk) {
    return {
        address: MONAD_MARKET,
        adapters: [],
        cooldownLength: 1200n,
        tokens: [
            createPackedBootStaticToken(packedSdk, MONAD_WMON_CTOKEN, "WMON", packedSdk.chain_config["monad-mainnet"].wrapped_native),
            createPackedBootStaticToken(packedSdk, MONAD_USDC_CTOKEN, "USDC", TOKEN_IN),
        ],
    };
}

function createPackedBootStaticToken(packedSdk, cToken, symbol, asset) {
    void packedSdk;
    return {
        address: cToken,
        name: `Curvance ${symbol}`,
        symbol: `c${symbol}`,
        decimals: 18n,
        asset: {
            address: asset,
            name: symbol,
            symbol,
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
    };
}

function createPackedBootDynamicMarket() {
    return {
        address: MONAD_MARKET,
        tokens: [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN].map((address, index) => ({
            address,
            totalSupply: 10n + BigInt(index),
            totalAssets: 20n + BigInt(index),
            exchangeRate: 1n,
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
        })),
    };
}

function createPackedBootUserMarket() {
    return {
        address: MONAD_MARKET,
        collateral: 0n,
        maxDebt: 0n,
        debt: 0n,
        positionHealth: 0n,
        cooldown: 1200n,
        errorCodeHit: false,
        priceStale: false,
        tokens: [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN].map((address, index) => ({
            address,
            userAssetBalance: 100n + BigInt(index),
            userShareBalance: 0n,
            userUnderlyingBalance: 0n,
            userCollateral: 0n,
            userDebt: 0n,
            liquidationPrice: 0n,
        })),
    };
}

function createPackedBootMarketData(packedSdk) {
    return {
        staticMarket: [createPackedBootStaticMarket(packedSdk)],
        dynamicMarket: [createPackedBootDynamicMarket()],
        userData: {
            locks: [],
            markets: [createPackedBootUserMarket()],
        },
    };
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

function readPackMetadata(output, packDir) {
    const trimmedOutput = output.trim();

    if (trimmedOutput.length > 0) {
        const jsonStart = trimmedOutput.indexOf("[");
        if (jsonStart !== -1) {
            const [pack] = JSON.parse(trimmedOutput.slice(jsonStart));
            return pack;
        }
    }

    const tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, "npm pack should create exactly one tarball");

    const filename = tarballs[0];
    const tarball = path.join(packDir, filename);
    const listing = execFileSync("tar", ["-tzf", tarball], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const files = listing
        .trim()
        .split(/\r?\n/)
        .map((file) => file.replace(/^package\//, ""))
        .filter((file) => file.length > 0 && !file.endsWith("/"))
        .map((file) => ({ path: file }));

    return { filename, files };
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
        const pack = readPackMetadata(output, packDir);
        const tarball = path.join(packDir, pack.filename);
        execFileSync("tar", ["-xzf", tarball, "-C", packDir], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });
        process.once("exit", () => {
            rmSync(packDir, { recursive: true, force: true });
        });

        return run({
            files: new Set(pack.files.map((file) => file.path.replace(/\\/g, "/"))),
            packageRoot: path.join(packDir, "package"),
        });
    } catch (error) {
        rmSync(packDir, { recursive: true, force: true });
        throw error;
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
    assert.equal(typeof sdk.OracleManager, "function", "dist should export OracleManager");
    assert.equal(typeof sdk.PositionManager, "function", "dist should export PositionManager");
    assert.equal(typeof sdk.Zapper, "function", "dist should export Zapper");
    assert.equal(typeof sdk.OptimizerZapper, "function", "dist should export OptimizerZapper");
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
    assert.equal(typeof packedSdk.Api?.getRewards, "function", "packed package root should export Api helpers");
    assert.equal(typeof packedSdk.Market?.getAll, "function", "packed package root should export Market");
    assert.equal(typeof packedSdk.ProtocolReader, "function", "packed package root should export ProtocolReader");
    assert.equal(typeof packedSdk.OracleManager, "function", "packed package root should export OracleManager");
    assert.equal(typeof packedSdk.OptimizerReader, "function", "packed package root should export OptimizerReader");
    assert.equal(typeof packedSdk.PositionManager, "function", "packed package root should export PositionManager");
    assert.equal(typeof packedSdk.CToken, "function", "packed package root should export CToken");
    assert.equal(typeof packedSdk.Zapper, "function", "packed package root should export Zapper");
    assert.equal(typeof packedSdk.OptimizerZapper, "function", "packed package root should export OptimizerZapper");
    assert.equal(typeof packedSdk.KyberSwap, "function", "packed package root should export KyberSwap");
    assert.equal(typeof packedSdk.UnsupportedDexAgg, "function", "packed package root should export UnsupportedDexAgg");
    assert.equal(typeof packedSdk.getActiveUserMarkets, "function", "packed package root should export active-user helpers");
    assert.equal(typeof packedSdk.refreshActiveUserMarkets, "function", "packed package root should export full user refresh helpers");
    assert.equal(typeof packedSdk.refreshActiveUserMarketSummaries, "function", "packed package root should export summary user refresh helpers");
    assert.equal(typeof packedSdk.takePortfolioSnapshot, "function", "packed package root should export portfolio snapshots");
    assert.equal(typeof packedSdk.snapshotMarket, "function", "packed package root should export market snapshots");
    assert.equal(typeof packedSdk.getChainConfig, "function", "packed package root should export chain config helpers");
    assert.equal(typeof packedSdk.getContractAddresses, "function", "packed package root should export contract manifest helpers");
    assert.equal(typeof packedSdk.defaultFeePolicyForChain, "function", "packed package root should export default fee policy helpers");
    assert.equal(typeof packedSdk.fetchMerklOpportunities, "function", "packed package root should export Merkl helpers");
    assert.equal(typeof packedSdk.fetchMerklUserRewards, "function", "packed package root should export Merkl user reward helpers");
    assert.equal(typeof packedSdk.fetchMerklCampaignsBySymbol, "function", "packed package root should export Merkl campaign helpers");
    assert.equal(
        packedSdk.chain_config["monad-mainnet"].services.dexAggregators.kyberSwap.router,
        sdk.chain_config["monad-mainnet"].services.dexAggregators.kyberSwap.router,
        "packed package root should resolve built chain services through package main",
    );
    assert.equal(packedSdk.getChainConfig("monad-mainnet").chainId, 143);
    assert.equal(packedSdk.getChainConfig("arb-sepolia").chainId, 421614);
    assert.equal(
        packedSdk.getContractAddresses("monad-mainnet").CentralRegistry,
        sdk.getContractAddresses("monad-mainnet").CentralRegistry,
        "packed package root should resolve Monad contract manifests through package main",
    );
    assert.notEqual(
        packedSdk.getContractAddresses("monad-mainnet").CentralRegistry.toLowerCase(),
        packedSdk.getContractAddresses("arb-sepolia").CentralRegistry.toLowerCase(),
        "packed contract manifest helper should keep per-chain deployments distinct",
    );
    const packedMutableContractsCopy = packedSdk.getContractAddresses("monad-mainnet");
    packedMutableContractsCopy.CentralRegistry = packedSdk.EMPTY_ADDRESS;
    assert.notEqual(
        packedSdk.getContractAddresses("monad-mainnet").CentralRegistry.toLowerCase(),
        packedSdk.EMPTY_ADDRESS.toLowerCase(),
        "packed contract manifest helper should return a defensive copy",
    );
    const packedArbDefaultFeePolicy = packedSdk.defaultFeePolicyForChain("arb-sepolia", FEE_RECEIVER);
    assert.equal(
        packedArbDefaultFeePolicy.getFeeBps({
            operation: "zap",
            inputToken: packedSdk.NATIVE_ADDRESS,
            outputToken: packedSdk.chain_config["arb-sepolia"].wrapped_native,
            inputAmount: 1n,
            currentLeverage: null,
            targetLeverage: null,
        }),
        0n,
        "packed default fee policy should use the selected chain's wrapped native exemption",
    );
    assert.equal(
        packedArbDefaultFeePolicy.getFeeBps({
            operation: "zap",
            inputToken: packedSdk.NATIVE_ADDRESS,
            outputToken: packedSdk.chain_config["monad-mainnet"].wrapped_native,
            inputAmount: 1n,
            currentLeverage: null,
            targetLeverage: null,
        }),
        packedSdk.CURVANCE_FEE_BPS,
        "packed default fee policy should not leak another chain's wrapped native exemption",
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
                    excluded_zap_symbols: [],
                },
            },
        ),
        /requires a setup-bound DEX aggregator/i,
        "dist Zapper should fail closed instead of falling back to mutable chain config",
    );

    const packedZapperSetup = {
        chain: "monad-mainnet",
        feePolicy: packedSdk.NO_FEE_POLICY,
        assets: {
            native_symbol: "MON",
            native_name: "Monad",
            wrapped_native: packedSdk.chain_config["monad-mainnet"].wrapped_native,
            native_vaults: [],
            vaults: [],
            excluded_zap_symbols: [],
        },
    };
    const packedDirectZapper = Object.create(packedSdk.Zapper.prototype);
    packedDirectZapper.address = FEE_RECEIVER;
    packedDirectZapper.type = "simple";
    packedDirectZapper.signer = { address: WALLET };
    packedDirectZapper.setup = packedZapperSetup;
    packedDirectZapper.dexAgg = {
        quote: async () => {
            throw new Error("packed direct Zapper setup guard should run before DEX quote");
        },
    };
    packedDirectZapper.getCallData = () => {
        throw new Error("packed direct Zapper setup guard should run before calldata encoding");
    };
    const packedForeignZapperToken = Object.create(packedSdk.CToken.prototype);
    packedForeignZapperToken.address = TOKEN_IN;
    packedForeignZapperToken.market = {
        address: TOKEN_OUT,
        setup: {
            ...packedZapperSetup,
        },
    };
    packedForeignZapperToken.convertToShares = async () => {
        throw new Error("packed direct Zapper setup guard should run before token conversion");
    };

    await assert.rejects(
        () => packedDirectZapper.getSimpleZapCalldata(
            packedForeignZapperToken,
            TOKEN_IN,
            TOKEN_IN,
            1n,
            false,
            50n,
            WALLET,
        ),
        /without the same setup snapshot/i,
        "packed direct Zapper helpers should reject tokens from a different setup snapshot before calldata work",
    );
    const packedDirectZapperRouteCalls = [];
    const packedSameSetupZapperToken = Object.create(packedSdk.CToken.prototype);
    packedSameSetupZapperToken.address = TOKEN_IN;
    packedSameSetupZapperToken.market = {
        address: TOKEN_OUT,
        setup: packedZapperSetup,
    };
    packedSameSetupZapperToken.oracleRoute = async (calldata, overrides, receiver) => {
        packedDirectZapperRouteCalls.push({ calldata, overrides, receiver });
        return { hash: "0xpacked-direct-zap" };
    };
    packedDirectZapper.getSimpleZapCalldata = async (_ctoken, inputToken, _outputToken, amount, _collateralize, _slippage, receiver) => {
        assert.equal(receiver, WALLET);
        return inputToken.toLowerCase() === packedSdk.NATIVE_ADDRESS.toLowerCase()
            ? `0xnative${amount.toString(16)}`
            : `0xerc20${amount.toString(16)}`;
    };
    await packedDirectZapper.simpleZap(
        packedSameSetupZapperToken,
        packedSdk.NATIVE_ADDRESS,
        TOKEN_IN,
        20_000n,
        false,
        50n,
        WALLET,
    );
    await packedDirectZapper.simpleZap(
        packedSameSetupZapperToken,
        TOKEN_IN,
        TOKEN_IN,
        30_000n,
        false,
        50n,
        WALLET,
    );
    assert.deepEqual(
        packedDirectZapperRouteCalls,
        [
            {
                calldata: "0xnative4e20",
                overrides: { value: 20_000n, to: FEE_RECEIVER },
                receiver: WALLET,
            },
            {
                calldata: "0xerc207530",
                overrides: { to: FEE_RECEIVER },
                receiver: WALLET,
            },
        ],
        "packed direct Zapper.simpleZap should forward native value only for native input",
    );
    const packedUnsupportedDex = new packedSdk.UnsupportedDexAgg("arb-sepolia");
    assert.deepEqual(
        await packedUnsupportedDex.getAvailableTokens({}, "usdc", WALLET),
        [],
        "packed UnsupportedDexAgg should advertise no simple zap tokens",
    );
    await assert.rejects(
        () => packedUnsupportedDex.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1n, 50n),
        /DEX aggregation is not configured for arb-sepolia/i,
        "packed UnsupportedDexAgg should fail closed before quote construction",
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

    const packedExplicitProvider = { id: "packed-explicit-provider" };
    assert.equal(
        new packedSdk.ProtocolReader(TOKEN_IN, packedExplicitProvider, "monad-mainnet").provider,
        packedExplicitProvider,
        "packed ProtocolReader should preserve explicit detached providers",
    );
    assert.equal(
        new packedSdk.OracleManager(TOKEN_OUT, packedExplicitProvider).provider,
        packedExplicitProvider,
        "packed OracleManager should preserve explicit detached providers",
    );
    assert.equal(
        new packedSdk.OptimizerReader(TOKEN_OUT, packedExplicitProvider).provider,
        packedExplicitProvider,
        "packed OptimizerReader should preserve explicit detached providers",
    );
    const packedTokenReaderCalls = [];
    const packedReader = Object.create(packedSdk.ProtocolReader.prototype);
    const packedTokenReader = Object.create(packedSdk.ProtocolReader.prototype);
    packedReader.address = TOKEN_IN;
    packedTokenReader.address = TOKEN_IN;
    packedReader.batchKey = `monad-mainnet:${TOKEN_IN}`;
    packedTokenReader.batchKey = `monad-mainnet:${TOKEN_IN}`;
    packedReader.contract = {
        maxRedemptionOf: async (account, ctoken, bufferTime) => {
            packedTokenReaderCalls.push({ method: "maxRedemptionOf", account, ctoken, bufferTime });
            return [333n, 111n, false];
        },
        hypotheticalRedemptionOf: async (account, ctoken, shares, bufferTime) => {
            packedTokenReaderCalls.push({ method: "hypotheticalRedemptionOf", account, ctoken, shares, bufferTime });
            return [444n, 222n, true, false];
        },
        hypotheticalBorrowOf: async (account, ctoken, assets, bufferTime) => {
            packedTokenReaderCalls.push({ method: "hypotheticalBorrowOf", account, ctoken, assets, bufferTime });
            return [555n, 333n, true, false, true];
        },
    };
    const packedReaderToken = {
        address: TOKEN_OUT,
        market: {
            address: TOKEN_IN,
            reader: packedTokenReader,
            setup: { chain: "monad-mainnet" },
        },
    };
    const packedReaderResult = await packedReader.maxRedemptionOf(
        WALLET,
        packedReaderToken,
        60n,
    );
    const packedRedemptionPreview = await packedReader.hypotheticalRedemptionOf(
        WALLET,
        packedReaderToken,
        444n,
        120n,
    );
    const packedBorrowPreview = await packedReader.hypotheticalBorrowOf(
        WALLET,
        packedReaderToken,
        555n,
        180n,
    );
    assert.deepEqual(
        packedTokenReaderCalls,
        [
            { method: "maxRedemptionOf", account: WALLET, ctoken: TOKEN_OUT, bufferTime: 60n },
            { method: "hypotheticalRedemptionOf", account: WALLET, ctoken: TOKEN_OUT, shares: 444n, bufferTime: 120n },
            { method: "hypotheticalBorrowOf", account: WALLET, ctoken: TOKEN_OUT, assets: 555n, bufferTime: 180n },
        ],
        "packed ProtocolReader should accept token-object wrappers from the same deployment key",
    );
    assert.deepEqual(
        {
            maxCollateralizedShares: packedReaderResult.maxCollateralizedShares,
            maxUncollateralizedShares: packedReaderResult.maxUncollateralizedShares,
            errorCodeHit: packedReaderResult.errorCodeHit,
        },
        {
            maxCollateralizedShares: 333n,
            maxUncollateralizedShares: 111n,
            errorCodeHit: false,
        },
    );
    assert.deepEqual(
        {
            excess: packedRedemptionPreview.excess,
            deficit: packedRedemptionPreview.deficit,
            isPossible: packedRedemptionPreview.isPossible,
            oracleError: packedRedemptionPreview.oracleError,
            priceStale: packedRedemptionPreview.priceStale,
        },
        {
            excess: 444n,
            deficit: 222n,
            isPossible: true,
            oracleError: false,
            priceStale: false,
        },
    );
    assert.deepEqual(
        {
            excess: packedBorrowPreview.excess,
            deficit: packedBorrowPreview.deficit,
            isPossible: packedBorrowPreview.isPossible,
            loanSizeError: packedBorrowPreview.loanSizeError,
            oracleError: packedBorrowPreview.oracleError,
            priceStale: packedBorrowPreview.priceStale,
        },
        {
            excess: 555n,
            deficit: 333n,
            isPossible: true,
            loanSizeError: false,
            oracleError: true,
            priceStale: true,
        },
    );
    const packedDetachedReader = Object.create(packedSdk.ProtocolReader.prototype);
    const packedDetachedTokenReader = Object.create(packedSdk.ProtocolReader.prototype);
    packedDetachedReader.address = TOKEN_IN;
    packedDetachedTokenReader.address = TOKEN_IN;
    packedDetachedReader.batchKey = null;
    packedDetachedTokenReader.batchKey = null;
    let packedDetachedReaderCalled = false;
    packedDetachedReader.contract = {
        maxRedemptionOf: async () => {
            packedDetachedReaderCalled = true;
            throw new Error("packed ProtocolReader guard should run before detached reader RPC");
        },
    };
    const packedDetachedReaderToken = {
        address: TOKEN_OUT,
        market: {
            address: TOKEN_IN,
            reader: packedDetachedTokenReader,
            setup: { chain: "monad-mainnet" },
        },
    };
    await assert.rejects(
        () => packedDetachedReader.maxRedemptionOf(WALLET, packedDetachedReaderToken, 60n),
        /ProtocolReader .* cannot read redemption token/i,
        "packed ProtocolReader should reject same-address reader clones without deployment keys before contract reads",
    );
    assert.equal(packedDetachedReaderCalled, false);

    const packedLeverageToken = Object.create(packedSdk.CToken.prototype);
    packedLeverageToken.address = TOKEN_IN;
    packedLeverageToken.market = {
        address: TOKEN_IN,
        setup: { chain: "monad-mainnet" },
        reader: { batchKey: "monad-mainnet:packed-leverage-reader" },
    };
    const packedForeignBorrowToken = Object.create(packedSdk.CToken.prototype);
    packedForeignBorrowToken.address = TOKEN_OUT;
    packedForeignBorrowToken.market = {
        address: TOKEN_OUT,
        setup: { chain: "arb-sepolia" },
        reader: { batchKey: "arb-sepolia:packed-leverage-reader" },
    };
    assert.throws(
        () => packedLeverageToken.previewLeverageUp(Decimal(2), packedForeignBorrowToken),
        /Borrow token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
        "packed CToken leverage previews should reject foreign borrow tokens before math or RPC",
    );
    assert.throws(
        () => packedLeverageToken.previewLeverageDown(Decimal("1.5"), Decimal(2), packedForeignBorrowToken),
        /Borrow token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
        "packed CToken deleverage previews should reject foreign borrow tokens before math or RPC",
    );

    const packedDuplicateKyber = new packedSdk.KyberSwap(FEE_RECEIVER).withContext({
        markets: [
            {
                tokens: [{
                    name: "Wrapped Monad",
                    symbol: "WMON",
                    getAsset: () => ({ address: packedSdk.chain_config["monad-mainnet"].wrapped_native, symbol: "WMON" }),
                }],
            },
            {
                tokens: [{
                    name: "Liquid Staked Monad",
                    symbol: "shMON",
                    getAsset: () => ({ address: packedSdk.chain_config["monad-mainnet"].wrapped_native, symbol: "shMON" }),
                }],
            },
        ],
        feePolicy: packedSdk.NO_FEE_POLICY,
        checkerDao: FEE_RECEIVER,
    });
    const packedDuplicateZapTokens = await packedDuplicateKyber.getAvailableTokens({}, "staked", WALLET);
    assert.deepEqual(
        packedDuplicateZapTokens.map((token) => ({
            address: token.interface.address.toLowerCase(),
            symbol: token.interface.symbol,
            quoteable: typeof token.quote === "function",
        })),
        [{
            address: packedSdk.chain_config["monad-mainnet"].wrapped_native.toLowerCase(),
            symbol: "shMON",
            quoteable: true,
        }],
        "packed simple zap token search should not let a nonmatching duplicate hide a later matching alias",
    );

    const packedExcludedToken = createPackedRouteToken(packedSdk, {
        assetSymbol: "SAUSD",
        excludedZapSymbols: ["sAUSD"],
    });
    assert.deepEqual(packedExcludedToken.zapTypes, [], "packed CToken should suppress excluded zap routes");
    assert.deepEqual(packedExcludedToken.leverageTypes, [], "packed CToken should suppress excluded leverage routes");
    assert.deepEqual(
        (await packedExcludedToken.getDepositTokens()).map((option) => ({
            type: option.type,
            address: option.interface.address.toLowerCase(),
            quoteable: typeof option.quote === "function",
        })),
        [{ type: "none", address: TOKEN_IN, quoteable: false }],
        "packed CToken should leave only direct deposits for excluded route targets",
    );
    assert.equal(
        packedExcludedToken.routeTestState.availableTokenCalls,
        0,
        "packed excluded route targets should not query DEX deposit options",
    );

    const packedAllowedToken = createPackedRouteToken(packedSdk, {
        assetSymbol: "SAUSD",
        excludedZapSymbols: [],
    });
    assert.deepEqual(packedAllowedToken.zapTypes, ["simple"]);
    assert.deepEqual(packedAllowedToken.leverageTypes, ["simple"]);
    assert.deepEqual(
        (await packedAllowedToken.getDepositTokens()).map((option) => ({
            type: option.type,
            address: option.interface.address.toLowerCase(),
            quoteable: typeof option.quote === "function",
        })),
        [
            { type: "none", address: TOKEN_IN, quoteable: false },
            { type: "simple", address: TOKEN_OUT, quoteable: true },
            { type: "simple", address: packedSdk.NATIVE_ADDRESS.toLowerCase(), quoteable: false },
        ],
        "packed CToken should allow the same symbol when the setup snapshot does not exclude it",
    );
    assert.equal(
        packedAllowedToken.routeTestState.availableTokenCalls,
        1,
        "packed allowed route targets should query DEX deposit options once",
    );
    assert.deepEqual(
        (await packedAllowedToken.getDepositTokens("usd")).map((option) => ({
            type: option.type,
            symbol: option.interface.symbol,
            address: option.interface.address.toLowerCase(),
        })),
        [
            { type: "none", symbol: "SAUSD", address: TOKEN_IN },
            { type: "simple", symbol: "USDC", address: TOKEN_OUT },
        ],
        "packed CToken search should exclude synthetic native simple routes from nonmatching searches",
    );
    assert.deepEqual(
        (await packedAllowedToken.getDepositTokens("mon")).map((option) => ({
            type: option.type,
            symbol: option.interface.symbol,
            address: option.interface.address.toLowerCase(),
        })),
        [
            { type: "simple", symbol: "MON", address: packedSdk.NATIVE_ADDRESS.toLowerCase() },
        ],
        "packed CToken search should keep matching synthetic native simple routes",
    );

    const originalGetRewards = packedSdk.Api.getRewards;
    const originalGetAll = packedSdk.Market.getAll;
    const originalGetDaoAddress = packedSdk.ProtocolReader.prototype.getDaoAddress;
    let monadSetupSnapshot;
    const routeRefreshEvents = [];
    try {
        packedSdk.Api.getRewards = async () => ({
            milestones: {
                global: {
                    market: "global",
                    multiplier: 3,
                    tvl: 1,
                    chain_network: "monad-mainnet",
                },
            },
            incentives: {},
        });
        packedSdk.Market.getAll = async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
            const market = {
                address: setup.chain === "monad-mainnet" ? TOKEN_IN : TOKEN_OUT,
                setup,
                tokens: [],
            };
            market.tokens.push({
                refreshRouteCapabilities() {
                    routeRefreshEvents.push({
                        chain: setup.chain,
                        marketDexAgg: market.dexAgg,
                        exportedDexAgg: packedSdk.chain_config[setup.chain].dexAgg,
                        hasBoundDexAgg: market.dexAgg != null,
                    });
                },
            });
            return [market];
        };
        packedSdk.ProtocolReader.prototype.getDaoAddress = async () => FEE_RECEIVER;

        const setupResult = await packedSdk.setupChain("arb-sepolia", null, "https://api.dist-smoke.example");
        assert.equal(setupResult.chain, "arb-sepolia");
        assert.equal(setupResult.chainId, 421614);
        assert.equal(setupResult.setupConfigSnapshot.chain, "arb-sepolia");
        assert.equal(setupResult.setupConfigSnapshot.chainId, 421614);
        assert.equal(setupResult.setupConfigSnapshot.environment, "testnet");
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot), true);
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.contracts), true);
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.assets), true);
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.assets.excluded_zap_symbols), true);
        assert.notEqual(
            setupResult.setupConfigSnapshot.assets.native_vaults,
            packedSdk.chain_config["arb-sepolia"].native_vaults,
            "setup snapshot should clone chain asset arrays instead of sharing exported chain config",
        );
        assert.notEqual(
            setupResult.setupConfigSnapshot.assets.excluded_zap_symbols,
            packedSdk.chain_config["arb-sepolia"].excluded_zap_symbols,
            "setup snapshot should clone zap exclusion arrays instead of sharing exported chain config",
        );
        assert.deepEqual(setupResult.setupConfigSnapshot.assets, {
            native_symbol: packedSdk.chain_config["arb-sepolia"].native_symbol,
            native_name: packedSdk.chain_config["arb-sepolia"].native_name,
            wrapped_native: packedSdk.chain_config["arb-sepolia"].wrapped_native,
            native_vaults: [...packedSdk.chain_config["arb-sepolia"].native_vaults],
            vaults: [...packedSdk.chain_config["arb-sepolia"].vaults],
            excluded_zap_symbols: [...packedSdk.chain_config["arb-sepolia"].excluded_zap_symbols],
        });
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.services), true);
        assert.notEqual(
            setupResult.setupConfigSnapshot.services,
            packedSdk.chain_config["arb-sepolia"].services,
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
        assert.equal(setupResult.markets[0].dexAgg, setupResult.dexAgg);
        assert.equal(setupResult.global_milestone?.multiplier, 3);

        const monadSetupResult = await packedSdk.setupChain("monad-mainnet", null, "https://api.dist-smoke.example", {
            feePolicy: packedSdk.flatFeePolicy({
                bps: packedSdk.CURVANCE_FEE_BPS,
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
        assert.equal(Object.isFrozen(monadSetupResult.setupConfigSnapshot.assets.excluded_zap_symbols), true);
        assert.notEqual(
            monadSetupResult.setupConfigSnapshot.assets.native_vaults,
            packedSdk.chain_config["monad-mainnet"].native_vaults,
            "Monad setup snapshot should clone native vault arrays instead of sharing exported chain config",
        );
        assert.notEqual(
            monadSetupResult.setupConfigSnapshot.assets.excluded_zap_symbols,
            packedSdk.chain_config["monad-mainnet"].excluded_zap_symbols,
            "Monad setup snapshot should clone zap exclusion arrays instead of sharing exported chain config",
        );
        assert.deepEqual(monadSetupResult.setupConfigSnapshot.assets, {
            native_symbol: packedSdk.chain_config["monad-mainnet"].native_symbol,
            native_name: packedSdk.chain_config["monad-mainnet"].native_name,
            wrapped_native: packedSdk.chain_config["monad-mainnet"].wrapped_native,
            native_vaults: [...packedSdk.chain_config["monad-mainnet"].native_vaults],
            vaults: [...packedSdk.chain_config["monad-mainnet"].vaults],
            excluded_zap_symbols: [...packedSdk.chain_config["monad-mainnet"].excluded_zap_symbols],
        });
        assert.deepEqual(monadSetupResult.setupConfigSnapshot.services.curvanceApi, {
            rewardsSlug: "monad-mainnet",
            rewardChainAliases: ["monad"],
            nativeYieldSlug: "monad",
            suppressedNativeYieldSymbols: ["USDC"],
        });
        assert.deepEqual(
            monadSetupResult.setupConfigSnapshot.services.dexAggregators.kyberSwap,
            packedSdk.chain_config["monad-mainnet"].services.dexAggregators.kyberSwap,
        );
        assert.notEqual(
            monadSetupResult.dexAgg,
            packedSdk.chain_config["monad-mainnet"].dexAgg,
            "Monad setup should return a context-bound DEX aggregator instead of the exported singleton",
        );
        assert.equal(monadSetupResult.markets[0].setup, monadSetupResult.setupConfigSnapshot);
        assert.equal(monadSetupResult.markets[0].dexAgg, monadSetupResult.dexAgg);
        assert.equal(monadSetupResult.global_milestone?.multiplier, 3);
        monadSetupSnapshot = monadSetupResult.setupConfigSnapshot;
    } finally {
        packedSdk.Api.getRewards = originalGetRewards;
        packedSdk.Market.getAll = originalGetAll;
        packedSdk.ProtocolReader.prototype.getDaoAddress = originalGetDaoAddress;
    }
    assert.deepEqual(
        routeRefreshEvents.map((event) => ({
            chain: event.chain,
            hasBoundDexAgg: event.hasBoundDexAgg,
        })),
        [
            { chain: "arb-sepolia", hasBoundDexAgg: true },
            { chain: "monad-mainnet", hasBoundDexAgg: true },
        ],
        "packed setupChain should bind the result DEX adapter before refreshing token route metadata",
    );
    const monadRouteRefresh = routeRefreshEvents.find((event) => event.chain === "monad-mainnet");
    assert.ok(monadRouteRefresh);
    assert.notEqual(
        monadRouteRefresh.marketDexAgg,
        monadRouteRefresh.exportedDexAgg,
        "packed Monad setup should refresh routes with a context-bound DEX adapter",
    );

    const packedRefreshCalls = [];
    const packedMonadRefreshReader = {
        batchKey: "monad-mainnet:packed-active-reader",
        getMarketStates: async (addresses, account) => {
            packedRefreshCalls.push({ source: "monad-full", addresses, account });
            return {
                dynamicMarkets: addresses.map((address) =>
                    createPackedRefreshDynamicMarket(address, TOKEN_IN),
                ),
                userMarkets: addresses.map((address) =>
                    createPackedRefreshUserMarket(address, TOKEN_IN, { userAssetBalance: 17n }),
                ),
            };
        },
        getMarketSummaries: async (addresses, account) => {
            packedRefreshCalls.push({ source: "monad-summary", addresses, account });
            return addresses.map((address) =>
                createPackedRefreshUserSummary(address, { collateral: 19n, maxDebt: 20n }),
            );
        },
        getAllDynamicState: async (account) => {
            packedRefreshCalls.push({ source: "monad-snapshot", addresses: [TOKEN_IN], account });
            return {
                dynamicMarket: [createPackedRefreshDynamicMarket(TOKEN_IN, TOKEN_IN)],
                userData: {
                    markets: [createPackedRefreshUserMarket(TOKEN_IN, TOKEN_IN, { userAssetBalance: 41n })],
                },
            };
        },
    };
    const packedArbRefreshReader = {
        batchKey: "arb-sepolia:packed-active-reader",
        getMarketStates: async (addresses, account) => {
            packedRefreshCalls.push({ source: "arb-full", addresses, account });
            return {
                dynamicMarkets: addresses.map((address) =>
                    createPackedRefreshDynamicMarket(address, TOKEN_OUT),
                ),
                userMarkets: addresses.map((address) =>
                    createPackedRefreshUserMarket(address, TOKEN_OUT, { userDebt: 23n }),
                ),
            };
        },
        getMarketSummaries: async (addresses, account) => {
            packedRefreshCalls.push({ source: "arb-summary", addresses, account });
            return addresses.map((address) =>
                createPackedRefreshUserSummary(address, { collateral: 29n, maxDebt: 31n, debt: 23n }),
            );
        },
        getAllDynamicState: async (account) => {
            packedRefreshCalls.push({ source: "arb-snapshot", addresses: [TOKEN_IN], account });
            return {
                dynamicMarket: [createPackedRefreshDynamicMarket(TOKEN_IN, TOKEN_OUT)],
                userData: {
                    markets: [createPackedRefreshUserMarket(TOKEN_IN, TOKEN_OUT, { userDebt: 47n })],
                },
            };
        },
    };
    const packedMonadRefreshMarket = createPackedRefreshMarket(packedSdk, {
        address: TOKEN_IN,
        tokenAddress: TOKEN_IN,
        reader: packedMonadRefreshReader,
        setup: { chain: "monad-mainnet", chainId: 143 },
    });
    const packedArbRefreshMarket = createPackedRefreshMarket(packedSdk, {
        address: TOKEN_IN,
        tokenAddress: TOKEN_OUT,
        reader: packedArbRefreshReader,
        setup: { chain: "arb-sepolia", chainId: 421614 },
    });

    const packedActiveMarkets = await packedSdk.refreshActiveUserMarkets(
        WALLET,
        [packedMonadRefreshMarket, packedArbRefreshMarket],
    );
    assert.deepEqual(
        packedActiveMarkets,
        [packedMonadRefreshMarket, packedArbRefreshMarket],
        "packed full active-user refresh should keep same-address markets from different chains",
    );
    assert.deepEqual(
        packedRefreshCalls,
        [
            { source: "monad-full", addresses: [TOKEN_IN], account: WALLET },
            { source: "arb-full", addresses: [TOKEN_IN], account: WALLET },
        ],
        "packed full active-user refresh should group same-address markets by reader deployment",
    );
    assert.equal(packedMonadRefreshMarket.account, WALLET);
    assert.equal(packedArbRefreshMarket.account, WALLET);
    assert.equal(packedMonadRefreshMarket.tokens[0].cache.userAssetBalance, 17n);
    assert.equal(packedArbRefreshMarket.tokens[0].cache.userDebt, 23n);
    assert.deepEqual(
        packedSdk.getActiveUserMarkets([packedMonadRefreshMarket, packedArbRefreshMarket]),
        [packedMonadRefreshMarket, packedArbRefreshMarket],
        "packed active-user helper should read full refreshed token caches",
    );

    const packedSummaryMarkets = await packedSdk.refreshActiveUserMarketSummaries(
        WALLET,
        [packedMonadRefreshMarket, packedArbRefreshMarket],
    );
    assert.deepEqual(
        packedSummaryMarkets,
        [packedMonadRefreshMarket, packedArbRefreshMarket],
        "packed summary refresh should return every explicitly requested market",
    );
    assert.deepEqual(
        packedRefreshCalls,
        [
            { source: "monad-full", addresses: [TOKEN_IN], account: WALLET },
            { source: "arb-full", addresses: [TOKEN_IN], account: WALLET },
            { source: "monad-summary", addresses: [TOKEN_IN], account: WALLET },
            { source: "arb-summary", addresses: [TOKEN_IN], account: WALLET },
        ],
        "packed summary refresh should also group same-address markets by reader deployment",
    );
    assert.equal(packedMonadRefreshMarket.userDataScope, "summary");
    assert.equal(packedArbRefreshMarket.userDataScope, "summary");
    assert.throws(
        () => packedSdk.getActiveUserMarkets([packedMonadRefreshMarket]),
        /summary-only refresh/i,
        "packed active-user helper should fail closed after summary-only refresh",
    );
    const packedAutoPromotedSnapshot = await packedSdk.takePortfolioSnapshot(WALLET, {
        markets: [packedMonadRefreshMarket, packedArbRefreshMarket],
        allowMixedChains: true,
    });
    assert.deepEqual(
        packedRefreshCalls.slice(-2),
        [
            { source: "monad-full", addresses: [TOKEN_IN], account: WALLET },
            { source: "arb-full", addresses: [TOKEN_IN], account: WALLET },
        ],
        "packed portfolio snapshot should promote summary-scoped same-address markets through full grouped refresh",
    );
    assert.equal(packedMonadRefreshMarket.userDataScope, "full");
    assert.equal(packedArbRefreshMarket.userDataScope, "full");
    assert.deepEqual(
        packedAutoPromotedSnapshot.markets.map((market) => ({
            address: market.marketAddress,
            chain: market.chain,
            chainId: market.chainId,
        })),
        [
            { address: TOKEN_IN, chain: "monad-mainnet", chainId: 143 },
            { address: TOKEN_IN, chain: "arb-sepolia", chainId: 421614 },
        ],
        "packed portfolio snapshot should preserve chain provenance after summary auto-promotion",
    );
    const packedRefreshedSnapshot = await packedSdk.takePortfolioSnapshot(WALLET, {
        markets: [packedMonadRefreshMarket, packedArbRefreshMarket],
        refresh: true,
        allowMixedChains: true,
    });
    assert.deepEqual(
        packedRefreshCalls.slice(-2),
        [
            { source: "monad-snapshot", addresses: [TOKEN_IN], account: WALLET },
            { source: "arb-snapshot", addresses: [TOKEN_IN], account: WALLET },
        ],
        "packed portfolio snapshot refresh should group same-address markets by reader deployment",
    );
    assert.equal(packedMonadRefreshMarket.userDataScope, "full");
    assert.equal(packedArbRefreshMarket.userDataScope, "full");
    assert.deepEqual(
        packedRefreshedSnapshot.markets.map((market) => ({
            address: market.marketAddress,
            chain: market.chain,
            chainId: market.chainId,
        })),
        [
            { address: TOKEN_IN, chain: "monad-mainnet", chainId: 143 },
            { address: TOKEN_IN, chain: "arb-sepolia", chainId: 421614 },
        ],
        "packed portfolio snapshot refresh should preserve per-market chain provenance for same-address markets",
    );

    const packedCooldownCalls = [];
    const packedCooldownNow = BigInt(Math.floor(Date.now() / 1000));
    const packedCooldownReader = {
        address: "0x0000000000000000000000000000000000000c01",
        batchKey: "monad-mainnet:packed-cooldown-reader",
        marketMultiCooldown: async (addresses, account) => {
            packedCooldownCalls.push({ addresses, account });
            return [1200n, packedCooldownNow + 60n];
        },
    };
    const packedCooldownPeerReader = {
        address: "0x0000000000000000000000000000000000000c02",
        batchKey: "monad-mainnet:packed-cooldown-reader",
    };
    const packedCooldownBase = createPackedRefreshMarket(packedSdk, {
        address: TOKEN_IN,
        tokenAddress: TOKEN_IN,
        reader: packedCooldownReader,
        setup: { chain: "monad-mainnet", chainId: 143 },
    });
    const packedCooldownPeer = createPackedRefreshMarket(packedSdk, {
        address: TOKEN_OUT,
        tokenAddress: TOKEN_OUT,
        reader: packedCooldownPeerReader,
        setup: { chain: "monad-mainnet", chainId: 143 },
    });
    packedCooldownBase.account = WALLET;
    packedCooldownPeer.account = WALLET;

    const packedDetachedCooldownPeer = createPackedRefreshMarket(packedSdk, {
        address: TOKEN_OUT,
        tokenAddress: TOKEN_OUT,
        reader: {
            address: packedCooldownReader.address,
            batchKey: null,
            marketMultiCooldown: async () => {
                throw new Error("packed cooldown guard should run before detached reader RPC");
            },
        },
        setup: { chain: "monad-mainnet", chainId: 143 },
    });
    packedDetachedCooldownPeer.account = WALLET;
    await assert.rejects(
        () => packedCooldownBase.multiHoldExpiresAt([
            packedCooldownBase,
            packedDetachedCooldownPeer,
        ]),
        /Cannot batch cooldowns across different ProtocolReader deployments/i,
        "packed cooldown batching should reject same-address reader clones without deployment keys before RPC",
    );
    assert.deepEqual(packedCooldownCalls, []);

    const packedCooldowns = await packedCooldownBase.multiHoldExpiresAt([
        packedCooldownBase,
        packedCooldownPeer,
    ]);
    assert.deepEqual(
        packedCooldownCalls,
        [{ addresses: [TOKEN_IN, TOKEN_OUT], account: WALLET }],
        "packed cooldown batching should accept same-deployment reader objects",
    );
    assert.equal(packedCooldowns[TOKEN_IN], null);
    assert.equal(packedCooldowns[TOKEN_OUT]?.getTime(), Number((packedCooldownNow + 60n) * 1000n));

    const packedVaultPreviewCalls = [];
    const packedVaultConvertCalls = [];
    const packedVaultSetup = { chain: "monad-mainnet" };
    const packedVaultMarketAddress = "0x0000000000000000000000000000000000000def";
    const packedVaultReaderKey = "monad-mainnet:packed-vault-planner";
    const packedVaultDepositToken = Object.create(packedSdk.CToken.prototype);
    packedVaultDepositToken.address = TOKEN_IN;
    packedVaultDepositToken.market = {
        address: packedVaultMarketAddress,
        setup: packedVaultSetup,
        reader: {
            address: "0x0000000000000000000000000000000000000a01",
            batchKey: packedVaultReaderKey,
        },
    };
    packedVaultDepositToken.cache = {
        asset: { address: TOKEN_IN, decimals: 18n },
        decimals: 18n,
    };
    packedVaultDepositToken.getUnderlyingVault = () => ({
        previewDeposit: async (assets) => {
            packedVaultPreviewCalls.push(assets);
            return 20_000n;
        },
    });
    packedVaultDepositToken.convertToShares = async (assets) => {
        packedVaultConvertCalls.push(assets);
        return assets + 2n;
    };

    const packedVaultBorrowToken = Object.create(packedSdk.CToken.prototype);
    packedVaultBorrowToken.address = TOKEN_OUT;
    packedVaultBorrowToken.market = {
        address: packedVaultMarketAddress,
        setup: packedVaultSetup,
        reader: {
            address: "0x0000000000000000000000000000000000000a02",
            batchKey: packedVaultReaderKey,
        },
    };
    packedVaultBorrowToken.cache = {
        asset: { address: TOKEN_OUT, decimals: 6n },
        decimals: 18n,
    };

    const packedVaultDetachedBorrowToken = Object.create(packedSdk.CToken.prototype);
    packedVaultDetachedBorrowToken.address = TOKEN_OUT;
    packedVaultDetachedBorrowToken.market = {
        address: packedVaultMarketAddress,
        setup: packedVaultSetup,
        reader: {
            address: "0x0000000000000000000000000000000000000a01",
            batchKey: null,
        },
    };
    packedVaultDetachedBorrowToken.cache = {
        asset: { address: TOKEN_OUT, decimals: 6n },
        decimals: 18n,
    };
    await assert.rejects(
        () => packedSdk.PositionManager.getVaultExpectedShares(
            packedVaultDepositToken,
            packedVaultDetachedBorrowToken,
            Decimal("1.25"),
        ),
        /Vault expected shares for deposit token .* with a different reader deployment/i,
        "packed PositionManager should reject same-address reader clones without deployment keys before amount scaling",
    );
    assert.deepEqual(packedVaultPreviewCalls, []);
    assert.deepEqual(packedVaultConvertCalls, []);

    assert.equal(
        await packedSdk.PositionManager.getVaultExpectedShares(
            packedVaultDepositToken,
            packedVaultBorrowToken,
            Decimal("1.25"),
        ),
        19_998n,
        "packed PositionManager should accept same-deployment reader objects for vault expected shares",
    );
    assert.deepEqual(packedVaultPreviewCalls, [1_250_000n]);
    assert.deepEqual(packedVaultConvertCalls, [19_996n]);

    const originalPackedSupportGetRewards = packedSdk.Api.getRewards;
    const originalPackedSupportGetAll = packedSdk.Market.getAll;
    const originalPackedSupportGetDaoAddress = packedSdk.ProtocolReader.prototype.getDaoAddress;
    try {
        packedSdk.Api.getRewards = async () => ({ milestones: {}, incentives: {} });
        packedSdk.Market.getAll = async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => [{
            address: setup.chain === "monad-mainnet" ? TOKEN_IN : TOKEN_OUT,
            setup,
            tokens: [],
        }];
        packedSdk.ProtocolReader.prototype.getDaoAddress = async () => FEE_RECEIVER;

        const packedMonadSupportResult = await packedSdk.setupChain("monad-mainnet", null, "https://api.packed-support-monad.example", {
            feePolicy: packedSdk.flatFeePolicy({
                bps: packedSdk.CURVANCE_FEE_BPS,
                feeReceiver: FEE_RECEIVER,
                chain: "monad-mainnet",
            }),
            readProvider: createPackedDecimalsReadProvider(143n),
        });
        const packedMonadDefaultReader = new packedSdk.ProtocolReader(
            packedMonadSupportResult.setupConfigSnapshot.contracts.ProtocolReader,
            undefined,
            "monad-mainnet",
        );
        const packedMonadDefaultOracle = new packedSdk.OracleManager(
            packedMonadSupportResult.setupConfigSnapshot.contracts.OracleManager,
        );
        const packedMonadDefaultOptimizerReader = new packedSdk.OptimizerReader(
            packedMonadSupportResult.setupConfigSnapshot.contracts.ProtocolReader,
        );

        const packedArbSupportResult = await packedSdk.setupChain("arb-sepolia", null, "https://api.packed-support-arb.example", {
            readProvider: createPackedDecimalsReadProvider(421614n),
        });
        const packedArbDefaultReader = new packedSdk.ProtocolReader(
            packedArbSupportResult.setupConfigSnapshot.contracts.ProtocolReader,
            undefined,
            "arb-sepolia",
        );

        assert.equal(
            packedMonadDefaultReader.provider,
            packedMonadSupportResult.setupConfigSnapshot.readProvider,
            "packed default ProtocolReader should keep the setup-time read provider after singleton movement",
        );
        assert.equal(
            packedMonadDefaultOracle.provider,
            packedMonadSupportResult.setupConfigSnapshot.readProvider,
            "packed default OracleManager should keep the setup-time read provider after singleton movement",
        );
        assert.equal(
            packedMonadDefaultOptimizerReader.provider,
            packedMonadSupportResult.setupConfigSnapshot.readProvider,
            "packed default OptimizerReader should keep the setup-time read provider after singleton movement",
        );
        assert.equal(packedArbDefaultReader.provider, packedArbSupportResult.setupConfigSnapshot.readProvider);
        assert.notEqual(packedMonadDefaultReader.provider, packedArbDefaultReader.provider);
        assert.notEqual(packedMonadDefaultReader.batchKey, packedArbDefaultReader.batchKey);
        assert.equal(
            packedSdk.getChainConfig().chainId,
            packedArbSupportResult.chainId,
            "packed getChainConfig() without an explicit chain should follow the latest published setup",
        );

        const packedOptimizerAddress = "0x0000000000000000000000000000000000000f01";
        const packedOptimizerSent = [];
        const packedOptimizerAllowanceChecks = [];
        const packedOptimizerSigner = {
            address: WALLET,
            provider: packedMonadSupportResult.setupConfigSnapshot.readProvider,
            sendTransaction: async (tx) => {
                packedOptimizerSent.push(tx);
                return { hash: "0xpacked-optimizer" };
            },
        };
        const packedOptimizerAsset = {
            provider: packedMonadSupportResult.setupConfigSnapshot.readProvider,
            signer: packedOptimizerSigner,
            decimals: 0n,
            symbol: "pTOK",
            allowance: async (owner, spender) => {
                packedOptimizerAllowanceChecks.push({ owner, spender });
                return 10n;
            },
        };
        const packedOptimizer = new packedSdk.LendingOptimizer(
            packedOptimizerAddress,
            packedOptimizerAsset,
        );
        const packedOptimizerTx = await packedOptimizer.deposit(1);

        assert.equal(
            packedOptimizer.provider,
            packedMonadSupportResult.setupConfigSnapshot.readProvider,
            "packed LendingOptimizer should prefer the asset-bound provider after setup moves to another chain",
        );
        assert.equal(
            packedOptimizer.signer,
            packedOptimizerSigner,
            "packed LendingOptimizer should prefer the asset-bound signer after setup moves to another chain",
        );
        assert.deepEqual(packedOptimizerTx, { hash: "0xpacked-optimizer" });
        assert.deepEqual(packedOptimizerAllowanceChecks, [{
            owner: WALLET,
            spender: packedOptimizerAddress,
        }]);
        assert.equal(packedOptimizerSent.length, 1);
        assert.equal(packedOptimizerSent[0].to, packedOptimizerAddress);
        const packedOptimizerReader = Object.create(packedSdk.OptimizerReader.prototype);
        packedOptimizerReader.contract = {
            optimalRebalance: async (optimizer, slippageBps, rebalanceChunks) => {
                assert.equal(optimizer, packedOptimizerAddress);
                assert.equal(slippageBps, 31n);
                assert.equal(rebalanceChunks, 200n);
                return {
                    actions: [
                        { cToken: TOKEN_IN, assetsOrBps: 1200n },
                        { cToken: TOKEN_OUT, assets: -800n },
                    ],
                    bounds: [
                        { cToken: TOKEN_IN, minBps: 2500n, maxBps: 5000n },
                        { cToken: TOKEN_OUT, minBps: 5000n, maxBps: 7500n },
                    ],
                };
            },
        };
        const packedRebalancePlan = await packedOptimizerReader.optimalRebalance(packedOptimizerAddress, 31n);
        await packedOptimizer.rebalance(packedRebalancePlan);
        assert.equal(packedOptimizerSent.length, 2);
        assert.equal(packedOptimizerSent[1].to, packedOptimizerAddress);
        const packedRebalanceDecoded = packedOptimizer.contract.interface.decodeFunctionData(
            "rebalance",
            packedOptimizerSent[1].data,
        );
        assert.deepEqual(
            packedRebalanceDecoded[0].map((action) => ({
                cToken: action.cToken.toLowerCase(),
                assetsOrBps: action.assetsOrBps,
            })),
            [
                { cToken: TOKEN_IN.toLowerCase(), assetsOrBps: 1200n },
                { cToken: TOKEN_OUT.toLowerCase(), assetsOrBps: -800n },
            ],
            "packed OptimizerReader rebalance plans should execute through packed LendingOptimizer calldata unchanged",
        );
        assert.deepEqual(
            packedRebalanceDecoded[1].map((bound) => ({
                cToken: bound.cToken.toLowerCase(),
                minBps: bound.minBps,
                maxBps: bound.maxBps,
            })),
            [
                { cToken: TOKEN_IN.toLowerCase(), minBps: 2500n, maxBps: 5000n },
                { cToken: TOKEN_OUT.toLowerCase(), minBps: 5000n, maxBps: 7500n },
            ],
            "packed LendingOptimizer rebalance should preserve optimizer-reader allocation bounds",
        );

        const packedApprovalCalls = [];
        const packedPluginApprovalCalls = [];
        const originalPackedErc20Approve = packedSdk.ERC20.prototype.approve;
        try {
            packedSdk.ERC20.prototype.approve = async function(spender, amount) {
                packedApprovalCalls.push({
                    token: this.address,
                    spender,
                    amount: amount == null ? null : String(amount),
                    signer: this.signer,
                    provider: this.provider,
                });
                return { hash: "0xpacked-approval" };
            };

            const packedApprovalToken = Object.create(packedSdk.CToken.prototype);
            packedApprovalToken.provider = packedMonadSupportResult.setupConfigSnapshot.readProvider;
            packedApprovalToken.address = MONAD_WMON_CTOKEN;
            packedApprovalToken.market = {
                signer: packedOptimizerSigner,
                account: WALLET,
                setup: packedMonadSupportResult.setupConfigSnapshot,
                plugins: {},
                dexAgg: packedMonadSupportResult.dexAgg,
            };
            packedApprovalToken.cache = {
                asset: {
                    address: TOKEN_OUT,
                    decimals: 18n,
                    symbol: "pTOK",
                },
                decimals: 18n,
            };
            packedApprovalToken.getWriteContract = function() {
                return {
                    setDelegateApproval: async (plugin, approved) => {
                        packedPluginApprovalCalls.push({
                            plugin,
                            approved,
                            signer: this.signer,
                        });
                        return { hash: "0xpacked-plugin-approval" };
                    },
                };
            };

            await packedApprovalToken.approveUnderlying(new Decimal(1));
            await packedApprovalToken.approve(new Decimal(2), TOKEN_IN);
            await packedApprovalToken.approveZapAsset({
                type: "simple",
                inputToken: TOKEN_IN,
                slippage: new Decimal("0.01"),
            }, new Decimal(3));
            await packedApprovalToken.approvePlugin("simple", "zapper");
        } finally {
            packedSdk.ERC20.prototype.approve = originalPackedErc20Approve;
        }
        assert.deepEqual(
            packedApprovalCalls.map((call) => ({
                token: call.token.toLowerCase(),
                spender: call.spender.toLowerCase(),
                amount: call.amount,
                signer: call.signer,
                provider: call.provider,
            })),
            [
                {
                    token: TOKEN_OUT.toLowerCase(),
                    spender: MONAD_WMON_CTOKEN.toLowerCase(),
                    amount: "1",
                    signer: packedOptimizerSigner,
                    provider: packedMonadSupportResult.setupConfigSnapshot.readProvider,
                },
                {
                    token: MONAD_WMON_CTOKEN.toLowerCase(),
                    spender: TOKEN_IN.toLowerCase(),
                    amount: "2",
                    signer: packedOptimizerSigner,
                    provider: packedMonadSupportResult.setupConfigSnapshot.readProvider,
                },
                {
                    token: TOKEN_IN.toLowerCase(),
                    spender: String(packedMonadSupportResult.setupConfigSnapshot.contracts.zappers.simpleZapper).toLowerCase(),
                    amount: "3",
                    signer: packedOptimizerSigner,
                    provider: packedMonadSupportResult.setupConfigSnapshot.readProvider,
                },
            ],
            "packed cToken approval helpers should use the token setup signer/provider and setup-owned spender targets",
        );
        assert.deepEqual(packedPluginApprovalCalls, [{
            plugin: packedMonadSupportResult.setupConfigSnapshot.contracts.zappers.simpleZapper,
            approved: true,
            signer: packedOptimizerSigner,
        }]);

        const packedCollateralInterface = new Interface([
            "function redeemCollateralFor(uint256 shares,address receiver,address owner)",
            "function removeCollateral(uint256 shares)",
        ]);
        const packedCollateralTransactions = [];
        const packedCollateralRefreshes = [];
        const packedCollateralPreflights = [];
        let packedCollateralFetches = 0;
        const packedCollateralSigner = {
            address: WALLET,
            sendTransaction: async (tx) => {
                packedCollateralTransactions.push(tx);
                return {
                    hash: "0xpacked-collateral",
                    wait: async () => ({ status: 1 }),
                };
            },
        };
        const packedCollateralToken = Object.create(packedSdk.CToken.prototype);
        packedCollateralToken.provider = packedMonadSupportResult.setupConfigSnapshot.readProvider;
        packedCollateralToken.address = MONAD_WMON_CTOKEN;
        packedCollateralToken.contract = {
            interface: packedCollateralInterface,
            isDelegate: async (owner, delegate) => owner === TOKEN_OUT && delegate === WALLET,
            allowance: async () => {
                throw new Error("packed delegated redeemCollateral should not check share allowance");
            },
        };
        packedCollateralToken.cache = {
            address: MONAD_WMON_CTOKEN,
            symbol: "cWMON",
            decimals: 18n,
            totalSupply: 10n,
            totalAssets: 10n,
            asset: {
                address: TOKEN_OUT,
                decimals: 18n,
                symbol: "WMON",
            },
        };
        packedCollateralToken.market = {
            signer: packedCollateralSigner,
            account: WALLET,
            setup: packedMonadSupportResult.setupConfigSnapshot,
            userDebt: new Decimal(0),
            reader: {
                maxRedemptionOf: async (account, token, bufferTime) => {
                    packedCollateralPreflights.push({ account, token: token.address, bufferTime });
                    return {
                        maxCollateralizedShares: 123n,
                        maxUncollateralizedShares: 456n,
                        errorCodeHit: false,
                    };
                },
            },
            reloadUserData: async (account) => {
                packedCollateralRefreshes.push(account);
            },
        };
        packedCollateralToken.fetchUserCollateral = async () => {
            packedCollateralFetches += 1;
            return 0n;
        };

        const packedRedeemCollateralTx = await packedCollateralToken.redeemCollateral(
            new Decimal(1),
            TOKEN_IN,
            TOKEN_OUT,
        );
        const packedRedeemCollateralDecoded = packedCollateralInterface.decodeFunctionData(
            "redeemCollateralFor",
            packedCollateralTransactions[0].data,
        );
        const packedRemoveMaxCollateralTx = await packedCollateralToken.removeMaxCollateral();
        const packedRemoveMaxCollateralDecoded = packedCollateralInterface.decodeFunctionData(
            "removeCollateral",
            packedCollateralTransactions[1].data,
        );

        assert.equal(packedRedeemCollateralTx.hash, "0xpacked-collateral");
        assert.equal(packedRemoveMaxCollateralTx.hash, "0xpacked-collateral");
        assert.equal(packedCollateralTransactions.length, 2);
        assert.equal(packedCollateralTransactions[0].to, MONAD_WMON_CTOKEN);
        assert.equal(packedCollateralTransactions[1].to, MONAD_WMON_CTOKEN);
        assert.ok(packedRedeemCollateralDecoded[0] > 0n);
        assert.equal(packedRedeemCollateralDecoded[1], TOKEN_IN);
        assert.equal(packedRedeemCollateralDecoded[2], TOKEN_OUT);
        assert.equal(packedRemoveMaxCollateralDecoded[0], 123n);
        assert.deepEqual(packedCollateralPreflights, [{
            account: WALLET,
            token: MONAD_WMON_CTOKEN,
            bufferTime: 0n,
        }]);
        assert.equal(packedCollateralFetches, 1);
        assert.deepEqual(
            packedCollateralRefreshes,
            [WALLET, WALLET],
            "packed collateral writes should keep signer-backed refreshes on the signer account",
        );

        await assert.rejects(
            () => packedSdk.setupChain("arb-sepolia", null, "https://api.packed-wrong-fee-chain.example", {
                readProvider: createPackedDecimalsReadProvider(421614n),
                feePolicy: packedSdk.flatFeePolicy({
                    bps: packedSdk.CURVANCE_FEE_BPS,
                    feeReceiver: FEE_RECEIVER,
                    chain: "monad-mainnet",
                }),
            }),
            /Fee policy for monad-mainnet cannot be used with setupChain\('arb-sepolia'\)/i,
            "packed setupChain should reject a fee policy bound to a different chain",
        );

        {
            const originalFetch = globalThis.fetch;
            const poisonReadProvider = createPackedDecimalsReadProvider(421614n);
            let networkCalls = 0;
            let fetchCalls = 0;
            poisonReadProvider.getNetwork = async () => {
                networkCalls += 1;
                throw new Error("packed read-provider validation should not run for invalid API URLs");
            };
            globalThis.fetch = async () => {
                fetchCalls += 1;
                throw new Error("packed reward fetch should not run for invalid API URLs");
            };
            try {
                await assert.rejects(
                    () => packedSdk.setupChain(
                        "arb-sepolia",
                        poisonReadProvider,
                        "http://api.packed-invalid.example",
                    ),
                    /api_url must use HTTPS/i,
                    "packed setupChain should reject invalid API URLs before boot side effects",
                );
                assert.equal(networkCalls, 0);
                assert.equal(fetchCalls, 0);
            } finally {
                globalThis.fetch = originalFetch;
            }
        }
    } finally {
        packedSdk.Api.getRewards = originalPackedSupportGetRewards;
        packedSdk.Market.getAll = originalPackedSupportGetAll;
        packedSdk.ProtocolReader.prototype.getDaoAddress = originalPackedSupportGetDaoAddress;
    }

    const originalPackedMonadDexAgg = packedSdk.chain_config["monad-mainnet"].dexAgg;
    const originalSameChainGetRewards = packedSdk.Api.getRewards;
    const originalSameChainGetAll = packedSdk.Market.getAll;
    const originalSameChainGetDaoAddress = packedSdk.ProtocolReader.prototype.getDaoAddress;
    const firstDao = "0x0000000000000000000000000000000000000dA1";
    const secondDao = "0x0000000000000000000000000000000000000dA2";
    const packedContextBindings = [];
    const packedContextQuoteCalls = [];
    let sameChainDaoLookup = 0;
    try {
        packedSdk.Api.getRewards = async () => ({ milestones: {}, incentives: {} });
        packedSdk.Market.getAll = async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => [{
            address: setup.api_url.includes("first") ? TOKEN_IN : TOKEN_OUT,
            symbol: setup.api_url.includes("first") ? "FIRST" : "SECOND",
            setup,
            tokens: [],
        }];
        packedSdk.ProtocolReader.prototype.getDaoAddress = async () => {
            sameChainDaoLookup += 1;
            return sameChainDaoLookup === 1 ? firstDao : secondDao;
        };
        packedSdk.chain_config["monad-mainnet"].dexAgg = {
            dao: FEE_RECEIVER,
            router: TOKEN_OUT,
            withContext(context) {
                const binding = {
                    apiUrl: context.markets[0].setup.api_url,
                    checkerDao: context.checkerDao,
                    feeReceiver: context.feePolicy.feeReceiver,
                    marketSymbols: context.markets.map((market) => market.symbol),
                };
                packedContextBindings.push(binding);

                return {
                    dao: context.checkerDao,
                    router: TOKEN_OUT,
                    getAvailableTokens: async () => [{
                        interface: { address: TOKEN_OUT, symbol: binding.marketSymbols[0] },
                        type: "simple",
                        quote: async () => {
                            packedContextQuoteCalls.push({
                                apiUrl: binding.apiUrl,
                                checkerDao: context.checkerDao,
                                feeBps: context.feePolicy.getFeeBps({
                                    operation: "zap",
                                    inputToken: TOKEN_IN,
                                    outputToken: TOKEN_OUT,
                                    inputAmount: 1n,
                                    currentLeverage: null,
                                    targetLeverage: null,
                                }),
                                feeReceiver: context.feePolicy.feeReceiver,
                            });
                            return {
                                minOut_raw: 1n,
                                output_raw: 2n,
                                minOut: Decimal(1),
                                output: Decimal(2),
                            };
                        },
                    }],
                    quoteAction: async () => {
                        throw new Error("packed same-chain quoteAction is not used");
                    },
                    quoteMin: async () => 1n,
                    quote: async () => ({
                        to: TOKEN_OUT,
                        calldata: "0x",
                        min_out: 1n,
                        out: 2n,
                    }),
                };
            },
            getAvailableTokens: async () => {
                throw new Error("packed unbound same-chain dex adapter was used");
            },
            quoteAction: async () => {
                throw new Error("packed unbound same-chain dex adapter was used");
            },
            quoteMin: async () => {
                throw new Error("packed unbound same-chain dex adapter was used");
            },
            quote: async () => {
                throw new Error("packed unbound same-chain dex adapter was used");
            },
        };

        const firstSameChain = await packedSdk.setupChain(
            "monad-mainnet",
            null,
            "https://api.packed-same-chain-first.example",
        );
        const secondSameChain = await packedSdk.setupChain(
            "monad-mainnet",
            null,
            "https://api.packed-same-chain-second.example",
        );
        assert.notEqual(firstSameChain.dexAgg, secondSameChain.dexAgg);
        assert.equal(secondSameChain.setupConfigSnapshot.api_url, "https://api.packed-same-chain-second.example");
        assert.deepEqual(packedContextBindings, [
            {
                apiUrl: "https://api.packed-same-chain-first.example",
                checkerDao: firstDao,
                feeReceiver: firstDao,
                marketSymbols: ["FIRST"],
            },
            {
                apiUrl: "https://api.packed-same-chain-second.example",
                checkerDao: secondDao,
                feeReceiver: secondDao,
                marketSymbols: ["SECOND"],
            },
        ]);

        const firstSameChainTokens = await firstSameChain.dexAgg.getAvailableTokens(null, null, WALLET);
        const secondSameChainTokens = await secondSameChain.dexAgg.getAvailableTokens(null, null, WALLET);
        assert.deepEqual(firstSameChainTokens.map((token) => token.interface.symbol), ["FIRST"]);
        assert.deepEqual(secondSameChainTokens.map((token) => token.interface.symbol), ["SECOND"]);
        await firstSameChainTokens[0].quote(TOKEN_IN, TOKEN_OUT, Decimal(1), Decimal(0.01));
        await secondSameChainTokens[0].quote(TOKEN_IN, TOKEN_OUT, Decimal(1), Decimal(0.01));
        assert.deepEqual(packedContextQuoteCalls, [
            {
                apiUrl: "https://api.packed-same-chain-first.example",
                checkerDao: firstDao,
                feeBps: packedSdk.CURVANCE_FEE_BPS,
                feeReceiver: firstDao,
            },
            {
                apiUrl: "https://api.packed-same-chain-second.example",
                checkerDao: secondDao,
                feeBps: packedSdk.CURVANCE_FEE_BPS,
                feeReceiver: secondDao,
            },
        ]);
    } finally {
        packedSdk.chain_config["monad-mainnet"].dexAgg = originalPackedMonadDexAgg;
        packedSdk.Api.getRewards = originalSameChainGetRewards;
        packedSdk.Market.getAll = originalSameChainGetAll;
        packedSdk.ProtocolReader.prototype.getDaoAddress = originalSameChainGetDaoAddress;
    }

    const originalPackedRealDexAgg = packedSdk.chain_config["monad-mainnet"].dexAgg;
    const originalPackedRealGetRewards = packedSdk.Api.getRewards;
    const originalPackedRealGetAllMarketData = packedSdk.ProtocolReader.prototype.getAllMarketData;
    const originalPackedRealGetDaoAddress = packedSdk.ProtocolReader.prototype.getDaoAddress;
    const originalPackedRealFetch = globalThis.fetch;
    const firstPackedRealDao = "0x0000000000000000000000000000000000000dB1";
    const secondPackedRealDao = "0x0000000000000000000000000000000000000dB2";
    const packedRealQuoteCalls = [];
    let packedRealDaoLookup = 0;
    try {
        packedSdk.Api.getRewards = async () => ({ milestones: {}, incentives: {} });
        packedSdk.ProtocolReader.prototype.getAllMarketData = async () => createPackedBootMarketData(packedSdk);
        packedSdk.ProtocolReader.prototype.getDaoAddress = async () => {
            packedRealDaoLookup += 1;
            return packedRealDaoLookup === 1 ? firstPackedRealDao : secondPackedRealDao;
        };
        globalThis.fetch = async (input) => {
            const url = String(input);
            if (url.includes("/native_apy")) {
                return jsonResponse({ native_apy: [] });
            }
            const merklUrl = getProxiedMerklUrl(url);
            if (merklUrl.origin === "https://api.merkl.xyz" && merklUrl.pathname === "/v4/opportunities") {
                return jsonResponse([]);
            }

            throw new Error(`Unexpected packed real CToken setup fetch: ${url}`);
        };
        packedSdk.chain_config["monad-mainnet"].dexAgg = {
            dao: FEE_RECEIVER,
            router: packedSdk.chain_config["monad-mainnet"].wrapped_native,
            withContext(context) {
                return {
                    dao: context.checkerDao,
                    router: packedSdk.chain_config["monad-mainnet"].wrapped_native,
                    getAvailableTokens: async () => [{
                        interface: {
                            address: packedSdk.chain_config["monad-mainnet"].wrapped_native,
                            symbol: "WMON",
                            name: "Wrapped Monad",
                            decimals: 18n,
                        },
                        type: "simple",
                        quote: async () => {
                            packedRealQuoteCalls.push({
                                apiUrl: context.markets[0].setup.api_url,
                                checkerDao: context.checkerDao,
                                feeBps: context.feePolicy.getFeeBps({
                                    operation: "zap",
                                    inputToken: packedSdk.chain_config["monad-mainnet"].wrapped_native,
                                    outputToken: TOKEN_IN,
                                    inputAmount: 1n,
                                    currentLeverage: null,
                                    targetLeverage: null,
                                }),
                                feeReceiver: context.feePolicy.feeReceiver,
                            });
                            return {
                                minOut_raw: 1n,
                                output_raw: 2n,
                                minOut: Decimal(1),
                                output: Decimal(2),
                            };
                        },
                    }],
                    quoteAction: async () => {
                        throw new Error("packed real CToken same-chain quoteAction is not used");
                    },
                    quoteMin: async () => 1n,
                    quote: async () => ({
                        to: packedSdk.chain_config["monad-mainnet"].wrapped_native,
                        calldata: "0x",
                        min_out: 1n,
                        out: 2n,
                    }),
                };
            },
            getAvailableTokens: async () => {
                throw new Error("packed real CToken unbound same-chain dex adapter was used");
            },
            quoteAction: async () => {
                throw new Error("packed real CToken unbound same-chain dex adapter was used");
            },
            quoteMin: async () => {
                throw new Error("packed real CToken unbound same-chain dex adapter was used");
            },
            quote: async () => {
                throw new Error("packed real CToken unbound same-chain dex adapter was used");
            },
        };

        const firstPackedReal = await packedSdk.setupChain(
            "monad-mainnet",
            null,
            "https://api.packed-real-token-first.example",
            {
                account: WALLET,
                readProvider: createPackedDecimalsReadProvider(143n),
            },
        );
        const secondPackedReal = await packedSdk.setupChain(
            "monad-mainnet",
            null,
            "https://api.packed-real-token-second.example",
            {
                account: WALLET,
                readProvider: createPackedDecimalsReadProvider(143n),
            },
        );
        const firstUsdc = firstPackedReal.markets[0].tokens.find(
            (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
        );
        const secondUsdc = secondPackedReal.markets[0].tokens.find(
            (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
        );
        assert.ok(firstUsdc);
        assert.ok(secondUsdc);
        assert.notEqual(firstUsdc.market.dexAgg, secondUsdc.market.dexAgg);

        const firstWrappedRoute = (await firstUsdc.getDepositTokens()).find(
            (token) => token.type === "simple" &&
                token.interface.address.toLowerCase() ===
                    packedSdk.chain_config["monad-mainnet"].wrapped_native.toLowerCase(),
        );
        const secondWrappedRoute = (await secondUsdc.getDepositTokens()).find(
            (token) => token.type === "simple" &&
                token.interface.address.toLowerCase() ===
                    packedSdk.chain_config["monad-mainnet"].wrapped_native.toLowerCase(),
        );
        assert.ok(firstWrappedRoute?.quote, "packed first real CToken route should expose a quote closure");
        assert.ok(secondWrappedRoute?.quote, "packed second real CToken route should expose a quote closure");

        await firstWrappedRoute.quote(
            packedSdk.chain_config["monad-mainnet"].wrapped_native,
            TOKEN_IN,
            Decimal(1),
            Decimal(0.01),
        );
        await secondWrappedRoute.quote(
            packedSdk.chain_config["monad-mainnet"].wrapped_native,
            TOKEN_IN,
            Decimal(1),
            Decimal(0.01),
        );
        assert.deepEqual(
            packedRealQuoteCalls,
            [
                {
                    apiUrl: "https://api.packed-real-token-first.example",
                    checkerDao: firstPackedRealDao,
                    feeBps: packedSdk.CURVANCE_FEE_BPS,
                    feeReceiver: firstPackedRealDao,
                },
                {
                    apiUrl: "https://api.packed-real-token-second.example",
                    checkerDao: secondPackedRealDao,
                    feeBps: packedSdk.CURVANCE_FEE_BPS,
                    feeReceiver: secondPackedRealDao,
                },
            ],
            "packed real CToken route quotes should preserve same-chain setup context after a newer boot",
        );
    } finally {
        packedSdk.chain_config["monad-mainnet"].dexAgg = originalPackedRealDexAgg;
        packedSdk.Api.getRewards = originalPackedRealGetRewards;
        packedSdk.ProtocolReader.prototype.getAllMarketData = originalPackedRealGetAllMarketData;
        packedSdk.ProtocolReader.prototype.getDaoAddress = originalPackedRealGetDaoAddress;
        globalThis.fetch = originalPackedRealFetch;
    }

    const originalPackedArbGetRewards = packedSdk.Api.getRewards;
    const originalPackedArbGetAllMarketData = packedSdk.ProtocolReader.prototype.getAllMarketData;
    const originalPackedArbGetDaoAddress = packedSdk.ProtocolReader.prototype.getDaoAddress;
    const originalPackedArbFetch = globalThis.fetch;
    const packedArbFetchUrls = [];
    try {
        const packedArbContracts = packedSdk.getContractAddresses("arb-sepolia");
        const packedArbStableMarket = packedArbContracts.markets["Stable Market"];
        const packedArbUsdcCToken = packedArbStableMarket.tokens.USDC;
        packedSdk.Api.getRewards = async () => ({ milestones: {}, incentives: {} });
        packedSdk.ProtocolReader.prototype.getDaoAddress = async () => FEE_RECEIVER;
        packedSdk.ProtocolReader.prototype.getAllMarketData = async () => ({
            staticMarket: [{
                address: packedArbStableMarket.address,
                adapters: [],
                cooldownLength: 1200n,
                tokens: [
                    createPackedBootStaticToken(
                        packedSdk,
                        packedArbUsdcCToken,
                        "USDC",
                        packedArbContracts.USDC,
                    ),
                ],
            }],
            dynamicMarket: [createPackedRefreshDynamicMarket(packedArbStableMarket.address, packedArbUsdcCToken)],
            userData: {
                locks: [],
                markets: [createPackedRefreshUserMarket(packedArbStableMarket.address, packedArbUsdcCToken)],
            },
        });
        globalThis.fetch = async (input) => {
            const url = String(input);
            packedArbFetchUrls.push(url);
            const merklUrl = getProxiedMerklUrl(url);
            if (merklUrl.origin === "https://api.merkl.xyz" && merklUrl.pathname === "/v4/opportunities") {
                return jsonResponse([]);
            }

            throw new Error(`Unexpected packed Arbitrum boot fetch: ${url}`);
        };

        const packedArbRealBoot = await packedSdk.setupChain(
            "arb-sepolia",
            null,
            "https://api.packed-arb-real.example",
            {
                account: WALLET,
                readProvider: createPackedDecimalsReadProvider(421614n),
            },
        );
        const packedArbToken = packedArbRealBoot.markets[0]?.tokens[0];

        assert.equal(packedArbRealBoot.chain, "arb-sepolia");
        assert.equal(packedArbRealBoot.chainId, 421614);
        assert.equal(packedArbRealBoot.markets.length, 1);
        assert.ok(packedArbToken);
        assert.equal(packedArbToken.market.setup, packedArbRealBoot.setupConfigSnapshot);
        assert.equal(packedArbToken.canZap, false);
        assert.equal(packedArbToken.canLeverage, false);
        assert.deepEqual(packedArbToken.zapTypes, []);
        assert.deepEqual(packedArbToken.leverageTypes, []);
        assert.deepEqual(
            (await packedArbToken.getDepositTokens()).map((token) => token.type),
            ["none"],
            "packed Arbitrum real boot should not expose simple/native zap routes while DEX aggregation is unsupported",
        );
        assert.ok(
            packedArbRealBoot.dexAgg instanceof packedSdk.UnsupportedDexAgg,
            "packed Arbitrum real boot should return the unsupported DEX adapter",
        );
        assert.deepEqual(
            packedArbFetchUrls.map((url) => getProxiedMerklUrl(url).searchParams.get("chainId")),
            ["421614", "421614"],
            "packed Arbitrum real boot should only make chain-scoped Merkl opportunity requests",
        );
    } finally {
        packedSdk.Api.getRewards = originalPackedArbGetRewards;
        packedSdk.ProtocolReader.prototype.getAllMarketData = originalPackedArbGetAllMarketData;
        packedSdk.ProtocolReader.prototype.getDaoAddress = originalPackedArbGetDaoAddress;
        globalThis.fetch = originalPackedArbFetch;
    }

    const packedMonadMarket = createPackedSnapshotMarket(packedSdk, {
        address: TOKEN_IN,
        chain: "monad-mainnet",
        chainId: 143,
        name: "Shared Market",
    });
    const packedArbMarket = createPackedSnapshotMarket(packedSdk, {
        address: TOKEN_IN,
        chain: "arb-sepolia",
        chainId: 421614,
        name: "Shared Market",
    });
    await assert.rejects(
        () => packedSdk.takePortfolioSnapshot(WALLET, {
            markets: [packedMonadMarket, packedArbMarket],
        }),
        /received markets from multiple chains/i,
        "packed portfolio snapshots should require explicit opt-in for mixed-chain market sets",
    );
    const packedMixedSnapshot = await packedSdk.takePortfolioSnapshot(WALLET, {
        markets: [packedMonadMarket, packedArbMarket],
        allowMixedChains: true,
    });
    assert.equal(packedMixedSnapshot.chain, "multi");
    assert.deepEqual(
        packedMixedSnapshot.markets.map((market) => ({
            address: market.marketAddress,
            chain: market.chain,
            chainId: market.chainId,
        })),
        [
            { address: TOKEN_IN, chain: "monad-mainnet", chainId: 143 },
            { address: TOKEN_IN, chain: "arb-sepolia", chainId: 421614 },
        ],
        "packed portfolio snapshots should preserve per-market chain provenance for same-address markets",
    );
    const originalPackedMonadChainId = packedSdk.chain_config["monad-mainnet"].chainId;
    try {
        packedSdk.chain_config["monad-mainnet"].chainId = 999_999;
        assert.equal(
            packedSdk.snapshotMarket(packedMonadMarket).chainId,
            143,
            "packed snapshotMarket should use the market setup snapshot after exported chain config moves",
        );
    } finally {
        packedSdk.chain_config["monad-mainnet"].chainId = originalPackedMonadChainId;
    }

    const originalMonadRewardsSlug = packedSdk.chain_config["monad-mainnet"].services.curvanceApi.rewardsSlug;
    const originalMonadNativeYieldSlug = packedSdk.chain_config["monad-mainnet"].services.curvanceApi.nativeYieldSlug;
    try {
        packedSdk.chain_config["monad-mainnet"].services.curvanceApi.rewardsSlug = "moved-dist-monad";
        packedSdk.chain_config["monad-mainnet"].services.curvanceApi.nativeYieldSlug = "moved-dist-native";

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
                }, {
                    market: TOKEN_IN,
                    type: "supply",
                    rate: 99,
                    description: "wrong-chain dist reward",
                    image: "stars-rewards",
                    chain_network: "Ethereum",
                }],
            },
            async (urls) => {
                const rewards = await packedSdk.Api.getRewards(monadSetupSnapshot);

                assert.deepEqual(urls, [
                    "https://api.dist-smoke.example/v1/rewards/active/monad-mainnet",
                ]);
                assert.equal(rewards.milestones[TOKEN_IN]?.chain_network, "monad-mainnet");
                assert.deepEqual(
                    rewards.incentives[TOKEN_IN]?.map((incentive) => incentive.description),
                    ["dist reward"],
                    "packed Api.getRewards should drop explicit wrong-chain incentive rows",
                );
            },
        );

        await withMockedFetch(
            {
                native_apy: [{ symbol: "WMON", apy: 3.14 }],
            },
            async (urls) => {
                const yields = await packedSdk.Api.fetchNativeYields(monadSetupSnapshot);

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

                assert.deepEqual(urls.map((url) => getProxiedMerklUrl(url).searchParams.get("chainId")), ["143"]);
                assert.deepEqual(
                    opportunities.map((opportunity) => opportunity.identifier),
                    ["dist-monad-lend", TOKEN_IN],
                    "packed Merkl helper should reject conflicting or malformed explicit chain metadata",
                );
            },
        );

        {
            const originalFetch = globalThis.fetch;
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls += 1;
                return jsonResponse([]);
            };
            try {
                await assert.rejects(
                    () => packedSdk.fetchMerklUserRewards({
                        wallet: "not-a-wallet?chainId=1",
                        chainId: 143,
                    }),
                    /Invalid address from Merkl rewards wallet/,
                    "packed Merkl reward helper should validate wallet path input before fetch",
                );
                assert.equal(fetchCalls, 0);
            } finally {
                globalThis.fetch = originalFetch;
            }
        }

        {
            const originalFetch = globalThis.fetch;
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls += 1;
                return jsonResponse([]);
            };
            try {
                await assert.rejects(
                    () => packedSdk.fetchMerklUserRewards({ wallet: WALLET, chainId: 0 }),
                    /Invalid chainId from Merkl rewards chainId/,
                    "packed Merkl reward helper should validate chainId before fetch",
                );
                await assert.rejects(
                    () => packedSdk.fetchMerklCampaignsBySymbol({ tokenSymbol: "WMON", chainId: -1 }),
                    /Invalid chainId from Merkl campaigns chainId/,
                    "packed Merkl campaign helper should validate chainId before fetch",
                );
                await assert.rejects(
                    () => packedSdk.fetchMerklOpportunities({ action: "LEND", chainId: Number.NaN }),
                    /Invalid chainId from Merkl opportunities chainId/,
                    "packed Merkl opportunity helper should validate chainId before fetch",
                );
                assert.equal(fetchCalls, 0);
            } finally {
                globalThis.fetch = originalFetch;
            }
        }

        await withMockedFetch(
            [
                {
                    chain: { id: 143, name: "Monad" },
                    rewards: [
                        {
                            distributionChainId: 143,
                            root: "0xmonad-root",
                            recipient: WALLET,
                            amount: "100",
                            claimed: "10",
                            pending: "90",
                            token: {
                                symbol: "WMON",
                                address: TOKEN_IN,
                                chainId: 143,
                                decimals: 18,
                            },
                        },
                        {
                            distributionChainId: 1,
                            root: "0xwrong-reward-root",
                            recipient: WALLET,
                            amount: "200",
                            claimed: "0",
                            token: {
                                symbol: "WMON",
                                address: TOKEN_OUT,
                                chainId: 143,
                                decimals: 18,
                            },
                        },
                    ],
                },
                {
                    chain: { id: 1, name: "Ethereum" },
                    rewards: [
                        {
                            distributionChainId: 1,
                            root: "0xethereum-root",
                            recipient: WALLET,
                            amount: "300",
                            claimed: "0",
                            token: {
                                symbol: "WMON",
                                address: TOKEN_OUT,
                                chainId: 1,
                                decimals: 18,
                            },
                        },
                    ],
                },
            ],
            async (urls) => {
                const rewards = await packedSdk.fetchMerklUserRewards({ wallet: WALLET, chainId: 143 });
                const url = getProxiedMerklUrl(urls[0]);

                assert.equal(url.pathname, `/v4/users/${WALLET}/rewards`);
                assert.equal(url.searchParams.get("chainId"), "143");
                assert.deepEqual(
                    rewards.map((row) => ({
                        chainId: row.chain.id,
                        rewardRoots: row.rewards.map((reward) => reward.root),
                    })),
                    [{
                        chainId: 143,
                        rewardRoots: ["0xmonad-root"],
                    }],
                    "packed Merkl user reward helper should filter rows and nested rewards by chain metadata",
                );
            },
        );
        await withMockedFetch(
            [
                {
                    id: "packed-campaign-monad",
                    campaignId: "packed-campaign-monad-id",
                    computeChainId: 143,
                    distributionChainId: 143,
                    chain: { id: 143, name: "Monad" },
                    distributionChain: { id: 143, name: "Monad" },
                    rewardToken: {
                        symbol: "WMON",
                        address: TOKEN_IN,
                        chainId: 143,
                        decimals: 18,
                    },
                },
                {
                    id: "packed-campaign-wrong-chain",
                    campaignId: "packed-campaign-wrong-chain-id",
                    computeChainId: 1,
                    distributionChainId: 1,
                    chain: { id: 1, name: "Ethereum" },
                    distributionChain: { id: 1, name: "Ethereum" },
                    rewardToken: {
                        symbol: "WMON",
                        address: TOKEN_OUT,
                        chainId: 1,
                        decimals: 18,
                    },
                },
            ],
            async (urls) => {
                const campaigns = await packedSdk.fetchMerklCampaignsBySymbol({ tokenSymbol: "WMON", chainId: 143 });
                const url = getProxiedMerklUrl(urls[0]);

                assert.equal(url.searchParams.get("mainProtocolId"), "curvance");
                assert.equal(url.searchParams.get("tokenSymbol"), "WMON");
                assert.equal(url.searchParams.get("chainId"), "143");
                assert.deepEqual(
                    campaigns.map((campaign) => campaign.id),
                    ["packed-campaign-monad"],
                    "packed Merkl campaign helper should filter same-symbol campaigns by chain metadata",
                );
            },
        );
    } finally {
        packedSdk.chain_config["monad-mainnet"].services.curvanceApi.rewardsSlug = originalMonadRewardsSlug;
        packedSdk.chain_config["monad-mainnet"].services.curvanceApi.nativeYieldSlug = originalMonadNativeYieldSlug;
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
        /staticCallOrCall/,
        "dist OptimizerReader should use static simulation for reader calls",
    );
    assert.doesNotMatch(
        optimizerReaderDist,
        /assetsAtTimestamp|optimalRebalanceAt|optimalRebalanceUpdated/,
        "dist OptimizerReader should not expose removed reader helpers",
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

    const packedKyber = new packedSdk.KyberSwap(FEE_RECEIVER).withContext({
        markets: [createPackedKyberContextMarket("PKCTX", TOKEN_OUT)],
        feePolicy: {
            getFeeBps: () => 4n,
            feeReceiver: FEE_RECEIVER,
            chain: "monad-mainnet",
        },
        checkerDao: FEE_RECEIVER,
    });
    let packedKyberQuoteArgs = null;
    packedKyber.quote = async (...args) => {
        packedKyberQuoteArgs = args;
        return {
            to: TOKEN_IN,
            calldata: "0x",
            min_out: 1n,
            out: 2n,
        };
    };
    const packedKyberTokens = await packedKyber.getAvailableTokens(
        createPackedDecimalsReadProvider(143n),
        null,
        WALLET,
    );
    assert.deepEqual(
        packedKyberTokens.map((token) => ({
            symbol: token.interface.symbol,
            address: token.interface.address.toLowerCase(),
            quoteable: typeof token.quote === "function",
        })),
        [{
            symbol: "PKCTX",
            address: TOKEN_OUT,
            quoteable: true,
        }],
        "packed KyberSwap.getAvailableTokens should use bound context markets before mutable globals",
    );
    await packedKyberTokens[0].quote(TOKEN_OUT, TOKEN_IN, Decimal(1), Decimal("0.01"));
    assert.deepEqual(
        packedKyberQuoteArgs,
        [
            WALLET,
            TOKEN_OUT,
            TOKEN_IN,
            1_000_000_000_000_000_000n,
            100n,
            4n,
            FEE_RECEIVER,
        ],
        "packed KyberSwap quote closures should use the bound context fee policy",
    );

    {
        const packedValidatingKyber = new packedSdk.KyberSwap(FEE_RECEIVER);
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls += 1;
            throw new Error("packed Kyber request should not be sent for invalid request addresses");
        };
        try {
            await assert.rejects(
                () => packedValidatingKyber.quote(
                    "not-a-wallet",
                    TOKEN_IN,
                    TOKEN_OUT,
                    1_000n,
                    50n,
                    4n,
                    FEE_RECEIVER,
                ),
                /Invalid address from KyberSwap wallet/,
                "packed KyberSwap should validate wallet before fetch",
            );
            await assert.rejects(
                () => packedValidatingKyber.quote(
                    WALLET,
                    TOKEN_IN,
                    TOKEN_OUT,
                    0n,
                    50n,
                    4n,
                    FEE_RECEIVER,
                ),
                /KyberSwap quote amount must be positive, got 0/,
                "packed KyberSwap should validate quote amount before fetch",
            );
            assert.equal(fetchCalls, 0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    }

    {
        let childQuoteCalls = 0;
        const child = {
            dao: FEE_RECEIVER,
            router: TOKEN_IN,
            getAvailableTokens: async () => [],
            quoteAction: async () => {
                childQuoteCalls += 1;
                throw new Error("packed child quoteAction should not run for invalid request inputs");
            },
            quoteMin: async () => {
                childQuoteCalls += 1;
                throw new Error("packed child quoteMin should not run for invalid request inputs");
            },
            quote: async () => {
                childQuoteCalls += 1;
                throw new Error("packed child quote should not run for invalid request inputs");
            },
        };
        const packedMulti = new packedSdk.MultiDexAgg([child]);

        await assert.rejects(
            () => packedMulti.quote("not-a-wallet", TOKEN_IN, TOKEN_OUT, 1_000n, 50n),
            /Invalid address from MultiDexAgg wallet/,
            "packed MultiDexAgg should validate wallet before child fan-out",
        );
        await assert.rejects(
            () => packedMulti.quoteMin(WALLET, "not-a-token", TOKEN_OUT, 1_000n, 50n),
            /Invalid address from MultiDexAgg tokenIn/,
            "packed MultiDexAgg should validate tokenIn before child fan-out",
        );
        await assert.rejects(
            () => packedMulti.quoteAction(WALLET, TOKEN_IN, "not-a-token", 1_000n, 50n),
            /Invalid address from MultiDexAgg tokenOut/,
            "packed MultiDexAgg should validate tokenOut before child fan-out",
        );
        await assert.rejects(
            () => packedMulti.quote(WALLET, TOKEN_IN, TOKEN_OUT, 0n, 50n),
            /MultiDexAgg quote amount must be positive, got 0/,
            "packed MultiDexAgg should validate quote amount before child fan-out",
        );
        await assert.rejects(
            () => packedMulti.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 10_000n),
            /Slippage out of range \(0-9999 BPS\) in MultiDexAgg quote: 10000/,
            "packed MultiDexAgg should validate slippage before child fan-out",
        );
        await assert.rejects(
            () => packedMulti.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, "not-a-receiver"),
            /Invalid address from MultiDexAgg feeReceiver/,
            "packed MultiDexAgg should validate fee receiver before child fan-out",
        );
        assert.equal(childQuoteCalls, 0);
    }

    {
        const quoteActionCalls = [];
        const conservativeAction = { aggregator: "packed-conservative" };
        const optimisticAction = { aggregator: "packed-optimistic" };
        const conservative = {
            dao: FEE_RECEIVER,
            router: TOKEN_IN,
            getAvailableTokens: async () => [],
            quoteAction: async (wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver) => {
                quoteActionCalls.push({
                    label: "conservative",
                    wallet,
                    tokenIn,
                    tokenOut,
                    amount,
                    slippage,
                    feeBps,
                    feeReceiver,
                });
                return {
                    action: conservativeAction,
                    quote: {
                        to: TOKEN_IN,
                        calldata: "0x",
                        min_out: 80n,
                        out: 90n,
                    },
                };
            },
            quoteMin: async () => 80n,
            quote: async () => ({
                to: TOKEN_IN,
                calldata: "0x",
                min_out: 80n,
                out: 90n,
            }),
        };
        const optimistic = {
            dao: FEE_RECEIVER,
            router: TOKEN_OUT,
            getAvailableTokens: async () => [],
            quoteAction: async (wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver) => {
                quoteActionCalls.push({
                    label: "optimistic",
                    wallet,
                    tokenIn,
                    tokenOut,
                    amount,
                    slippage,
                    feeBps,
                    feeReceiver,
                });
                return {
                    action: optimisticAction,
                    quote: {
                        to: TOKEN_OUT,
                        calldata: "0x",
                        min_out: 50n,
                        out: 100n,
                    },
                };
            },
            quoteMin: async () => 50n,
            quote: async () => ({
                to: TOKEN_OUT,
                calldata: "0x",
                min_out: 50n,
                out: 100n,
            }),
        };
        const packedMulti = new packedSdk.MultiDexAgg([optimistic, conservative]);
        const { action, quote } = await packedMulti.quoteAction(
            WALLET,
            TOKEN_IN,
            TOKEN_OUT,
            1_000n,
            50n,
            4n,
            FEE_RECEIVER,
        );

        assert.equal(action, conservativeAction);
        assert.equal(quote.min_out, 80n);
        assert.deepEqual(
            quoteActionCalls
                .map((call) => ({
                    ...call,
                    feeReceiver: call.feeReceiver && call.feeReceiver.toLowerCase(),
                }))
                .sort((a, b) => a.label.localeCompare(b.label)),
            [
                {
                    label: "conservative",
                    wallet: WALLET,
                    tokenIn: TOKEN_IN,
                    tokenOut: TOKEN_OUT,
                    amount: 1_000n,
                    slippage: 50n,
                    feeBps: 4n,
                    feeReceiver: FEE_RECEIVER.toLowerCase(),
                },
                {
                    label: "optimistic",
                    wallet: WALLET,
                    tokenIn: TOKEN_IN,
                    tokenOut: TOKEN_OUT,
                    amount: 1_000n,
                    slippage: 50n,
                    feeBps: 4n,
                    feeReceiver: FEE_RECEIVER.toLowerCase(),
                },
            ],
            "packed MultiDexAgg.quoteAction should pass fee policy arguments through child fan-out",
        );
    }

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
