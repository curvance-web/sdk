import { Decimal } from "decimal.js";

export const USD_DUST_THRESHOLD = new Decimal('0.01');
const DEFAULT_USD_VIEW_DECIMALS = 2;
const DEFAULT_USD_INTERNAL_DECIMALS = 8;

export function clampUsdDustAmount(value: Decimal.Value): Decimal {
    const amount = new Decimal(value || 0);
    return amount.abs().lt(USD_DUST_THRESHOLD) ? new Decimal(0) : amount;
}

const trimTrailingZeros = (value: string) =>
    value.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');

export function normalizeAmountString(
    value: Decimal.Value,
    maxFractionDigits: number,
    roundingMode = Decimal.ROUND_DOWN,
): string {
    const decimals = Math.max(0, maxFractionDigits);
    let decimalValue: Decimal;
    try {
        decimalValue = new Decimal(value || 0);
    } catch {
        return '0';
    }

    const rounded = decimalValue.toDecimalPlaces(decimals, roundingMode);
    if (rounded.isZero()) return '0';

    return trimTrailingZeros(rounded.toFixed(decimals, roundingMode));
}

export type NormalizeCurrencyAmountsOptions = {
    amount: string;
    currencyView: 'dollar' | 'token';
    tokenDecimals: number;
    price: Decimal.Value;
    usdDecimals?: number;
    usdViewDecimals?: number;
};

export function normalizeCurrencyAmounts({
    amount,
    currencyView,
    tokenDecimals,
    price,
    usdDecimals = DEFAULT_USD_INTERNAL_DECIMALS,
    usdViewDecimals = DEFAULT_USD_VIEW_DECIMALS,
}: NormalizeCurrencyAmountsOptions): { amount: string; usdAmount: string; tokenAmount: string } {
    if (!amount) {
        return { amount, usdAmount: '0', tokenAmount: '0' };
    }

    let amountDecimal: Decimal;
    try {
        amountDecimal = new Decimal(amount || 0);
    } catch {
        return { amount: '0', usdAmount: '0', tokenAmount: '0' };
    }

    const priceDecimal = new Decimal(price || 0);
    const hasPrice = priceDecimal.gt(0);

    const tokenAmountRaw =
        currencyView === 'token'
            ? amountDecimal
            : hasPrice
                ? amountDecimal.div(priceDecimal)
                : new Decimal(0);
    const usdAmountRaw =
        currencyView === 'dollar'
            ? amountDecimal
            : hasPrice
                ? amountDecimal.mul(priceDecimal)
                : new Decimal(0);

    const endsWithDot = typeof amount === 'string' && amount.endsWith('.');

    // Preserve trailing zeros after decimal point during user input (e.g., "0.0", "0.00", "1.20")
    const hasTrailingZeros = typeof amount === 'string' && /\.\d*0$/.test(amount);

    const dustDecimals = currencyView === 'dollar' ? usdViewDecimals : usdDecimals;
    const usdThreshold = new Decimal(10).pow(-Math.max(0, dustDecimals));
    if (
        !endsWithDot &&
        !hasTrailingZeros &&
        (currencyView === 'dollar' || hasPrice) &&
        usdAmountRaw.abs().lt(usdThreshold)
    ) {
        return { amount: '0', usdAmount: '0', tokenAmount: '0' };
    }

    const normalizedAmount =
        currencyView === 'dollar'
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
