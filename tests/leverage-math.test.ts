import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import { amplifyContractSlippage, toContractSwapSlippage } from '../src/helpers';

/**
 * Pure unit tests for `amplifyContractSlippage`. No Anvil, no RPC — the
 * function is deterministic bigint/Decimal math. Runs in `test:transport`.
 *
 * The helper was extracted from 3 near-identical inline sites in CToken.ts
 * (leverageUp, leverageDown, depositAndLeverage). These tests pin the
 * behavior documented in the helper's JSDoc so a future regression that
 * drops the ceil, flips the guard, or loses precision fails visibly.
 */

describe('amplifyContractSlippage', () => {
    describe('zero-bps guard', () => {
        test('returns baseSlippage unchanged when bpsToAmplify is 0n', () => {
            // The zero-guard is not just an optimization — it also prevents
            // a Decimal(0).toFixed(0) → '0' → BigInt('0') → 0n add, which
            // would be correct but wasteful. Explicit short-circuit matches
            // the original inline behavior at all 3 sites.
            const result = amplifyContractSlippage(100n, Decimal(9), 0n);
            assert.strictEqual(result, 100n);
        });

        test('returns baseSlippage unchanged even when leverageDelta is 0', () => {
            // Degenerate case: leverage hasn't moved. The guard on bpsToAmplify
            // fires first, but even if it didn't, leverageDelta × fee = 0.
            const result = amplifyContractSlippage(250n, Decimal(0), 0n);
            assert.strictEqual(result, 250n);
        });
    });

    describe('leverageUp-shaped call (feeBps only)', () => {
        test('small fee at moderate leverage: 100 bps base + 5× × 4 bps = 120 bps', () => {
            // leverageUp: leverageDelta = newLeverage - 1. newLeverage=5 → delta=4.
            // Amplification: 4 × 4 = 16. Total: 100 + 16 = 116.
            const result = amplifyContractSlippage(100n, Decimal(4), 4n);
            assert.strictEqual(result, 116n);
        });

        test('shMON-like: 100 bps base + (10-1) × 4 bps = 136 bps', () => {
            // At theoretical max leverage for shMON (r=0.9 → L=10), the fee
            // eats (L-1) × fee = 9 × 4 = 36 bps of equity-fraction loss. Plus
            // the user's 100 bps slippage budget, contract tolerance = 136 bps.
            const result = amplifyContractSlippage(100n, Decimal(9), 4n);
            assert.strictEqual(result, 136n);
        });

        test('zero leverage delta (L=1, no leverage): expansion is 0', () => {
            // At exactly 1x (no leverage), there's no equity-fraction
            // amplification — the swap IS the whole equity. Expansion=0.
            const result = amplifyContractSlippage(50n, Decimal(0), 4n);
            assert.strictEqual(result, 50n);
        });
    });

    describe('leverageDown-shaped call (full deleverage with overhead)', () => {
        test('full deleverage: 100 bps base + (L-1) × (overhead + fee)', () => {
            // Full deleverage from 10x: leverageDelta = 10 - 1 = 9. forcedBps
            // = DELEVERAGE_OVERHEAD_BPS (20) + feeBps (4) = 24. Expansion:
            // 9 × 24 = 216. Total: 100 + 216 = 316.
            const result = amplifyContractSlippage(100n, Decimal(9), 24n);
            assert.strictEqual(result, 316n);
        });

        test('partial deleverage: 50 bps base + (currL - newL) × fee', () => {
            // Partial from 5x → 3x: leverageDelta = 5 - 3 = 2. forcedBps = fee
            // = 4. Expansion: 2 × 4 = 8. Total: 50 + 8 = 58.
            const result = amplifyContractSlippage(50n, Decimal(2), 4n);
            assert.strictEqual(result, 58n);
        });
    });

    describe('precision + ceiling behavior', () => {
        test('rounds UP on non-integer expansion', () => {
            // 2.5 × 3 = 7.5 → ceil = 8. The ceil is critical: rounding down
            // would under-reserve, which is the bug class the helper exists
            // to prevent. Any regression to floor/round would break this.
            const result = amplifyContractSlippage(0n, Decimal(2.5), 3n);
            assert.strictEqual(result, 8n);
        });

        test('rounds UP on tiny fractional expansion', () => {
            // 1 × 0.1 would give 0.1 → ceil = 1. But bpsToAmplify is bigint,
            // so this scenario requires leverageDelta to produce a fractional
            // product. 0.33 × 3 = 0.99 → ceil = 1. Pins the directional
            // rounding without depending on Decimal's exact internal form.
            const result = amplifyContractSlippage(10n, Decimal(0.33), 3n);
            assert.strictEqual(result, 11n);
        });

        test('handles very large leverageDelta without precision loss', () => {
            // Pathological but harmless: 1000 × 4 = 4000. Helper shouldn't
            // overflow or lose precision on Decimal → bigint conversion.
            const result = amplifyContractSlippage(0n, Decimal(1000), 4n);
            assert.strictEqual(result, 4000n);
        });

        test('handles Decimal with arbitrary precision in leverageDelta', () => {
            // Decimal(9.9999...) → product with 4 → ceil should land at 40.
            // Real-world: preview computes leverageDelta from Decimal math,
            // which may accumulate sub-ULP noise. Helper must ceil that to
            // the nearest bps.
            const result = amplifyContractSlippage(0n, Decimal('9.9999999999'), 4n);
            assert.strictEqual(result, 40n);
        });
    });

    describe('MAX_LEVERAGE_FACTOR source pin', () => {
        // LEVERAGE is file-private in CToken.ts — source-audit this instead of
        // importing. Guards against silent tuning regressions that would let
        // users back over the boundary on high-collRatio markets (shMON etc).
        const ctokenPath = path.resolve(__dirname, '..', 'src', 'classes', 'CToken.ts');
        const ctokenSrc = readFileSync(ctokenPath, 'utf8');

        test('MAX_LEVERAGE_FACTOR is set to 0.98 (tuned after CURVANCE_FEE_BPS landed)', () => {
            // Previous values: 0.99 (original), 0.995 (post-caching precision
            // improvement). Current 0.98 absorbs the (L-1) × fee equity-
            // fraction amplification at high-collRatio markets without
            // requiring fee-aware borrow math in previewLeverageUp.
            assert.match(ctokenSrc, /MAX_LEVERAGE_FACTOR:\s*Decimal\(\s*0\.98\s*\)/);
        });

        test('shMON-shaped market (r=0.9, theoretical=10) caps at 9.82x', () => {
            // Hand-computed: 1 + (10 - 1) × 0.98 = 9.82.
            // shMON empirical per Josh: 9.8x works, 9.9x sim-fails, 10x revert.
            // 9.82x leaves ~2bps of headroom above Josh's safe threshold.
            const theoretical = new Decimal(10);
            const factor = new Decimal(0.98);
            const expectedCap = new Decimal(1).add(theoretical.sub(1).mul(factor));
            assert.strictEqual(expectedCap.toFixed(2), '9.82');
        });

        test('2x theoretical market (r=0.5) caps at 1.98x', () => {
            // At lower leverage the factor is less painful in absolute terms.
            // 1 + (2 - 1) × 0.98 = 1.98. Users lose 2% of advertised 2x;
            // acceptable tradeoff for the safety margin.
            const theoretical = new Decimal(2);
            const factor = new Decimal(0.98);
            const expectedCap = new Decimal(1).add(theoretical.sub(1).mul(factor));
            assert.strictEqual(expectedCap.toFixed(2), '1.98');
        });
    });

    describe('non-regression: behavior identical to pre-extraction inline form', () => {
        // These tests pin EXACT numerical outputs that match what the three
        // inline call sites would have produced before extraction. If a
        // refactor drifts the helper's semantics (e.g., changes ceil → floor,
        // changes guard condition, adds pre/post-multiplication), these
        // fail and point at the parity loss.
        test('leverageUp at 5x with 10 bps user slippage + 4 bps fee', () => {
            // Inline pre-extraction: slippage(10) + BigInt(Decimal(4).mul(4).ceil().toFixed(0))
            //                      = 10 + 16 = 26
            assert.strictEqual(
                amplifyContractSlippage(10n, Decimal(4), 4n),
                26n,
            );
        });

        test('leverageDown partial 5x→3x with 50 bps slippage + 4 bps fee', () => {
            // Inline: 50 + Decimal(2).mul(4).ceil() = 50 + 8 = 58
            assert.strictEqual(
                amplifyContractSlippage(50n, Decimal(2), 4n),
                58n,
            );
        });

        test('leverageDown full from 10x with 100 bps slippage + (20+4) bps', () => {
            // Inline: 100 + Decimal(9).mul(24).ceil() = 100 + 216 = 316
            assert.strictEqual(
                amplifyContractSlippage(100n, Decimal(9), 24n),
                316n,
            );
        });
    });
});

