import { Decimal } from "decimal.js";

export const MIN_LOAN_USD = 10;

export function calculateMaxBorrow(
    userRemainingCredit: Decimal,
    remainingDebt: Decimal,
    availableLiquidity: Decimal,
): Decimal {
    const credit = Decimal.max(userRemainingCredit, 0);
    const debt = Decimal.max(remainingDebt, 0);
    const liquidity = Decimal.max(availableLiquidity, 0);

    return Decimal.min(credit, debt, liquidity);
}

export function calculateMaxRepay(userBalance: Decimal, userDebt: Decimal): Decimal {
    return Decimal.min(userBalance, userDebt);
}

export interface RepayValidation {
    isValid: boolean;
    error?: 'min_loan';
}

export function validateRepayRemainder(
    currentDebtUsd: Decimal,
    repayAmountUsd: Decimal,
    minLoanUsd: number = MIN_LOAN_USD,
): RepayValidation {
    const remainingDebt = currentDebtUsd.minus(repayAmountUsd);

    // TODO: Remove this once we have a better way to handle dust loans
    if (remainingDebt.greaterThan(0.001) && remainingDebt.lessThan(minLoanUsd)) {
        return { isValid: false, error: 'min_loan' };
    }

    return { isValid: true };
}

export function calculateDebtPreview(
    currentDebt: Decimal,
    amount: Decimal,
    isRepaying: boolean,
): Decimal {
    return isRepaying ? currentDebt.minus(amount) : currentDebt.plus(amount);
}

export function convertAmountByCurrencyView(
    amount: string,
    price: Decimal,
    currencyView: 'dollar' | 'token',
): { usdAmount: string; tokenAmount: string } {
    if (!amount) return { usdAmount: '0', tokenAmount: '0' };

    const usdAmount = currencyView === 'dollar' ? amount : new Decimal(amount).mul(price).toString();
    const tokenAmount = currencyView === 'token' ? amount : new Decimal(amount).div(price).toString();

    return { usdAmount, tokenAmount };
}
