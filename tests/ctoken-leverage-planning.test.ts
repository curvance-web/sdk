import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { BorrowableCToken, CToken } from '../src';
import type { FeePolicyContext } from '../src/feePolicy';

const WAD = 10n ** 18n;
const COLLATERAL = '0x00000000000000000000000000000000000000c1';
const DEBT = '0x00000000000000000000000000000000000000d1';
const ACCOUNT = '0x00000000000000000000000000000000000000aa';

const toWad = (value: string | number) =>
    BigInt(new Decimal(value).mul(new Decimal(10).pow(18)).toFixed(0));

function expectClose(actual: Decimal, expected: Decimal.Value, tolerance = '0.0000001') {
    assert.ok(
        actual.sub(new Decimal(expected)).abs().lte(new Decimal(tolerance)),
        `expected ${actual.toString()} to be within ${tolerance} of ${expected}`,
    );
}

function createLeveragePlanningHarness({
    feeByOperation = {},
    maxLeverage = Decimal(100),
    marketCollateralUsd = Decimal(100),
    tokenCollateralUsd = Decimal(100),
    userDebtUsd = Decimal(40),
}: {
    feeByOperation?: Partial<Record<'leverage-up' | 'deposit-and-leverage', bigint>>;
    maxLeverage?: Decimal;
    marketCollateralUsd?: Decimal;
    tokenCollateralUsd?: Decimal;
    userDebtUsd?: Decimal;
} = {}) {
    const feeCalls: FeePolicyContext[] = [];
    const token = Object.create(CToken.prototype) as CToken;
    const borrow = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
    const tokenCollateralShares = BigInt(
        tokenCollateralUsd.div(Decimal(2)).mul(new Decimal(10).pow(18)).toFixed(0),
    );

    const market = {
        address: '0x0000000000000000000000000000000000000abc',
        account: ACCOUNT,
        userCollateral: marketCollateralUsd,
        userDebt: userDebtUsd,
        cache: {
            user: {
                collateral: toWad(marketCollateralUsd.toString()),
                debt: toWad(userDebtUsd.toString()),
            },
        },
        setup: {
            chain: 'monad-mainnet',
            feePolicy: {
                feeReceiver: ACCOUNT,
                getFeeBps(ctx: FeePolicyContext) {
                    feeCalls.push(ctx);
                    return feeByOperation[ctx.operation as 'leverage-up' | 'deposit-and-leverage'] ?? 0n;
                },
            },
        },
    };

    (token as any).market = market;
    (token as any).cache = {
        maxLeverage: 100_000n,
        userCollateral: tokenCollateralShares,
        decimals: 18n,
        asset: { address: COLLATERAL, decimals: 18n },
        assetPrice: WAD,
        assetPriceLower: WAD,
        sharePrice: 2n * WAD,
        sharePriceLower: 2n * WAD,
        totalAssets: 200n * WAD,
        totalSupply: 100n * WAD,
    };
    Object.defineProperty(token, 'maxLeverage', {
        configurable: true,
        get: () => maxLeverage,
    });
    (borrow as any).market = market;
    (borrow as any).cache = {
        decimals: 18n,
        asset: { address: DEBT, decimals: 18n },
        assetPrice: WAD,
        assetPriceLower: WAD,
        sharePrice: WAD,
        sharePriceLower: WAD,
        totalAssets: 1n,
        totalSupply: 1n,
    };

    return { token, borrow, feeCalls };
}

