"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateExchangeRate = calculateExchangeRate;
exports.calculateCollateralBreakdown = calculateCollateralBreakdown;
exports.calculateNewCollateral = calculateNewCollateral;
const decimal_js_1 = require("decimal.js");
function calculateExchangeRate(assetBalance, shareBalance) {
    if (shareBalance.gt(0) && !shareBalance.isZero()) {
        return assetBalance.div(shareBalance);
    }
    return new decimal_js_1.Decimal(1);
}
function calculateCollateralBreakdown(assetBalance, collateralShares, exchangeRate) {
    const collateralAssets = decimal_js_1.Decimal.min(assetBalance, collateralShares.mul(exchangeRate));
    const uncollateralizedAssets = decimal_js_1.Decimal.max(assetBalance.minus(collateralAssets), new decimal_js_1.Decimal(0));
    return {
        exchangeRate,
        collateralAssets,
        uncollateralizedAssets,
    };
}
function calculateNewCollateral(currentCollateral, amount, action) {
    if (action === 'add') {
        return currentCollateral.plus(amount);
    }
    return decimal_js_1.Decimal.max(currentCollateral.minus(amount), new decimal_js_1.Decimal(0));
}
//# sourceMappingURL=collateral.js.map