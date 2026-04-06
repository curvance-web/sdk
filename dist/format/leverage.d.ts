import { Decimal } from "decimal.js";
export declare const MIN_DEPOSIT_USD = 10;
export declare const MIN_BORROW_USD = 10.1;
export declare const HIGH_LEVERAGE_THRESHOLD = 60;
export declare const MAX_LTV_RATIO = 0.85;
export declare function calculateBorrowAmount(depositUsd: Decimal, leverage: number): Decimal;
export declare function calculateLeverageRatio(totalValue: Decimal, debtAmount: Decimal): Decimal;
export declare function calculateDeleverageAmount(currentLeverage: number, targetLeverage: number, totalValue: Decimal): Decimal;
export declare function calculatePositionSize(tokenAmount: Decimal, leverage: number): Decimal;
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
        current: {
            usd: number | string;
        };
        new?: {
            usd: number | string;
        };
    };
    leverage: number;
    borrowAmount: Decimal | undefined;
}
export declare function checkLeverageAmountBelowMinimum(input: CheckLeverageAmountBelowMinimumInput): boolean;
export declare function checkBorrowExceedsLiquidity(borrowAmount: Decimal | undefined, availableLiquidity: Decimal | undefined): boolean;
export declare function validateLeverageInput(input: LeverageValidationInput): ValidationResult;
//# sourceMappingURL=leverage.d.ts.map