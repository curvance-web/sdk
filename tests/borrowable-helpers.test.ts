import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { BorrowableCToken } from "../src/classes/BorrowableCToken";

test("BorrowableCToken.getMaxBorrowable clamps negative and non-finite outputs to zero", async () => {
    const token = Object.create(BorrowableCToken.prototype) as BorrowableCToken;

    (token as any).market = {
        userRemainingCredit: new Decimal(-5),
    };
    (token as any).convertUsdToTokens = () => {
        throw new Error("negative credit should not attempt conversion");
    };

    assert.ok((await token.getMaxBorrowable()).eq(0));
    assert.ok((await token.getMaxBorrowable(true)).eq(0));

    (token as any).market = {
        userRemainingCredit: new Decimal(5),
    };
    (token as any).convertUsdToTokens = () => new Decimal(Infinity);

    assert.ok((await token.getMaxBorrowable()).eq(0));

    (token as any).convertUsdToTokens = () => new Decimal(2.5);

    assert.ok((await token.getMaxBorrowable()).eq(2.5));
    assert.ok((await token.getMaxBorrowable(true)).eq(5));
});
