import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { AbiCoder } from "ethers";
import * as setupModule from "../src/setup";
import { KyberSwap } from "../src/classes/DexAggregators/KyberSwap";
import { MultiDexAgg } from "../src/classes/DexAggregators/MultiDexAgg";
import { UnsupportedDexAgg } from "../src/classes/DexAggregators/UnsupportedDexAgg";
import { buildLocalSimpleZapTokens } from "../src/classes/DexAggregators/helpers";
import FormatConverter from "../src/classes/FormatConverter";
import { chain_config } from "../src/chains";
import { safeBigInt, validateSlippageBps } from "../src/validation";
import * as sdk from "../src";
import type { address, bytes } from "../src/types";
import type { IDexAgg, MilestoneResponse, Quote, QuoteArgs, SetupChainResult } from "../src";

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
// client-side signal.

const TOKEN_IN = "0x0000000000000000000000000000000000000001" as address;
const TOKEN_OUT = "0x0000000000000000000000000000000000000002" as address;
const WALLET = "0x0000000000000000000000000000000000000003" as address;
const FEE_RECEIVER = "0x0000000000000000000000000000000000000004" as address;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as address;
const MONAD_WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as address;
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as address;
const DECIMALS_SELECTOR = "0x313ce567";
const KYBER_SWAP_SELECTOR = "0xe21fd0e9";
const KYBER_SWAP_PARAMS_TYPE =
    "tuple(address callTarget,address approveTarget,bytes targetData," +
    "tuple(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts," +
    "address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount," +
    "uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData)";

test("IDexAgg quoteMin exposes primitive bigint", () => {
    const quoteMinShape = (agg: IDexAgg): Promise<bigint> =>
        agg.quoteMin(WALLET, TOKEN_IN, TOKEN_OUT, 1n, 50n);
    assert.equal(typeof quoteMinShape, "function");
});

test("public SDK surface exports DEX aggregator types", () => {
    const args: QuoteArgs = [WALLET, TOKEN_IN, TOKEN_OUT, 1n, 50n];
    const quote: Quote = {
        to: TOKEN_OUT,
        calldata: "0x" as bytes,
        min_out: 1n,
        out: 2n,
    };
    const extractDexAgg = (result: SetupChainResult): IDexAgg => result.dexAgg;

    assert.equal(args[0], WALLET);
    assert.equal(quote.min_out, 1n);
    assert.equal(typeof extractDexAgg, "function");
    assert.equal(typeof sdk.KyberSwap, "function");
    assert.equal(typeof sdk.MultiDexAgg, "function");
    assert.equal("Kuru" in sdk, false);
});

test("public SDK surface exports setup reward result types", () => {
    const milestone: MilestoneResponse = {
        market: TOKEN_IN,
        tvl: 1,
        multiplier: 2,
        fail_multiplier: 0,
        chain_network: "monad-mainnet",
        start_date: "2026-01-01",
        end_date: "2026-01-02",
        duration_in_days: 1,
    };
    const extractGlobalMilestone = (result: SetupChainResult): MilestoneResponse | null =>
        result.global_milestone;

    assert.equal(typeof sdk.Api, "function");
    assert.equal(typeof extractGlobalMilestone, "function");
    assert.equal(milestone.multiplier, 2);
});

