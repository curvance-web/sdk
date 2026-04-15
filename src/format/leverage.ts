import { Decimal } from "decimal.js";

export const MIN_DEPOSIT_USD = 10;
export const MIN_BORROW_USD = 10.1;
export const HIGH_LEVERAGE_THRESHOLD = 60;
export const MAX_LTV_RATIO = 0.85;

export function calculateBorrowAmount(depositUsd: Decimal, leverage: number): Decimal {
    if (leverage <= 1) return new Decimal(0);
    return depositUsd.mul(leverage - 1);
}

export function calculateLeverageRatio(totalValue: Decimal, debtAmount: Decimal): Decimal {
    if (debtAmount.isZero()) return new Decimal(1);
    const collateralValue = totalValue.minus(debtAmount);
    if (collateralValue.lte(0)) return new Decimal(0);
    return totalValue.div(collateralValue);
}

export function calculateDeleverageAmount(
    currentLeverage: number,
    targetLeverage: number,
    totalValue: Decimal,
): Decimal {
    if (targetLeverage >= currentLeverage) return new Decimal(0);

    const currentDebt = totalValue.mul(1 - 1 / currentLeverage);
    const targetDebt = targetLeverage === 1 ? new Decimal(0) : totalValue.mul(1 - 1 / targetLeverage);

    return currentDebt.minus(targetDebt);
}

export function calculatePositionSize(tokenAmount: Decimal, leverage: number): Decimal {
    return tokenAmount.mul(leverage);
}

export interface LeverageValidationInput {
    depositAmount: number;
    leverage: number;
    availableLiquidity: number;
    maxLeverage: number;
    userBalance: number;
    currentDebt?: number;
}

export interface ValidationResult {
    isValid: boolean;
    error?: string;
    warning?: string;
    canProceed: boolean;
}

export interface CheckLeverageAmountBelowMinimumInput {
    isEditLeverage: boolean;
    debtSize: {
        current: { usd: number | string };
        new?: { usd: number | string };
    };
    leverage: number;
    borrowAmount: Decimal | undefined;
}

export function checkLeverageAmountBelowMinimum(
    input: CheckLeverageAmountBelowMinimumInput,
): boolean {
    const { isEditLeverage, debtSize, leverage, borrowAmount } = input;

    if (isEditLeverage && debtSize.new) {
        const newDebt = new Decimal(debtSize.new.usd || 0);

        // Terminal debt must be either 0 (fully closed) or > MIN_BORROW_USD
        if (newDebt.isZero()) return false;
        return newDebt.lt(MIN_BORROW_USD);
    }

    if (leverage <= 1) return false;
    return borrowAmount?.gt(0) && borrowAmount?.lt(MIN_BORROW_USD) ? true : false;
}

export function checkBorrowExceedsLiquidity(
    borrowAmount: Decimal | undefined,
    availableLiquidity: Decimal | undefined,
): boolean {
    if (!borrowAmount || !availableLiquidity) return false;
    return borrowAmount.gt(availableLiquidity);
}

export function validateLeverageInput(input: LeverageValidationInput): ValidationResult {
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
    if (depositAmount > 0 && depositAmount < MIN_DEPOSIT_USD) {
        return {
            isValid: false,
            error: `Minimum deposit is $${MIN_DEPOSIT_USD}`,
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
    if (leverage > 1 && borrowAmount > 0 && borrowAmount < MIN_BORROW_USD) {
        return {
            isValid: false,
            error: `Leverage would result in borrow below $${MIN_BORROW_USD} minimum`,
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
    if (leverage >= HIGH_LEVERAGE_THRESHOLD) {
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
