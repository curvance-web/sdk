import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Decimal from "decimal.js";
import { Wallet } from "ethers";
import {
    BorrowableCToken,
    CToken,
    DexQuoteError,
    NATIVE_ADDRESS,
    REPAY_WITH_SWAP,
    Zapper,
    toContractSwapSlippage,
    type RepayWithSwapPlan,
} from "../src";
import type { address } from "../src/types";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const SIGNER = new Wallet(PRIVATE_KEY);
const PAYER = SIGNER.address as address;
const RECEIVER = "0x00000000000000000000000000000000000000a2" as address;
const CTOKEN = "0x00000000000000000000000000000000000000c1" as address;
const DEBT_TOKEN = "0x00000000000000000000000000000000000000d1" as address;
const INPUT_TOKEN = "0x00000000000000000000000000000000000000d2" as address;
const WRAPPED_NATIVE = "0x00000000000000000000000000000000000000d3" as address;
const ZAPPER = "0x00000000000000000000000000000000000000e1" as address;
const ROUTER = "0x00000000000000000000000000000000000000e2" as address;
const ORACLE_MANAGER = "0x00000000000000000000000000000000000000e3" as address;
const MARKET = "0x00000000000000000000000000000000000000f1" as address;

type QuoteCall = {
    wallet: string;
    tokenIn: string;
    tokenOut: string;
    amount: bigint;
    slippage: bigint;
    feeBps: bigint | undefined;
    feeReceiver: address | undefined;
};

function createSetup(dexAgg: any, feeBps: bigint = 4n) {
    return {
        chain: "monad-mainnet",
        contracts: {
            OracleManager: ORACLE_MANAGER,
            zappers: { simpleZapper: ZAPPER },
        },
        assets: {
            wrapped_native: WRAPPED_NATIVE,
            native_symbol: "MON",
            native_name: "Monad",
            native_vaults: [],
            vaults: [],
            excluded_zap_symbols: [],
        },
        feePolicy: {
            feeReceiver: RECEIVER,
            getFeeBps: () => feeBps,
        },
    } as any;
}

function createDex(
    quoteFn: (amount: bigint) => { min: bigint; out: bigint } = (amount) => ({
        min: amount * 9n / 5n,
        out: amount * 2n,
    }),
    buildQuoteFn: (amount: bigint) => { min: bigint; out: bigint } = quoteFn,
) {
    const calls: QuoteCall[] = [];
    const buildCalls: QuoteCall[] = [];
    const prepareQuote = async (
        wallet: string,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        slippage: bigint,
        feeBps?: bigint,
        feeReceiver?: address,
    ) => {
        const call = { wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver };
        calls.push(call);
        const result = quoteFn(amount);
        return {
            min_out: result.min,
            out: result.out,
            async build() {
                buildCalls.push(call);
                const built = buildQuoteFn(amount);
                return {
                    to: ROUTER,
                    calldata: "0x1234" as const,
                    min_out: built.min,
                    out: built.out,
                };
            },
        };
    };
    const dexAgg = {
        dao: RECEIVER,
        router: ROUTER,
        prepareQuote,
        async quote(
            wallet: string,
            tokenIn: string,
            tokenOut: string,
            amount: bigint,
            slippage: bigint,
            feeBps?: bigint,
            feeReceiver?: address,
        ) {
            return (await prepareQuote(
                wallet,
                tokenIn,
                tokenOut,
                amount,
                slippage,
                feeBps,
                feeReceiver,
            )).build();
        },
    };
    return { dexAgg, calls, buildCalls };
}

function createCToken(setup: any, debtToken: address = DEBT_TOKEN) {
    const token = Object.create(CToken.prototype) as CToken;
    (token as any).address = CTOKEN;
    (token as any).cache = {
        asset: { address: debtToken, decimals: 0n },
    };
    (token as any).market = { address: MARKET, setup };
    return token;
}

function createZapperHarness(
    debtToken: address = DEBT_TOKEN,
    feeBps: bigint = 4n,
    quoteFn?: (amount: bigint) => { min: bigint; out: bigint },
) {
    const dex = createDex(quoteFn);
    const setup = createSetup(dex.dexAgg, feeBps);
    const ctoken = createCToken(setup, debtToken);
    const zapper = new Zapper(ZAPPER, SIGNER, "simple", setup, dex.dexAgg as any);
    return { ...dex, setup, ctoken, zapper };
}

