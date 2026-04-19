import assert from "node:assert/strict";
import test from "node:test";
import { Market } from "../src/classes/Market";

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

test("buildOpportunityIndex keeps the first match for a token identifier", () => {
    const index = (Market as any).buildOpportunityIndex([
        { identifier: "0xAbC", apr: 12, name: "first", type: "merkl", tokens: [] },
        { identifier: "0xaBc", apr: 34, name: "second", type: "merkl", tokens: [] },
    ]);

    assert.equal(index.size, 1);
    assert.equal(index.get("0xabc")?.apr, 12);
    assert.equal(index.get("0xabc")?.name, "first");
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
