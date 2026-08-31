import { config } from "dotenv";
config({ quiet: true });

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import Decimal from "decimal.js";
import { Wallet } from "ethers";
import {
    configureRetries,
    DEFAULT_RETRY_CONFIG,
    DexQuoteError,
    type BorrowableCToken,
    type RedeemAndSwapPlan,
    type RedeemSwapAndDepositPlan,
    type address,
} from "../src";
import { TestFramework } from "./utils/TestFramework";

const HAS_FORK_ENV = Boolean(process.env.TEST_RPC);
const FORK_SKIP = HAS_FORK_ENV
    ? undefined
    : "Fork env not configured: set TEST_RPC to an Anvil-compatible Monad fork.";
const TEST_PRIVATE_KEY = Wallet.createRandom().privateKey;
const TEST_API_URL = process.env.TEST_API_URL ?? "https://api2.curvance.com";
const SEEDED_WMON = 1_000n * 10n ** 18n;
const DEPOSIT_AMOUNT = new Decimal(10);
const SLIPPAGE = new Decimal("0.01");
const QUOTE_ATTEMPTS = 3;
const QUOTE_RETRY_DELAY_MS = 1_000;

async function waitFor(txLike: unknown) {
    if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === "function") {
        await (txLike as { wait: () => Promise<unknown> }).wait();
    }
}

async function quoteWithRetry<T>(quote: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt++) {
        try {
            return await quote();
        } catch (error) {
            lastError = error;
            if (
                !(error instanceof DexQuoteError) ||
                !error.retryable ||
                attempt === QUOTE_ATTEMPTS
            ) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, QUOTE_RETRY_DELAY_MS));
        }
    }
    throw lastError;
}

