import { Decimal } from "decimal.js";

export interface CollateralBreakdown {
    exchangeRate: Decimal;
    collateralAssets: Decimal;
    uncollateralizedAssets: Decimal;
}

export function calculateExchangeRate(assetBalance: Decimal, shareBalance: Decimal): Decimal {
    if (shareBalance.gt(0) && !shareBalance.isZero()) {
        return assetBalance.div(shareBalance);
    }
    return new Decimal(1);
}

export function calculateCollateralBreakdown(
    assetBalance: Decimal,
    collateralShares: Decimal,
    exchangeRate: Decimal,
): CollateralBreakdown {
    const collateralAssets = Decimal.min(assetBalance, collateralShares.mul(exchangeRate));
    const uncollateralizedAssets = Decimal.max(assetBalance.minus(collateralAssets), new Decimal(0));

    return {
        exchangeRate,
        collateralAssets,
        uncollateralizedAssets,
    };
}

export function calculateNewCollateral(
    currentCollateral: Decimal,
    amount: Decimal,
    action: 'add' | 'remove',
): Decimal {
    if (action === 'add') {
        return currentCollateral.plus(amount);
    }
    return Decimal.max(currentCollateral.minus(amount), new Decimal(0));
}