describe("Zapper swapAndRepay calldata", () => {
    test("same-token repayment bypasses the DEX and encodes a no-op swap", async () => {
        const { zapper, ctoken, calls } = createZapperHarness();
        const quote = await zapper.quoteSwapAndRepay(ctoken, DEBT_TOKEN, 1_000n, 50n);

        assert.equal(calls.length, 0);
        assert.equal(quote.minimumOutput, 1_000n);
        assert.equal(quote.expectedOutput, 1_000n);
        assert.equal(quote.feeBps, 0n);
        assert.equal(quote.action.target, "0x0000000000000000000000000000000000000000");
        assert.equal(quote.action.call, "0x");

        const calldata = zapper.getSwapAndRepayCalldataFromQuote(ctoken, quote, 999n, RECEIVER);
        const decoded = zapper.contract.interface.decodeFunctionData("swapAndRepay", calldata);
        assert.equal(decoded.borrowableCToken.toLowerCase(), CTOKEN.toLowerCase());
        assert.equal(decoded.depositAsWrappedNative, false);
        assert.equal(decoded.swapAction.inputToken.toLowerCase(), DEBT_TOKEN.toLowerCase());
        assert.equal(decoded.swapAction.inputAmount, 1_000n);
        assert.equal(decoded.repayAssets, 999n);
        assert.equal(decoded.receiver.toLowerCase(), RECEIVER.toLowerCase());
    });

    test("native-to-wrapped debt repayment wraps without asking the DEX", async () => {
        const { zapper, ctoken, calls } = createZapperHarness(WRAPPED_NATIVE);
        const quote = await zapper.quoteSwapAndRepay(ctoken, NATIVE_ADDRESS, 500n, 75n);

        assert.equal(calls.length, 0);
        assert.equal(quote.depositAsWrappedNative, true);
        assert.equal(quote.swapInputToken, WRAPPED_NATIVE);
        assert.equal(quote.action.inputToken, NATIVE_ADDRESS);
        assert.equal(quote.action.outputToken, WRAPPED_NATIVE);
    });

    test("real native swap quotes wrapped input and preserves native outer action", async () => {
        const { zapper, ctoken, calls } = createZapperHarness();
        const quote = await zapper.quoteSwapAndRepay(ctoken, NATIVE_ADDRESS, 500n, 50n);

        assert.deepEqual(calls, [{
            wallet: ZAPPER,
            tokenIn: WRAPPED_NATIVE,
            tokenOut: DEBT_TOKEN,
            amount: 500n,
            slippage: 50n,
            feeBps: 4n,
            feeReceiver: RECEIVER,
        }]);
        assert.equal(quote.action.inputToken, NATIVE_ADDRESS);
        assert.equal(quote.action.target, ROUTER);
        assert.equal(quote.action.slippage, toContractSwapSlippage(50n, 4n));
        assert.equal(quote.slippageBps, 50n);
        assert.equal(quote.minimumOutput, 900n);
    });

    test("repayment floor and quote/action mismatches fail before calldata", async () => {
        const { zapper, ctoken } = createZapperHarness();
        const quote = await zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, 100n, 50n);

        assert.throws(
            () => zapper.getSwapAndRepayCalldataFromQuote(ctoken, quote, 181n, RECEIVER),
            /minimum output 180 does not cover repayment floor 181/i,
        );
        assert.throws(
            () => zapper.getSwapAndRepayCalldataFromQuote(
                ctoken,
                { ...quote, action: { ...quote.action, inputAmount: 99n } },
                100n,
                RECEIVER,
            ),
            /quote action does not match/i,
        );
    });

    test("malformed DEX output bounds fail before repayment calldata", async () => {
        const zero = createZapperHarness(DEBT_TOKEN, 4n, () => ({ min: 0n, out: 1n }));
        await assert.rejects(
            () => zero.zapper.quoteSwapAndRepay(zero.ctoken, INPUT_TOKEN, 100n, 50n),
            /zero guaranteed output/i,
        );

        const inverted = createZapperHarness(DEBT_TOKEN, 4n, () => ({ min: 101n, out: 100n }));
        await assert.rejects(
            () => inverted.zapper.quoteSwapAndRepay(inverted.ctoken, INPUT_TOKEN, 100n, 50n),
            /expected output 100 is below minimum output 101/i,
        );
    });

    test("rejects non-positive input amounts before requesting a DEX quote", async () => {
        const { zapper, ctoken, calls } = createZapperHarness();

        for (const amount of [0n, -1n]) {
            await assert.rejects(
                () => zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, amount, 50n),
                /input amount must be positive/i,
            );
        }
        assert.equal(calls.length, 0);
    });

    test("rejects slippage outside the inclusive 0-9999 BPS range before quoting", async () => {
        const { zapper, ctoken, calls } = createZapperHarness();

        for (const slippage of [-1n, 10_000n]) {
            await assert.rejects(
                () => zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, 100n, slippage),
                /Slippage out of range \(0-9999 BPS\)/i,
            );
        }
        assert.equal(calls.length, 0);
    });

    test("accepts both slippage boundaries and omits the fee receiver for a zero-fee quote", async () => {
        const { zapper, ctoken, calls } = createZapperHarness(DEBT_TOKEN, 0n);
        const zero = await zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, 100n, 0n);
        const maximum = await zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, 100n, 9_999n);

        assert.equal(zero.feeBps, 0n);
        assert.equal(zero.feeReceiver, undefined);
        assert.equal(zero.action.slippage, toContractSwapSlippage(0n, 0n));
        assert.equal(maximum.action.slippage, toContractSwapSlippage(9_999n, 0n));
        assert.deepEqual(calls.map((call) => ({
            slippage: call.slippage,
            feeBps: call.feeBps,
            feeReceiver: call.feeReceiver,
        })), [
            { slippage: 0n, feeBps: 0n, feeReceiver: undefined },
            { slippage: 9_999n, feeBps: 0n, feeReceiver: undefined },
        ]);
    });

    test("rejects non-positive repayment floors and quotes for another debt asset", async () => {
        const { zapper, ctoken } = createZapperHarness();
        const quote = await zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, 100n, 50n);

        for (const repayAssets of [0n, -1n]) {
            assert.throws(
                () => zapper.getSwapAndRepayCalldataFromQuote(
                    ctoken,
                    quote,
                    repayAssets,
                    RECEIVER,
                ),
                /repayment floor must be positive/i,
            );
        }
        assert.throws(
            () => zapper.getSwapAndRepayCalldataFromQuote(
                ctoken,
                {
                    ...quote,
                    outputToken: INPUT_TOKEN,
                    action: { ...quote.action, outputToken: INPUT_TOKEN },
                },
                100n,
                RECEIVER,
            ),
            /quote output .* does not match debt asset/i,
        );
    });

    test("rejects every declared swap-action identity mismatch", async () => {
        const { zapper, ctoken } = createZapperHarness();
        const quote = await zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, 100n, 50n);
        const mismatchedActions = [
            { ...quote.action, inputToken: DEBT_TOKEN },
            { ...quote.action, inputAmount: quote.inputAmount + 1n },
            { ...quote.action, outputToken: INPUT_TOKEN },
        ];

        for (const action of mismatchedActions) {
            assert.throws(
                () => zapper.getSwapAndRepayCalldataFromQuote(
                    ctoken,
                    { ...quote, action },
                    100n,
                    RECEIVER,
                ),
                /quote action does not match/i,
            );
        }
    });

    test("defaults the repayment receiver to the connected signer", async () => {
        const { zapper, ctoken } = createZapperHarness();
        const calldata = await zapper.getSwapAndRepayCalldata(
            ctoken,
            INPUT_TOKEN,
            100n,
            100n,
            50n,
        );
        const decoded = zapper.contract.interface.decodeFunctionData("swapAndRepay", calldata);

        assert.equal(decoded.receiver.toLowerCase(), PAYER.toLowerCase());
    });

    test("rejects a cToken bound to a different setup snapshot", async () => {
        const { zapper, ctoken, calls } = createZapperHarness();
        (ctoken as any).market.setup = { ...(ctoken as any).market.setup };

        await assert.rejects(
            () => zapper.quoteSwapAndRepay(ctoken, INPUT_TOKEN, 100n, 50n),
            /without the same setup snapshot/i,
        );
        assert.equal(calls.length, 0);
    });

    test("swapAndRepay routes native value and ERC20 calls through oracleRoute", async () => {
        const { zapper, ctoken } = createZapperHarness();
        const routed: Array<{ overrides: any; receiver: address }> = [];
        (ctoken as any).oracleRoute = async (_calldata: string, overrides: any, receiver: address) => {
            routed.push({ overrides, receiver });
            return { hash: "0x1" };
        };

        await zapper.swapAndRepay(ctoken, NATIVE_ADDRESS, 100n, 150n, 50n, RECEIVER);
        await zapper.swapAndRepay(ctoken, INPUT_TOKEN, 100n, 150n, 50n, RECEIVER);

        assert.deepEqual(routed, [
            { overrides: { value: 100n, to: ZAPPER }, receiver: RECEIVER },
            { overrides: { to: ZAPPER }, receiver: RECEIVER },
        ]);
    });
});

