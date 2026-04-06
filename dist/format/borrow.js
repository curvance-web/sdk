"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_LOAN_USD = void 0;
exports.calculateMaxBorrow = calculateMaxBorrow;
exports.calculateMaxRepay = calculateMaxRepay;
exports.validateRepayRemainder = validateRepayRemainder;
exports.calculateDebtPreview = calculateDebtPreview;
exports.convertAmountByCurrencyView = convertAmountByCurrencyView;
const decimal_js_1 = require("decimal.js");
exports.MIN_LOAN_USD = 10;
function calculateMaxBorrow(userRemainingCredit, remainingDebt, availableLiquidity) {
    const credit = decimal_js_1.Decimal.max(userRemainingCredit, 0);
    const debt = decimal_js_1.Decimal.max(remainingDebt, 0);
    const liquidity = decimal_js_1.Decimal.max(availableLiquidity, 0);
    return decimal_js_1.Decimal.min(credit, debt, liquidity);
}
function calculateMaxRepay(userBalance, userDebt) {
    return decimal_js_1.Decimal.min(userBalance, userDebt);
}
function validateRepayRemainder(currentDebtUsd, repayAmountUsd, minLoanUsd = exports.MIN_LOAN_USD) {
    const remainingDebt = currentDebtUsd.minus(repayAmountUsd);
    // TODO: Remove this once we have a better way to handle dust loans
    if (remainingDebt.greaterThan(0.001) && remainingDebt.lessThan(minLoanUsd)) {
        return { isValid: false, error: 'min_loan' };
    }
    return { isValid: true };
}
function calculateDebtPreview(currentDebt, amount, isRepaying) {
    return isRepaying ? currentDebt.minus(amount) : currentDebt.plus(amount);
}
function convertAmountByCurrencyView(amount, price, currencyView) {
    if (!amount)
        return { usdAmount: '0', tokenAmount: '0' };
    const usdAmount = currencyView === 'dollar' ? amount : new decimal_js_1.Decimal(amount).mul(price).toString();
    const tokenAmount = currencyView === 'token' ? amount : new decimal_js_1.Decimal(amount).div(price).toString();
    return { usdAmount, tokenAmount };
}
//# sourceMappingURL=borrow.js.map