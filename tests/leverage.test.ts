import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, afterEach, after } from 'node:test';
import { address } from '../src/types';
import Decimal from 'decimal.js';
import { TestFramework } from './utils/TestFramework';
import assert from 'node:assert';
import { FormatConverter } from '../src';

const FORK_SKIP = (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.TEST_RPC)
    ? 'Fork env not configured: set DEPLOYER_PRIVATE_KEY and TEST_RPC in .env. See tests/README.md.'
    : undefined;

describe('Leverage', { skip: FORK_SKIP }, () => {
    const SIMPLE_SLIPPAGE = Decimal(0.01);
    let account: address;
    let framework: TestFramework;

    before(async () => {
        framework = await TestFramework.init(process.env.DEPLOYER_PRIVATE_KEY as string, 'monad-mainnet', {
            seedNativeBalance: true,
            seedUnderlying: true,
            snapshot: true,
            log: true,
        });
        account = framework.account;
    })

    after(async () => {
        await framework.destroy();
    });

    afterEach(async () => {
        await framework.reset();
    });

    async function reloadUserState(market: { reloadUserData: (account: address) => Promise<unknown> }) {
        await market.reloadUserData(account);
    }

    async function settleWrite(
        market: { reloadUserData: (account: address) => Promise<unknown> },
        txLike: unknown,
    ) {
        if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === 'function') {
            await (txLike as { wait: () => Promise<unknown> }).wait();
        }

        await reloadUserState(market);
    }

    function computePostDepositBaseline(collateralUsd: Decimal, debtUsd: Decimal, depositUsd: Decimal) {
        const collateralAfterDeposit = collateralUsd.add(depositUsd);
        return collateralAfterDeposit.div(collateralAfterDeposit.sub(debtUsd));
    }

    function assertLeverageInRange(
        leverage: Decimal | null,
        min: Decimal,
        max: Decimal,
        label: string,
    ) {
        assert(leverage !== null, `${label}: expected leverage to be set`);
        assert(
            leverage!.gte(min) && leverage!.lte(max),
            `${label}: expected leverage ${leverage} to be between ${min} and ${max}`,
        );
    }

    function assertDecimalGt(actual: Decimal, expected: Decimal, label: string) {
        assert(
            actual.gt(expected),
            `${label}: expected ${actual.toString()} to be greater than ${expected.toString()}`,
        );
    }

    function assertDecimalLt(actual: Decimal, expected: Decimal, label: string) {
        assert(
            actual.lt(expected),
            `${label}: expected ${actual.toString()} to be less than ${expected.toString()}`,
        );
    }

    function assertDecimalClose(actual: Decimal, expected: Decimal, tolerance: Decimal, label: string) {
        const delta = actual.sub(expected).abs();
        assert(
            delta.lte(tolerance),
            `${label}: expected ${actual.toString()} to be within ${tolerance.toString()} of ${expected.toString()}`,
        );
    }

    test('Native vault deposit and leverage', async function() {
        const [ market, cshMON, cWMON ] = await framework.getMarket('shMON | WMON');

        await cWMON.approveUnderlying();
        await settleWrite(market, await cWMON.deposit(Decimal(5000))); // Seed borrow

        const depositAmount = Decimal(1_000);
        const collateralBefore = cshMON.getUserCollateral(true);
        const debtBefore = cWMON.getUserDebt(true);
        await cshMON.approvePlugin('native-vault', 'positionManager');
        await cshMON.approveUnderlying(depositAmount, cshMON.getPluginAddress('native-vault', 'positionManager'));
        await settleWrite(market, await cshMON.depositAndLeverage(depositAmount, cWMON, Decimal(3), 'native-vault', Decimal(0.01)));

        const leverage = cshMON.getLeverage();
        assertLeverageInRange(leverage, Decimal(2.4), Decimal(3.2), 'native-vault deposit+leverage');
        assertDecimalGt(cshMON.getUserCollateral(true), collateralBefore, 'native-vault collateral after deposit+leverage');
        assertDecimalGt(cWMON.getUserDebt(true), debtBefore, 'native-vault debt after deposit+leverage');
    });

    test('Native vault leverage up & down', async function() {
        const [ market, cshMON, cWMON ] = await framework.getMarket('shMON | WMON');

        await cWMON.approveUnderlying();
        await settleWrite(market, await cWMON.deposit(Decimal(5000))); // Seed borrow

        const depositAmount = Decimal(1_000);
        await cshMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cshMON.depositAsCollateral(depositAmount));
        await cshMON.approvePlugin('native-vault', 'positionManager');
        const debtBeforeUp = cWMON.getUserDebt(true);
        await settleWrite(market, await cshMON.leverageUp(cWMON, Decimal(3), 'native-vault', Decimal(0.01)));

        const leverageAfterUp = cshMON.getLeverage();
        assertLeverageInRange(leverageAfterUp, Decimal(2.4), Decimal(3.2), 'native-vault leverageUp');
        const debtAfterUp = cWMON.getUserDebt(true);
        assertDecimalGt(debtAfterUp, debtBeforeUp, 'native-vault debt after leverageUp');

        await framework.skipMarketCooldown(market.address);
        await cshMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cshMON.leverageDown(cWMON, leverageAfterUp!, Decimal(1.5), 'simple', Decimal(0.01)));

        const leverageAfterDown = cshMON.getLeverage();
        assertLeverageInRange(leverageAfterDown, Decimal(1.1), leverageAfterUp!, 'native-vault leverageDown');
        assertDecimalLt(cWMON.getUserDebt(true), debtAfterUp, 'native-vault debt after leverageDown');
    });

    test('Simple deposit and leverage', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000))); // Seed borrow

        const depositAmount = Decimal(1_000);
        const collateralBefore = cWMON.getUserCollateral(true);
        const debtBefore = cUSDC.getUserDebt(true);
        await cWMON.approvePlugin('simple', 'positionManager');
        await cWMON.approveUnderlying(depositAmount, cWMON.getPluginAddress('simple', 'positionManager'));
        await settleWrite(market, await cWMON.depositAndLeverage(depositAmount, cUSDC, Decimal(3), 'simple', Decimal(0.005)));

        const leverage = cWMON.getLeverage();
        assertLeverageInRange(leverage, Decimal(2.4), Decimal(3.2), 'simple deposit+leverage');
        assertDecimalGt(cWMON.getUserCollateral(true), collateralBefore, 'simple collateral after deposit+leverage');
        assertDecimalGt(cUSDC.getUserDebt(true), debtBefore, 'simple debt after deposit+leverage');
    });

    test('Simple leverage up & down', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000))); // Seed borrow

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount));
        await cWMON.approvePlugin('simple', 'positionManager');
        const debtBeforeUp = cUSDC.getUserDebt(true);
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', Decimal(0.005)));

        const leverageAfterUp = cWMON.getLeverage();
        assertLeverageInRange(leverageAfterUp, Decimal(2.4), Decimal(3.2), 'simple leverageUp');
        const debtAfterUp = cUSDC.getUserDebt(true);
        assertDecimalGt(debtAfterUp, debtBeforeUp, 'simple debt after leverageUp');

        await framework.skipMarketCooldown(market.address);
        await settleWrite(market, await cWMON.leverageDown(cUSDC, leverageAfterUp!, Decimal(1.5), 'simple', Decimal(0.005)));

        const leverageAfterDown = cWMON.getLeverage();
        assertLeverageInRange(leverageAfterDown, Decimal(1.1), leverageAfterUp!, 'simple leverageDown');
        assertDecimalLt(cUSDC.getUserDebt(true), debtAfterUp, 'simple debt after leverageDown');
    });

    // SDK-001: leverageUp simple — expectedShares unit mismatch
    // On a market where the collateral cToken has accrued interest
    // (exchangeRate > 1e18), leverageUp would revert because expectedShares
    // was set to a raw asset amount instead of being converted to shares.
    test('SDK-001: leverageUp simple with exchangeRate > 1', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        const exchangeRate = await cWMON.getExchangeRate();
        assert(exchangeRate > 1000000000000000000n, `Expected exchangeRate > 1e18, got ${exchangeRate}`);

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000)));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount));

        await cWMON.approvePlugin('simple', 'positionManager');
        const collateralBefore = cWMON.getUserCollateral(true);
        const debtBefore = cUSDC.getUserDebt(true);
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', Decimal(0.01)));

        const leverage = cWMON.getLeverage();
        assertLeverageInRange(leverage, Decimal(2.4), Decimal(3.2), 'SDK-001 simple leverageUp');
        assertDecimalGt(cWMON.getUserCollateral(true), collateralBefore, 'SDK-001 collateral after leverageUp');
        assertDecimalGt(cUSDC.getUserDebt(true), debtBefore, 'SDK-001 debt after leverageUp');
    });

    // SDK-002: previewLeverageDown returned the target collateral level
    // instead of the collateral *reduction* (current - target). This caused
    // leverageDown to over-withdraw collateral.
    test('SDK-002: previewLeverageDown computes correct reduction', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000)));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount));

        await cWMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', Decimal(0.01)));

        const leverageAfterUp = cWMON.getLeverage();
        assertLeverageInRange(leverageAfterUp, Decimal(2.5), Decimal(3.2), 'SDK-002 leverageUp');

        // Verify previewLeverageDown returns a sane reduction amount
        const preview = cWMON.previewLeverageDown(Decimal(1.5), leverageAfterUp!, cUSDC);
        const collateralUsd = cWMON.getUserCollateral(true);
        const reductionUsd = preview.collateralAssetReductionUsd;

        // The reduction must be less than total collateral
        assert(reductionUsd.lt(collateralUsd), `Reduction $${reductionUsd} should be less than total collateral $${collateralUsd}`);

        // Verify new debt/collateral fields
        const debt = cWMON.market.userDebt;
        const equity = collateralUsd.sub(debt);

        // newCollateral = equity * newLeverage
        const expectedCollateral = equity.mul(Decimal(1.5));
        assertDecimalClose(preview.newCollateral, expectedCollateral, Decimal(0.01), 'SDK-002 newCollateral');

        // newDebt = equity * (newLeverage - 1)
        const expectedDebt = equity.mul(Decimal(0.5));
        assertDecimalClose(preview.newDebt, expectedDebt, Decimal(0.01), 'SDK-002 newDebt');
        assertDecimalClose(reductionUsd, collateralUsd.sub(expectedCollateral), Decimal(0.01), 'SDK-002 collateral reduction');

        // Invariant: newCollateral - newDebt = equity
        const impliedEquity = preview.newCollateral.sub(preview.newDebt);
        assertDecimalClose(impliedEquity, equity, Decimal(0.01), 'SDK-002 implied equity');

        // newDebtInAssets defined when borrow param provided
        assert(preview.newDebtInAssets !== undefined, 'newDebtInAssets should be defined when borrow param is provided');
        assertDecimalClose(preview.newDebtInAssets!, cUSDC.convertUsdToTokens(expectedDebt, true), Decimal('0.000001'), 'SDK-002 newDebtInAssets');
        assertDecimalClose(preview.newCollateralInAssets, cWMON.convertUsdToTokens(expectedCollateral, true), Decimal('0.000001'), 'SDK-002 newCollateralInAssets');
        assert(preview.newDebt.lt(debt), `newDebt ${preview.newDebt} should be less than current debt ${debt}`);

        // Without borrow param, newDebtInAssets should be undefined
        const previewNoBorrow = cWMON.previewLeverageDown(Decimal(1.5), leverageAfterUp!);
        assert(previewNoBorrow.newDebtInAssets === undefined, 'newDebtInAssets should be undefined when borrow param is omitted');
        assertDecimalClose(previewNoBorrow.newCollateral, expectedCollateral, Decimal(0.01), 'SDK-002 no-borrow newCollateral');
        assertDecimalClose(previewNoBorrow.newCollateralInAssets, cWMON.convertUsdToTokens(expectedCollateral, true), Decimal('0.000001'), 'SDK-002 no-borrow newCollateralInAssets');

        const debtBeforeDown = cUSDC.getUserDebt(true);
        const collateralBeforeDown = cWMON.getUserCollateral(true);
        await framework.skipMarketCooldown(market.address);
        await settleWrite(market, await cWMON.leverageDown(cUSDC, leverageAfterUp!, Decimal(1.5), 'simple', Decimal(0.01)));

        const leverageAfterDown = cWMON.getLeverage();
        assertLeverageInRange(leverageAfterDown, Decimal(1.1), leverageAfterUp!, 'SDK-002 leverageDown');
        assertDecimalLt(cUSDC.getUserDebt(true), debtBeforeDown, 'SDK-002 debt after leverageDown');
        assertDecimalLt(cWMON.getUserCollateral(true), collateralBeforeDown, 'SDK-002 collateral after leverageDown');
    });

    test('SDK-005: depositAndLeverage accepts targets between post-deposit baseline and live leverage', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000)));

        const initialDeposit = Decimal(1000);
        await cWMON.approveUnderlying(initialDeposit);
        await settleWrite(market, await cWMON.depositAsCollateral(initialDeposit));

        await cWMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', SIMPLE_SLIPPAGE));

        const leverageBefore = cWMON.getLeverage();
        assert(leverageBefore !== null, 'Leverage should exist after the initial leverageUp');

        const additionalDeposit = Decimal(500);
        const depositAssets = FormatConverter.decimalToBigInt(additionalDeposit, cWMON.asset.decimals);
        const depositUsd = cWMON.convertAssetsToUsd(depositAssets);
        const currentCollateralUsd = cWMON.getUserCollateral(true);
        const currentDebtUsd = cWMON.market.userDebt;
        const baseline = computePostDepositBaseline(currentCollateralUsd, currentDebtUsd, depositUsd);
        const targetLeverage = baseline.add(Decimal(0.15));

        assert(
            targetLeverage.lt(leverageBefore!),
            `Expected deposit target ${targetLeverage} to stay below live leverage ${leverageBefore}`,
        );

        const preview = cWMON.previewDepositAndLeverage(targetLeverage, cUSDC, depositAssets);
        assertDecimalClose(preview.borrowAmount, cUSDC.convertUsdToTokens(preview.debtIncrease, true), Decimal('0.000001'), 'SDK-005 preview borrow amount');
        assertDecimalGt(preview.debtIncrease, Decimal(0), 'SDK-005 preview debt increase');
        assert(
            preview.effectiveCurrentLeverage.lt(leverageBefore!),
            `Post-deposit baseline ${preview.effectiveCurrentLeverage} should be below live leverage ${leverageBefore}`,
        );
        assertDecimalClose(preview.collateralIncrease, depositUsd.add(preview.debtIncrease.sub(preview.feeUsd)), Decimal(0.01), 'SDK-005 collateral increase');

        await cWMON.approveUnderlying(
            additionalDeposit,
            cWMON.getPluginAddress('simple', 'positionManager'),
        );
        await settleWrite(market, await cWMON.depositAndLeverage(additionalDeposit, cUSDC, targetLeverage, 'simple', SIMPLE_SLIPPAGE));

        const leverageAfter = cWMON.getLeverage();
        assert(leverageAfter !== null, 'Leverage should exist after depositAndLeverage');
        assert(
            leverageAfter!.lt(leverageBefore!),
            `Leverage should step down from ${leverageBefore} after adding collateral, got ${leverageAfter}`,
        );
        assert(
            leverageAfter!.gte(baseline),
            `Leverage after execution ${leverageAfter} should stay at or above the post-deposit baseline ${baseline}`,
        );
    });

    test('SDK-006: depositAndLeverage rejects targets below the post-deposit baseline', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000)));

        const initialDeposit = Decimal(1000);
        await cWMON.approveUnderlying(initialDeposit);
        await settleWrite(market, await cWMON.depositAsCollateral(initialDeposit));

        await cWMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', SIMPLE_SLIPPAGE));

        const leverageBefore = cWMON.getLeverage();
        assert(leverageBefore !== null, 'Leverage should exist after the initial leverageUp');

        const additionalDeposit = Decimal(500);
        const depositAssets = FormatConverter.decimalToBigInt(additionalDeposit, cWMON.asset.decimals);
        const depositUsd = cWMON.convertAssetsToUsd(depositAssets);
        const baseline = computePostDepositBaseline(
            cWMON.getUserCollateral(true),
            cWMON.market.userDebt,
            depositUsd,
        );
        const targetLeverage = baseline.sub(Decimal(0.05));

        assert(targetLeverage.gt(Decimal(1)), `Expected below-baseline target to remain above 1x, got ${targetLeverage}`);

        const preview = cWMON.previewDepositAndLeverage(targetLeverage, cUSDC, depositAssets);
        assert.equal(preview.borrowAssets, 0n, `Preview should not borrow below the post-deposit baseline, got ${preview.borrowAssets}`);
        assert(preview.borrowAmount.eq(0), `Preview should size zero borrow below the post-deposit baseline, got ${preview.borrowAmount}`);
        assert(
            preview.targetLeverage.eq(preview.effectiveCurrentLeverage),
            `Resolved target ${preview.targetLeverage} should clamp to the post-deposit baseline ${preview.effectiveCurrentLeverage}`,
        );
        assert(
            preview.effectiveCurrentLeverage.sub(baseline).abs().lt(Decimal(0.0001)),
            `Preview baseline ${preview.effectiveCurrentLeverage} should match computed baseline ${baseline}`,
        );
        assert(
            preview.effectiveCurrentLeverage.lt(leverageBefore),
            `Post-deposit baseline ${preview.effectiveCurrentLeverage} should stay below live leverage ${leverageBefore}`,
        );

        const simulation = await cWMON.depositAndLeverage(
            additionalDeposit,
            cUSDC,
            targetLeverage,
            'simple',
            SIMPLE_SLIPPAGE,
            true,
        );
        assert.deepEqual(simulation, {
            success: false,
            error: 'Target leverage must exceed the post-deposit leverage to borrow more.',
        });
    });

    test('SDK-007: removeMaxCollateral recomputes safely after partial repay', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000)));

        const initialDeposit = Decimal(1000);
        await cWMON.approveUnderlying(initialDeposit);
        await settleWrite(market, await cWMON.depositAsCollateral(initialDeposit));

        await cWMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', SIMPLE_SLIPPAGE));

        const collateralBeforeFirstRemoval = cWMON.getUserCollateral(true);
        const debtBeforeFirstRemoval = cUSDC.getUserDebt(true);
        const firstMax = await cWMON.maxRemovableCollateral();
        assert(
            firstMax.gt(0) && firstMax.lte(cWMON.getUserCollateralAssets()),
            `Expected first max removable ${firstMax} to be within posted collateral ${cWMON.getUserCollateralAssets()}`,
        );

        await framework.skipMarketCooldown(market.address);
        await cWMON.removeMaxCollateral();
        await reloadUserState(market);

        const collateralAfterFirstRemoval = cWMON.getUserCollateral(true);
        const debtAfterFirstRemoval = cUSDC.getUserDebt(true);
        assert(
            collateralAfterFirstRemoval.lt(collateralBeforeFirstRemoval),
            `Cycle 1 should reduce collateral from ${collateralBeforeFirstRemoval} to ${collateralAfterFirstRemoval}`,
        );
        assert(
            debtAfterFirstRemoval.gte(debtBeforeFirstRemoval),
            `Collateral removal should not reduce debt without repayment: before ${debtBeforeFirstRemoval}, after ${debtAfterFirstRemoval}`,
        );

        const debtAssetsBeforeRepay = cUSDC.getUserDebt(false);
        const repayAmount = debtAssetsBeforeRepay.div(2);
        assertDecimalClose(repayAmount, debtAssetsBeforeRepay.mul(0.5), Decimal('0.000001'), 'SDK-007 half repay amount');
        await settleWrite(market, await cUSDC.repay(repayAmount));

        const debtAfterRepay = cUSDC.getUserDebt(true);
        assert(
            debtAfterRepay.lt(debtAfterFirstRemoval),
            `Repay should reduce debt from ${debtAfterFirstRemoval} to ${debtAfterRepay}`,
        );

        const secondMax = await cWMON.maxRemovableCollateral();
        assert(
            secondMax.gt(0) && secondMax.lte(cWMON.getUserCollateralAssets()),
            `Expected second max removable ${secondMax} to be within posted collateral ${cWMON.getUserCollateralAssets()}`,
        );

        await framework.skipMarketCooldown(market.address);
        await cWMON.removeMaxCollateral();
        await reloadUserState(market);

        const collateralAfterSecondRemoval = cWMON.getUserCollateral(true);
        assert(
            collateralAfterSecondRemoval.lt(collateralAfterFirstRemoval),
            `Cycle 2 should reduce collateral from ${collateralAfterFirstRemoval} to ${collateralAfterSecondRemoval}`,
        );
    });

    test('SDK-008: removeCollateralExact stays exact when well below the safe cap', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000)));

        const initialDeposit = Decimal(1000);
        await cWMON.approveUnderlying(initialDeposit);
        await settleWrite(market, await cWMON.depositAsCollateral(initialDeposit));

        await cWMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', SIMPLE_SLIPPAGE));

        const maxRemovable = await cWMON.maxRemovableCollateral();
        assert(maxRemovable.gt(Decimal(0)), `Expected positive removable collateral, got ${maxRemovable}`);

        const requestedRemoval = maxRemovable.mul(Decimal(0.25));
        assert(
            requestedRemoval.gt(Decimal(0)),
            `Expected a positive exact removal request below the safe cap, got ${requestedRemoval}`,
        );

        const collateralBefore = cWMON.getUserCollateral(false);

        await framework.skipMarketCooldown(market.address);
        await cWMON.removeCollateralExact(requestedRemoval);
        await reloadUserState(market);

        const collateralAfter = cWMON.getUserCollateral(false);
        const removed = collateralBefore.sub(collateralAfter);

        assert(
            removed.sub(requestedRemoval).abs().lte(Decimal('0.000001')),
            `Expected exact removal ${removed} to stay close to request ${requestedRemoval}`,
        );

        const remainingRemovable = await cWMON.maxRemovableCollateral();
        assert(
            remainingRemovable.gt(Decimal(0)),
            `Expected removable collateral to remain after an exact sub-max removal, got ${remainingRemovable}`,
        );
        assert(
            remainingRemovable.lt(maxRemovable),
            `Expected removable collateral to decrease after exact removal: before ${maxRemovable}, after ${remainingRemovable}`,
        );
    });

    // SDK-003: Full deleverage at user-facing minimum slippage.
    // Bug: BasePositionManager__InvalidSlippage (0xeac6760a) was thrown
    // when going from L > ~4 to L=1 at 1% user slippage. Cause: the PR
    // removed the contract-slippage expansion that compensates for the
    // (L-1) × DELEVERAGE_OVERHEAD_BPS equity-amplified forced loss from
    // the intentional swap overshoot. Without expansion, the contract's
    // checkSlippage modifier sees the overshoot as equity loss exceeding
    // the user's tolerance and reverts.
    //
    // This test reproduces the exact failure mode and validates the fix.
    test('SDK-003: full deleverage from 3x at 1% slippage', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(5000)));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount));

        await cWMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', Decimal(0.01)));

        const leverageBeforeDown = cWMON.getLeverage();
        assert(leverageBeforeDown !== null, 'Leverage should not be null after leverageUp');
        assert(leverageBeforeDown!.gte(Decimal(2.5)),
            `Expected leverage ≥ 2.5 after up, got ${leverageBeforeDown}`);

        const collateralBeforeDown = cWMON.getUserCollateral(true);

        // Full deleverage at the user-facing minimum slippage (1%).
        // Pre-fix this reverted with BasePositionManager__InvalidSlippage.
        await framework.skipMarketCooldown(market.address);
        await settleWrite(market, await cWMON.leverageDown(cUSDC, leverageBeforeDown!, Decimal(1), 'simple', Decimal(0.01)));

        // After full deleverage, debt should be effectively zero.
        const debtAfter = cWMON.market.userDebt;
        assert(debtAfter.lt(Decimal(0.01)),
            `Debt should be ~0 after full deleverage, got ${debtAfter}`);

        assertDecimalLt(cWMON.getUserCollateral(true), collateralBeforeDown, 'SDK-003 collateral after full deleverage');

        // Leverage should be ~1 (or null, if computed from zero debt).
        const leverageAfter = cWMON.getLeverage();
        assert(leverageAfter === null || leverageAfter.lte(Decimal(1.001)),
            `Expected leverage ~1 or null after full deleverage, got ${leverageAfter}`);
    });

    // SDK-004: Full deleverage from higher source leverage.
    // The contract-slippage expansion is (currentLeverage - 1) × DELEVERAGE_OVERHEAD_BPS.
    // At higher source leverage, the (L-1) amplification factor grows, so
    // this stresses the math at a different operating point than SDK-003.
    // Also validates that leverageUp at L=5 with 1% user slippage works
    // (the flat LEVERAGE_UP_BUFFER_BPS is sized to handle this).
    test('SDK-004: full deleverage from 5x at 1% slippage', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        // Seed extra liquidity for higher leverage (~$4k borrow needed at 5x)
        await cUSDC.approveUnderlying();
        await settleWrite(market, await cUSDC.deposit(Decimal(20_000)));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount));

        await cWMON.approvePlugin('simple', 'positionManager');
        await settleWrite(market, await cWMON.leverageUp(cUSDC, Decimal(5), 'simple', Decimal(0.01)));

        const leverageBeforeDown = cWMON.getLeverage();
        assert(leverageBeforeDown !== null, 'Leverage should not be null after leverageUp');
        assert(leverageBeforeDown!.gte(Decimal(4.5)),
            `Expected leverage ≥ 4.5 after up to 5x, got ${leverageBeforeDown}`);

        const collateralBeforeDown = cWMON.getUserCollateral(true);

        // Full deleverage from ~5x at 1% slippage.
        // Pre-fix this would fail more dramatically than the 3x case because
        // the (L-1) amplification scales linearly with starting leverage.
        await framework.skipMarketCooldown(market.address);
        await settleWrite(market, await cWMON.leverageDown(cUSDC, leverageBeforeDown!, Decimal(1), 'simple', Decimal(0.01)));

        const debtAfter = cWMON.market.userDebt;
        assert(debtAfter.lt(Decimal(0.01)),
            `Debt should be ~0 after full deleverage from ${leverageBeforeDown}, got ${debtAfter}`);

        assertDecimalLt(cWMON.getUserCollateral(true), collateralBeforeDown, 'SDK-004 collateral after full deleverage');

        const leverageAfter = cWMON.getLeverage();
        assert(leverageAfter === null || leverageAfter.lte(Decimal(1.001)),
            `Expected leverage ~1 or null after full deleverage, got ${leverageAfter}`);
    });
});
