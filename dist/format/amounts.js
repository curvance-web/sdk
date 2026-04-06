"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.USD_DUST_THRESHOLD = void 0;
exports.clampUsdDustAmount = clampUsdDustAmount;
exports.normalizeAmountString = normalizeAmountString;
exports.normalizeCurrencyAmounts = normalizeCurrencyAmounts;
const decimal_js_1 = require("decimal.js");
exports.USD_DUST_THRESHOLD = new decimal_js_1.Decimal('0.01');
const DEFAULT_USD_VIEW_DECIMALS = 2;
const DEFAULT_USD_INTERNAL_DECIMALS = 8;
function clampUsdDustAmount(value) {
    const amount = new decimal_js_1.Decimal(value || 0);
    return amount.abs().lt(exports.USD_DUST_THRESHOLD) ? new decimal_js_1.Decimal(0) : amount;
}
const trimTrailingZeros = (value) => value.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
function normalizeAmountString(value, maxFractionDigits, roundingMode = decimal_js_1.Decimal.ROUND_DOWN) {
    const decimals = Math.max(0, maxFractionDigits);
    let decimalValue;
    try {
        decimalValue = new decimal_js_1.Decimal(value || 0);
    }
    catch {
        return '0';
    }
    const rounded = decimalValue.toDecimalPlaces(decimals, roundingMode);
    if (rounded.isZero())
        return '0';
    return trimTrailingZeros(rounded.toFixed(decimals, roundingMode));
}
function normalizeCurrencyAmounts({ amount, currencyView, tokenDecimals, price, usdDecimals = DEFAULT_USD_INTERNAL_DECIMALS, usdViewDecimals = DEFAULT_USD_VIEW_DECIMALS, }) {
    if (!amount) {
        return { amount, usdAmount: '0', tokenAmount: '0' };
    }
    let amountDecimal;
    try {
        amountDecimal = new decimal_js_1.Decimal(amount || 0);
    }
    catch {
        return { amount: '0', usdAmount: '0', tokenAmount: '0' };
    }
    const priceDecimal = new decimal_js_1.Decimal(price || 0);
    const hasPrice = priceDecimal.gt(0);
    const tokenAmountRaw = currencyView === 'token'
        ? amountDecimal
        : hasPrice
            ? amountDecimal.div(priceDecimal)
            : new decimal_js_1.Decimal(0);
    const usdAmountRaw = currencyView === 'dollar'
        ? amountDecimal
        : hasPrice
            ? amountDecimal.mul(priceDecimal)
            : new decimal_js_1.Decimal(0);
    const endsWithDot = typeof amount === 'string' && amount.endsWith('.');
    // Preserve trailing zeros after decimal point during user input (e.g., "0.0", "0.00", "1.20")
    const hasTrailingZeros = typeof amount === 'string' && /\.\d*0$/.test(amount);
    const dustDecimals = currencyView === 'dollar' ? usdViewDecimals : usdDecimals;
    const usdThreshold = new decimal_js_1.Decimal(10).pow(-Math.max(0, dustDecimals));
    if (!endsWithDot &&
        !hasTrailingZeros &&
        (currencyView === 'dollar' || hasPrice) &&
        usdAmountRaw.abs().lt(usdThreshold)) {
        return { amount: '0', usdAmount: '0', tokenAmount: '0' };
    }
    const normalizedAmount = currencyView === 'dollar'
        ? normalizeAmountString(amountDecimal, usdViewDecimals)
        : normalizeAmountString(amountDecimal, tokenDecimals);
    // Preserve user's exact input when they're typing decimal values with trailing zeros
    const preservedAmount = endsWithDot || hasTrailingZeros ? amount : normalizedAmount;
    return {
        amount: preservedAmount,
        usdAmount: normalizeAmountString(usdAmountRaw, usdDecimals),
        tokenAmount: normalizeAmountString(tokenAmountRaw, tokenDecimals),
    };
}
//# sourceMappingURL=amounts.js.map