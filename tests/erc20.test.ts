import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { ERC20 } from "../src/classes/ERC20";

const TOKEN = "0x00000000000000000000000000000000000000e1";
const SPENDER = "0x00000000000000000000000000000000000000e2";
const HASH = `0x${"cd".repeat(32)}`;

test("standalone ERC20 contract includes totalSupply ABI support", () => {
    const token = new ERC20({} as any, TOKEN as any);

    assert.equal(typeof (token.contract as any).totalSupply, "function");
});

test("fetchTotalSupply uses the contract method and caches the result", async () => {
    const token = Object.create(ERC20.prototype) as ERC20;
    (token as any).cache = undefined;
    (token as any).contract = {
        totalSupply: async () => 123n,
    };

    assert.equal(await token.fetchTotalSupply(), 123n);
    assert.equal(token.totalSupply, 123n);
});

test("cached zero ERC20 balance is returned as Decimal(0)", () => {
    const token = Object.create(ERC20.prototype) as ERC20;
    (token as any).cache = {
        balance: 0n,
        decimals: 18n,
    };

    assert.equal(token.balance?.toString(), "0");
});

test("ERC20 approval keeps the normal signer path and does not run recovery reads", async () => {
    let submissions = 0;
    let recoveryReads = 0;
    const expectedTransaction = { hash: `0x${"ef".repeat(32)}` } as any;
    const readProvider = {
        getTransaction: async () => {
            recoveryReads += 1;
            return null;
        },
    };
    const signer = {
        address: "0x00000000000000000000000000000000000000aa",
        provider: readProvider,
        estimateGas: async () => 100n,
        sendTransaction: async () => {
            submissions += 1;
            return expectedTransaction;
        },
    };
    const token = new ERC20(
        readProvider as any,
        TOKEN as any,
        { decimals: 18n } as any,
        undefined,
        signer as any,
    );

    const transaction = await token.approve(SPENDER as any, new Decimal(1));

    assert.equal(transaction.hash, expectedTransaction.hash);
    assert.equal(submissions, 1);
    assert.equal(recoveryReads, 0);
});

test("ERC20 approval recovers a transaction already broadcast by the wallet", async () => {
    let submissions = 0;
    const recoveryReads: string[] = [];
    const originalError = Object.assign(new Error("invalid pending transaction response"), {
        code: "BAD_DATA",
        info: { sendTransactionHash: HASH },
    });
    const recoveredTransaction = { hash: HASH, wait: async () => ({ status: 1 }) } as any;
    const readProvider = {
        getTransaction: async (hash: string) => {
            recoveryReads.push(hash);
            return recoveredTransaction;
        },
    };
    const signer = {
        address: "0x00000000000000000000000000000000000000aa",
        provider: readProvider,
        estimateGas: async () => 100n,
        sendTransaction: async () => {
            submissions += 1;
            throw originalError;
        },
    };
    const token = new ERC20(
        readProvider as any,
        TOKEN as any,
        { decimals: 18n } as any,
        undefined,
        signer as any,
    );

    const transaction = await token.approve(SPENDER as any, new Decimal(1));

    assert.equal(transaction, recoveredTransaction);
    assert.equal(submissions, 1, "approval must not be submitted twice");
    assert.deepEqual(recoveryReads, [HASH]);
});
