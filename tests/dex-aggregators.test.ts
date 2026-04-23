import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { AbiCoder } from "ethers";
import "../src/setup";
import { KyberSwap } from "../src/classes/DexAggregators/KyberSwap";
import { Kuru } from "../src/classes/DexAggregators/Kuru";
import { MultiDexAgg } from "../src/classes/DexAggregators/MultiDexAgg";
import { UnsupportedDexAgg } from "../src/classes/DexAggregators/UnsupportedDexAgg";
import { buildLocalSimpleZapTokens } from "../src/classes/DexAggregators/helpers";
import FormatConverter from "../src/classes/FormatConverter";
import { chain_config } from "../src/chains";
import { safeBigInt, validateSlippageBps } from "../src/validation";
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
const MONAD_WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as address;
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as address;
const DECIMALS_SELECTOR = "0x313ce567";
const KYBER_SWAP_SELECTOR = "0xe21fd0e9";
const KYBER_SWAP_PARAMS_TYPE =
    "tuple(address callTarget,address approveTarget,bytes targetData," +
    "tuple(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts," +
    "address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount," +
    "uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData)";

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

function createDecimalsProvider(decimalsByAddress: Map<string, bigint>) {
    return {
        async call(tx: { to?: string; data?: string }) {
            const to = tx.to?.toLowerCase();
            if ((tx.data ?? "").slice(0, 10) !== DECIMALS_SELECTOR || to == null) {
                throw new Error(`Unexpected call in decimals provider: ${JSON.stringify(tx)}`);
            }

            const decimals = decimalsByAddress.get(to);
            if (decimals == null) {
                throw new Error(`Missing decimals stub for ${to}`);
            }

            return `0x${decimals.toString(16).padStart(64, "0")}`;
        },
        async getNetwork() {
            return { chainId: 1n, name: "test" };
        },
        async resolveName(name: string) {
            return name;
        },
    };
}

function encodeKyberSwapCalldata({
    feeBps,
    feeReceiver = FEE_RECEIVER,
}: {
    feeBps: bigint;
    feeReceiver?: address;
}): bytes {
    const execution = [
        WALLET,
        TOKEN_IN,
        "0x1234",
        [
            TOKEN_IN,
            TOKEN_OUT,
            [WALLET],
            [1_000n],
            [feeReceiver],
            [feeBps],
            WALLET,
            1_000n,
            900n,
            0x280n,
            "0x",
        ],
        "0x5678",
    ];

    return (KYBER_SWAP_SELECTOR + AbiCoder.defaultAbiCoder().encode([KYBER_SWAP_PARAMS_TYPE], [execution]).slice(2)) as bytes;
}

function jsonResponse(body: unknown, ok = true): any {
    return {
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? "OK" : "Internal Server Error",
        async json() {
            return body;
        },
    };
}

async function withMockedKyberFetch<T>(kyber: KyberSwap, calldata: bytes, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    (globalThis as any).fetch = async () => {
        calls++;

        if (calls === 1) {
            return jsonResponse({
                message: "OK",
                data: {
                    routeSummary: {
                        tokenIn: TOKEN_IN,
                        tokenOut: TOKEN_OUT,
                        amountIn: "1000",
                        amountOut: "1000",
                        extraFee: {
                            feeAmount: "0",
                            chargeFeeBy: "",
                            isInBps: true,
                            feeReceiver: FEE_RECEIVER,
                        },
                        route: [],
                    },
                    routerAddress: kyber.router,
                },
                requestId: "routes",
            });
        }

        return jsonResponse({
            code: 0,
            message: "OK",
            data: {
                amountIn: "1000",
                amountInUsd: "1",
                amountOut: "1000",
                amountOutUsd: "1",
                gas: "0",
                gasUsd: "0",
                additionalCostUsd: "0",
                additionalCostMessage: "",
                outputChange: {
                    amount: "0",
                    percent: 0,
                    level: 0,
                },
                data: calldata,
                routerAddress: kyber.router,
                transactionValue: "0",
            },
            requestId: "build",
        });
    };

    try {
        return await run();
    } finally {
        globalThis.fetch = originalFetch;
    }
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

test("chain configs keep Monad on KyberSwap and fail closed on Arbitrum Sepolia DEX quotes", async () => {
    const monadDex = chain_config["monad-mainnet"].dexAgg;
    const arbDex = chain_config["arb-sepolia"].dexAgg;

    assert.ok(monadDex instanceof KyberSwap);
    assert.ok(arbDex instanceof UnsupportedDexAgg);
    assert.equal(arbDex instanceof KyberSwap, false);
    assert.deepEqual(await arbDex.getAvailableTokens({} as any, null, WALLET), []);

    await assert.rejects(
        () => arbDex.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
        /DEX aggregation is not configured for arb-sepolia/i,
    );
});

test("KyberSwap.quoteAction rejects effective swap slippage at the contract ceiling before quote", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);
    (kyber as any).quote = async () => {
        throw new Error("quote should not run");
    };

    await assert.rejects(
        () => kyber.quoteAction(
            WALLET,
            TOKEN_IN,
            TOKEN_OUT,
            1_000n,
            9_996n,
            4n,
            FEE_RECEIVER,
        ),
        /Swap slippage out of range \(0-9999 BPS\): 10000/,
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

test("KyberSwap.quoteMin returns the minimum output, not the optimistic output", async () => {
    const kyber = new KyberSwap();
    (kyber as any).quote = async () => ({
        to: kyber.router,
        calldata: "0x" as bytes,
        min_out: 95n,
        out: 100n,
        raw: {} as any,
    });

    const minOut = await kyber.quoteMin(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
    );

    assert.equal(minOut, 95n);
});

test("Kuru.quoteMin returns the minimum output, not the optimistic output", async () => {
    const kuru = new Kuru();
    (kuru as any).quote = async () => ({
        to: kuru.router,
        calldata: "0x" as bytes,
        min_out: 88n,
        out: 91n,
    });

    const minOut = await kuru.quoteMin(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
    );

    assert.equal(minOut, 88n);
});

test("KyberSwap.quote validates current router fee calldata without warning", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
    };

    try {
        const quote = await withMockedKyberFetch(
            kyber,
            encodeKyberSwapCalldata({ feeBps: 4n, feeReceiver: FEE_RECEIVER }),
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
        );

        assert.equal(quote.to.toLowerCase(), kyber.router.toLowerCase());
        assert.deepEqual(warnings, []);
    } finally {
        console.warn = originalWarn;
    }
});