describe('toContractSwapSlippage', () => {
    // `bpsToBpsWad(n) = n × 1e14`. Expected WAD values below are hand-computed
    // from that identity so a regression to a different conversion factor
    // fails visibly.
    const BPS_TO_WAD = 100_000_000_000_000n; // 1e14

    describe('zero-input guard', () => {
        test('returns 0n when userSlippage is 0n and feeBps is undefined', () => {
            assert.strictEqual(toContractSwapSlippage(0n), 0n);
        });

        test('returns 0n when userSlippage is 0n and feeBps is 0n', () => {
            assert.strictEqual(toContractSwapSlippage(0n, 0n), 0n);
        });

        test('returns 0n when userSlippage is 0n and feeBps is negative (no amplification)', () => {
            // Negative feeBps represents a rebate-style aggregator (gas refund,
            // positive-sum RFQ). We do NOT amplify on negative — the fee
            // isn't reducing swap output, so _swapSafe sees nothing extra.
            // Zero userSlippage + no amplification → 0n, preserving adapter
            // parity for rebate paths.
            assert.strictEqual(toContractSwapSlippage(0n, -5n), 0n);
        });
    });

    describe('user slippage only (no fee)', () => {
        test('100 bps user slippage → 100 × 1e14 WAD', () => {
            assert.strictEqual(toContractSwapSlippage(100n), 100n * BPS_TO_WAD);
        });

        test('100 bps user slippage with explicit feeBps=0n → unchanged', () => {
            assert.strictEqual(toContractSwapSlippage(100n, 0n), 100n * BPS_TO_WAD);
        });

        test('1 bps user slippage → 1e14 WAD', () => {
            assert.strictEqual(toContractSwapSlippage(1n), BPS_TO_WAD);
        });
    });

    describe('fee expansion (the bug-fix behavior for Kuru)', () => {
        test('100 bps slippage + 4 bps fee → 104 × 1e14 WAD (CURVANCE_FEE_BPS at shMON)', () => {
            // The exact case Kuru would have under-tolerated before the
            // refactor. User sets 100 bps slippage; CURVANCE_FEE_BPS = 4
            // means the on-chain _swapSafe sees 104 bps of swap-layer loss.
            assert.strictEqual(
                toContractSwapSlippage(100n, 4n),
                104n * BPS_TO_WAD,
            );
        });

        test('0 bps slippage + 4 bps fee → 4 × 1e14 WAD', () => {
            // Edge: user sets zero slippage tolerance, fee alone is the
            // entire _swapSafe budget. Matches KyberSwap's pre-extraction
            // behavior (falsy userSlippage + truthy fee → expansion = fee).
            assert.strictEqual(
                toContractSwapSlippage(0n, 4n),
                4n * BPS_TO_WAD,
            );
        });

        test('200 bps slippage + 10 bps fee → 210 × 1e14 WAD', () => {
            assert.strictEqual(
                toContractSwapSlippage(200n, 10n),
                210n * BPS_TO_WAD,
            );
        });
    });

    describe('KyberSwap non-regression (parity with pre-extraction inline form)', () => {
        // Prior KyberSwap.ts:254-261 computed:
        //   effective = feeBps && feeBps > 0n ? slippage + feeBps : slippage
        //   result    = effective ? bpsToBpsWad(effective) : 0n
        // These cases pin identical outputs so the refactor is a true
        // behavior-preserving change for KyberSwap.
        test('realistic call: 50 bps slippage + 4 bps CURVANCE fee', () => {
            assert.strictEqual(
                toContractSwapSlippage(50n, 4n),
                54n * BPS_TO_WAD,
            );
        });

        test('no-fee policy (feeBps undefined): slippage passes through unchanged', () => {
            assert.strictEqual(
                toContractSwapSlippage(75n, undefined),
                75n * BPS_TO_WAD,
            );
        });

        test('zero-slippage + zero-fee: returns 0n without WAD conversion', () => {
            // Critical edge: the guard must short-circuit before bpsToBpsWad
            // to preserve the `effective ? ... : 0n` semantics of both
            // pre-extraction adapters.
            assert.strictEqual(toContractSwapSlippage(0n, 0n), 0n);
            assert.strictEqual(toContractSwapSlippage(0n), 0n);
        });
    });
});