type BorrowableHarness = ReturnType<typeof createBorrowableHarness>;

function createBorrowableHarness({
    projectedDebt = 1_000n,
    allowance = 2n ** 255n,
    quoteFn,
    buildQuoteFn,
}: {
    projectedDebt?: bigint;
    allowance?: bigint;
    quoteFn?: (amount: bigint) => { min: bigint; out: bigint };
    buildQuoteFn?: (amount: bigint) => { min: bigint; out: bigint };
} = {}) {
    let chainTimestamp = 1_700_000_000n;
    let currentProjectedDebt = projectedDebt;
    let currentAllowance = allowance;
    let simulation = { success: true } as { success: boolean; error?: string };
    const debtReads: Array<{ receiver: address; timestamp: bigint }> = [];
    const approvals: Array<{ spender: address; amount: Decimal | null }> = [];
    const simulations: Array<{ calldata: string; overrides: any }> = [];
    const submissions: Array<{ calldata: string; overrides: any; receiver: address }> = [];
    const dex = createDex(quoteFn, buildQuoteFn);
    const setup = createSetup(dex.dexAgg);
    const token = Object.create(BorrowableCToken.prototype) as BorrowableCToken;

    (token as any).address = CTOKEN;
    (token as any).provider = {
        getBlock: async () => ({ timestamp: Number(chainTimestamp) }),
    };
    (token as any).cache = {
        symbol: "cDEBT",
        asset: {
            address: DEBT_TOKEN,
            decimals: 0n,
            symbol: "DEBT",
            name: "Debt Token",
        },
    };
    (token as any).market = {
        address: MARKET,
        signer: SIGNER,
        account: PAYER,
        setup,
        dexAgg: dex.dexAgg,
        reader: {
            debtBalanceAtTimestamp: async (receiver: address, _ctoken: address, timestamp: bigint) => {
                debtReads.push({ receiver, timestamp });
                return currentProjectedDebt;
            },
        },
        oracle_manager: {
            getPrice: async (asset: address, _inUsd: boolean, lower: boolean) => {
                if (asset.toLowerCase() === INPUT_TOKEN.toLowerCase()) return lower ? 4n : 5n;
                if (asset.toLowerCase() === DEBT_TOKEN.toLowerCase()) return 2n;
                throw new Error(`unexpected price request ${asset}`);
            },
        },
        reloadUserData: async () => undefined,
    };
    (token as any).getRepayWithSwapInputToken = () => ({
        fetchDecimals: async () => 0n,
        allowance: async () => currentAllowance,
        approve: async (spender: address, amount: Decimal | null) => {
            approvals.push({ spender, amount });
            return { hash: "0xapprove" };
        },
    });
    (token as any).simulateOracleRoute = async (calldata: string, overrides: any) => {
        simulations.push({ calldata, overrides });
        return simulation;
    };
    (token as any).oracleRoute = async (calldata: string, overrides: any, receiver: address) => {
        submissions.push({ calldata, overrides, receiver });
        return { hash: "0xsubmit" };
    };

    return {
        token,
        dexAgg: dex.dexAgg,
        dexCalls: dex.calls,
        dexBuildCalls: dex.buildCalls,
        debtReads,
        approvals,
        simulations,
        submissions,
        setTimestamp: (value: bigint) => { chainTimestamp = value; },
        setProjectedDebt: (value: bigint) => { currentProjectedDebt = value; },
        setAllowance: (value: bigint) => { currentAllowance = value; },
        setSimulation: (value: { success: boolean; error?: string }) => { simulation = value; },
    };
}

function mutablePlan(plan: RepayWithSwapPlan): RepayWithSwapPlan {
    return { ...plan, swapAction: { ...plan.swapAction } };
}

