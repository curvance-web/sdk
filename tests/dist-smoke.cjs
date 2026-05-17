const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const sdk = require("../dist/index.js");
const { Api } = require("../dist/classes/Api.js");
const { Market } = require("../dist/classes/Market.js");
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

function npmPackInvocation(packDir) {
    const npmCliCandidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter(Boolean);
    const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));

    if (npmCli) {
        return {
            command: process.execPath,
            args: [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
        };
    }

    return {
        command: "npm",
        args: ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
    };
}

function readPackedFiles() {
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
        return new Set(pack.files.map((file) => file.path.replace(/\\/g, "/")));
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
    const packedFiles = readPackedFiles();
    assert.ok(packedFiles.has("dist/index.js"), "package tarball should include built root entry");
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
    assert.equal(typeof sdk.Api, "function", "dist should export Api reward helpers and types");
    assert.equal(typeof sdk.KyberSwap, "function", "dist should export KyberSwap");
    assert.equal(typeof sdk.MultiDexAgg, "function", "dist should export MultiDexAgg");
    assert.equal("Kuru" in sdk, false, "dist should not export deprecated Kuru support");
    assert.equal(typeof sdk.leverage.calculateBorrowAmount, "function", "dist should export leverage namespace");
    assert.equal(typeof sdk.borrow.calculateMaxBorrow, "function", "dist should export borrow namespace");
    assert.equal(typeof sdk.collateral.calculateExchangeRate, "function", "dist should export collateral namespace");
    assert.equal(typeof sdk.health.formatHealthFactor, "function", "dist should export health namespace");
    assert.equal(typeof sdk.amounts.normalizeAmountString, "function", "dist should export amounts namespace");

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    try {
        Api.getRewards = async () => ({ milestones: {}, incentives: {} });
        Market.getAll = async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => [
            { setup },
        ];

        const setupResult = await sdk.setupChain("arb-sepolia", null, "https://api.dist-smoke.example");
        assert.equal(setupResult.chain, "arb-sepolia");
        assert.equal(setupResult.chainId, 421614);
        assert.equal(setupResult.setupConfigSnapshot.chain, "arb-sepolia");
        assert.equal(setupResult.setupConfigSnapshot.chainId, 421614);
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot), true);
        assert.equal(Object.isFrozen(setupResult.setupConfigSnapshot.contracts), true);
        assert.equal(setupResult.markets[0].setup, setupResult.setupConfigSnapshot);
    } finally {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
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