describe('CToken leverage planning', () => {
    test('legacy overloaded preview accepts targets between post-deposit baseline and live leverage', () => {
        const { token, borrow } = createLeveragePlanningHarness();
        const preview = token.previewLeverageUp(Decimal('1.60'), borrow, toWad(10));

        expectClose(preview.currentLeverage, '1.6666666667');
        expectClose(preview.effectiveCurrentLeverage, '1.5714285714');
        expectClose(preview.targetLeverage, '1.6');
        expectClose(preview.borrowAmount, '2');
        expectClose(preview.debtIncrease, '2');
        expectClose(preview.collateralIncreaseInAssets, '12');
        assert.equal(preview.borrowAssets, toWad(2));
    });

    test('previewDepositAndLeverage clamps to the post-deposit baseline instead of inventing extra borrow', () => {
        const { token, borrow } = createLeveragePlanningHarness();
        const preview = token.previewDepositAndLeverage(Decimal('1.55'), borrow, toWad(10));

        expectClose(preview.effectiveCurrentLeverage, '1.5714285714');
        expectClose(preview.targetLeverage, preview.effectiveCurrentLeverage);
        expectClose(preview.borrowAmount, '0');
        expectClose(preview.debtIncrease, '0');
        expectClose(preview.collateralIncreaseInAssets, '10');
        assert.equal(preview.borrowAssets, 0n);
        assert.equal(preview.feeBps, 0n);
    });

    test('deposit-and-leverage preview uses deposit-specific fee policy semantics', () => {
        const { token, borrow, feeCalls } = createLeveragePlanningHarness({
            feeByOperation: {
                'leverage-up': 11n,
                'deposit-and-leverage': 37n,
            },
        });

        const preview = token.previewDepositAndLeverage(Decimal('1.60'), borrow, toWad(10));

        assert.equal(preview.feeBps, 37n);
        assert.equal(feeCalls.length, 1);
        assert.equal(feeCalls[0]?.operation, 'deposit-and-leverage');
        expectClose(feeCalls[0]?.currentLeverage ?? Decimal(0), '1.5714285714');
        expectClose(preview.collateralIncreaseInAssets, '11.9926');
    });

    test('plain leverage-up preview keeps leverage-up fee policy semantics', () => {
        const { token, borrow, feeCalls } = createLeveragePlanningHarness({
            feeByOperation: {
                'leverage-up': 11n,
                'deposit-and-leverage': 37n,
            },
        });

        const preview = token.previewLeverageUp(Decimal('2.00'), borrow);

        assert.equal(preview.feeBps, 11n);
        assert.equal(feeCalls.length, 1);
        assert.equal(feeCalls[0]?.operation, 'leverage-up');
        expectClose(feeCalls[0]?.currentLeverage ?? Decimal(0), '1.6666666667');
    });

    test('previewDepositAndLeverage caps requested leverage at maxLeverage before planning fees and borrow', () => {
        const { token, borrow, feeCalls } = createLeveragePlanningHarness({
            feeByOperation: {
                'deposit-and-leverage': 37n,
            },
            maxLeverage: Decimal('1.58'),
        });

        const preview = token.previewDepositAndLeverage(Decimal('2.25'), borrow, toWad(10));

        expectClose(preview.effectiveCurrentLeverage, '1.5714285714');
        expectClose(preview.targetLeverage, '1.58');
        expectClose(preview.borrowAmount, '0.6');
        expectClose(preview.debtIncrease, '0.6');
        assert.equal(feeCalls.length, 1);
        expectClose(feeCalls[0]?.targetLeverage ?? Decimal(0), '1.58');
        expectClose(feeCalls[0]?.currentLeverage ?? Decimal(0), '1.5714285714');
    });

    test('previewDepositAndLeverage stays pinned to the post-deposit baseline when maxLeverage drops below it', () => {
        const { token, borrow } = createLeveragePlanningHarness({
            maxLeverage: Decimal('1.55'),
        });

        const preview = token.previewDepositAndLeverage(Decimal('2.25'), borrow, toWad(10));

        expectClose(preview.effectiveCurrentLeverage, '1.5714285714');
        expectClose(preview.targetLeverage, '1.5714285714');
        expectClose(preview.borrowAmount, '0');
        expectClose(preview.debtIncrease, '0');
        assert.equal(preview.borrowAssets, 0n);
    });

    test('previewLeverageUp uses aggregate market collateral when other collateral is posted in the same market', () => {
        const { token, borrow } = createLeveragePlanningHarness({
            marketCollateralUsd: Decimal(100),
            tokenCollateralUsd: Decimal(50),
        });

        const preview = token.previewLeverageUp(Decimal('2.00'), borrow);

        expectClose(token.getLeverage() ?? Decimal(0), '1.6666666667');
        expectClose(preview.currentLeverage, '1.6666666667');
        expectClose(preview.borrowAmount, '20');
        expectClose(preview.debtIncrease, '20');
        expectClose(preview.newCollateral, '120');
        assert.equal(preview.borrowAssets, toWad(20));
    });

    test('previewDepositAndLeverage uses aggregate market collateral when computing the post-deposit baseline', () => {
        const { token, borrow } = createLeveragePlanningHarness({
            marketCollateralUsd: Decimal(100),
            tokenCollateralUsd: Decimal(50),
        });

        const preview = token.previewDepositAndLeverage(Decimal('1.60'), borrow, toWad(10));

        expectClose(preview.currentLeverage, '1.6666666667');
        expectClose(preview.effectiveCurrentLeverage, '1.5714285714');
        expectClose(preview.targetLeverage, '1.6');
        expectClose(preview.borrowAmount, '2');
        expectClose(preview.debtIncrease, '2');
        assert.equal(preview.borrowAssets, toWad(2));
    });

    test('previewLeverageDown uses aggregate market collateral when sizing deleverage on a mixed-collateral position', () => {
        const { token, borrow } = createLeveragePlanningHarness({
            marketCollateralUsd: Decimal(100),
            tokenCollateralUsd: Decimal(50),
        });

        const preview = token.previewLeverageDown(
            Decimal('1.50'),
            token.getLeverage() ?? Decimal(1),
            borrow,
        );

        expectClose(preview.collateralAssetReductionUsd, '10');
        assert.equal(preview.collateralAssetReduction, toWad(10));
        expectClose(preview.newDebt, '30');
        expectClose(preview.newCollateral, '90');
    });
});