test("KyberSwap.quote rejects checker-incompatible missing or custom fee policy before fetch", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    (globalThis as any).fetch = async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run");
    };

    try {
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n),
            /KyberSwap checker requires feeBps=4/,
        );
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 0n, undefined),
            /KyberSwap checker requires feeBps=4/,
        );
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 5n, FEE_RECEIVER),
            /got feeBps=5/,
        );
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, TOKEN_IN),
            /feeReceiver=0x0000000000000000000000000000000000000001/,
        );
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("KyberSwap.quote rejects current router calldata with the wrong fee amount", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);

    await assert.rejects(
        () => withMockedKyberFetch(
            kyber,
            encodeKyberSwapCalldata({ feeBps: 5n, feeReceiver: FEE_RECEIVER }),
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
        ),
        /KyberSwap calldata feeAmount=5, expected 4/,
    );
});

test("validation rejects negative unsigned API integers and 10000 BPS swap slippage", () => {
    assert.equal(safeBigInt("42", "test amount"), 42n);
    assert.throws(
        () => safeBigInt("-1", "test amount"),
        /Invalid unsigned numeric value from test amount/,
    );
    assert.equal(validateSlippageBps(9_999n, "test swap"), 9_999n);
    assert.throws(
        () => validateSlippageBps(10_000n, "test swap"),
        /Slippage out of range \(0-9999 BPS\) in test swap: 10000/,
    );
});

test("MultiDexAgg.quoteMin picks the route with the highest guaranteed output", async () => {
    const conservative = {
        dao: FEE_RECEIVER,
        router: TOKEN_IN,
        getAvailableTokens: async () => [],
        quoteAction: async () => {
            throw new Error("not used");
        },
        quoteMin: async () => 80n,
        quote: async () => ({
            to: TOKEN_IN,
            calldata: "0x" as bytes,
            min_out: 80n,
            out: 90n,
        }),
    } as any;

    const optimistic = {
        dao: FEE_RECEIVER,
        router: TOKEN_OUT,
        getAvailableTokens: async () => [],
        quoteAction: async () => {
            throw new Error("not used");
        },
        quoteMin: async () => 50n,
        quote: async () => ({
            to: TOKEN_OUT,
            calldata: "0x" as bytes,
            min_out: 50n,
            out: 100n,
        }),
    } as any;

    const multi = new MultiDexAgg([optimistic, conservative]);
    const minOut = await multi.quoteMin(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
    );

    assert.equal(minOut, 80n);
});

