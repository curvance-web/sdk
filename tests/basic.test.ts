import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, afterEach, after } from 'node:test';
import { address } from '../src/types';
import Decimal from 'decimal.js';
import { TestFramework } from './utils/TestFramework';
import assert from 'node:assert';

const FORK_SKIP = (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.TEST_RPC)
    ? 'Fork env not configured: set DEPLOYER_PRIVATE_KEY and TEST_RPC in .env. See tests/README.md.'
    : undefined;

describe('Basic operations', { skip: FORK_SKIP }, () => {
    let account: address;
    let target_market = 'WMON | USDC';
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

    async function settleWrite(market: { reloadUserData: (account: address) => Promise<unknown> }, txLike: unknown) {
        if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === 'function') {
            await (txLike as { wait: () => Promise<unknown> }).wait();
        }

        await market.reloadUserData(account);
    }

    test('Deposit and redeem without anything remaining', async function() {
        const [ market, tokenA, tokenB ] = await framework.getMarket(target_market);

        await tokenA.approveUnderlying();
        await settleWrite(market, await tokenA.depositAsCollateral(Decimal(1000)));
        await framework.skipMarketCooldown(market.address);

        const balanceBefore = await tokenA.balanceOf(account);

        const sdkBalance = tokenA.getUserAssetBalance(false);
        await settleWrite(market, await tokenA.redeem(sdkBalance));

        const balanceAfter = await tokenA.balanceOf(account);

        assert(balanceAfter < balanceBefore, 'Token A balance did not decrease after attempting to withdraw all');
        assert(balanceAfter == 0n, 'Token A balance not zero after redeeming all');
    });

    test('Deposit, borrow, repay, redeem without anything remaining', async function() {
        const [ market, tokenA, tokenB ] = await framework.getMarket(target_market);

        await tokenA.approveUnderlying();
        const tokenABalance = await tokenA.getAsset(true).balanceOf(account, true);
        await settleWrite(market, await tokenA.depositAsCollateral(tokenABalance.mul(0.5))); // Deposit 50%;
        await framework.skipMarketCooldown(market.address);

        const balanceBefore = await tokenA.balanceOf(account);

        const maxBorrow = await tokenB.getMaxBorrowable();
        await settleWrite(market, await tokenB.borrow(maxBorrow.mul(0.5))); // 50% borrow
        await framework.skipMarketCooldown(market.address);

        await tokenB.approveUnderlying();
        await settleWrite(market, await tokenB.repay(Decimal(0))); // Repay all

        await settleWrite(market, await tokenA.redeem(tokenA.getUserAssetBalance(false)));
        const balanceAfter = await tokenA.balanceOf(account);

        assert(balanceAfter < balanceBefore, 'Token A balance did not decrease after attempting to withdraw all');
        assert(balanceAfter == 0n, 'Token A balance not zero after redeeming all');
    });
});