function stubKyberSwapQuote(kyber: KyberSwap) {
    (kyber as any).quote = async () => ({
        to: kyber.router,
        calldata: '0x' as bytes,
        min_out: 0n,
        out: 0n,
        raw: {} as any,
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

function createKyberContextMarket(symbol: string, assetAddress: address) {
    return {
        tokens: [{
            name: `Token ${symbol}`,
            symbol,
            getAsset: () => ({
                address: assetAddress,
                name: `Token ${symbol}`,
                symbol,
                decimals: 18n,
            }),
        }],
    };
}

function encodeKyberSwapCalldata({
    feeBps,
    feeReceiver = FEE_RECEIVER,
    callTarget = WALLET,
    approveTarget = ZERO_ADDRESS,
    targetData = "0x1234",
    srcToken = TOKEN_IN,
    dstToken = TOKEN_OUT,
    srcReceivers = [WALLET],
    srcAmounts = [1_000n],
    feeReceivers,
    feeAmounts,
    dstReceiver = WALLET,
    amount = 1_000n,
    minReturnAmount = 995n,
    flags = 0x280n,
    permit = "0x",
}: {
    feeBps: bigint;
    feeReceiver?: address;
    callTarget?: address;
    approveTarget?: address;
    targetData?: string;
    srcToken?: address;
    dstToken?: address;
    srcReceivers?: address[];
    srcAmounts?: bigint[];
    feeReceivers?: address[];
    feeAmounts?: bigint[];
    dstReceiver?: address;
    amount?: bigint;
    minReturnAmount?: bigint;
    flags?: bigint;
    permit?: string;
}): bytes {
    const execution = [
        callTarget,
        approveTarget,
        targetData,
        [
            srcToken,
            dstToken,
            srcReceivers,
            srcAmounts,
            feeReceivers ?? [feeReceiver],
            feeAmounts ?? [feeBps],
            dstReceiver,
            amount,
            minReturnAmount,
            flags,
            permit,
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

async function withMockedKyberFetch<T>(
    kyber: KyberSwap,
    calldata: bytes,
    run: () => Promise<T>,
    buildDataOverrides: Record<string, unknown> = {},
): Promise<T> {
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
                ...buildDataOverrides,
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
    const monadKyberConfig = chain_config["monad-mainnet"].services.dexAggregators.kyberSwap;

    assert.ok(monadKyberConfig);
    assert.ok(monadDex instanceof KyberSwap);
    assert.equal(monadDex.chain, monadKyberConfig.chainSlug);
    assert.equal(monadDex.api, `${monadKyberConfig.apiBase}/${monadKyberConfig.chainSlug}`);
    assert.equal(monadDex.router, monadKyberConfig.router);
    assert.ok(arbDex instanceof UnsupportedDexAgg);
    assert.equal(arbDex instanceof KyberSwap, false);
    assert.equal(chain_config["arb-sepolia"].services.dexAggregators.kyberSwap, null);
    assert.deepEqual(await arbDex.getAvailableTokens({} as any, null, WALLET), []);

    await assert.rejects(
        () => arbDex.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
        /DEX aggregation is not configured for arb-sepolia/i,
    );
});

test("KyberSwap rejects insecure custom API bases at construction", () => {
    assert.throws(
        () => new KyberSwap(FEE_RECEIVER, TOKEN_IN, "monad-mainnet", "http://aggregator.example"),
        /api_url must use HTTPS/i,
    );
});

test("KyberSwap normalizes trailing slashes in custom API bases", () => {
    const kyber = new KyberSwap(
        FEE_RECEIVER,
        TOKEN_IN,
        "monad-mainnet",
        "https://aggregator.example/",
    );

    assert.equal(kyber.api, "https://aggregator.example/monad");
});

test("MultiDexAgg rejects invalid routing config before quote fan-out", () => {
    const agg = {
        dao: FEE_RECEIVER,
        router: TOKEN_IN,
        getAvailableTokens: async () => [],
        quoteAction: async () => {
            throw new Error("not used");
        },
        quoteMin: async () => 1n,
        quote: async () => ({
            to: TOKEN_IN,
            calldata: "0x" as bytes,
            min_out: 1n,
            out: 1n,
        }),
    } as any;

    assert.doesNotThrow(() => new MultiDexAgg([agg], {
        outlierThresholdPercent: 0,
        quoteTimeoutMs: 1,
    }));
    assert.throws(
        () => new MultiDexAgg([agg], { outlierThresholdPercent: 20.5 }),
        /outlierThresholdPercent must be a non-negative integer/i,
    );
    assert.throws(
        () => new MultiDexAgg([agg], { outlierThresholdPercent: -1 }),
        /outlierThresholdPercent must be a non-negative integer/i,
    );
    assert.throws(
        () => new MultiDexAgg([agg], { quoteTimeoutMs: 0 }),
        /quoteTimeoutMs must be a positive integer/i,
    );
    assert.throws(
        () => new MultiDexAgg([agg], { quoteTimeoutMs: 10.5 }),
        /quoteTimeoutMs must be a positive integer/i,
    );
});

test("MultiDexAgg validates quote request inputs before child fan-out", async () => {
    let quoteCalls = 0;
    const child = {
        dao: FEE_RECEIVER,
        router: TOKEN_IN,
        getAvailableTokens: async () => [],
        quoteAction: async () => {
            quoteCalls += 1;
            throw new Error("quoteAction should not run for invalid request inputs");
        },
        quoteMin: async () => {
            quoteCalls += 1;
            throw new Error("quoteMin should not run for invalid request inputs");
        },
        quote: async () => {
            quoteCalls += 1;
            throw new Error("quote should not run for invalid request inputs");
        },
    } as any;
    const multi = new MultiDexAgg([child]);

    await assert.rejects(
        () => multi.quote("not-a-wallet", TOKEN_IN, TOKEN_OUT, 1_000n, 50n),
        /Invalid address from MultiDexAgg wallet/,
    );
    await assert.rejects(
        () => multi.quoteMin(WALLET, "not-a-token", TOKEN_OUT, 1_000n, 50n),
        /Invalid address from MultiDexAgg tokenIn/,
    );
    await assert.rejects(
        () => multi.quoteAction(WALLET, TOKEN_IN, "not-a-token", 1_000n, 50n),
        /Invalid address from MultiDexAgg tokenOut/,
    );
    await assert.rejects(
        () => multi.quote(WALLET, TOKEN_IN, TOKEN_OUT, 0n, 50n),
        /MultiDexAgg quote amount must be positive, got 0/,
    );
    await assert.rejects(
        () => multi.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 10_000n),
        /Slippage out of range \(0-9999 BPS\) in MultiDexAgg quote: 10000/,
    );
    await assert.rejects(
        () => multi.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, "not-a-receiver" as any),
        /Invalid address from MultiDexAgg feeReceiver/,
    );
    assert.equal(quoteCalls, 0);
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

test("KyberSwap.quote rejects nonzero transaction value before returning calldata", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);

    await assert.rejects(
        () => withMockedKyberFetch(
            kyber,
            encodeKyberSwapCalldata({ feeBps: 4n, feeReceiver: FEE_RECEIVER }),
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
            { transactionValue: "1" },
        ),
        /KyberSwap quote transactionValue=1, expected 0/,
    );
});

test("KyberSwap.quote rejects malformed transaction value before returning calldata", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);

    await assert.rejects(
        () => withMockedKyberFetch(
            kyber,
            encodeKyberSwapCalldata({ feeBps: 4n, feeReceiver: FEE_RECEIVER }),
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
            { transactionValue: "not-a-number" },
        ),
        /Invalid unsigned numeric value from KyberSwap transactionValue: "not-a-number"/,
    );
});

test("KyberSwap.quote accepts currency_in fee-net source amounts", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);
    const amount = 1_000_000n;
    const feeBps = 4n;
    const feeNetSourceAmount = amount - (amount * feeBps / 10_000n);

    const quote = await withMockedKyberFetch(
        kyber,
        encodeKyberSwapCalldata({
            feeBps,
            feeReceiver: FEE_RECEIVER,
            amount,
            srcAmounts: [feeNetSourceAmount],
        }),
        () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, amount, 50n, feeBps, FEE_RECEIVER),
    );

    assert.equal(quote.min_out, 995n);
});