test("MultiDexAgg.quoteAction picks the route with the highest guaranteed output", async () => {
    const conservativeAction = { aggregator: "conservative" } as any;
    const optimisticAction = { aggregator: "optimistic" } as any;

    const conservative = {
        dao: FEE_RECEIVER,
        router: TOKEN_IN,
        getAvailableTokens: async () => [],
        quoteAction: async () => ({
            action: conservativeAction,
            quote: {
                to: TOKEN_IN,
                calldata: "0x" as bytes,
                min_out: 80n,
                out: 90n,
            },
        }),
        quoteMin: async () => 80n,
        quote: async () => ({
            to: TOKEN_IN,
            calldata: "0x" as bytes,
            min_out: 80n,
            out: 90n,
        }),
    } as any;

    const optimistic = {
        dao: FEE_RECEIVER,
        router: TOKEN_OUT,
        getAvailableTokens: async () => [],
        quoteAction: async () => ({
            action: optimisticAction,
            quote: {
                to: TOKEN_OUT,
                calldata: "0x" as bytes,
                min_out: 50n,
                out: 100n,
            },
        }),
        quoteMin: async () => 50n,
        quote: async () => ({
            to: TOKEN_OUT,
            calldata: "0x" as bytes,
            min_out: 50n,
            out: 100n,
        }),
    } as any;

    const multi = new MultiDexAgg([optimistic, conservative]);
    const { action, quote } = await multi.quoteAction(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
    );

    assert.equal(action, conservativeAction);
    assert.equal(quote.min_out, 80n);
    assert.equal(quote.out, 90n);
});

test("KyberSwap.getAvailableTokens quote closure formats output using output token decimals", async () => {
    const decimalsByAddress = new Map<string, bigint>();
    const provider = createDecimalsProvider(decimalsByAddress);
    const zapTokens = buildLocalSimpleZapTokens(
        [
            {
                tokens: [
                    {
                        name: "Wrapped Monad",
                        symbol: "WMON",
                        getAsset: () => ({ address: MONAD_WMON, symbol: "WMON" }),
                    },
                    {
                        name: "USD Coin",
                        symbol: "USDC",
                        getAsset: () => ({ address: MONAD_USDC, symbol: "USDC" }),
                    },
                ],
            },
        ] as any,
        provider as any,
        null,
        null,
        async () => ({
            to: TOKEN_OUT,
            calldata: "0x" as bytes,
            min_out: 1_234_567n,
            out: 2_345_678n,
            raw: { route: "stub" },
        }),
    );

    const wmonZap = zapTokens.find(
        (token) => token.interface.address.toLowerCase() === MONAD_WMON.toLowerCase(),
    );
    const usdcZap = zapTokens.find(
        (token) => token.interface.address.toLowerCase() === MONAD_USDC.toLowerCase(),
    );

    assert(wmonZap?.quote, "Expected WMON zap token to expose a quote closure");
    assert(usdcZap, "Expected USDC zap token to exist in the available token list");

    decimalsByAddress.set(wmonZap.interface.address.toLowerCase(), 18n);
    decimalsByAddress.set(usdcZap.interface.address.toLowerCase(), 6n);

    const result = await wmonZap.quote!(
        wmonZap.interface.address,
        usdcZap.interface.address,
        Decimal(1),
        Decimal(0.01),
    );

    assert.equal(result.output_raw, 2_345_678n);
    assert.equal(result.minOut_raw, 1_234_567n);
    assert.equal(result.output.toString(), "2.345678");
    assert.equal(result.minOut.toString(), "1.234567");
});

test("simple zap quote closure passes fee policy output into the quote path", async () => {
    const decimalsByAddress = new Map<string, bigint>([
        [MONAD_WMON.toLowerCase(), 18n],
        [MONAD_USDC.toLowerCase(), 6n],
    ]);
    const provider = createDecimalsProvider(decimalsByAddress);
    const quoteCalls: Array<{ amount: bigint; feeBps: bigint | undefined; feeReceiver: string | undefined }> = [];
    const feeReceiver = "0x00000000000000000000000000000000000000f1" as address;
    const zapTokens = buildLocalSimpleZapTokens(
        [
            {
                tokens: [
                    {
                        name: "Wrapped Monad",
                        symbol: "WMON",
                        getAsset: () => ({ address: MONAD_WMON, symbol: "WMON" }),
                    },
                    {
                        name: "USD Coin",
                        symbol: "USDC",
                        getAsset: () => ({ address: MONAD_USDC, symbol: "USDC" }),
                    },
                ],
            },
        ] as any,
        provider as any,
        null,
        null,
        async (_wallet, _tokenIn, _tokenOut, amount, _slippage, feeBps, receiver) => {
            quoteCalls.push({ amount, feeBps, feeReceiver: receiver });
            return {
                to: TOKEN_OUT,
                calldata: "0x" as bytes,
                min_out: 1n,
                out: 2n,
            };
        },
        (_tokenIn, _tokenOut, amount) => ({
            feeBps: amount > 0n ? 4n : 0n,
            feeReceiver,
        }),
    );

    const wmonZap = zapTokens.find(
        (token) => token.interface.address.toLowerCase() === MONAD_WMON.toLowerCase(),
    );
    assert(wmonZap?.quote, "Expected WMON zap token to expose a quote closure");

    await wmonZap.quote!(
        MONAD_WMON,
        MONAD_USDC,
        Decimal(1),
        Decimal(0.01),
    );

    assert.deepEqual(quoteCalls, [{
        amount: 1_000_000_000_000_000_000n,
        feeBps: 4n,
        feeReceiver,
    }]);
});
