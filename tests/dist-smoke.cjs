const assert = require("node:assert/strict");
const sdk = require("../dist/index.js");

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
    assert.equal(typeof sdk.setupChain, "function", "dist should export setupChain");
    assert.equal(typeof sdk.Calldata, "function", "dist should export Calldata");
    assert.equal(typeof sdk.OptimizerReader, "function", "dist should export OptimizerReader");
    assert.equal(typeof sdk.KyberSwap, "function", "dist should export KyberSwap");

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