test("KyberSwap.quote accepts bounded currency_in source amount rounding", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);
    const amount = 1_000_000n;
    const feeBps = 4n;

    for (const deductedBps of [2n, 6n]) {
        const sourceAmount = amount - (amount * deductedBps / 10_000n);
        const quote = await withMockedKyberFetch(
            kyber,
            encodeKyberSwapCalldata({
                feeBps,
                feeReceiver: FEE_RECEIVER,
                amount,
                srcAmounts: [sourceAmount],
            }),
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, amount, 50n, feeBps, FEE_RECEIVER),
        );

        assert.equal(quote.min_out, 995n);
    }
});

test("KyberSwap.quote accepts zero dstReceiver as Kyber msg.sender shorthand", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);

    const quote = await withMockedKyberFetch(
        kyber,
        encodeKyberSwapCalldata({
            feeBps: 4n,
            feeReceiver: FEE_RECEIVER,
            dstReceiver: ZERO_ADDRESS,
        }),
        () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
    );

    assert.equal(quote.min_out, 995n);
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

test("KyberSwap.quote validates request addresses before fetch", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("Kyber request should not be sent for invalid address inputs");
    }) as typeof fetch;

    try {
        await assert.rejects(
            () => kyber.quote("not-a-wallet", TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
            /Invalid address from KyberSwap wallet/,
        );
        await assert.rejects(
            () => kyber.quote(WALLET, "not-a-token", TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
            /Invalid address from KyberSwap tokenIn/,
        );
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, "not-a-token", 1_000n, 50n, 4n, FEE_RECEIVER),
            /Invalid address from KyberSwap tokenOut/,
        );
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, "not-a-receiver" as any),
            /Invalid address from KyberSwap feeReceiver/,
        );
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("KyberSwap.quote rejects non-positive request amounts before fetch", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("Kyber request should not be sent for invalid quote amounts");
    }) as typeof fetch;

    try {
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 0n, 50n, 4n, FEE_RECEIVER),
            /KyberSwap quote amount must be positive, got 0/,
        );
        await assert.rejects(
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, -1n, 50n, 4n, FEE_RECEIVER),
            /KyberSwap quote amount must be positive, got -1/,
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

