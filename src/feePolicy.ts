import Decimal from "decimal.js";
import { address } from "./types";
import { ChainRpcPrefix } from "./helpers";
import { chain_config } from "./chains";

/**
 * Fee policy for SDK-initiated DEX swaps (zaps and leverage operations).
 *
 * Fees are charged at the DEX aggregator layer via KyberSwap's `feeAmount`
 * parameter (`chargeFeeBy=currency_in`, `isInBps=true`). The user's swap input
 * is reduced by the fee bps before the swap; the fee is sent directly to
 * `feeReceiver` by the aggregator.
 *
 * Design notes
 * ------------
 * - Fees are denominated in BPS of swap notional (input amount), matching the
 *   convention used by every major perp platform (Hyperliquid, Binance, Bybit,
 *   dYdX, GMX). They are NOT scaled by leverage. Users coming from those
 *   venues expect "X bps per trade" semantics.
 *
 * - The policy callback shape is intentionally extensible. `flatFeePolicy`
 *   ships as the default convenience helper. Consumers needing more complex
 *   logic (per-asset overrides, leverage tiers, time-of-day, etc.) can write
 *   their own object implementing `FeePolicy`.
 *
 * - No-op exemptions: same input/output token (zapping a token into its own
 *   market) and native↔wrapped (zapping native into the wrapped-native market)
 *   bypass the DEX aggregator entirely on-chain via SimpleZapper's
 *   _isMatchingToken short-circuit. The default policy mirrors that path so
 *   no fee is charged for swaps that don't actually swap anything.
 *
 * - Deleverage interaction: when fees are active, the deleverage swap-sizing
 *   overhead must absorb the fee bps in addition to LEVERAGE.DELEVERAGE_OVERHEAD_BPS
 *   to prevent dust debt. The fee compensation is applied at the call site,
 *   not in the policy itself.
 *
 * Future functionality (not yet implemented)
 * ------------------------------------------
 * - **SDK-native token classification.** Currently, stable/volatile classification
 *   requires a consumer-provided `classify` callback. Long-term, the SDK should
 *   carry token category metadata directly on each cToken/Market (sourced from
 *   the Curvance API or chain config), eliminating the duplicate source of truth
 *   between the SDK and the v1 app's token lists.
 *
 * - **Multi-receiver fee splits.** KyberSwap supports comma-separated
 *   `feeReceiver` and `feeAmount` lists. The current FeePolicy only exposes a
 *   single receiver. Extending to a `feeReceivers: { address, share }[]` array
 *   would let the protocol, integrators, and a referral program co-receive
 *   fees in one swap call.
 *
 * - **Per-user fee tiers / discounts.** The current policy is global (one
 *   policy per setupChain). To support staker discounts, volume tiers, or
 *   referral codes, the policy would need to be invoked with per-call user
 *   context (user address, staking balance, referral code) — likely via an
 *   additional optional field on FeePolicyContext.
 *
 * - **Volume-based tiering.** Hyperliquid-style 14-day rolling volume tiers
 *   require off-chain volume tracking (Curvance API) and a policy that can
 *   query it. The classifier callback pattern generalizes to this — a
 *   `getUserVolume(address)` callback that the policy uses to pick a tier.
 *
 * - **Per-aggregator routing fees.** Currently both KyberSwap and Kuru use the
 *   same fee policy. If routing economics differ (e.g., Kuru's referrerFeeBps
 *   has different rebate semantics), the policy interface could be extended
 *   to take an aggregator name and return aggregator-specific bps.
 *
 * - **Leverage-tiered fees (if reversed from current decision).** The current
 *   design matches perp convention (flat bps on notional). If product later
 *   wants to reduce fees at high leverage to keep equity-cost flat, that's a
 *   one-line change in a custom FeePolicy implementation reading
 *   ctx.currentLeverage / ctx.targetLeverage.
 */

export type FeeOperation =
    | 'leverage-up'
    | 'leverage-down'
    | 'deposit-and-leverage'
    | 'zap';

export interface FeePolicyContext {
    /** Which SDK operation is requesting the fee. */
    operation: FeeOperation;
    /** Token being sent into the swap (the fee is taken from this side). */
    inputToken: address;
    /** Token being received from the swap. */
    outputToken: address;
    /** Raw amount of `inputToken` being swapped (in input token's native decimals). */
    inputAmount: bigint;
    /** Current leverage at the time of operation. null for zap. */
    currentLeverage: Decimal | null;
    /** Target leverage. null for zap. */
    targetLeverage: Decimal | null;
}

export interface FeePolicy {
    /** Returns the fee in BPS for this operation. Return 0n for no fee. */
    getFeeBps(ctx: FeePolicyContext): bigint;
    /** Address that receives the fee. KyberSwap supports comma-separated
     *  multi-receiver lists if extended in the future. */
    feeReceiver: address;
}

/** Curvance DAO fee receiver — same wallet used for protocol interest fees
 *  and existing Kuru aggregator referrer fees. */
export const CURVANCE_DAO_FEE_RECEIVER: address =
    '0x0Acb7eF4D8733C719d60e0992B489b629bc55C02';

