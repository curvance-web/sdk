import assert from "node:assert/strict";
import test from "node:test";
import type { CToken as CTokenType } from "../src/classes/CToken";
require("../src/classes/Market");
const { CToken } = require("../src/classes/CToken") as typeof import("../src/classes/CToken");

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const ASSET = "0x00000000000000000000000000000000000000b1";
const UNDERLYING = "0x00000000000000000000000000000000000000c2";

test("CToken.getSnapshot preserves the underlying token address from the contract tuple", async () => {
    const token = Object.create(CToken.prototype) as CTokenType;
    token.contract = {
        getSnapshot: async (_account: string) => ({
            asset: ASSET,
            underlying: UNDERLYING,
            decimals: 6,
            isCollateral: true,
            collateralPosted: 11n,
            debtBalance: 12n,
        }),
    } as any;

    const snapshot = await token.getSnapshot(ACCOUNT as any);

    assert.deepEqual(snapshot, {
        asset: ASSET,
        underlying: UNDERLYING,
        decimals: 6n,
        isCollateral: true,
        collateralPosted: 11n,
        debtBalance: 12n,
    });
});