describe("BorrowableCToken repay-with-swap planning", () => {
    test("exact-input plan exposes guaranteed repayment and expected repayment separately", async () => {
        const harness = createBorrowableHarness();
        const plan = await harness.token.quoteRepayWithSwap(
            INPUT_TOKEN,
            Decimal(10),
            Decimal("0.005"),
            { receiver: RECEIVER },
        );

        assert.equal(plan.mode, "exact-input");
        assert.equal(plan.payer, PAYER);
        assert.equal(plan.receiver, RECEIVER);
        assert.equal(plan.inputAmount, 10n);
        assert.equal(plan.minimumOutput, 18n);
        assert.equal(plan.expectedOutput, 20n);
        assert.equal(plan.repayAssets, 18n);
        assert.equal(plan.projectedDebt, 1_000n);
        assert.equal(plan.quotedAt, 1_700_000_000n);
        assert.equal(plan.validUntil, 1_700_000_100n);
        assert.equal(plan.debtProjectionUntil, plan.validUntil);
        assert.equal(plan.routeQuotedAt, 1_700_000_000n);
        assert.equal(plan.routeValidUntil, 1_700_000_010n);
        assert.equal(plan.routeMinSubmitWindowSeconds, 2n);
        assert.equal(plan.slippageBps, 50n);
        assert.equal(plan.contractSlippage, toContractSwapSlippage(50n, 4n));
        assert.equal(plan.value, 0n);
        assert.equal(Object.isFrozen(plan), true);
    });

    test("starts route freshness after slow route construction completes", async () => {
        const harness = createBorrowableHarness();
        const prepareQuote = harness.dexAgg.prepareQuote.bind(harness.dexAgg);
        harness.dexAgg.prepareQuote = async (...args: any[]) => {
            const prepared = await (prepareQuote as any)(...args);
            const build = prepared.build.bind(prepared);
            return {
                ...prepared,
                build: async (...buildArgs: any[]) => {
                    harness.setTimestamp(1_700_000_009n);
                    return (build as any)(...buildArgs);
                },
            };
        };

        const plan = await harness.token.quoteRepayWithSwap(
            INPUT_TOKEN,
            Decimal(10),
            Decimal("0.005"),
        );

        assert.equal(plan.routeQuotedAt, 1_700_000_009n);
        assert.equal(plan.routeValidUntil, plan.routeQuotedAt + 10n);
        const simulation = await harness.token.simulateRepayWithSwap(plan);
        assert.equal(simulation.success, true);
    });

    test("repay-all projects to deadline, buffers debt, and rescales until min output covers it", async () => {
        const harness = createBorrowableHarness();
        const plan = await harness.token.quoteRepayAllWithSwap(
            INPUT_TOKEN,
            Decimal("0.005"),
            { receiver: RECEIVER },
        );

        assert.equal(plan.mode, "repay-all");
        assert.equal(plan.projectedDebt, 1_000n);
        assert.equal(plan.repayAssets, 1_002n);
        assert.ok(plan.minimumOutput >= plan.repayAssets);
        assert.equal(plan.inputAmount, 558n);
        assert.equal(plan.minimumOutput, 1_004n);
        assert.equal(plan.quoteIterations, 2);
        assert.deepEqual(harness.dexCalls.map((call) => call.amount), [501n, 558n]);
        assert.deepEqual(harness.dexBuildCalls.map((call) => call.amount), [558n]);
        assert.deepEqual(harness.debtReads, [{
            receiver: RECEIVER,
            timestamp: 1_700_000_100n,
        }]);
    });

    test("repay-all accepts an explicit initial estimate when oracle sizing is unavailable", async () => {
        const harness = createBorrowableHarness();
        (harness.token as any).market.oracle_manager.getPrice = async () => {
            throw new Error("oracle should not be called");
        };

        const plan = await harness.token.quoteRepayAllWithSwap(
            INPUT_TOKEN,
            Decimal("0.005"),
            { initialInputAmount: Decimal(600) },
        );

        assert.ok(plan.minimumOutput >= plan.repayAssets);
        assert.equal(harness.dexCalls[0]?.amount, 600n);
    });

    test("same-debt-token repay-all is a one-quote no-op and still includes interest margin", async () => {
        const harness = createBorrowableHarness();
        const plan = await harness.token.quoteRepayAllWithSwap(
            DEBT_TOKEN,
            Decimal("0.01"),
        );

        assert.equal(harness.dexCalls.length, 0);
        assert.equal(plan.inputAmount, 1_002n);
        assert.equal(plan.minimumOutput, 1_002n);
        assert.equal(plan.swapAction.target, "0x0000000000000000000000000000000000000000");
        assert.equal(plan.quoteIterations, 1);
    });

    test("native repay-all requires no approval and carries exact msg.value", async () => {
        const harness = createBorrowableHarness();
        const plan = await harness.token.quoteRepayAllWithSwap(
            NATIVE_ADDRESS,
            Decimal("0.005"),
            { initialInputAmount: Decimal(600) },
        );

        assert.equal(plan.inputDecimals, 18n);
        assert.equal(plan.value, plan.inputAmount);
        assert.equal(await harness.token.isRepayAllWithSwapApproved(plan), true);
        assert.equal(await harness.token.approveRepayAllWithSwap(plan), undefined);
        assert.equal(harness.approvals.length, 0);
    });

    test("rejects exact-input amounts that are negative, zero, or truncate to zero", async () => {
        for (const inputAmount of [Decimal(-1), Decimal(0), Decimal("0.9")]) {
            const harness = createBorrowableHarness();
            await assert.rejects(
                () => harness.token.quoteRepayWithSwap(
                    INPUT_TOKEN,
                    inputAmount,
                    Decimal("0.005"),
                ),
                /input amount must be greater than zero/i,
            );
            assert.equal(harness.dexCalls.length, 0);
        }
    });

    test("rejects repay-all initial inputs that are negative, zero, or truncate to zero", async () => {
        for (const initialInputAmount of [Decimal(-1), Decimal(0), Decimal("0.9")]) {
            const harness = createBorrowableHarness();
            await assert.rejects(
                () => harness.token.quoteRepayAllWithSwap(
                    INPUT_TOKEN,
                    Decimal("0.005"),
                    { initialInputAmount },
                ),
                /initial input amount must be greater than zero/i,
            );
            assert.equal(harness.dexCalls.length, 0);
        }
    });

    test("enforces validity and minimum-submit-window boundaries", async () => {
        for (const validForSeconds of [0n, REPAY_WITH_SWAP.MAX_VALID_FOR_SECONDS + 1n]) {
            const harness = createBorrowableHarness();
            await assert.rejects(
                () => harness.token.quoteRepayWithSwap(
                    INPUT_TOKEN,
                    Decimal(10),
                    Decimal("0.005"),
                    { validForSeconds },
                ),
                /validity must be/i,
            );
        }

        for (const minSubmitWindowSeconds of [-1n, 100n]) {
            const harness = createBorrowableHarness();
            await assert.rejects(
                () => harness.token.quoteRepayWithSwap(
                    INPUT_TOKEN,
                    Decimal(10),
                    Decimal("0.005"),
                    { validForSeconds: 100n, minSubmitWindowSeconds },
                ),
                /minimum submit window must be non-negative and shorter than validity/i,
            );
        }

        const boundary = createBorrowableHarness();
        const plan = await boundary.token.quoteRepayAllWithSwap(
            INPUT_TOKEN,
            Decimal("0.005"),
            {
                validForSeconds: REPAY_WITH_SWAP.MAX_VALID_FOR_SECONDS,
                minSubmitWindowSeconds: 0n,
                debtBufferBps: 9_999n,
                maxQuoteIterations: REPAY_WITH_SWAP.MAX_QUOTE_ITERATIONS,
            },
        );
        assert.equal(
            plan.validUntil - plan.quotedAt,
            REPAY_WITH_SWAP.MAX_VALID_FOR_SECONDS,
        );
        assert.equal(plan.minSubmitWindowSeconds, 0n);
        assert.equal(plan.repayAssets, 2_001n);
    });

    test("rejects fractional, zero, negative, and excessive quote-iteration limits", async () => {
        for (const maxQuoteIterations of [-1, 0, 1.5, REPAY_WITH_SWAP.MAX_QUOTE_ITERATIONS + 1]) {
            const harness = createBorrowableHarness();
            await assert.rejects(
                () => harness.token.quoteRepayAllWithSwap(
                    INPUT_TOKEN,
                    Decimal("0.005"),
                    { maxQuoteIterations },
                ),
                /maxQuoteIterations must be an integer/i,
            );
        }
    });

    test("rejects non-positive input and debt oracle prices during repay-all sizing", async () => {
        const zeroInput = createBorrowableHarness();
        (zeroInput.token as any).market.oracle_manager.getPrice = async (asset: address) => (
            asset.toLowerCase() === INPUT_TOKEN.toLowerCase() ? 0n : 2n
        );
        await assert.rejects(
            () => zeroInput.token.quoteRepayAllWithSwap(INPUT_TOKEN, Decimal("0.005")),
            /non-positive oracle prices \(input=0, debt=2\)/i,
        );

        const zeroDebt = createBorrowableHarness();
        (zeroDebt.token as any).market.oracle_manager.getPrice = async (asset: address) => (
            asset.toLowerCase() === INPUT_TOKEN.toLowerCase() ? 4n : 0n
        );
        await assert.rejects(
            () => zeroDebt.token.quoteRepayAllWithSwap(INPUT_TOKEN, Decimal("0.005")),
            /non-positive oracle prices \(input=4, debt=0\)/i,
        );
    });

    test("applies the one-base-unit repay-all margin even with a zero BPS buffer", async () => {
        const harness = createBorrowableHarness({ projectedDebt: 1n });
        const plan = await harness.token.quoteRepayAllWithSwap(
            DEBT_TOKEN,
            Decimal(0),
            { debtBufferBps: 0n },
        );

        assert.equal(plan.projectedDebt, 1n);
        assert.equal(plan.repayAssets, 2n);
        assert.equal(plan.inputAmount, 2n);
    });

    test("accepts the first safe route and builds calldata once without optimizing downward", async () => {
        const harness = createBorrowableHarness({
            quoteFn: (amount) => amount >= 600n
                ? { min: 1_200n, out: 1_200n }
                : { min: 900n, out: 900n },
        });
        const plan = await harness.token.quoteRepayAllWithSwap(
            INPUT_TOKEN,
            Decimal("0.005"),
            { initialInputAmount: Decimal(600), maxQuoteIterations: 2 },
        );

        assert.equal(plan.inputAmount, 600n);
        assert.equal(plan.minimumOutput, 1_200n);
        assert.equal(plan.quoteIterations, 1);
        assert.deepEqual(harness.dexCalls.map((call) => call.amount), [600n]);
        assert.deepEqual(harness.dexBuildCalls.map((call) => call.amount), [600n]);
    });

    test("sizes a preview cushion before the single build to absorb small Kyber output drift", async () => {
        const harness = createBorrowableHarness({
            quoteFn: (amount) => amount === 600n
                ? { min: 1_002n, out: 1_010n }
                : { min: 1_004n, out: 1_012n },
            buildQuoteFn: () => ({ min: 1_002n, out: 1_010n }),
        });

        const plan = await harness.token.quoteRepayAllWithSwap(
            INPUT_TOKEN,
            Decimal("0.005"),
            { initialInputAmount: Decimal(600), maxQuoteIterations: 2 },
        );

        assert.equal(REPAY_WITH_SWAP.REPAY_ALL_ROUTE_BUILD_BUFFER_BPS, 1n);
        assert.equal(plan.repayAssets, 1_002n);
        assert.equal(plan.minimumOutput, 1_002n);
        assert.equal(plan.inputAmount, 601n);
        assert.deepEqual(harness.dexCalls.map((call) => call.amount), [600n, 601n]);
        assert.deepEqual(harness.dexBuildCalls.map((call) => call.amount), [601n]);
    });

    test("fails closed when the final calldata build falls below the repay-all floor", async () => {
        const harness = createBorrowableHarness({
            quoteFn: () => ({ min: 1_200n, out: 1_250n }),
            buildQuoteFn: () => ({ min: 900n, out: 950n }),
        });

        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { initialInputAmount: Decimal(600) },
            ),
            /built minimum output 900 no longer covers repay-all floor/i,
        );
        assert.equal(harness.dexCalls.length, 1);
        assert.equal(harness.dexBuildCalls.length, 1);
    });

    test("enforces one hard planning deadline across a hanging route request", async () => {
        const harness = createBorrowableHarness();
        (harness.dexAgg as any).prepareQuote = async (...args: any[]) => {
            const options = args[7] as { signal: AbortSignal };
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            });
        };

        const startedAt = Date.now();
        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { initialInputAmount: Decimal(600), planningTimeoutMs: 20 },
            ),
            (error: unknown) => error instanceof DexQuoteError && error.code === "timeout",
        );
        assert.ok(Date.now() - startedAt < 500);
    });

    test("enforces the same hard deadline when GET succeeds but calldata build hangs", async () => {
        const harness = createBorrowableHarness();
        let buildCalls = 0;
        (harness.dexAgg as any).prepareQuote = async () => ({
            min_out: 1_200n,
            out: 1_250n,
            build: async ({ signal }: { signal: AbortSignal }) => {
                buildCalls++;
                return new Promise((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            },
        });

        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { initialInputAmount: Decimal(600), planningTimeoutMs: 20 },
            ),
            (error: unknown) => error instanceof DexQuoteError && error.code === "timeout",
        );
        assert.equal(buildCalls, 1);
    });

    test("does not reset the global deadline between repay-all sizing iterations", async () => {
        const harness = createBorrowableHarness();
        let previews = 0;
        (harness.dexAgg as any).prepareQuote = async (...args: any[]) => {
            previews++;
            if (previews === 1) {
                return {
                    min_out: 500n,
                    out: 550n,
                    build: async () => { throw new Error("under-floor preview must not build"); },
                };
            }
            const signal = (args[7] as { signal: AbortSignal }).signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        };

        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { initialInputAmount: Decimal(600), planningTimeoutMs: 20 },
            ),
            (error: unknown) => error instanceof DexQuoteError && error.code === "timeout",
        );
        assert.equal(previews, 2);
    });

    test("propagates caller cancellation through the whole repay-all solver", async () => {
        const harness = createBorrowableHarness();
        let receivedSignal: AbortSignal | undefined;
        let markRouteStarted: (() => void) | undefined;
        const routeStarted = new Promise<void>((resolve) => { markRouteStarted = resolve; });
        (harness.dexAgg as any).prepareQuote = async (...args: any[]) => {
            receivedSignal = (args[7] as { signal: AbortSignal }).signal;
            markRouteStarted?.();
            return new Promise((_resolve, reject) => {
                receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), { once: true });
            });
        };
        const controller = new AbortController();
        const planning = harness.token.quoteRepayAllWithSwap(
            INPUT_TOKEN,
            Decimal("0.005"),
            { initialInputAmount: Decimal(600), signal: controller.signal },
        );
        await routeStarted;
        controller.abort("superseded");

        await assert.rejects(
            () => planning,
            (error: unknown) => error instanceof DexQuoteError && error.code === "aborted",
        );
        assert.equal(receivedSignal?.aborted, true);
    });

    test("fails closed when positive quotes never cover the repay-all floor", async () => {
        const harness = createBorrowableHarness({
            quoteFn: () => ({ min: 1n, out: 1n }),
        });

        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { initialInputAmount: Decimal(1), maxQuoteIterations: 2 },
            ),
            /Could not find a repay-all swap.*within 2 quotes/i,
        );
        assert.equal(harness.dexCalls.length, 2);
        assert.equal(harness.dexBuildCalls.length, 0);
    });

    test("uses no more than three sizing previews by default", async () => {
        const harness = createBorrowableHarness({ quoteFn: () => ({ min: 1n, out: 1n }) });

        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { initialInputAmount: Decimal(1) },
            ),
            /within 3 quotes/i,
        );
        assert.equal(REPAY_WITH_SWAP.DEFAULT_MAX_QUOTE_ITERATIONS, 3);
        assert.equal(harness.dexCalls.length, 3);
        assert.equal(harness.dexBuildCalls.length, 0);
    });

    test("fails clearly when chain time, a Simple Zapper, or outstanding debt is unavailable", async () => {
        const noBlock = createBorrowableHarness();
        (noBlock.token as any).provider.getBlock = async () => null;
        await assert.rejects(
            () => noBlock.token.quoteRepayWithSwap(
                INPUT_TOKEN,
                Decimal(10),
                Decimal("0.005"),
            ),
            /Could not read the latest block/i,
        );

        const noZapper = createBorrowableHarness();
        (noZapper.token as any).getZapper = () => null;
        await assert.rejects(
            () => noZapper.token.quoteRepayWithSwap(
                INPUT_TOKEN,
                Decimal(10),
                Decimal("0.005"),
            ),
            /Simple Zapper is not configured/i,
        );

        const noDebt = createBorrowableHarness({ projectedDebt: 0n });
        await assert.rejects(
            () => noDebt.token.quoteRepayWithSwap(
                INPUT_TOKEN,
                Decimal(10),
                Decimal("0.005"),
            ),
            /no outstanding cDEBT debt/i,
        );
    });

    test("planning rejects no debt, invalid validity, invalid buffers, and unsolved routes", async () => {
        const noDebt = createBorrowableHarness({ projectedDebt: 0n });
        await assert.rejects(
            () => noDebt.token.quoteRepayAllWithSwap(INPUT_TOKEN, Decimal("0.005")),
            /no outstanding cDEBT debt/i,
        );

        const harness = createBorrowableHarness({ quoteFn: () => ({ min: 0n, out: 0n }) });
        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { validForSeconds: REPAY_WITH_SWAP.MAX_VALID_FOR_SECONDS + 1n },
            ),
            /validity must be/i,
        );
        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { debtBufferBps: 10_000n },
            ),
            /debt buffer must be/i,
        );
        await assert.rejects(
            () => harness.token.quoteRepayAllWithSwap(
                INPUT_TOKEN,
                Decimal("0.005"),
                { initialInputAmount: Decimal(1), maxQuoteIterations: 1 },
            ),
            /zero guaranteed output/i,
        );
    });
});

