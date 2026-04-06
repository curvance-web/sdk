"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAUTION_HEALTH_UPPER = exports.LOW_HEALTH_THRESHOLD = void 0;
exports.getHealthStatus = getHealthStatus;
exports.healthFactorToPercentage = healthFactorToPercentage;
exports.formatHealthFactorPercentage = formatHealthFactorPercentage;
exports.formatHealthFactor = formatHealthFactor;
exports.getLiquidityStatus = getLiquidityStatus;
const decimal_js_1 = require("decimal.js");
exports.LOW_HEALTH_THRESHOLD = 10;
exports.CAUTION_HEALTH_UPPER = 20;
function getHealthStatus(percentageValue) {
    if (percentageValue == null)
        return 'Healthy';
    if (percentageValue < 5)
        return 'Danger';
    if (percentageValue >= 5 && percentageValue <= 20)
        return 'Caution';
    if (percentageValue > 20)
        return 'Healthy';
    return 'Healthy';
}
function healthFactorToPercentage(rawHealthFactor) {
    return Math.max(((rawHealthFactor ?? 5) - 1) * 100, 0);
}
function formatHealthFactorPercentage(value) {
    return new Intl.NumberFormat('en-US', {
        style: 'percent',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value / 100);
}
function formatHealthFactor(value) {
    if (value === null || value === undefined)
        return '∞';
    if (value >= 999)
        return '>999%';
    return formatHealthFactorPercentage(Math.max(value, 0));
}
function getLiquidityStatus(ratio) {
    const v = new decimal_js_1.Decimal(ratio).toNumber();
    if (v < 0.75)
        return 'green';
    if (v >= 0.76 && v <= 0.9)
        return 'yellow';
    if (v > 0.91)
        return 'red';
    return 'yellow';
}
//# sourceMappingURL=health.js.map