import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, afterEach, after } from 'node:test';
import { address } from '../src/types';
import Decimal from 'decimal.js';
import { TestFramework } from './utils/TestFramework';
import assert from 'node:assert';

const FORK_SKIP = (!process.env.ARB_DEPLOYER_PRIVATE_KEY || !process.env.TEST_RPC)
    ? 'Fork env not configured: set ARB_DEPLOYER_PRIVATE_KEY and TEST_RPC in .env. See tests/README.md.'
    : undefined;

describe('Basic operations', { skip: FORK_SKIP }, () => {
    let account: address;
    let target_market = 'Stable Market';
    let framework: TestFramework;

    before(async () => {
        framework = await TestFramework.init(process.env.ARB_DEPLOYER_PRIVATE_KEY as string, 'arb-sepolia', {
            seedNativeBalance: true,
            seedUnderlying: false,
            snapshot: true,
            log: true,
        });
        account = framework.account;

        // TODO: Fix this so we dont need an arb deployer key
        // account = '0x6D3DA13B41E18Dc7bd1c084De0034fBcB1fDbCE8';
        // await framework.impersonateStart(account);
    })

    after(async () => {
        await framework.destroy();
    });

    afterEach(async () => {
        await framework.reset();
    });

    async function settleWrite(market: { reloadUserData: (account: address) => Promise<unknown> }, txLike: unknown) {
        if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === 'function') {
            await (txLike as { wait: () => Promise<unknown> }).wait();
        }

        await market.reloadUserData(account);
    }

    function assertDecimalGt(actual: Decimal, expected: Decimal, label: string) {
        assert(
            actual.gt(expected),
            `${label}: expected ${actual.toString()} to be greater than ${expected.toString()}`,
        );
    }

    function assertDecimalZero(actual: Decimal, label: string) {
        assert(
            actual.eq(0),
            `${label}: expected 0, got ${actual.toString()}`,
        );
    }

    function assertDecimalClose(actual: Decimal, expected: Decimal, tolerance: Decimal, label: string) {
        const delta = actual.sub(expected).abs();
        assert(
            delta.lte(tolerance),
            `${label}: expected ${actual.toString()} to be within ${tolerance.toString()} of ${expected.toString()}`,
        );
    }

    test('Deposit and redeem without anything remaining', async function() {
        const [ market, tokenA ] = await framework.getMarket(target_market);

        const depositAmount = Decimal(100);
        await tokenA.approveUnderlying();
        await settleWrite(market, await tokenA.depositAsCollateral(depositAmount));

        const balanceAfterDeposit = await tokenA.balanceOf(account);
        assert.equal(balanceAfterDeposit, tokenA.getUserCollateralShares(), 'cToken balance should equal posted collateral shares after collateral deposit');
        assertDecimalClose(tokenA.getUserCollateralAssets(), depositAmount, Decimal('0.000001'), 'collateral assets after deposit');
        assertDecimalGt(tokenA.getUserAssetBalance(false), Decimal(0), 'asset balance after deposit');
        assertDecimalZero(tokenA.market.userDebt, 'market debt after deposit-only flow');

        const sdkBalance = tokenA.getUserAssetBalance(false);
        await framework.skipMarketCooldown(market.address);
        await settleWrite(market, await tokenA.redeem(sdkBalance));

        const balanceAfter = await tokenA.balanceOf(account);

        assert(balanceAfter < balanceAfterDeposit, 'Token A balance did not decrease after attempting to withdraw all');
        assert(balanceAfter == 0n, 'Token A balance not zero after redeeming all');
        assertDecimalZero(tokenA.getUserAssetBalance(false), 'asset balance after redeem-all');
        assertDecimalZero(tokenA.getUserCollateralAssets(), 'collateral after redeem-all');
        assertDecimalZero(tokenA.market.userDebt, 'market debt after redeem-all');
    });

    test('Deposit, borrow, repay, redeem without anything remaining', async function() {
        const [ market, tokenA, tokenB ] = await framework.getMarket(target_market);

        await tokenA.approveUnderlying();
        const tokenABalance = await tokenA.getAsset(true).balanceOf(account, true);
        const depositAmount = tokenABalance.mul(0.5);
        await settleWrite(market, await tokenA.depositAsCollateral(depositAmount)); // Deposit 50%;

        const balanceAfterDeposit = await tokenA.balanceOf(account);
        assert.equal(balanceAfterDeposit, tokenA.getUserCollateralShares(), 'cToken balance should equal posted collateral shares after collateral deposit');
        assertDecimalClose(tokenA.getUserCollateralAssets(), depositAmount, Decimal('0.000001'), 'collateral assets after deposit');
        assertDecimalZero(tokenA.market.userDebt, 'market debt before borrow');

        const maxBorrow = await tokenB.getMaxBorrowable();
        assertDecimalGt(maxBorrow, Decimal(0), 'max borrowable before borrow');
        const borrowAmount = maxBorrow.mul(0.5);
        await settleWrite(market, await tokenB.borrow(borrowAmount)); // 50% borrow

        assertDecimalClose(tokenB.getUserDebt(false), borrowAmount, Decimal('0.000001'), 'borrow token debt after borrow');
        assertDecimalClose(tokenB.getUserDebt(true), market.userDebt, Decimal('0.01'), 'market debt after borrow');

        await tokenB.approveUnderlying();
        await framework.skipMarketCooldown(market.address);
        await settleWrite(market, await tokenB.repay(Decimal(0))); // Repay all
        assertDecimalZero(tokenB.getUserDebt(false), 'borrow token debt after repay-all');
        assertDecimalZero(market.userDebt, 'market debt after repay-all');

        await framework.skipMarketCooldown(market.address);
        await settleWrite(market, await tokenA.redeem(tokenA.getUserAssetBalance(false)));
        const balanceAfter = await tokenA.balanceOf(account);

        assert(balanceAfter < balanceAfterDeposit, 'Token A balance did not decrease after attempting to withdraw all');
        assert(balanceAfter == 0n, 'Token A balance not zero after redeeming all');
        assertDecimalZero(tokenA.getUserAssetBalance(false), 'asset balance after repay/redeem');
        assertDecimalZero(tokenA.getUserCollateralAssets(), 'collateral after repay/redeem');
        assertDecimalZero(market.userDebt, 'market debt after repay/redeem');
    });
});