test("KyberSwap.quote rejects current router calldata with the wrong selector", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);

    await assert.rejects(
        () => withMockedKyberFetch(
            kyber,
            "0x12345678" as bytes,
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
        ),
        /KyberSwap calldata selector=0x12345678, expected 0xe21fd0e9/,
    );
});

test("KyberSwap.quote rejects calldata that does not bind requested swap fields", async () => {
    const cases: Array<{
        name: string;
        calldata: bytes;
        pattern: RegExp;
    }> = [
        {
            name: "wrong source token",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                srcToken: TOKEN_OUT,
            }),
            pattern: /srcToken=.*expected 0x0000000000000000000000000000000000000001/i,
        },
        {
            name: "wrong destination token",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                dstToken: TOKEN_IN,
            }),
            pattern: /dstToken=.*expected 0x0000000000000000000000000000000000000002/i,
        },
        {
            name: "wrong amount",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                amount: 999n,
            }),
            pattern: /amount=999, expected 1000/i,
        },
        {
            name: "wrong recipient",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                dstReceiver: FEE_RECEIVER,
            }),
            pattern: /dstReceiver=.*expected 0x0000000000000000000000000000000000000003/i,
        },
        {
            name: "minimum return below SDK quote minimum",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                minReturnAmount: 994n,
            }),
            pattern: /minReturnAmount=994, expected at least 995/i,
        },
        {
            name: "non-empty approve target",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                approveTarget: TOKEN_IN,
            }),
            pattern: /approveTarget=.*expected 0x0000000000000000000000000000000000000000/i,
        },
        {
            name: "empty target data",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                targetData: "0x",
            }),
            pattern: /targetData cannot be empty/i,
        },
        {
            name: "non-empty permit",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                permit: "0x1234",
            }),
            pattern: /permit must be empty/i,
        },
        {
            name: "zero call target",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                callTarget: ZERO_ADDRESS,
            }),
            pattern: /callTarget cannot be 0x0000000000000000000000000000000000000000/i,
        },
        {
            name: "zero source receiver",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                srcReceivers: [ZERO_ADDRESS],
            }),
            pattern: /srcReceiver cannot be 0x0000000000000000000000000000000000000000/i,
        },
        {
            name: "source receiver amount length mismatch",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                srcReceivers: [WALLET],
                srcAmounts: [],
            }),
            pattern: /srcReceivers\/srcAmounts length mismatch: 1\/0/i,
        },
        {
            name: "source amounts do not sum to requested amount",
            calldata: encodeKyberSwapCalldata({
                feeBps: 4n,
                srcAmounts: [100n],
            }),
            pattern: /srcAmounts total=100, expected 1000 or fee deduction 0-1 wei/i,
        },
    ];

    for (const entry of cases) {
        const kyber = new KyberSwap(FEE_RECEIVER);

        await assert.rejects(
            () => withMockedKyberFetch(
                kyber,
                entry.calldata,
                () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
            ),
            entry.pattern,
            entry.name,
        );
    }
});

