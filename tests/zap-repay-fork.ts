import { config } from "dotenv";
config({ quiet: true });

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import Decimal from "decimal.js";
import { Wallet } from "ethers";
import {
    configureRetries,
    DEFAULT_RETRY_CONFIG,
    NATIVE_ADDRESS,
    type BorrowableCToken,
    type Market,
} from "../src";
import { TestFramework } from "./utils/TestFramework";
import { fastForwardTime } from "./utils/helper";

const HAS_FORK_ENV = Boolean(process.env.TEST_RPC);
const FORK_SKIP = HAS_FORK_ENV
    ? undefined
    : "Fork env not configured: set TEST_RPC to an Anvil-compatible Monad fork.";
const TEST_PRIVATE_KEY = Wallet.createRandom().privateKey;
const TEST_API_URL = process.env.TEST_API_URL ?? "https://api.curvance.com";
const COLLATERAL_AMOUNT = Decimal(100_000);
const BORROW_AMOUNT = Decimal(500);
const SEEDED_TOKEN_UNITS = 1_000_000n;

async function waitFor(txLike: unknown) {
    if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === "function") {
        await (txLike as { wait: () => Promise<unknown> }).wait();
    }
}

describe("Zap repay on Monad fork", { skip: FORK_SKIP }, () => {
    let framework: TestFramework;

    before(async () => {
        // Cold fork reads can take longer than the production timeout while
        // Anvil hydrates remote storage. Keep mutable fork reads local so
        // simulations never observe a different remote head than writes.
        configureRetries({ timeoutMs: 30_000 });
        framework = await TestFramework.init(TEST_PRIVATE_KEY, "monad-mainnet", {
            seedNativeBalance: true,
            seedUnderlying: false,
            snapshot: true,
            log: false,
            apiUrl: TEST_API_URL,
        });
    });

    after(async () => {
        await framework.destroy();
        configureRetries({ timeoutMs: DEFAULT_RETRY_CONFIG.timeoutMs });
    });

    afterEach(async () => {
        await framework.reset();
    });

    async function openUsdcDebt(): Promise<{
        market: Market;
        cWMON: BorrowableCToken;
        cUSDC: BorrowableCToken;
    }> {
        const market = framework.curvance.markets.find((candidate) => {
            const symbols = new Set(candidate.tokens.map((token) => token.getAsset(true).symbol));
            return symbols.has("WMON") && symbols.has("USDC");
        });
        assert.ok(market, "Expected a live market containing WMON and USDC");

        const cWMON = market.tokens.find(
            (token) => token.getAsset(true).symbol === "WMON",
        ) as BorrowableCToken | undefined;
        const cUSDC = market.tokens.find(
            (token) => token.getAsset(true).symbol === "USDC",
        ) as BorrowableCToken | undefined;
        assert.ok(cWMON, "Expected WMON borrowable token in the live market");
        assert.ok(cUSDC, "Expected USDC borrowable token in the live market");

        const collateralAsset = cWMON.getAsset(true);
        const debtAsset = cUSDC.getAsset(true);
        await framework.setERC20Balance(
            collateralAsset.address,
            framework.account,
            SEEDED_TOKEN_UNITS * 10n ** (collateralAsset.decimals ?? 18n),
            3,
        );
        await framework.setERC20Balance(
            debtAsset.address,
            framework.account,
            SEEDED_TOKEN_UNITS * 10n ** (debtAsset.decimals ?? 6n),
            9,
        );

        const availableCollateral = await collateralAsset.balanceOf(framework.account, true);
        assert.ok(
            availableCollateral.gte(COLLATERAL_AMOUNT),
            `Fork account needs at least ${COLLATERAL_AMOUNT} WMON, got ${availableCollateral}`,
        );

        await waitFor(await cWMON.approveUnderlying(COLLATERAL_AMOUNT));
        await cWMON.depositAsCollateral(COLLATERAL_AMOUNT);
        const maxBorrowable = await cUSDC.getMaxBorrowable();
        assert.ok(
            maxBorrowable.gte(BORROW_AMOUNT),
            `Expected at least ${BORROW_AMOUNT} USDC borrow capacity, got ${maxBorrowable}`,
        );
        await waitFor(await cUSDC.borrow(BORROW_AMOUNT));
        await framework.skipMarketCooldown(market.address);

        const debt = await cUSDC.debtBalance(framework.account);
        assert.ok(debt > 0n, "Expected live USDC debt after borrow");
        return { market, cWMON, cUSDC };
    }

    test("same-token repay-all projects interest, simulates, executes, and refunds excess", async () => {
        const { cUSDC } = await openUsdcDebt();
        const debtBefore = await cUSDC.debtBalance(framework.account);
        const debtAsset = cUSDC.getAsset(true);
        const balanceBefore = await debtAsset.balanceOf(framework.account);

        const plan = await cUSDC.quoteRepayAllWithSwap(
            debtAsset.address,
            Decimal("0.005"),
            { validForSeconds: 180n },
        );

        assert.equal(plan.mode, "repay-all");
        assert.ok(plan.projectedDebt >= debtBefore, "Projected debt must include current debt");
        assert.ok(plan.repayAssets > plan.projectedDebt, "Repay-all floor must include debt margin");
        assert.equal(plan.minimumOutput, plan.inputAmount, "Same-token route should be a no-op");
        assert.equal(plan.quoteIterations, 1);

        await waitFor(await cUSDC.approveRepayAllWithSwap(plan));
        assert.equal(await cUSDC.isRepayAllWithSwapApproved(plan), true);
        const simulation = await cUSDC.simulateRepayAllWithSwap(plan);
        assert.deepEqual(simulation, { success: true });

        await cUSDC.repayAllWithSwap(plan);
        assert.equal(await cUSDC.debtBalance(framework.account), 0n);
        const balanceAfter = await debtAsset.balanceOf(framework.account);
        assert.ok(balanceAfter < balanceBefore, "Repayment should spend debt assets");
        assert.ok(
            balanceBefore - balanceAfter <= plan.inputAmount,
            "Excess same-token input should be refunded to the payer",
        );
    });

    test("ERC20 exact-input zap repayment spends the planned input and reduces live debt", async () => {
        const { cWMON, cUSDC } = await openUsdcDebt();
        const debtBefore = await cUSDC.debtBalance(framework.account);
        const inputAsset = cWMON.getAsset(true);
        const inputBalanceBefore = await inputAsset.balanceOf(framework.account);

        const plan = await cUSDC.quoteRepayWithSwap(
            inputAsset.address,
            Decimal(1),
            Decimal("0.01"),
            { validForSeconds: 180n },
        );

        assert.equal(plan.mode, "exact-input");
        assert.equal(plan.inputToken.toLowerCase(), inputAsset.address.toLowerCase());
        assert.ok(plan.minimumOutput > 0n, "Guaranteed debt output must be positive");
        assert.ok(plan.expectedOutput >= plan.minimumOutput);
        await waitFor(await cUSDC.approveRepayWithSwap(plan));
        assert.equal(await cUSDC.isRepayWithSwapApproved(plan), true);

        const simulation = await cUSDC.simulateRepayWithSwap(plan);
        assert.deepEqual(simulation, { success: true });
        await cUSDC.repayWithSwap(plan);

        const debtAfter = await cUSDC.debtBalance(framework.account);
        const inputBalanceAfter = await inputAsset.balanceOf(framework.account);
        assert.ok(debtAfter < debtBefore, "Exact-input zap should reduce live debt");
        assert.equal(
            inputBalanceBefore - inputBalanceAfter,
            plan.inputAmount,
            "Exact-input zap should spend the planned ERC20 amount",
        );
    });

    test("native-to-USDC repay-all survives interest accrual and clears debt through Kyber", async () => {
        const { cUSDC } = await openUsdcDebt();
        const debtBefore = await cUSDC.debtBalance(framework.account);

        const plan = await cUSDC.quoteRepayAllWithSwap(
            NATIVE_ADDRESS,
            Decimal("0.01"),
            {
                validForSeconds: 300n,
                debtBufferBps: 2n,
                maxQuoteIterations: 8,
            },
        );

        assert.equal(plan.inputToken.toLowerCase(), NATIVE_ADDRESS.toLowerCase());
        assert.ok(plan.projectedDebt >= debtBefore, "Projected debt must include current debt");
        assert.ok(plan.minimumOutput >= plan.repayAssets, "Guaranteed output must cover repay-all floor");
        assert.ok(plan.expectedOutput >= plan.minimumOutput, "Expected output must cover guaranteed output");
        assert.ok(plan.inputAmount > 0n, "Solver must produce positive native input");
        assert.equal(plan.value, plan.inputAmount);
        assert.equal(await cUSDC.isRepayAllWithSwapApproved(plan), true);

        await fastForwardTime(framework.provider, 30);
        const simulation = await cUSDC.simulateRepayAllWithSwap(plan);
        assert.deepEqual(simulation, { success: true });

        await cUSDC.repayAllWithSwap(plan);
        assert.equal(await cUSDC.debtBalance(framework.account), 0n);
    });
});
