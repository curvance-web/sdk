import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { BorrowableCToken, CToken, Market } from '../src';

describe('Market leverage health preview delegation', () => {
    test('previewPositionHealthLeverageUp forwards pure leverage deltas from the token preview', async () => {
        const market = Object.create(Market.prototype) as Market;
        const depositToken = Object.create(CToken.prototype) as CToken;
        const borrowToken = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
        const calls: unknown[][] = [];

        (market as any).previewPositionHealth = async (...args: unknown[]) => {
            calls.push(args);
            return Decimal(4.2);
        };
        (depositToken as any).previewLeverageUp = () => ({
            collateralIncreaseInAssets: Decimal('3.21'),
            debtIncreaseInAssets: Decimal('1.11'),
        });

        const result = await market.previewPositionHealthLeverageUp(
            depositToken,
            borrowToken,
            Decimal('2.50'),
        );

        assert.equal(result?.toString(), '4.2');
        assert.deepEqual(calls, [[
            depositToken,
            borrowToken,
            true,
            Decimal('3.21'),
            false,
            Decimal('1.11'),
        ]]);
    });

    test('previewPositionHealthLeverageUp switches to deposit-and-leverage deltas when deposit assets are present', async () => {
        const market = Object.create(Market.prototype) as Market;
        const depositToken = Object.create(CToken.prototype) as CToken;
        const borrowToken = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
        const calls: unknown[][] = [];

        (market as any).previewPositionHealth = async (...args: unknown[]) => {
            calls.push(args);
            return Decimal(7.5);
        };
        (depositToken as any).previewDepositAndLeverage = (
            leverage: Decimal,
            borrow: BorrowableCToken,
            depositAssets: bigint,
        ) => {
            assert.equal(leverage.toString(), '1.6');
            assert.equal(borrow, borrowToken);
            assert.equal(depositAssets, 10n);
            return {
                collateralIncreaseInAssets: Decimal('11.9926'),
                debtIncreaseInAssets: Decimal('2'),
            };
        };

        const result = await market.previewPositionHealthLeverageUp(
            depositToken,
            borrowToken,
            Decimal('1.6'),
            10n,
        );

        assert.equal(result?.toString(), '7.5');
        assert.deepEqual(calls, [[
            depositToken,
            borrowToken,
            true,
            Decimal('11.9926'),
            false,
            Decimal('2'),
        ]]);
    });
});