/** Token classification used by the optional category-tier override.
 *  Consumers provide their own classifier — the SDK does not currently
 *  populate token categories from market metadata. */
export type TokenClass = 'stable' | 'volatile' | 'native';

export interface FlatFeePolicyConfig {
    /** Default fee in BPS for non-no-op swaps. Must be < 10000. */
    bps: bigint;
    /** Address that receives the fee. */
    feeReceiver: address;
    /** Chain identifier — used to resolve wrapped-native for the no-op
     *  exemption. Must match the chain passed to setupChain. */
    chain: ChainRpcPrefix;
    /** Optional override: BPS for stable→stable swaps. Only takes effect when
     *  `classify` is provided AND both input and output classify as 'stable'.
     *  Defaults to `bps` if omitted. */
    stableToStableBps?: bigint;
    /** Optional token classifier. When provided AND `stableToStableBps` is set,
     *  used to detect stable→stable swaps. The SDK does not currently populate
     *  this from market metadata — consumers provide classification from their
     *  own data sources (e.g., app-side token lists or the Curvance API). */
    classify?: (token: address) => TokenClass | null;
}

const NATIVE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * Default fee policy: flat BPS for all operations, with no-op exemptions for
 * same-token and native↔wrapped routes. Optionally supports a stable→stable
 * tier when a classifier is provided.
 *
 * @example
 *   // Simple flat 4 bps everywhere except no-ops:
 *   flatFeePolicy({
 *       bps: 4n,
 *       feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
 *       chain: 'monad-mainnet',
 *   })
 *
 * @example
 *   // 4 bps default, 1 bps on stable→stable pairs:
 *   const STABLES = new Set(['0xUSDC...', '0xAUSD...', '0xUSDT...']);
 *   flatFeePolicy({
 *       bps: 4n,
 *       stableToStableBps: 1n,
 *       feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
 *       chain: 'monad-mainnet',
 *       classify: (addr) => STABLES.has(addr.toLowerCase()) ? 'stable' : 'volatile',
 *   })
 */
export function flatFeePolicy(config: FlatFeePolicyConfig): FeePolicy {
    const { bps, feeReceiver, chain, stableToStableBps, classify } = config;

    if (bps < 0n) {
        throw new Error(`flatFeePolicy: bps must be non-negative, got ${bps}`);
    }
    if (bps >= 10000n) {
        throw new Error(`flatFeePolicy: bps must be < 10000 (100%), got ${bps}`);
    }
    if (stableToStableBps !== undefined) {
        if (stableToStableBps < 0n || stableToStableBps >= 10000n) {
            throw new Error(`flatFeePolicy: stableToStableBps must be in [0, 10000), got ${stableToStableBps}`);
        }
    }

    // Resolve wrapped-native for the chain at construction time. This is
    // required so the policy can identify native↔wrapped no-ops without the
    // call site having to pre-filter them.
    const chainCfg = chain_config[chain];
    if (!chainCfg) {
        throw new Error(`flatFeePolicy: unknown chain '${chain}'`);
    }
    const wrappedNativeLower = chainCfg.wrapped_native.toLowerCase();

    return {
        feeReceiver,
        getFeeBps(ctx: FeePolicyContext): bigint {
            const inLower = ctx.inputToken.toLowerCase();
            const outLower = ctx.outputToken.toLowerCase();

            // No-op: same input and output token (zapping a token into its
            // own market). SimpleZapper.swapAndDeposit handles this on-chain
            // via _isMatchingToken — no real swap occurs, no fee should apply.
            if (inLower === outLower) return 0n;

            // No-op: native↔wrapped. Curvance native zappers handle wrap/unwrap
            // without a DEX call, so no fee applies. This exemption is
            // unconditional — native↔wrapped is always a no-op regardless of
            // which call site invokes the policy.
            if (
                (inLower === NATIVE_ADDRESS && outLower === wrappedNativeLower) ||
                (inLower === wrappedNativeLower && outLower === NATIVE_ADDRESS)
            ) {
                return 0n;
            }

            // Stable→stable tier (only when both classify and stableToStableBps
            // are provided).
            if (classify && stableToStableBps !== undefined) {
                const inClass = classify(ctx.inputToken);
                const outClass = classify(ctx.outputToken);
                if (inClass === 'stable' && outClass === 'stable') {
                    return stableToStableBps;
                }
            }

            return bps;
        },
    };
}

/**
 * Convenience: a no-op fee policy that returns 0 bps for all operations.
 * This is the default when no policy is configured in setupChain — it
 * preserves backward compatibility with pre-fee-policy SDK behavior.
 *
 * The receiver is set to the Curvance DAO address for consistency, but it's
 * never used since getFeeBps always returns 0n.
 *
 * Frozen to prevent accidental mutation. Anyone needing a customized no-op
 * variant should construct a fresh `flatFeePolicy({ bps: 0n, ... })` instead
 * of mutating this singleton.
 */
export const NO_FEE_POLICY: FeePolicy = Object.freeze({
    feeReceiver: CURVANCE_DAO_FEE_RECEIVER,
    getFeeBps: () => 0n,
});
