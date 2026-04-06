"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LTV_RATIO = exports.HIGH_LEVERAGE_THRESHOLD = exports.MIN_BORROW_USD = exports.MIN_DEPOSIT_USD = void 0;
exports.calculateBorrowAmount = calculateBorrowAmount;
exports.calculateLeverageRatio = calculateLeverageRatio;
exports.calculateDeleverageAmount = calculateDeleverageAmount;
exports.calculatePositionSize = calculatePositionSize;
exports.checkLeverageAmountBelowMinimum = checkLeverageAmountBelowMinimum;
exports.checkBorrowExceedsLiquidity = checkBorrowExceedsLiquidity;
exports.validateLeverageInput = validateLeverageInput;
const decimal_js_1 = require("decimal.js");
exports.MIN_DEPOSIT_USD = 10;
exports.MIN_BORROW_USD = 10.1;
exports.HIGH_LEVERAGE_THRESHOLD = 60;
exports.MAX_LTV_RATIO = 0.85;
function calculateBorrowAmount(depositUsd, leverage) {
    if (leverage <= 1)
        return new decimal_js_1.Decimal(0);
    return depositUsd.mul(leverage - 1);
}
function calculateLeverageRatio(totalValue, debtAmount) {
    if (debtAmount.isZero())
        return new decimal_js_1.Decimal(1);
    const collateralValue = totalValue.minus(debtAmount);
    if (collateralValue.lte(0))
        return new decimal_js_1.Decimal(0);
    return totalValue.div(collateralValue);
}
function calculateDeleverageAmount(currentLeverage, targetLeverage, totalValue) {
    if (targetLeverage >= currentLeverage)
        return new decimal_js_1.Decimal(0);
    const currentDebt = totalValue.mul(1 - 1 / currentLeverage);
    const targetDebt = targetLeverage === 1 ? new decimal_js_1.Decimal(0) : totalValue.mul(1 - 1 / targetLeverage);
    return currentDebt.minus(targetDebt);
}
function calculatePositionSize(tokenAmount, leverage) {
    return tokenAmount.mul(leverage);
}
function checkLeverageAmountBelowMinimum(input) {
    const { isEditLeverage, debtSize, leverage, borrowAmount } = input;
    if (isEditLeverage && debtSize.new) {
        const newDebt = new decimal_js_1.Decimal(debtSize.new.usd || 0);
        // Terminal debt must be either 0 (fully closed) or > MIN_BORROW_USD
        if (newDebt.isZero())
            return false;
        return newDebt.lt(exports.MIN_BORROW_USD);
    }
    if (leverage <= 1)
        return false;
    return borrowAmount?.gt(0) && borrowAmount?.lt(exports.MIN_BORROW_USD) ? true : false;
}
function checkBorrowExceedsLiquidity(borrowAmount, availableLiquidity) {
    if (!borrowAmount || !availableLiquidity)
        return false;
    return borrowAmount.gt(availableLiquidity);
}
function validateLeverageInput(input) {
    const { depositAmount, leverage, availableLiquidity, maxLeverage, userBalance } = input;
    const borrowAmount = depositAmount * (leverage - 1);
    // Priority 1: Balance check
    if (depositAmount > userBalance) {
        return {
            isValid: false,
            error: 'Insufficient balance',
            canProceed: false,
        };
    }
    // Priority 2: Minimum deposit
    if (depositAmount > 0 && depositAmount < exports.MIN_DEPOSIT_USD) {
        return {
            isValid: false,
            error: `Minimum deposit is $${exports.MIN_DEPOSIT_USD}`,
            canProceed: false,
        };
    }
    // Priority 3: Zero deposit
    if (depositAmount <= 0) {
        return {
            isValid: false,
            canProceed: false,
        };
    }
    // Priority 4: Minimum borrow (except for 1x)
    if (leverage > 1 && borrowAmount > 0 && borrowAmount < exports.MIN_BORROW_USD) {
        return {
            isValid: false,
            error: `Leverage would result in borrow below $${exports.MIN_BORROW_USD} minimum`,
            canProceed: false,
        };
    }
    // Priority 5: Available liquidity
    if (borrowAmount > availableLiquidity) {
        return {
            isValid: false,
            error: 'Leverage limit exceeded - insufficient liquidity available',
            canProceed: false,
        };
    }
    // Priority 6: Maximum leverage
    if (leverage > maxLeverage) {
        return {
            isValid: false,
            error: `Maximum leverage is ${maxLeverage}x`,
            canProceed: false,
        };
    }
    // Warning: High leverage
    if (leverage >= exports.HIGH_LEVERAGE_THRESHOLD) {
        return {
            isValid: true,
            warning: `High leverage warning: ${leverage}x leverage increases liquidation risk`,
            canProceed: true,
        };
    }
    // Warning: Low liquidity
    const liquidityUtilization = borrowAmount / availableLiquidity;
    if (liquidityUtilization > 0.8) {
        return {
            isValid: true,
            warning: 'Low available liquidity - leverage may be limited',
            canProceed: true,
        };
    }
    // All validations passed
    return {
        isValid: true,
        canProceed: true,
    };
}
//# sourceMappingURL=leverage.js.map