const assert = require("node:assert/strict");
const sdk = require("../dist/index.js");

class LegacyProviderBackedCalldata extends sdk.Calldata {
    constructor(provider) {
        super();
        this.provider = provider;
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
    const legacySigner = {
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

    const calldata = new LegacyProviderBackedCalldata(legacySigner);
    const tx = await calldata.executeCallData("0x1234");
    assert.equal(tx.hash, "0xlegacy");

    const simulation = await calldata.simulateCallData("0x1234");
    assert.deepEqual(simulation, { success: true });

    assert.equal(calls.length, 2, "expected one send and one call through the legacy provider path");
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
            from: "0x00000000000000000000000000000000000000aa",
        },
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
