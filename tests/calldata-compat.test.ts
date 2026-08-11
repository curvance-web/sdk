import assert from "node:assert/strict";
import test from "node:test";
import { BrowserProvider, JsonRpcSigner } from "ethers";
import { Calldata } from "../src/classes/Calldata";

const ADDRESS = "0x00000000000000000000000000000000000000aa";
const HASH = `0x${"ab".repeat(32)}`;

class SignerBackedCalldata extends Calldata<{}> {
    address = ADDRESS as any;
    signer: any;
    provider: any;
    contract = {
        interface: {
            encodeFunctionData: () => "0xdeadbeef",
        },
    } as any;

    constructor(signer: any, provider: any = null) {
        super();
        this.signer = signer;
        this.provider = provider;
    }
}

test("Calldata executes through signer-backed subclasses", async () => {
    const calls: any[] = [];
    let recoveryReads = 0;
    const signer = {
        address: "0x0000000000000000000000000000000000000abc",
        sendTransaction: async (tx: any) => {
            calls.push(tx);
            return { hash: "0x1" };
        },
        call: async (tx: any) => {
            calls.push({ simulated: true, ...tx });
            return "0x";
        },
    };

    const calldata = new SignerBackedCalldata(signer, {
        getTransaction: async () => {
            recoveryReads += 1;
            throw new Error("normal submissions must not use recovery reads");
        },
    });
    const tx = await calldata.executeCallData("0xfeed" as any, { value: 123n });
    const simulation = await calldata.simulateCallData("0xfeed" as any, { value: 456n });

    assert.deepEqual(tx, { hash: "0x1" });
    assert.deepEqual(simulation, { success: true });
    assert.equal(recoveryReads, 0);
    assert.deepEqual(calls, [
        {
            to: ADDRESS,
            data: "0xfeed",
            value: 123n,
        },
        {
            simulated: true,
            to: ADDRESS,
            data: "0xfeed",
            from: signer.address,
            value: 456n,
        },
    ]);
});

test("Calldata recovers a broadcast transaction from ethers sendTransactionHash metadata", async () => {
    let submissions = 0;
    const recoveryReads: string[] = [];
    const originalError = Object.assign(new Error("invalid pending transaction response"), {
        code: "BAD_DATA",
        info: { sendTransactionHash: HASH },
    });
    const recoveredTransaction = { hash: HASH, wait: async () => ({ status: 1 }) } as any;
    const calldata = new SignerBackedCalldata(
        {
            address: "0x0000000000000000000000000000000000000abc",
            sendTransaction: async () => {
                submissions += 1;
                throw originalError;
            },
        },
        {
            getTransaction: async (hash: string) => {
                recoveryReads.push(hash);
                return recoveredTransaction;
            },
        },
    );

    const transaction = await calldata.executeCallData("0xfeed" as any);

    assert.equal(transaction, recoveredTransaction);
    assert.equal(submissions, 1, "a broadcast transaction must never be submitted again");
    assert.deepEqual(recoveryReads, [HASH]);
});

test("Calldata recovers the hash emitted by ethers after a malformed EIP-1193 transaction read", async () => {
    const account = "0x0000000000000000000000000000000000000abc";
    const rpcMethods: string[] = [];
    const injectedProvider = {
        request: async ({ method }: { method: string; params?: unknown[] }) => {
            rpcMethods.push(method);
            switch (method) {
                case "eth_chainId":
                    return "0x8f";
                case "eth_blockNumber":
                    return "0x1";
                case "eth_estimateGas":
                    return "0x5208";
                case "eth_sendTransaction":
                    return HASH;
                case "eth_getTransactionByHash":
                    return { hash: HASH, nonce: null };
                default:
                    throw new Error(`unexpected EIP-1193 method: ${method}`);
            }
        },
    };
    const browserProvider = new BrowserProvider(injectedProvider as any, "any");
    const signer = new JsonRpcSigner(browserProvider, account);
    const recoveredTransaction = { hash: HASH, wait: async () => ({ status: 1 }) } as any;
    const recoveryReads: string[] = [];
    const calldata = new SignerBackedCalldata(signer, {
        getTransaction: async (hash: string) => {
            recoveryReads.push(hash);
            return recoveredTransaction;
        },
    });

    const transaction = await calldata.executeCallData("0xfeed" as any);

    assert.equal(transaction, recoveredTransaction);
    assert.equal(
        rpcMethods.filter((method) => method === "eth_sendTransaction").length,
        1,
        "recovery must not prompt or submit a second transaction",
    );
    assert.equal(
        rpcMethods.includes("eth_getTransactionByHash"),
        true,
        "the test must reproduce ethers failing after the wallet returned a hash",
    );
    assert.deepEqual(recoveryReads, [HASH]);
});

test("Calldata does not recover errors without a valid ethers sendTransactionHash", async () => {
    for (const originalError of [
        Object.assign(new Error("user rejected"), { code: "ACTION_REJECTED" }),
        Object.assign(new Error("unrelated transaction hash"), { hash: HASH }),
        Object.assign(new Error("malformed transaction hash"), {
            info: { sendTransactionHash: "0x1234" },
        }),
    ]) {
        let submissions = 0;
        let recoveryReads = 0;
        const calldata = new SignerBackedCalldata(
            {
                address: "0x0000000000000000000000000000000000000abc",
                sendTransaction: async () => {
                    submissions += 1;
                    throw originalError;
                },
            },
            {
                getTransaction: async () => {
                    recoveryReads += 1;
                    return null;
                },
            },
        );

        await assert.rejects(
            calldata.executeCallData("0xfeed" as any),
            (error: unknown) => error === originalError,
        );
        assert.equal(submissions, 1);
        assert.equal(recoveryReads, 0);
    }
});

test("Calldata preserves the original wallet error when recovery cannot find the transaction", async () => {
    const originalError = Object.assign(new Error("invalid pending transaction response"), {
        code: "BAD_DATA",
        info: { sendTransactionHash: HASH },
    });
    let submissions = 0;
    let recoveryReads = 0;
    const calldata = new SignerBackedCalldata(
        {
            address: "0x0000000000000000000000000000000000000abc",
            sendTransaction: async () => {
                submissions += 1;
                throw originalError;
            },
        },
        {
            getTransaction: async () => {
                recoveryReads += 1;
                return null;
            },
        },
    );

    await assert.rejects(
        calldata.executeCallData("0xfeed" as any),
        (error: unknown) => error === originalError,
    );
    assert.equal(submissions, 1);
    assert.equal(recoveryReads, 1);
});
