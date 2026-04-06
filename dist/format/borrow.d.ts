import { Decimal } from "decimal.js";
export declare const MIN_LOAN_USD = 10;
export declare function calculateMaxBorrow(userRemainingCredit: Decimal, remainingDebt: Decimal, availableLiquidity: Decimal): Decimal;
export declare function calculateMaxRepay(userBalance: Decimal, userDebt: Decimal): Decimal;
export interface RepayValidation {
    isValid: boolean;
    error?: 'min_loan';
}
export declare function validateRepayRemainder(currentDebtUsd: Decimal, repayAmountUsd: Decimal, minLoanUsd?: number): RepayValidation;
export declare function calculateDebtPreview(currentDebt: Decimal, amount: Decimal, isRepaying: boolean): Decimal;
export declare function convertAmountByCurrencyView(amount: string, price: Decimal, currencyView: 'dollar' | 'token'): {
    usdAmount: string;
    tokenAmount: string;
};
//# sourceMappingURL=borrow.d.ts.map