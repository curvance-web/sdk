import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, afterEach, after } from 'node:test';
import { address } from '../src/types';
import Decimal from 'decimal.js';
import { TestFramework } from './utils/TestFramework';
import { fastForwardTime, MARKET_HOLD_PERIOD_SECS } from './utils/helper';
import assert from 'node:assert';

describe('Leverage', () => {
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

    test('Native vault deposit and leverage', async function() {
        const [ market, cshMON, cWMON ] = await framework.getMarket('shMON | WMON');

        await cWMON.approveUnderlying();
        await cWMON.deposit(Decimal(5000)); // Seed borrow

        const depositAmount = Decimal(1_000);
        await cshMON.approvePlugin('native-vault', 'positionManager');
        await cshMON.approveUnderlying(depositAmount, cshMON.getPluginAddress('native-vault', 'positionManager'));
        await cshMON.depositAndLeverage(depositAmount, cWMON, Decimal(3), 'native-vault', Decimal(0.01));
    });

    test('Native vault leverage up & down', async function() {
        const [ market, cshMON, cWMON ] = await framework.getMarket('shMON | WMON');

        await cWMON.approveUnderlying();
        await cWMON.deposit(Decimal(5000)); // Seed borrow

        const depositAmount = Decimal(1_000);
        await cshMON.approveUnderlying(depositAmount);
        await cshMON.depositAsCollateral(depositAmount);
        await cshMON.approvePlugin('native-vault', 'positionManager');
        await cshMON.leverageUp(cWMON, Decimal(3), 'native-vault', Decimal(0.01));

        await framework.skipMarketCooldown(market.address);
        await cshMON.approvePlugin('simple', 'positionManager');
        await cshMON.leverageDown(cWMON, cshMON.getLeverage() as Decimal, Decimal(1.5), 'simple', Decimal(0.01));
    });

    test('Vault deposit and leverage', async function() {
        const [ market, csAUSD, cAUSD ] = await framework.getMarket('sAUSD | AUSD');

        await cAUSD.approveUnderlying();
        await cAUSD.deposit(Decimal(5000)); // Seed borrow

        const depositAmount = Decimal(1_000);
        await csAUSD.approvePlugin('vault', 'positionManager');
        await csAUSD.approveUnderlying(depositAmount, csAUSD.getPluginAddress('vault', 'positionManager'));
        await csAUSD.depositAndLeverage(depositAmount, cAUSD, Decimal(3), 'vault', Decimal(0.005));
    });

    test('Vault leverage up & down', async function() {
        const [ market, csAUSD, cAUSD ] = await framework.getMarket('sAUSD | AUSD');

        await cAUSD.approveUnderlying();
        await cAUSD.deposit(Decimal(5000)); // Seed borrow

        const depositAmount = Decimal(1_000);
        await csAUSD.approveUnderlying(depositAmount);
        await csAUSD.depositAsCollateral(depositAmount);
        await csAUSD.approvePlugin('vault', 'positionManager');
        await csAUSD.leverageUp(cAUSD, Decimal(3), 'vault', Decimal(0.005));

        // TODO: Can't do this with sAUSD because there is no liquidity
        // await framework.skipMarketCooldown(market.address);
        // await sAUSD.approvePlugin('simple', 'positionManager');
        // await sAUSD.leverageDown(AUSD, sAUSD.getLeverage() as Decimal, Decimal(1.5), 'simple', Decimal(0.005));
    });

    test('Simple deposit and leverage', async function() {
        const [ market, cearnAUSD, cAUSD ] = await framework.getMarket('earnAUSD | AUSD');

        await cAUSD.approveUnderlying();
        await cAUSD.deposit(Decimal(5000)); // Seed borrow

        const depositAmount = Decimal(1_000);
        await cearnAUSD.approvePlugin('simple', 'positionManager');
        await cearnAUSD.approveUnderlying(depositAmount, cearnAUSD.getPluginAddress('simple', 'positionManager'));
        await cearnAUSD.depositAndLeverage(depositAmount, cAUSD, Decimal(3), 'simple', Decimal(0.005));
    });

    test('Simple leverage up & down', async function() {
        const [ market, cearnAUSD, cAUSD ] = await framework.getMarket('earnAUSD | AUSD');

        await cAUSD.approveUnderlying();
        await cAUSD.deposit(Decimal(5000)); // Seed borrow

        const depositAmount = Decimal(1_000);
        await cearnAUSD.approveUnderlying(depositAmount);
        await cearnAUSD.depositAsCollateral(depositAmount);
        await cearnAUSD.approvePlugin('simple', 'positionManager');
        await cearnAUSD.leverageUp(cAUSD, Decimal(3), 'simple', Decimal(0.005));

        await framework.skipMarketCooldown(market.address);
        await cearnAUSD.leverageDown(cAUSD, cearnAUSD.getLeverage() as Decimal, Decimal(1.5), 'simple', Decimal(0.005));
    });

    // SDK-001: leverageUp simple — expectedShares unit mismatch
    // On a market where the collateral cToken has accrued interest
    // (exchangeRate > 1e18), leverageUp would revert because expectedShares
    // was set to a raw asset amount instead of being converted to shares.
    test('SDK-001: leverageUp simple with exchangeRate > 1', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        const exchangeRate = await cWMON.getExchangeRate();
        console.log(`cWMON exchange rate: ${exchangeRate}`);
        assert(exchangeRate > 1000000000000000000n, `Expected exchangeRate > 1e18, got ${exchangeRate}`);

        await cUSDC.approveUnderlying();
        await cUSDC.deposit(Decimal(5000));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await cWMON.depositAsCollateral(depositAmount);

        await cWMON.approvePlugin('simple', 'positionManager');
        await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', Decimal(0.01));

        console.log(`Leverage: ${cWMON.getLeverage()}`);
    });

    // SDK-002: previewLeverageDown returned the target collateral level
    // instead of the collateral *reduction* (current - target). This caused
    // leverageDown to over-withdraw collateral.
    test('SDK-002: previewLeverageDown computes correct reduction', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        await cUSDC.approveUnderlying();
        await cUSDC.deposit(Decimal(5000));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await cWMON.depositAsCollateral(depositAmount);

        await cWMON.approvePlugin('simple', 'positionManager');
        await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', Decimal(0.01));

        const leverageAfterUp = cWMON.getLeverage();
        console.log(`Leverage after up: ${leverageAfterUp}`);
        assert(leverageAfterUp !== null, 'Leverage should not be null after leverageUp');
        assert(leverageAfterUp!.gte(Decimal(2.5)), `Expected leverage >= 2.5, got ${leverageAfterUp}`);

        // Verify previewLeverageDown returns a sane reduction amount
        const preview = cWMON.previewLeverageDown(Decimal(1.5), leverageAfterUp!, cUSDC);
        const collateralUsd = cWMON.getUserCollateral(true);
        const reductionUsd = preview.collateralAssetReductionUsd;

        console.log(`Collateral (USD): ${collateralUsd}`);
        console.log(`Predicted reduction (USD): ${reductionUsd}`);

        // The reduction must be less than total collateral
        assert(reductionUsd.lt(collateralUsd), `Reduction $${reductionUsd} should be less than total collateral $${collateralUsd}`);
        assert(reductionUsd.gt(0), `Reduction should be positive, got ${reductionUsd}`);

        // Verify new debt/collateral fields
        const debt = cWMON.market.userDebt;
        const equity = collateralUsd.sub(debt);

        // newCollateral = equity * newLeverage
        const expectedCollateral = equity.mul(Decimal(1.5));
        assert(preview.newCollateral.sub(expectedCollateral).abs().lt(Decimal(0.01)),
            `newCollateral ${preview.newCollateral} should ≈ equity*1.5 = ${expectedCollateral}`);

        // newDebt = equity * (newLeverage - 1)
        const expectedDebt = equity.mul(Decimal(0.5));
        assert(preview.newDebt.sub(expectedDebt).abs().lt(Decimal(0.01)),
            `newDebt ${preview.newDebt} should ≈ equity*0.5 = ${expectedDebt}`);

        // Invariant: newCollateral - newDebt = equity
        const impliedEquity = preview.newCollateral.sub(preview.newDebt);
        assert(impliedEquity.sub(equity).abs().lt(Decimal(0.01)),
            `newCollateral - newDebt = ${impliedEquity} should ≈ equity = ${equity}`);

        // newDebtInAssets defined when borrow param provided
        assert(preview.newDebtInAssets !== undefined, 'newDebtInAssets should be defined when borrow param is provided');
        assert(preview.newDebtInAssets!.gt(0), `newDebtInAssets should be positive, got ${preview.newDebtInAssets}`);
        assert(preview.newCollateralInAssets.gt(0), `newCollateralInAssets should be positive, got ${preview.newCollateralInAssets}`);
        assert(preview.newDebt.lt(debt), `newDebt ${preview.newDebt} should be less than current debt ${debt}`);

        // Without borrow param, newDebtInAssets should be undefined
        const previewNoBorrow = cWMON.previewLeverageDown(Decimal(1.5), leverageAfterUp!);
        assert(previewNoBorrow.newDebtInAssets === undefined, 'newDebtInAssets should be undefined when borrow param is omitted');
        assert(previewNoBorrow.newCollateral.gt(0), 'newCollateral should still work without borrow');
        assert(previewNoBorrow.newCollateralInAssets.gt(0), 'newCollateralInAssets should still work without borrow');

        // Execute leverageDown
        await framework.skipMarketCooldown(market.address);
        await cWMON.leverageDown(cUSDC, leverageAfterUp!, Decimal(1.5), 'simple', Decimal(0.01));

        const leverageAfterDown = cWMON.getLeverage();
        console.log(`Leverage after down: ${leverageAfterDown}`);
        assert(leverageAfterDown !== null, 'Leverage should not be null after leverageDown');
        assert(leverageAfterDown!.lt(leverageAfterUp!), `Leverage should decrease: was ${leverageAfterUp}, now ${leverageAfterDown}`);
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
        await cUSDC.deposit(Decimal(5000));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await cWMON.depositAsCollateral(depositAmount);

        await cWMON.approvePlugin('simple', 'positionManager');
        await cWMON.leverageUp(cUSDC, Decimal(3), 'simple', Decimal(0.01));

        const leverageBeforeDown = cWMON.getLeverage();
        console.log(`Leverage before full deleverage: ${leverageBeforeDown}`);
        assert(leverageBeforeDown !== null, 'Leverage should not be null after leverageUp');
        assert(leverageBeforeDown!.gte(Decimal(2.5)),
            `Expected leverage ≥ 2.5 after up, got ${leverageBeforeDown}`);

        // Full deleverage at the user-facing minimum slippage (1%).
        // Pre-fix this reverted with BasePositionManager__InvalidSlippage.
        await framework.skipMarketCooldown(market.address);
        await cWMON.leverageDown(cUSDC, leverageBeforeDown!, Decimal(1), 'simple', Decimal(0.01));

        // After full deleverage, debt should be effectively zero.
        const debtAfter = cWMON.market.userDebt;
        console.log(`Debt after full deleverage: ${debtAfter}`);
        assert(debtAfter.lt(Decimal(0.01)),
            `Debt should be ~0 after full deleverage, got ${debtAfter}`);

        // Leverage should be ~1 (or null, if computed from zero debt).
        const leverageAfter = cWMON.getLeverage();
        console.log(`Leverage after full deleverage: ${leverageAfter}`);
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
        await cUSDC.deposit(Decimal(20_000));

        const depositAmount = Decimal(1_000);
        await cWMON.approveUnderlying(depositAmount);
        await cWMON.depositAsCollateral(depositAmount);

        await cWMON.approvePlugin('simple', 'positionManager');
        await cWMON.leverageUp(cUSDC, Decimal(5), 'simple', Decimal(0.01));

        const leverageBeforeDown = cWMON.getLeverage();
        console.log(`Leverage before full deleverage: ${leverageBeforeDown}`);
        assert(leverageBeforeDown !== null, 'Leverage should not be null after leverageUp');
        assert(leverageBeforeDown!.gte(Decimal(4.5)),
            `Expected leverage ≥ 4.5 after up to 5x, got ${leverageBeforeDown}`);

        // Full deleverage from ~5x at 1% slippage.
        // Pre-fix this would fail more dramatically than the 3x case because
        // the (L-1) amplification scales linearly with starting leverage.
        await framework.skipMarketCooldown(market.address);
        await cWMON.leverageDown(cUSDC, leverageBeforeDown!, Decimal(1), 'simple', Decimal(0.01));

        const debtAfter = cWMON.market.userDebt;
        console.log(`Debt after full deleverage from 5x: ${debtAfter}`);
        assert(debtAfter.lt(Decimal(0.01)),
            `Debt should be ~0 after full deleverage from ${leverageBeforeDown}, got ${debtAfter}`);

        const leverageAfter = cWMON.getLeverage();
        console.log(`Leverage after full deleverage from 5x: ${leverageAfter}`);
        assert(leverageAfter === null || leverageAfter.lte(Decimal(1.001)),
            `Expected leverage ~1 or null after full deleverage, got ${leverageAfter}`);
    });
});