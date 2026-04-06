import { Decimal } from "decimal.js";
export declare const USD_DUST_THRESHOLD: Decimal;
export declare function clampUsdDustAmount(value: Decimal.Value): Decimal;
export declare function normalizeAmountString(value: Decimal.Value, maxFractionDigits: number, roundingMode?: 1): string;
export type NormalizeCurrencyAmountsOptions = {
    amount: string;
    currencyView: 'dollar' | 'token';
    tokenDecimals: number;
    price: Decimal.Value;
    usdDecimals?: number;
    usdViewDecimals?: number;
};
export declare function normalizeCurrencyAmounts({ amount, currencyView, tokenDecimals, price, usdDecimals, usdViewDecimals, }: NormalizeCurrencyAmountsOptions): {
    amount: string;
    usdAmount: string;
    tokenAmount: string;
};
//# sourceMappingURL=amounts.d.ts.map