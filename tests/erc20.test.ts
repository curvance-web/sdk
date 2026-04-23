import assert from "node:assert/strict";
import test from "node:test";
import { ERC20 } from "../src/classes/ERC20";

const TOKEN = "0x00000000000000000000000000000000000000e1";

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