describe("BorrowableCToken repay-with-swap execution", () => {
    async function buildPlan(harness: BorrowableHarness) {
        return harness.token.quoteRepayAllWithSwap(
            INPUT_TOKEN,
            Decimal("0.005"),
        );
    }

    const bindingMutationCases: Array<{
        name: string;
        mutate: (plan: RepayWithSwapPlan) => RepayWithSwapPlan;
        pattern: RegExp;
    }> = [
        {
            name: "an invalid plan discriminator",
            mutate: (plan) => ({ ...mutablePlan(plan), kind: "other-plan" as any }),
            pattern: /Invalid zap repay plan kind/i,
        },
        {
            name: "a foreign debt token",
            mutate: (plan) => ({ ...mutablePlan(plan), debtToken: INPUT_TOKEN }),
            pattern: /targets debt asset/i,
        },
        {
            name: "a foreign Simple Zapper",
            mutate: (plan) => ({ ...mutablePlan(plan), zapper: ROUTER }),
            pattern: /does not match the configured Simple Zapper/i,
        },
        {
            name: "a zero input amount",
            mutate: (plan) => ({ ...mutablePlan(plan), inputAmount: 0n }),
            pattern: /plan amounts must be positive/i,
        },
        {
            name: "a zero repayment floor",
            mutate: (plan) => ({ ...mutablePlan(plan), repayAssets: 0n }),
            pattern: /plan amounts must be positive/i,
        },
        {
            name: "minimum output below the repayment floor",
            mutate: (plan) => ({ ...mutablePlan(plan), minimumOutput: plan.repayAssets - 1n }),
            pattern: /minimum output .* does not cover/i,
        },
        {
            name: "expected output below minimum output",
            mutate: (plan) => ({ ...mutablePlan(plan), expectedOutput: plan.minimumOutput - 1n }),
            pattern: /expected output .* is below minimum/i,
        },
        {
            name: "a zero projected debt",
            mutate: (plan) => ({ ...mutablePlan(plan), projectedDebt: 0n }),
            pattern: /invalid debt projection or timing bounds/i,
        },
        {
            name: "a non-positive quote lifetime",
            mutate: (plan) => ({ ...mutablePlan(plan), quotedAt: plan.validUntil }),
            pattern: /invalid debt projection or timing bounds/i,
        },
        {
            name: "a negative minimum submit window",
            mutate: (plan) => ({ ...mutablePlan(plan), minSubmitWindowSeconds: -1n }),
            pattern: /invalid debt projection or timing bounds/i,
        },
        {
            name: "a minimum submit window equal to quote lifetime",
            mutate: (plan) => ({
                ...mutablePlan(plan),
                minSubmitWindowSeconds: plan.validUntil - plan.quotedAt,
            }),
            pattern: /invalid debt projection or timing bounds/i,
        },
        {
            name: "a repay-all floor that does not exceed projected debt",
            mutate: (plan) => ({ ...mutablePlan(plan), repayAssets: plan.projectedDebt }),
            pattern: /floor must exceed its projected debt/i,
        },
        {
            name: "a mutated swap-action input token",
            mutate: (plan) => ({
                ...mutablePlan(plan),
                swapAction: { ...plan.swapAction, inputToken: DEBT_TOKEN },
            }),
            pattern: /swap action does not match/i,
        },
        {
            name: "a mutated swap-action output token",
            mutate: (plan) => ({
                ...mutablePlan(plan),
                swapAction: { ...plan.swapAction, outputToken: INPUT_TOKEN },
            }),
            pattern: /swap action does not match/i,
        },
        {
            name: "mutated contract slippage",
            mutate: (plan) => ({
                ...mutablePlan(plan),
                swapAction: { ...plan.swapAction, slippage: plan.contractSlippage + 1n },
            }),
            pattern: /swap action does not match/i,
        },
        {
            name: "a swap input inconsistent with native wrapping rules",
            mutate: (plan) => ({ ...mutablePlan(plan), swapInputToken: DEBT_TOKEN }),
            pattern: /swap input does not match native wrapping rules/i,
        },
        {
            name: "unexpected native value on an ERC20 plan",
            mutate: (plan) => ({ ...mutablePlan(plan), value: 1n }),
            pattern: /native value .* does not match 0/i,
        },
    ];

    for (const edgeCase of bindingMutationCases) {
        test(`rejects ${edgeCase.name}`, async () => {
            const harness = createBorrowableHarness();
            const plan = await buildPlan(harness);

            await assert.rejects(
                () => harness.token.isRepayWithSwapApproved(edgeCase.mutate(plan)),
                edgeCase.pattern,
            );
        });
    }

    test("approval helpers check raw allowance and approve the exact planned input by default", async () => {
        const harness = createBorrowableHarness({ allowance: 0n });
        const plan = await buildPlan(harness);

        assert.equal(await harness.token.isRepayAllWithSwapApproved(plan), false);
        await harness.token.approveRepayAllWithSwap(plan);
        assert.equal(harness.approvals.length, 1);
        assert.equal(harness.approvals[0]?.spender, ZAPPER);
        assert.equal(harness.approvals[0]?.amount?.toString(), plan.inputAmount.toString());

        await harness.token.approveRepayAllWithSwap(plan, null);
        assert.equal(harness.approvals[1]?.amount, null);
    });

    test("treats exact allowance as approved and one unit less as unapproved", async () => {
        const harness = createBorrowableHarness({ allowance: 0n });
        const plan = await buildPlan(harness);

        harness.setAllowance(plan.inputAmount - 1n);
        assert.equal(await harness.token.isRepayAllWithSwapApproved(plan), false);
        harness.setAllowance(plan.inputAmount);
        assert.equal(await harness.token.isRepayAllWithSwapApproved(plan), true);
    });

    test("all-only helpers reject an exact-input plan", async () => {
        const harness = createBorrowableHarness();
        const plan = await harness.token.quoteRepayWithSwap(
            INPUT_TOKEN,
            Decimal(10),
            Decimal("0.005"),
        );

        await assert.rejects(
            () => harness.token.isRepayAllWithSwapApproved(plan),
            /Expected a repay-all swap plan, got exact-input/i,
        );
        await assert.rejects(
            () => harness.token.approveRepayAllWithSwap(plan),
            /Expected a repay-all swap plan, got exact-input/i,
        );
        await assert.rejects(
            () => harness.token.simulateRepayAllWithSwap(plan),
            /Expected a repay-all swap plan, got exact-input/i,
        );
        await assert.rejects(
            () => harness.token.repayAllWithSwap(plan),
            /Expected a repay-all swap plan, got exact-input/i,
        );
    });

    test("preflight rejects missing allowance without simulation or submission", async () => {
        const harness = createBorrowableHarness({ allowance: 0n });
        const plan = await buildPlan(harness);
        const result = await harness.token.simulateRepayAllWithSwap(plan);

        assert.equal(result.success, false);
        assert.match(result.error ?? "", /Please approve input token/i);
        assert.equal(harness.simulations.length, 0);
        assert.equal(harness.submissions.length, 0);
    });

    test("preflight rejects expired plans and debt growth beyond the buffered floor", async () => {
        const expiredHarness = createBorrowableHarness();
        const expiredPlan = await buildPlan(expiredHarness);
        expiredHarness.setTimestamp(expiredPlan.validUntil - expiredPlan.minSubmitWindowSeconds + 1n);
        const expired = await expiredHarness.token.simulateRepayAllWithSwap(expiredPlan);
        assert.equal(expired.success, false);
        assert.match(expired.error ?? "", /expired or too close to expiry/i);

        const growthHarness = createBorrowableHarness();
        const growthPlan = await buildPlan(growthHarness);
        growthHarness.setProjectedDebt(growthPlan.repayAssets + 1n);
        const growth = await growthHarness.token.simulateRepayAllWithSwap(growthPlan);
        assert.equal(growth.success, false);
        assert.match(growth.error ?? "", /Projected debt increased.*re-quote/i);
    });

    test("accepts the exact route expiry-window, debt-floor, and allowance boundaries", async () => {
        const harness = createBorrowableHarness({ allowance: 0n });
        const plan = await buildPlan(harness);
        harness.setAllowance(plan.inputAmount);
        harness.setTimestamp(plan.routeValidUntil - plan.routeMinSubmitWindowSeconds);
        harness.setProjectedDebt(plan.repayAssets);

        const result = await harness.token.simulateRepayAllWithSwap(plan);
        assert.deepEqual(result, { success: true });
        assert.equal(harness.simulations.length, 1);
    });

    test("fails preflight when the debt was repaid elsewhere after quoting", async () => {
        const harness = createBorrowableHarness();
        const plan = await buildPlan(harness);
        harness.setProjectedDebt(0n);

        const result = await harness.token.simulateRepayAllWithSwap(plan);
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /no outstanding cDEBT debt/i);
        assert.equal(harness.simulations.length, 0);
    });

    test("execution rejects plans bound to another token, payer, or mutated swap action", async () => {
        const harness = createBorrowableHarness();
        const plan = await buildPlan(harness);

        await assert.rejects(
            () => harness.token.repayAllWithSwap({
                ...mutablePlan(plan),
                borrowableCToken: "0x0000000000000000000000000000000000000999" as address,
            }),
            /targets cToken/i,
        );
        await assert.rejects(
            () => harness.token.repayAllWithSwap({
                ...mutablePlan(plan),
                payer: RECEIVER,
            }),
            /does not match signer/i,
        );
        await assert.rejects(
            () => harness.token.repayAllWithSwap({
                ...mutablePlan(plan),
                swapAction: { ...plan.swapAction, inputAmount: plan.inputAmount + 1n },
            }),
            /swap action does not match/i,
        );
        await assert.rejects(
            () => harness.token.repayAllWithSwap({
                ...mutablePlan(plan),
                calldata: "0x1234",
            }),
            /calldata is not swapAndRepay/i,
        );
    });

    test("rejects valid swapAndRepay calldata whose decoded fields differ from the plan", async () => {
        const harness = createBorrowableHarness();
        const plan = await buildPlan(harness);
        const zapper = (harness.token as any).getZapper("simple") as Zapper;
        const mismatchedCalldata = zapper.contract.interface.encodeFunctionData("swapAndRepay", [
            plan.borrowableCToken,
            false,
            plan.swapAction,
            plan.repayAssets,
            RECEIVER,
        ]);

        await assert.rejects(
            () => harness.token.repayAllWithSwap({
                ...mutablePlan(plan),
                calldata: mismatchedCalldata as `0x${string}`,
            }),
            /calldata does not match its declared transaction fields/i,
        );
    });

    test("failed simulation prevents broadcast; successful execution simulates then submits", async () => {
        const failed = createBorrowableHarness();
        const failedPlan = await buildPlan(failed);
        failed.setSimulation({ success: false, error: "contract reverted" });
        await assert.rejects(
            () => failed.token.repayAllWithSwap(failedPlan),
            /Zap repay simulation failed: contract reverted/i,
        );
        assert.equal(failed.submissions.length, 0);

        const success = createBorrowableHarness();
        const successPlan = await buildPlan(success);
        const tx = await success.token.repayAllWithSwap(successPlan);
        assert.deepEqual(tx, { hash: "0xsubmit" });
        assert.equal(success.simulations.length, 1);
        assert.equal(success.submissions.length, 1);
        assert.deepEqual(success.submissions[0]?.overrides, { to: ZAPPER });
        assert.equal(success.submissions[0]?.receiver, PAYER);
    });

    test("simulation helpers convert an asynchronous simulation throw into a failed result", async () => {
        const harness = createBorrowableHarness();
        const plan = await buildPlan(harness);
        (harness.token as any).simulateOracleRoute = async () => {
            const error = new Error("raw simulation error") as Error & { reason?: string };
            error.reason = "decoded simulation reason";
            throw error;
        };

        const result = await harness.token.simulateRepayAllWithSwap(plan);
        assert.deepEqual(result, {
            success: false,
            error: "decoded simulation reason",
        });
    });

    test("execution reports a simulation failure even when no error string is supplied", async () => {
        const harness = createBorrowableHarness();
        const plan = await buildPlan(harness);
        harness.setSimulation({ success: false });

        await assert.rejects(
            () => harness.token.repayAllWithSwap(plan),
            /Zap repay simulation failed\.$/i,
        );
        assert.equal(harness.submissions.length, 0);
    });

    test("native preflight and execution forward exactly the planned msg.value", async () => {
        const harness = createBorrowableHarness();
        const plan = await harness.token.quoteRepayAllWithSwap(
            NATIVE_ADDRESS,
            Decimal("0.005"),
            { initialInputAmount: Decimal(600) },
        );

        const simulation = await harness.token.simulateRepayAllWithSwap(plan);
        assert.deepEqual(simulation, { success: true });
        assert.deepEqual(harness.simulations[0]?.overrides, {
            value: plan.inputAmount,
            to: ZAPPER,
        });

        await harness.token.repayAllWithSwap(plan);
        assert.deepEqual(harness.submissions[0]?.overrides, {
            value: plan.inputAmount,
            to: ZAPPER,
        });
    });

    test("exact-input execution does not apply repay-all debt-growth rejection", async () => {
        const harness = createBorrowableHarness();
        const plan = await harness.token.quoteRepayWithSwap(
            INPUT_TOKEN,
            Decimal(10),
            Decimal("0.005"),
        );
        harness.setProjectedDebt(2_000n);

        const result = await harness.token.simulateRepayWithSwap(plan);
        assert.equal(result.success, true);
        assert.equal(harness.simulations.length, 1);
    });
});
