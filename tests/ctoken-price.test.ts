import assert from "node:assert/strict";
import test from "node:test";
import type { CToken as CTokenType } from "../src/classes/CToken";
require("../src/classes/Market");
const { CToken } = require("../src/classes/CToken") as typeof import("../src/classes/CToken");

const WAD = 10n ** 18n;

function createCachedToken(): CTokenType {
    const token = Object.create(CToken.prototype) as CTokenType;
    token.cache = {
        assetPrice: 3n * WAD,
        assetPriceLower: 25n * WAD / 10n,
        sharePrice: 12n * WAD / 10n,
        sharePriceLower: WAD,
    } as any;

    return token;
}

test("CToken price helpers expose asset and share price semantics explicitly", () => {
    const token = createCachedToken();

    assert.equal(token.getAssetPrice().toString(), "3");
    assert.equal(token.getAssetPrice(true).toString(), "2.5");
    assert.equal(token.getAssetPrice(false, false), 3n * WAD);
    assert.equal(token.getAssetPrice(true, false), 25n * WAD / 10n);

    assert.equal(token.getSharePrice().toString(), "1.2");
    assert.equal(token.getSharePrice(true).toString(), "1");
    assert.equal(token.getSharePrice(false, false), 12n * WAD / 10n);
    assert.equal(token.getSharePrice(true, false), WAD);
});

test("CToken.getPrice remains backward compatible with explicit helpers", () => {
    const token = createCachedToken();

    assert.equal(token.getPrice().toString(), token.getSharePrice().toString());
    assert.equal(token.getPrice(false).toString(), token.getSharePrice().toString());
    assert.equal(token.getPrice(false, true).toString(), token.getSharePrice(true).toString());
    assert.equal(token.getPrice(false, true, false), token.getSharePrice(true, false));

    assert.equal(token.getPrice(true).toString(), token.getAssetPrice().toString());
    assert.equal(token.getPrice(true, true).toString(), token.getAssetPrice(true).toString());
    assert.equal(token.getPrice(true, true, false), token.getAssetPrice(true, false));
});
