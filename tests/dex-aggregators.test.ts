import assert from "node:assert/strict";
import test from "node:test";
// NOTE: import `setup` first. KyberSwap and Kuru transitively import
// `all_markets` from setup; setup loads chain_config which instantiates
// KyberSwap at module-load time. Importing KyberSwap directly creates a
// circular load where monad.ts runs `new KyberSwap()` before the KyberSwap
// class has been evaluated.
import "../src/setup";
import { KyberSwap } from "../src/classes/DexAggregators/KyberSwap";
import { Kuru } from "../src/classes/DexAggregators/Kuru";
import FormatConverter from "../src/classes/FormatConverter";
import type { address, bytes } from "../src/types";

// ─── Fee-aware slippage expansion ───────────────────────────────────────────
//
// KyberSwap deducts its `currency_in` fee BEFORE the swap executes, which
// means the on-chain `_swapSafe` sees (valueIn - valueOut) / valueIn counting
// the fee as "slippage". Callers therefore need `action.slippage = raw_slippage
// + feeBps` to avoid false slippage reverts on fee-bearing leverage flows.
//
// That expansion belongs INSIDE the DEX aggregator so every caller of
// `quoteAction` inherits correct behavior automatically. Without it, any new
// call site that forgets the post-override causes on-chain reverts with no
// client-side signal. Kuru's fee semantics differ (Kuru takes a referrer-style
// fee) so Kuru.quoteAction intentionally keeps raw slippage.

const TOKEN_IN = "0x0000000000000000000000000000000000000001" as address;
const TOKEN_OUT = "0x0000000000000000000000000000000000000002" as address;
const WALLET = "0x0000000000000000000000000000000000000003" as address;
const FEE_RECEIVER = "0x0000000000000000000000000000000000000004" as address;

function stubKyberSwapQuote(kyber: KyberSwap) {
    (kyber as any).quote = async () => ({
        to: kyber.router,
        calldata: '0x' as bytes,
        min_out: 0n,
        out: 0n,
        raw: {} as any,
    });
}

function stubKuruQuote(kuru: Kuru) {
    (kuru as any).quote = async () => ({
        to: kuru.router,
        calldata: '0x' as bytes,
        min_out: 0n,
        out: 0n,
    });
}

test("KyberSwap.quoteAction expands action.slippage by feeBps when fees are active", async () => {
    const kyber = new KyberSwap();
    stubKyberSwapQuote(kyber);

    const { action } = await kyber.quoteAction(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,    // user slippage (BPS)
        10n,    // feeBps
        FEE_RECEIVER,
    );

    assert.equal(
        action.slippage,
        FormatConverter.bpsToBpsWad(60n),
        "action.slippage must cover user slippage + pre-swap fee BPS",
    );
});

test("KyberSwap.quoteAction keeps action.slippage unchanged when feeBps is zero", async () => {
    const kyber = new KyberSwap();
    stubKyberSwapQuote(kyber);

    const { action } = await kyber.quoteAction(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
        0n,
        undefined,
    );

    assert.equal(
        action.slippage,
        FormatConverter.bpsToBpsWad(50n),
        "no fee → no expansion, backward compatible",
    );
});

test("KyberSwap.quoteAction keeps action.slippage unchanged when feeBps is omitted", async () => {
    const kyber = new KyberSwap();
    stubKyberSwapQuote(kyber);

    const { action } = await kyber.quoteAction(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
    );

    assert.equal(
        action.slippage,
        FormatConverter.bpsToBpsWad(50n),
        "omitted feeBps → treated as zero, no expansion",
    );
});

test("Kuru.quoteAction keeps action.slippage raw even when feeBps is active (regression guard)", async () => {
    // Kuru's referrer-fee model takes fee via API parameter, not by pre-swap
    // deduction. The on-chain swap path does not double-count the fee as
    // slippage, so Kuru must not expand.
    const kuru = new Kuru();
    stubKuruQuote(kuru);

    const { action } = await kuru.quoteAction(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
        10n,
        FEE_RECEIVER,
    );

    assert.equal(
        action.slippage,
        FormatConverter.bpsToBpsWad(50n),
        "Kuru slippage must remain raw; expansion is a KyberSwap-specific concern",
    );
});
