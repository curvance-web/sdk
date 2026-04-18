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

    test('Deposit and redeem without anything remaining', async function() {
        const [ market, tokenA, tokenB ] = await framework.getMarket(target_market);

        await tokenA.approveUnderlying();
        await tokenA.depositAsCollateral(Decimal(100));
        await framework.skipMarketCooldown(market.address);

        const balanceBefore = await tokenA.balanceOf(account);

        const sdkBalance = tokenA.getUserAssetBalance(false);
        await tokenA.redeem(sdkBalance);

        const balanceAfter = await tokenA.balanceOf(account);

        assert(balanceAfter < balanceBefore, 'Token A balance did not decrease after attempting to withdraw all');
        assert(balanceAfter == 0n, 'Token A balance not zero after redeeming all');
    });

    // TODO: Fix this so it passes
    test('Deposit, borrow, repay, redeem without anything remaining', async function() {
        const [ market, tokenA, tokenB ] = await framework.getMarket(target_market);

        await tokenA.approveUnderlying();
        const tokenABalance = await tokenA.getAsset(true).balanceOf(account, true);
        await tokenA.depositAsCollateral(tokenABalance.mul(0.5)); // Deposit 50%;
        await framework.skipMarketCooldown(market.address);

        const balanceBefore = await tokenA.balanceOf(account);

        const maxBorrow = await tokenB.getMaxBorrowable();
        await tokenB.borrow(maxBorrow.mul(0.5)); // 50% borrow
        await framework.skipMarketCooldown(market.address);

        await tokenB.approveUnderlying();
        await tokenB.repay(Decimal(0)); // Repay all

        await tokenA.redeem(tokenA.getUserAssetBalance(false));
        const balanceAfter = await tokenA.balanceOf(account);

        assert(balanceAfter < balanceBefore, 'Token A balance did not decrease after attempting to withdraw all');
        assert(balanceAfter == 0n, 'Token A balance not zero after redeeming all');
    });
});