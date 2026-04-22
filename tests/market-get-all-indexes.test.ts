import assert from "node:assert/strict";
import test from "node:test";
import { Market } from "../src/classes/Market";
import { aggregateMerklAprByToken } from "../src/helpers";
import Decimal from "decimal.js";

test("buildDeployDataIndex normalizes addresses and keeps the first deployment entry", () => {
    const index = (Market as any).buildDeployDataIndex({
        contracts: {
            markets: {
                first: {
                    address: "0xAbC",
                    plugins: { simplePositionManager: "0x1" },
                },
                second: {
                    address: "0xaBc",
                    plugins: { simplePositionManager: "0x2" },
                },
                ignoredPrimitive: "0xdef",
                ignoredNull: null,
            },
        },
    });

    assert.equal(index.size, 1);
    assert.deepEqual(index.get("0xabc"), {
        name: "first",
        plugins: { simplePositionManager: "0x1" },
    });
});

test("aggregateMerklAprByToken sums duplicate opportunities by the shared matching policy", () => {
    const depositApy = aggregateMerklAprByToken([
        {
            identifier: "lend-campaign-1",
            apr: 12,
            tokens: [{ address: "0xAbC" }],
        },
        {
            identifier: "lend-campaign-2",
            apr: 34,
            tokens: [{ address: "0xaBc" }],
        },
    ], "deposit");
    const borrowApy = aggregateMerklAprByToken([
        {
            identifier: "0xAbC",
            apr: 5,
            tokens: [],
        },
        {
            identifier: "0xaBc",
            apr: 7,
            tokens: [{ address: "0xdef" }],
        },
    ], "borrow");

    assert.equal(depositApy.size, 1);
    assert.ok(depositApy.get("0xabc")?.eq(new Decimal(0.46)));
    assert.equal(borrowApy.size, 1);
    assert.ok(borrowApy.get("0xabc")?.eq(new Decimal(0.12)));
});

test("buildYieldIndex keeps the first match for a token symbol", () => {
    const index = (Market as any).buildYieldIndex([
        { symbol: "ausd", apy: 1.23 },
        { symbol: "AUSD", apy: 4.56 },
    ]);

    assert.equal(index.size, 1);
    assert.deepEqual(index.get("AUSD"), {
        symbol: "ausd",
        apy: 1.23,
    });
});
