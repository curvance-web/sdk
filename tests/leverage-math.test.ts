import { describe, test } from 'node:test';
import assert from 'node:assert';
import Decimal from 'decimal.js';
import { CToken } from '../src';
import { amplifyContractSlippage, toContractSwapSlippage } from '../src/helpers';

describe('amplifyContractSlippage', () => {
    const makeMaxLeverageToken = (maxLeverageBps: bigint) => {
        const token = Object.create(CToken.prototype) as CToken;
        (token as any).cache = { maxLeverage: maxLeverageBps };
        return token;
    };

    describe('zero-bps guard', () => {
        test('returns baseSlippage unchanged when bpsToAmplify is 0n', () => {
            const result = amplifyContractSlippage(100n, Decimal(9), 0n);
            assert.strictEqual(result, 100n);
        });

        test('returns baseSlippage unchanged even when leverageDelta is 0', () => {
            const result = amplifyContractSlippage(250n, Decimal(0), 0n);
            assert.strictEqual(result, 250n);
        });
    });

    describe('leverageUp-shaped call (fee only)', () => {
        test('moderate leverage: 100 bps base + 4 x 4 bps = 116 bps', () => {
            const result = amplifyContractSlippage(100n, Decimal(4), 4n);
            assert.strictEqual(result, 116n);
        });

        test('shMON-like: 100 bps base + (10-1) x 4 bps = 136 bps', () => {
            const result = amplifyContractSlippage(100n, Decimal(9), 4n);
            assert.strictEqual(result, 136n);
        });

        test('zero leverage delta leaves slippage unchanged', () => {
            const result = amplifyContractSlippage(50n, Decimal(0), 4n);
            assert.strictEqual(result, 50n);
        });
    });

    describe('leverageDown-shaped call', () => {
        test('full deleverage: 100 bps base + (L-1) x (overhead + fee)', () => {
            const result = amplifyContractSlippage(100n, Decimal(9), 24n);
            assert.strictEqual(result, 316n);
        });

        test('partial deleverage: 50 bps base + (currL - newL) x fee', () => {
            const result = amplifyContractSlippage(50n, Decimal(2), 4n);
            assert.strictEqual(result, 58n);
        });
    });

    describe('precision + ceiling behavior', () => {
        test('rounds up on non-integer expansion', () => {
            const result = amplifyContractSlippage(0n, Decimal(2.5), 3n);
            assert.strictEqual(result, 8n);
        });

        test('rounds up on tiny fractional expansion', () => {
            const result = amplifyContractSlippage(10n, Decimal(0.33), 3n);
            assert.strictEqual(result, 11n);
        });

        test('handles very large leverageDelta without precision loss', () => {
            const result = amplifyContractSlippage(0n, Decimal(1000), 4n);
            assert.strictEqual(result, 4000n);
        });

        test('handles high-precision Decimal leverageDelta values', () => {
            const result = amplifyContractSlippage(0n, Decimal('9.9999999999'), 4n);
            assert.strictEqual(result, 40n);
        });
    });

    describe('maxLeverage getter', () => {
        test('shMON-shaped market (r=0.9, theoretical=10) caps at 9.82x', () => {
            const token = makeMaxLeverageToken(100_000n);
            assert.strictEqual(token.maxLeverage.toFixed(2), '9.82');
        });

        test('2x theoretical market (r=0.5) caps at 1.98x', () => {
            const token = makeMaxLeverageToken(20_000n);
            assert.strictEqual(token.maxLeverage.toFixed(2), '1.98');
        });

        test('preserves the public cap formula across arbitrary markets', () => {
            const token = makeMaxLeverageToken(61_000n);
            const theoretical = new Decimal(6.1);
            const expectedCap = new Decimal(1).add(theoretical.sub(1).mul(new Decimal(0.98)));
            assert.strictEqual(token.maxLeverage.toFixed(6), expectedCap.toFixed(6));
        });
    });

    describe('non-regression: behavior identical to the pre-extraction inline form', () => {
        test('leverageUp at 5x with 10 bps user slippage + 4 bps fee', () => {
            assert.strictEqual(
                amplifyContractSlippage(10n, Decimal(4), 4n),
                26n,
            );
        });

        test('leverageDown partial 5x->3x with 50 bps slippage + 4 bps fee', () => {
            assert.strictEqual(
                amplifyContractSlippage(50n, Decimal(2), 4n),
                58n,
            );
        });

        test('leverageDown full from 10x with 100 bps slippage + (20+4) bps', () => {
            assert.strictEqual(
                amplifyContractSlippage(100n, Decimal(9), 24n),
                316n,
            );
        });
    });
});

describe('toContractSwapSlippage', () => {
    const BPS_TO_WAD = 100_000_000_000_000n;

    describe('zero-input guard', () => {
        test('returns 0n when userSlippage is 0n and feeBps is undefined', () => {
            assert.strictEqual(toContractSwapSlippage(0n), 0n);
        });

        test('returns 0n when userSlippage is 0n and feeBps is 0n', () => {
            assert.strictEqual(toContractSwapSlippage(0n, 0n), 0n);
        });

        test('returns 0n when userSlippage is 0n and feeBps is negative', () => {
            assert.strictEqual(toContractSwapSlippage(0n, -5n), 0n);
        });
    });

    describe('user slippage only (no fee)', () => {
        test('100 bps user slippage -> 100 x 1e14 WAD', () => {
            assert.strictEqual(toContractSwapSlippage(100n), 100n * BPS_TO_WAD);
        });

        test('100 bps user slippage with feeBps=0n stays unchanged', () => {
            assert.strictEqual(toContractSwapSlippage(100n, 0n), 100n * BPS_TO_WAD);
        });

        test('1 bps user slippage -> 1e14 WAD', () => {
            assert.strictEqual(toContractSwapSlippage(1n), BPS_TO_WAD);
        });
    });

    describe('fee expansion', () => {
        test('100 bps slippage + 4 bps fee -> 104 x 1e14 WAD', () => {
            assert.strictEqual(
                toContractSwapSlippage(100n, 4n),
                104n * BPS_TO_WAD,
            );
        });

        test('0 bps slippage + 4 bps fee -> 4 x 1e14 WAD', () => {
            assert.strictEqual(
                toContractSwapSlippage(0n, 4n),
                4n * BPS_TO_WAD,
            );
        });

        test('200 bps slippage + 10 bps fee -> 210 x 1e14 WAD', () => {
            assert.strictEqual(
                toContractSwapSlippage(200n, 10n),
                210n * BPS_TO_WAD,
            );
        });
    });

    describe('KyberSwap non-regression', () => {
        test('realistic call: 50 bps slippage + 4 bps Curvance fee', () => {
            assert.strictEqual(
                toContractSwapSlippage(50n, 4n),
                54n * BPS_TO_WAD,
            );
        });

        test('no-fee policy leaves slippage unchanged', () => {
            assert.strictEqual(
                toContractSwapSlippage(75n, undefined),
                75n * BPS_TO_WAD,
            );
        });

        test('zero-slippage + zero-fee returns 0n without WAD conversion', () => {
            assert.strictEqual(toContractSwapSlippage(0n, 0n), 0n);
            assert.strictEqual(toContractSwapSlippage(0n), 0n);
        });
    });
});
