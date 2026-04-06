import { Decimal } from "decimal.js";
export interface CollateralBreakdown {
    exchangeRate: Decimal;
    collateralAssets: Decimal;
    uncollateralizedAssets: Decimal;
}
export declare function calculateExchangeRate(assetBalance: Decimal, shareBalance: Decimal): Decimal;
export declare function calculateCollateralBreakdown(assetBalance: Decimal, collateralShares: Decimal, exchangeRate: Decimal): CollateralBreakdown;
export declare function calculateNewCollateral(currentCollateral: Decimal, amount: Decimal, action: 'add' | 'remove'): Decimal;
//# sourceMappingURL=collateral.d.ts.map