describe("SimpleZapper exits on Monad fork", { skip: FORK_SKIP }, () => {
    let framework: TestFramework;

    before(async () => {
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

    async function openWmonPosition(): Promise<{
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

        const wmon = cWMON.getAsset(true);
        await framework.setERC20Balance(wmon.address, framework.account, SEEDED_WMON, 3);
        await waitFor(await cWMON.approveUnderlying(DEPOSIT_AMOUNT));
        await cWMON.deposit(DEPOSIT_AMOUNT);
        await framework.skipMarketCooldown(market.address);

        const shares = await cWMON.balanceOf(framework.account);
        assert.ok(shares > 0n, "Expected source cWMON shares after deposit");
        return { cWMON, cUSDC };
    }

    async function assertFeeMovement(
        plan: RedeemAndSwapPlan | RedeemSwapAndDepositPlan,
        balancesBefore: { input: bigint; output: bigint } | null,
        balancesAfter: { input: bigint; output: bigint } | null,
    ) {
        if (!plan.feeReceiver) {
            assert.equal(plan.feeBps, 0n, "A positive fee must name its receiver");
            return;
        }
        assert.ok(balancesBefore && balancesAfter);
        if (plan.feeBps === 0n) {
            assert.deepEqual(balancesAfter, balancesBefore, "Fee-exempt routes must not move a fee");
            return;
        }
        assert.ok(
            balancesAfter.input > balancesBefore.input ||
                balancesAfter.output > balancesBefore.output,
            "A fee-bearing route must increase the fee receiver's input or output balance",
        );
    }

    test("MAX redeem-and-swap clears source shares, pays the wallet, moves fees, and leaves no residue", async () => {
        const { cWMON, cUSDC } = await openWmonPosition();
        const wmon = cWMON.getAsset(true);
        const usdc = cUSDC.getAsset(true);

        let plan = await quoteWithRetry(() => cWMON.quoteRedeemAndSwap(
            usdc.address,
            DEPOSIT_AMOUNT,
            SLIPPAGE,
            { redeemMax: true, validForSeconds: 300n },
        ));
        if (!(await cWMON.isRedeemAndSwapApproved(plan))) {
            await waitFor(await cWMON.approveRedeemAndSwap(plan));
        }
        plan = await quoteWithRetry(() => cWMON.refreshRedeemAndSwapPlan(plan));

        const sourceSharesBefore = await cWMON.balanceOf(framework.account);
        const walletOutputBefore = await usdc.balanceOf(framework.account);
        const zapperInputBefore = await wmon.balanceOf(plan.zapper);
        const zapperOutputBefore = await usdc.balanceOf(plan.zapper);
        const feeBefore = plan.feeReceiver
            ? {
                input: await wmon.balanceOf(plan.feeReceiver),
                output: await usdc.balanceOf(plan.feeReceiver),
            }
            : null;

        assert.equal(plan.sourceShares, sourceSharesBefore, "MAX must bind every executable share");
        const redeemCalldata = cWMON.getCallData("redeemFor", [
            plan.sourceShares,
            plan.zapper,
            framework.account,
        ]);
        const directRedeemResult = await framework.provider.call({
            from: plan.zapper,
            to: cWMON.address,
            data: redeemCalldata,
        });
        const [directRedeemAssets] = cWMON.contract.interface.decodeFunctionResult(
            "redeemFor",
            directRedeemResult,
        );
        assert.equal(
            plan.sourceAssets,
            directRedeemAssets,
            "Route input must equal the deployed redeemFor return value",
        );
        const simulation = await cWMON.simulateRedeemAndSwap(plan);
        assert.equal(
            simulation.success,
            true,
            `Exit simulation failed with sourceAssets=${plan.sourceAssets}, ` +
                `convertToAssets=${await cWMON.convertToAssets(plan.sourceShares)}, ` +
                `directRedeemAssets=${directRedeemAssets}, ` +
                `errorSelector=${simulation.error?.match(/data="(0x[0-9a-fA-F]{8})/)?.[1] ?? "unknown"}`,
        );
        await cWMON.redeemAndSwap(plan);

        const walletOutputAfter = await usdc.balanceOf(framework.account);
        const feeAfter = plan.feeReceiver
            ? {
                input: await wmon.balanceOf(plan.feeReceiver),
                output: await usdc.balanceOf(plan.feeReceiver),
            }
            : null;
        assert.equal(await cWMON.balanceOf(framework.account), 0n, "MAX must leave no source-share dust");
        assert.ok(
            walletOutputAfter - walletOutputBefore >= plan.minimumOutput,
            "Wallet output must satisfy the bound minimum",
        );
        assert.equal(await wmon.balanceOf(plan.zapper), zapperInputBefore, "Zapper must retain no WMON");
        assert.equal(await usdc.balanceOf(plan.zapper), zapperOutputBefore, "Zapper must retain no USDC");
        await assertFeeMovement(plan, feeBefore, feeAfter);
    });

    test("MAX move clears source shares and atomically posts destination collateral without wallet or zapper residue", async () => {
        const { cWMON, cUSDC } = await openWmonPosition();
        const wmon = cWMON.getAsset(true);
        const usdc = cUSDC.getAsset(true);

        let plan = await quoteWithRetry(() => cWMON.quoteRedeemSwapAndDeposit(
            cUSDC,
            DEPOSIT_AMOUNT,
            SLIPPAGE,
            true,
            { redeemMax: true, validForSeconds: 300n },
        ));
        if (!(await cWMON.isRedeemSwapAndDepositApproved(plan))) {
            await waitFor(await cWMON.approveRedeemSwapAndDeposit(plan));
        }
        if (!(await cWMON.isRedeemSwapAndDepositTargetApproved(plan))) {
            await waitFor(await cWMON.approveRedeemSwapAndDepositTarget(plan));
        }
        plan = await quoteWithRetry(() => cWMON.refreshRedeemSwapAndDepositPlan(plan));

        const sourceSharesBefore = await cWMON.balanceOf(framework.account);
        const destinationSharesBefore = await cUSDC.balanceOf(framework.account);
        const collateralBefore = await cUSDC.collateralPosted(framework.account);
        const walletOutputBefore = await usdc.balanceOf(framework.account);
        const zapperInputBefore = await wmon.balanceOf(plan.zapper);
        const zapperOutputBefore = await usdc.balanceOf(plan.zapper);
        const feeBefore = plan.feeReceiver
            ? {
                input: await wmon.balanceOf(plan.feeReceiver),
                output: await usdc.balanceOf(plan.feeReceiver),
            }
            : null;

        assert.equal(plan.sourceShares, sourceSharesBefore, "MAX must bind every executable share");
        const simulation = await cWMON.simulateRedeemSwapAndDeposit(plan);
        assert.equal(
            simulation.success,
            true,
            `Move simulation failed with sourceAssets=${plan.sourceAssets}, ` +
                `convertToAssets=${await cWMON.convertToAssets(plan.sourceShares)}: ` +
                `errorSelector=${simulation.error?.match(/data="(0x[0-9a-fA-F]{8})/)?.[1] ?? "unknown"}`,
        );
        await cWMON.redeemSwapAndDeposit(plan);

        const destinationSharesAfter = await cUSDC.balanceOf(framework.account);
        const collateralAfter = await cUSDC.collateralPosted(framework.account);
        const feeAfter = plan.feeReceiver
            ? {
                input: await wmon.balanceOf(plan.feeReceiver),
                output: await usdc.balanceOf(plan.feeReceiver),
            }
            : null;
        const destinationSharesReceived = destinationSharesAfter - destinationSharesBefore;
        assert.equal(await cWMON.balanceOf(framework.account), 0n, "MAX must leave no source-share dust");
        assert.ok(
            destinationSharesReceived >= plan.minimumDestinationShares,
            "Destination shares must satisfy the bound minimum",
        );
        assert.equal(
            collateralAfter - collateralBefore,
            destinationSharesReceived,
            "Every destination share must be posted as collateral",
        );
        assert.equal(
            await usdc.balanceOf(framework.account),
            walletOutputBefore,
            "Atomic move output must not pass through the wallet",
        );
        assert.equal(await wmon.balanceOf(plan.zapper), zapperInputBefore, "Zapper must retain no WMON");
        assert.equal(await usdc.balanceOf(plan.zapper), zapperOutputBefore, "Zapper must retain no USDC");
        await assertFeeMovement(plan, feeBefore, feeAfter);
    });
});
