import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    flatFeePolicy,
    NO_FEE_POLICY,
    CURVANCE_FEE_BPS,
    CURVANCE_DAO_FEE_RECEIVER,
    defaultFeePolicyForChain,
    getMonadMainnetFeePolicy,
    type FeePolicyContext,
    type TokenClass,
} from '../src/feePolicy';
import { chain_config } from '../src/chains';
import { address } from '../src/types';
import Decimal from 'decimal.js';

// Monad mainnet addresses for tests — these are what `chain_config['monad-mainnet'].wrapped_native`
// resolves to. Tests use real addresses to exercise the actual chain config lookup.
const WMON: address = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const ARB_WRAPPED_NATIVE: address = '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73';
const NATIVE: address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC: address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const AUSD: address = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const WBTC: address = '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c';

const baseCtx = (overrides: Partial<FeePolicyContext> = {}): FeePolicyContext => ({
    operation: 'leverage-up',
    inputToken: USDC,
    outputToken: WBTC,
    inputAmount: 1_000_000n,
    currentLeverage: Decimal(1),
    targetLeverage: Decimal(3),
    ...overrides,
});

describe('FeePolicy', () => {
    describe('NO_FEE_POLICY', () => {
        test('returns 0 bps for any operation', () => {
            assert.strictEqual(NO_FEE_POLICY.getFeeBps(baseCtx()), 0n);
            assert.strictEqual(NO_FEE_POLICY.getFeeBps(baseCtx({ operation: 'zap' })), 0n);
            assert.strictEqual(NO_FEE_POLICY.getFeeBps(baseCtx({ operation: 'leverage-down' })), 0n);
            assert.strictEqual(NO_FEE_POLICY.getFeeBps(baseCtx({ operation: 'deposit-and-leverage' })), 0n);
        });

        test('feeReceiver is the Curvance DAO address', () => {
            assert.strictEqual(NO_FEE_POLICY.feeReceiver, CURVANCE_DAO_FEE_RECEIVER);
        });
    });

    describe('defaultFeePolicyForChain', () => {
        test('defaults monad-mainnet to the live Curvance swap fee policy', () => {
            const policy = defaultFeePolicyForChain('monad-mainnet');
            assert.strictEqual(policy, getMonadMainnetFeePolicy());
            assert.strictEqual(policy.getFeeBps(baseCtx()), CURVANCE_FEE_BPS);
            assert.strictEqual(policy.feeReceiver, CURVANCE_DAO_FEE_RECEIVER);
        });

        test('keeps non-Monad chains on the no-fee default', () => {
            const policy = defaultFeePolicyForChain('arb-sepolia');
            assert.strictEqual(policy, NO_FEE_POLICY);
            assert.strictEqual(policy.getFeeBps(baseCtx()), 0n);
        });
    });

    describe('flatFeePolicy validation', () => {
        test('throws on negative bps', () => {
            assert.throws(() => flatFeePolicy({
                bps: -1n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
            }), /non-negative/);
        });

        test('throws on bps >= 10000', () => {
            assert.throws(() => flatFeePolicy({
                bps: 10000n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
            }), /must be < 10000/);
        });

        test('throws on negative stableToStableBps', () => {
            assert.throws(() => flatFeePolicy({
                bps: 4n,
                stableToStableBps: -1n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
            }), /stableToStableBps/);
        });

        test('throws on stableToStableBps >= 10000', () => {
            assert.throws(() => flatFeePolicy({
                bps: 4n,
                stableToStableBps: 10000n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
            }), /stableToStableBps/);
        });

        test('throws on unknown chain', () => {
            assert.throws(() => flatFeePolicy({
                bps: 4n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'fake-chain' as any,
            }), /unknown chain/);
        });

        test('accepts 0 bps (free swaps)', () => {
            const policy = flatFeePolicy({
                bps: 0n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
            });
            assert.strictEqual(policy.getFeeBps(baseCtx()), 0n);
        });
    });

    describe('flatFeePolicy default rate', () => {
        const policy = flatFeePolicy({
            bps: 4n,
            feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
            chain: 'monad-mainnet',
        });

        test('returns the configured bps for a normal swap', () => {
            assert.strictEqual(policy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: WBTC })), 4n);
        });

        test('returns the configured bps regardless of operation type', () => {
            assert.strictEqual(policy.getFeeBps(baseCtx({ operation: 'zap' })), 4n);
            assert.strictEqual(policy.getFeeBps(baseCtx({ operation: 'leverage-up' })), 4n);
            assert.strictEqual(policy.getFeeBps(baseCtx({ operation: 'leverage-down' })), 4n);
            assert.strictEqual(policy.getFeeBps(baseCtx({ operation: 'deposit-and-leverage' })), 4n);
        });

        test('returns the configured bps regardless of leverage', () => {
            // Per perp platform convention: fees are flat on notional, not
            // scaled by leverage. This test pins that behavior.
            assert.strictEqual(policy.getFeeBps(baseCtx({ targetLeverage: Decimal(2) })), 4n);
            assert.strictEqual(policy.getFeeBps(baseCtx({ targetLeverage: Decimal(10) })), 4n);
            assert.strictEqual(policy.getFeeBps(baseCtx({ targetLeverage: Decimal(20) })), 4n);
        });

        test('feeReceiver is preserved', () => {
            assert.strictEqual(policy.feeReceiver, CURVANCE_DAO_FEE_RECEIVER);
        });
    });

    describe('flatFeePolicy no-op exemptions', () => {
        const policy = flatFeePolicy({
            bps: 4n,
            feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
            chain: 'monad-mainnet',
        });

        test('exempts same-token zap (same case)', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: USDC })),
                0n,
            );
        });

        test('exempts same-token zap (different case)', () => {
            const usdcUpper = USDC.toUpperCase() as address;
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: usdcUpper })),
                0n,
            );
        });

        test('exempts native → wrapped native', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: NATIVE, outputToken: WMON })),
                0n,
            );
        });

        test('exempts wrapped native → native', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: WMON, outputToken: NATIVE })),
                0n,
            );
        });

        test('exempts native → wrapped (case-insensitive)', () => {
            const wmonLower = WMON.toLowerCase() as address;
            const nativeUpper = NATIVE.toUpperCase() as address;
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: nativeUpper, outputToken: wmonLower })),
                0n,
            );
        });

        test('does NOT exempt native → other tokens', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: NATIVE, outputToken: USDC })),
                4n,
            );
        });

        test('does NOT exempt wrapped native → other tokens', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: WMON, outputToken: USDC })),
                4n,
            );
        });

        test('arb-sepolia wrapped native stays aligned with the deployed zapper address', () => {
            assert.strictEqual(chain_config['arb-sepolia'].wrapped_native, ARB_WRAPPED_NATIVE);
        });

        test('exempts native → wrapped native on arb-sepolia using chain config', () => {
            const arbPolicy = flatFeePolicy({
                bps: 4n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'arb-sepolia',
            });
            assert.strictEqual(
                arbPolicy.getFeeBps(baseCtx({ inputToken: NATIVE, outputToken: ARB_WRAPPED_NATIVE })),
                0n,
            );
        });
    });

    describe('flatFeePolicy stable-tier override', () => {
        const STABLES = new Set([USDC.toLowerCase(), AUSD.toLowerCase()]);
        const classify = (token: address): TokenClass | null => {
            if (STABLES.has(token.toLowerCase())) return 'stable';
            return 'volatile';
        };
        const policy = flatFeePolicy({
            bps: 4n,
            stableToStableBps: 1n,
            feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
            chain: 'monad-mainnet',
            classify,
        });

        test('charges stable rate on stable→stable swap', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: AUSD })),
                1n,
            );
        });

        test('charges default rate on volatile→volatile swap', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: WBTC, outputToken: WMON })),
                4n,
            );
        });

        test('charges default rate on stable→volatile swap', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: WBTC })),
                4n,
            );
        });

        test('charges default rate on volatile→stable swap', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: WBTC, outputToken: USDC })),
                4n,
            );
        });

        test('falls back to default rate when one token is unclassified (null)', () => {
            const partialClassify = (token: address): TokenClass | null => {
                if (token.toLowerCase() === USDC.toLowerCase()) return 'stable';
                return null;
            };
            const partialPolicy = flatFeePolicy({
                bps: 4n,
                stableToStableBps: 1n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
                classify: partialClassify,
            });
            assert.strictEqual(
                partialPolicy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: WBTC })),
                4n,
            );
        });

        test('still exempts no-ops even with stable tier configured', () => {
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: USDC })),
                0n,
            );
            assert.strictEqual(
                policy.getFeeBps(baseCtx({ inputToken: NATIVE, outputToken: WMON })),
                0n,
            );
        });

        test('stable tier ignored when classify is omitted', () => {
            const noClassifyPolicy = flatFeePolicy({
                bps: 4n,
                stableToStableBps: 1n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
                // no classify
            });
            // Without a classifier, stable→stable falls through to default bps
            assert.strictEqual(
                noClassifyPolicy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: AUSD })),
                4n,
            );
        });

        test('stable tier ignored when stableToStableBps is omitted', () => {
            const noTierPolicy = flatFeePolicy({
                bps: 4n,
                feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
                chain: 'monad-mainnet',
                classify,
                // no stableToStableBps
            });
            assert.strictEqual(
                noTierPolicy.getFeeBps(baseCtx({ inputToken: USDC, outputToken: AUSD })),
                4n,
            );
        });
    });
});
