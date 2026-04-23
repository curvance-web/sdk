import assert from "node:assert/strict";
import test from "node:test";
import { contractWithGasBuffer } from "../src/helpers";

test("contractWithGasBuffer skips estimateGas for view methods", async () => {
    let estimateGasCalls = 0;
    const contract = {
        interface: {
            getFunction(name: string) {
                if (name !== "balanceOf") {
                    throw new Error(`unexpected function lookup: ${name}`);
                }

                return { stateMutability: "view" };
            },
        },
        balanceOf: Object.assign(
            async (account: string) => `balance:${account}`,
            {
                estimateGas: async () => {
                    estimateGasCalls += 1;
                    return 21_000n;
                },
            },
        ),
    };

    const wrapped = contractWithGasBuffer(contract);
    const result = await wrapped.balanceOf("0xabc");

    assert.equal(result, "balance:0xabc");
    assert.equal(estimateGasCalls, 0);
});

test("contractWithGasBuffer preserves gas estimation for write methods", async () => {
    let estimateGasCalls = 0;
    const sendArgs: any[] = [];
    const contract = {
        interface: {
            getFunction(name: string) {
                if (name !== "approve") {
                    throw new Error(`unexpected function lookup: ${name}`);
                }

                return { stateMutability: "nonpayable" };
            },
        },
        approve: Object.assign(
            async (...args: any[]) => {
                sendArgs.push(args);
                return "ok";
            },
            {
                estimateGas: async () => {
                    estimateGasCalls += 1;
                    return 100n;
                },
            },
        ),
    };

    const wrapped = contractWithGasBuffer(contract);
    const result = await wrapped.approve("0xspender", 10n);

    assert.equal(result, "ok");
    assert.equal(estimateGasCalls, 1);
    assert.deepEqual(sendArgs, [[
        "0xspender",
        10n,
        { gasLimit: 110n },
    ]]);
});

test("contractWithGasBuffer merges gas limit into existing transaction overrides", async () => {
    let estimateGasCalls = 0;
    const estimateArgs: any[] = [];
    const sendArgs: any[] = [];
    const contract = {
        interface: {
            getFunction(name: string) {
                if (name !== "deposit") {
                    throw new Error(`unexpected function lookup: ${name}`);
                }

                return {
                    stateMutability: "payable",
                    inputs: [{ name: "receiver" }, { name: "amount" }],
                };
            },
        },
        deposit: Object.assign(
            async (...args: any[]) => {
                sendArgs.push(args);
                return "ok";
            },
            {
                estimateGas: async (...args: any[]) => {
                    estimateGasCalls += 1;
                    estimateArgs.push(args);
                    return 100n;
                },
            },
        ),
    };

    const wrapped = contractWithGasBuffer(contract);
    const result = await wrapped.deposit("0xreceiver", 10n, { value: 5n });

    assert.equal(result, "ok");
    assert.equal(estimateGasCalls, 1);
    assert.deepEqual(estimateArgs, [[
        "0xreceiver",
        10n,
        { value: 5n },
    ]]);
    assert.deepEqual(sendArgs, [[
        "0xreceiver",
        10n,
        { value: 5n, gasLimit: 110n },
    ]]);
});

test("contractWithGasBuffer preserves ethers method helpers on wrapped methods", async () => {
    const contract = {
        interface: {
            getFunction(name: string) {
                if (name !== "deposit") {
                    throw new Error(`unexpected function lookup: ${name}`);
                }

                return {
                    stateMutability: "payable",
                    inputs: [{ name: "receiver" }, { name: "amount" }],
                };
            },
        },
        deposit: Object.assign(
            async () => "sent",
            {
                estimateGas: async () => 100n,
                staticCall: async (receiver: string, amount: bigint) => ({ receiver, amount, mode: "static" }),
                populateTransaction: async (receiver: string, amount: bigint) => ({ to: receiver, value: amount }),
                fragment: { name: "deposit" },
            },
        ),
    };

    const wrapped = contractWithGasBuffer(contract);
    const method = wrapped.deposit as any;

    assert.equal(await method.estimateGas("0xreceiver", 10n), 100n);
    assert.deepEqual(await method.staticCall("0xreceiver", 10n), {
        receiver: "0xreceiver",
        amount: 10n,
        mode: "static",
    });
    assert.deepEqual(await method.populateTransaction("0xreceiver", 10n), {
        to: "0xreceiver",
        value: 10n,
    });
    assert.deepEqual(method.fragment, { name: "deposit" });
    assert.equal(await method("0xreceiver", 10n), "sent");
});