test("KyberSwap.quote rejects current router calldata that cannot be decoded", async () => {
    const kyber = new KyberSwap(FEE_RECEIVER);

    await assert.rejects(
        () => withMockedKyberFetch(
            kyber,
            `${KYBER_SWAP_SELECTOR}00` as bytes,
            () => kyber.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER),
        ),
        /KyberSwap calldata could not be decoded for fee validation/,
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

test("MultiDexAgg.withContext binds every child adapter without mutating the original", async () => {
    const contextBindings: Array<{ label: string; chain: string }> = [];
    const quoteCalls: Array<{ label: string; chain: string; amount: bigint; feeBps: bigint | undefined }> = [];

    function contextAwareAgg(label: string, minOut: bigint, token: address) {
        return {
            dao: FEE_RECEIVER,
            router: token,
            withContext(context: any) {
                const chain = context.markets[0]?.setup?.chain ?? "unknown";
                contextBindings.push({ label, chain });

                return {
                    dao: FEE_RECEIVER,
                    router: token,
                    getAvailableTokens: async () => [{
                        interface: { address: token, symbol: label },
                        type: "simple",
                    }],
                    quoteAction: async () => {
                        throw new Error("quoteAction is not used by this test");
                    },
                    quoteMin: async () => minOut,
                    quote: async (
                        _wallet: string,
                        _tokenIn: string,
                        _tokenOut: string,
                        amount: bigint,
                        _slippage: bigint,
                        feeBps?: bigint,
                    ) => {
                        quoteCalls.push({ label, chain, amount, feeBps });
                        return {
                            to: token,
                            calldata: "0x" as bytes,
                            min_out: minOut,
                            out: minOut + 1n,
                        };
                    },
                };
            },
            getAvailableTokens: async () => {
                throw new Error(`${label} used without context`);
            },
            quoteAction: async () => {
                throw new Error(`${label} used without context`);
            },
            quoteMin: async () => {
                throw new Error(`${label} used without context`);
            },
            quote: async () => {
                throw new Error(`${label} used without context`);
            },
        };
    }

    const original = new MultiDexAgg([
        contextAwareAgg("primary", 90n, TOKEN_IN) as any,
        contextAwareAgg("secondary", 120n, TOKEN_OUT) as any,
    ]);
    const bound = original.withContext({
        markets: [{ setup: { chain: "monad-mainnet" } }],
        feePolicy: { getFeeBps: () => 4n, feeReceiver: FEE_RECEIVER, chain: "monad-mainnet" },
    } as any);

    const tokens = await bound.getAvailableTokens({} as any, null, WALLET);
    const quote = await bound.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n, 4n, FEE_RECEIVER);

    assert.deepEqual(contextBindings, [
        { label: "primary", chain: "monad-mainnet" },
        { label: "secondary", chain: "monad-mainnet" },
    ]);
    assert.deepEqual(tokens.map((token) => token.interface.address), [TOKEN_IN, TOKEN_OUT]);
    assert.equal(quote.to, TOKEN_OUT);
    assert.equal(quote.min_out, 120n);
    assert.deepEqual(quoteCalls, [
        { label: "primary", chain: "monad-mainnet", amount: 1_000n, feeBps: 4n },
        { label: "secondary", chain: "monad-mainnet", amount: 1_000n, feeBps: 4n },
    ]);
    await assert.rejects(
        () => original.quote(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n),
        /used without context/,
    );
});

test("KyberSwap.withContext binds the checker DAO without mutating the original", () => {
    const originalReceiver = "0x00000000000000000000000000000000000000d1" as address;
    const setupReceiver = "0x00000000000000000000000000000000000000d2" as address;
    const checkerDao = "0x00000000000000000000000000000000000000d3" as address;
    const original = new KyberSwap(originalReceiver);
    const bound = original.withContext({
        markets: [],
        feePolicy: { getFeeBps: () => 4n, feeReceiver: setupReceiver, chain: "monad-mainnet" },
        checkerDao,
    } as any);

    assert.equal(original.dao, originalReceiver);
    assert.equal(bound.dao, checkerDao);
});

test("KyberSwap.getAvailableTokens uses bound context before mutable globals", async (t) => {
    const originalAllMarkets = setupModule.all_markets;
    const originalSetupConfig = (setupModule as any).setup_config;
    const feeContexts: any[] = [];
    let quoteArgs: QuoteArgs | null = null;

    (setupModule as any).all_markets = [createKyberContextMarket("GLOBAL", TOKEN_OUT)];
    (setupModule as any).setup_config = {
        feePolicy: {
            getFeeBps: () => 99n,
            feeReceiver: ZERO_ADDRESS,
            chain: "monad-mainnet",
        },
    };

    t.after(() => {
        (setupModule as any).all_markets = originalAllMarkets;
        (setupModule as any).setup_config = originalSetupConfig;
    });

    const bound = new KyberSwap(FEE_RECEIVER).withContext({
        markets: [createKyberContextMarket("CTX", TOKEN_IN)],
        feePolicy: {
            getFeeBps: (context: any) => {
                feeContexts.push(context);
                return 4n;
            },
            feeReceiver: FEE_RECEIVER,
            chain: "monad-mainnet",
        },
        checkerDao: FEE_RECEIVER,
    } as any);
    (bound as any).quote = async (...args: QuoteArgs) => {
        quoteArgs = args;
        return {
            to: TOKEN_OUT,
            calldata: "0x" as bytes,
            min_out: 1n,
            out: 2n,
        };
    };

    const provider = createDecimalsProvider(new Map([
        [TOKEN_IN.toLowerCase(), 18n],
        [TOKEN_OUT.toLowerCase(), 18n],
    ]));
    const tokens = await bound.getAvailableTokens(provider as any, null, WALLET);

    assert.deepEqual(
        tokens.map((token) => ({
            symbol: token.interface.symbol,
            address: token.interface.address.toLowerCase(),
            quoteable: typeof token.quote === "function",
        })),
        [{
            symbol: "CTX",
            address: TOKEN_IN.toLowerCase(),
            quoteable: true,
        }],
    );

    await tokens[0]!.quote!(TOKEN_IN, TOKEN_OUT, Decimal(1), Decimal("0.01"));

    assert.deepEqual(quoteArgs, [
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000_000_000_000_000_000n,
        100n,
        4n,
        FEE_RECEIVER,
    ]);
    assert.equal(feeContexts.length, 1);
    assert.equal(feeContexts[0].inputToken, TOKEN_IN);
    assert.equal(feeContexts[0].outputToken, TOKEN_OUT);
    assert.equal(feeContexts[0].inputAmount, 1_000_000_000_000_000_000n);
});

test("MultiDexAgg exposes the first executable child router for route advertisement", () => {
    const unsupported = {
        dao: ZERO_ADDRESS,
        router: ZERO_ADDRESS,
        getAvailableTokens: async () => [],
        quoteAction: async () => {
            throw new Error("unsupported");
        },
        quoteMin: async () => {
            throw new Error("unsupported");
        },
        quote: async () => {
            throw new Error("unsupported");
        },
    } as any;
    const executable = {
        dao: FEE_RECEIVER,
        router: TOKEN_OUT,
        getAvailableTokens: async () => [],
        quoteAction: async () => {
            throw new Error("not used");
        },
        quoteMin: async () => 1n,
        quote: async () => ({
            to: TOKEN_OUT,
            calldata: "0x" as bytes,
            min_out: 1n,
            out: 2n,
        }),
    } as any;

    const multi = new MultiDexAgg([unsupported, executable]);

    assert.equal(multi.router, TOKEN_OUT);
    assert.equal(multi.dao, FEE_RECEIVER);
});

test("MultiDexAgg preserves quoteable duplicate token options across children", async () => {
    const unquoteable = {
        dao: FEE_RECEIVER,
        router: TOKEN_IN,
        getAvailableTokens: async () => [{
            interface: { address: TOKEN_IN, symbol: "DUP" },
            type: "simple",
        }],
        quoteAction: async () => {
            throw new Error("quoteAction is not used by this test");
        },
        quoteMin: async () => 1n,
        quote: async () => ({
            to: TOKEN_IN,
            calldata: "0x" as bytes,
            min_out: 1n,
            out: 2n,
        }),
    };
    const quoteable = {
        dao: FEE_RECEIVER,
        router: TOKEN_OUT,
        getAvailableTokens: async () => [{
            interface: { address: TOKEN_IN, symbol: "DUP" },
            type: "simple",
            quote: async () => ({
                minOut_raw: 11n,
                output_raw: 12n,
                minOut: Decimal(11),
                output: Decimal(12),
            }),
        }],
        quoteAction: async () => {
            throw new Error("quoteAction is not used by this test");
        },
        quoteMin: async () => 2n,
        quote: async () => ({
            to: TOKEN_OUT,
            calldata: "0x" as bytes,
            min_out: 2n,
            out: 3n,
        }),
    };

    const tokens = await new MultiDexAgg([unquoteable as any, quoteable as any])
        .getAvailableTokens({} as any, null, WALLET);

    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.interface.address, TOKEN_IN);
    assert.equal(typeof tokens[0]?.quote, "function");
    assert.equal((await tokens[0]!.quote!(TOKEN_IN, TOKEN_OUT, Decimal(1), Decimal("0.01"))).minOut_raw, 11n);
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

test("MultiDexAgg.quote picks the route with the highest guaranteed output", async () => {
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
    const quote = await multi.quote(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
    );

    assert.equal(quote.min_out, 80n);
    assert.equal(quote.out, 90n);
    assert.equal(quote.to, TOKEN_IN);
});

test("MultiDexAgg.quoteAction picks the route with the highest guaranteed output", async () => {
    const conservativeAction = { aggregator: "conservative" } as any;
    const optimisticAction = { aggregator: "optimistic" } as any;
    const quoteActionCalls: Array<{
        label: string;
        wallet: string;
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        slippage: bigint;
        feeBps: bigint | undefined;
        feeReceiver: string | undefined;
    }> = [];

    const conservative = {
        dao: FEE_RECEIVER,
        router: TOKEN_IN,
        getAvailableTokens: async () => [],
        quoteAction: async (
            wallet: string,
            tokenIn: string,
            tokenOut: string,
            amount: bigint,
            slippage: bigint,
            feeBps?: bigint,
            feeReceiver?: address,
        ) => {
            quoteActionCalls.push({ label: "conservative", wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver });
            return {
            action: conservativeAction,
            quote: {
                to: TOKEN_IN,
                calldata: "0x" as bytes,
                min_out: 80n,
                out: 90n,
            },
        };
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
        quoteAction: async (
            wallet: string,
            tokenIn: string,
            tokenOut: string,
            amount: bigint,
            slippage: bigint,
            feeBps?: bigint,
            feeReceiver?: address,
        ) => {
            quoteActionCalls.push({ label: "optimistic", wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver });
            return {
            action: optimisticAction,
            quote: {
                to: TOKEN_OUT,
                calldata: "0x" as bytes,
                min_out: 50n,
                out: 100n,
            },
        };
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
    const { action, quote } = await multi.quoteAction(
        WALLET,
        TOKEN_IN,
        TOKEN_OUT,
        1_000n,
        50n,
        4n,
        FEE_RECEIVER,
    );

    assert.equal(action, conservativeAction);
    assert.equal(quote.min_out, 80n);
    assert.equal(quote.out, 90n);
    assert.deepEqual(
        quoteActionCalls
            .map((call) => ({
                ...call,
                feeReceiver: call.feeReceiver?.toLowerCase(),
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        [
            {
                label: "conservative",
                wallet: WALLET,
                tokenIn: TOKEN_IN,
                tokenOut: TOKEN_OUT,
                amount: 1_000n,
                slippage: 50n,
                feeBps: 4n,
                feeReceiver: FEE_RECEIVER.toLowerCase(),
            },
            {
                label: "optimistic",
                wallet: WALLET,
                tokenIn: TOKEN_IN,
                tokenOut: TOKEN_OUT,
                amount: 1_000n,
                slippage: 50n,
                feeBps: 4n,
                feeReceiver: FEE_RECEIVER.toLowerCase(),
            },
        ],
    );
});

test("MultiDexAgg clears quote timeout timers when quotes resolve first", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const liveTimers = new Set<object>();
    const clearedTimers: object[] = [];

    (globalThis as any).setTimeout = () => {
        const timer = {};
        liveTimers.add(timer);
        return timer;
    };
    (globalThis as any).clearTimeout = (timer: object) => {
        clearedTimers.push(timer);
        liveTimers.delete(timer);
    };

    try {
        const fastA = {
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
        const fastB = {
            dao: FEE_RECEIVER,
            router: TOKEN_OUT,
            getAvailableTokens: async () => [],
            quoteAction: async () => {
                throw new Error("not used");
            },
            quoteMin: async () => 70n,
            quote: async () => ({
                to: TOKEN_OUT,
                calldata: "0x" as bytes,
                min_out: 70n,
                out: 70n,
            }),
        } as any;

        const multi = new MultiDexAgg([fastA, fastB], { quoteTimeoutMs: 10_000 });
        const minOut = await multi.quoteMin(WALLET, TOKEN_IN, TOKEN_OUT, 1_000n, 50n);

        assert.equal(minOut, 80n);
        assert.equal(clearedTimers.length, 2);
        assert.equal(liveTimers.size, 0);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
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

test("simple zap token search does not let a nonmatching duplicate hide a later matching alias", () => {
    const zapTokens = buildLocalSimpleZapTokens(
        [
            {
                tokens: [
                    {
                        name: "Wrapped Monad",
                        symbol: "WMON",
                        getAsset: () => ({ address: MONAD_WMON, symbol: "WMON" }),
                    },
                ],
            },
            {
                tokens: [
                    {
                        name: "Liquid Staked Monad",
                        symbol: "shMON",
                        getAsset: () => ({ address: MONAD_WMON, symbol: "shMON" }),
                    },
                ],
            },
        ] as any,
        {} as any,
        "staked",
        WALLET,
        async () => ({
            to: TOKEN_OUT,
            calldata: "0x" as bytes,
            min_out: 1n,
            out: 2n,
        }),
    );

    assert.equal(zapTokens.length, 1);
    assert.equal(zapTokens[0]?.interface.address, MONAD_WMON);
    assert.equal(zapTokens[0]?.interface.symbol, "shMON");
});
