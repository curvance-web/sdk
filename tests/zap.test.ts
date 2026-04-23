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

describe('Zapping', { skip: FORK_SKIP }, () => {
    let account: address;
    let framework: TestFramework;

    before(async () => {
        framework = await TestFramework.init(process.env.DEPLOYER_PRIVATE_KEY as string, 'monad-mainnet', {
            seedNativeBalance: true,
            seedUnderlying: true,
            snapshot: true,
            log: false,
        });
        account = framework.account;
    });

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

    test('Native Vault Zap', async function() {
        const [ market, shMON ] = await framework.getMarket('shMON | WMON');
        const depositAmount = Decimal(1_000);

        await shMON.approvePlugin('native-vault', 'zapper');
        await shMON.approveUnderlying(depositAmount);
        await settleWrite(market, await shMON.depositAsCollateral(depositAmount, 'native-vault'));

        assert(shMON.getUserAssetBalance(false).gt(0), 'Expected native-vault zap to post asset balance');
    });

    test('Native Simple Zap', async function() {
        const [ market, , cWMON ] = await framework.getMarket('shMON | WMON');
        const depositAmount = Decimal(1_000);

        await cWMON.approvePlugin('native-simple', 'zapper');
        await cWMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount, 'native-simple'));

        assert(cWMON.getUserAssetBalance(false).gt(0), 'Expected native-simple zap to post asset balance');
    });

    test('SDK-004: same-token simple zap deposits without a swap route', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');
        const depositAmount = Decimal(250);
        const instructions = {
            type: 'simple' as const,
            inputToken: cUSDC.getAsset(true).address,
            slippage: Decimal(0.005),
        };

        await cUSDC.approvePlugin('simple', 'zapper');
        await cUSDC.approveZapAsset(instructions, depositAmount);
        await settleWrite(market, await cUSDC.depositAsCollateral(depositAmount, instructions));

        const userAssets = cUSDC.getUserAssetBalance(false);
        const oneBaseUnit = Decimal(10).pow(-Number(cUSDC.asset.decimals));
        assert(
            userAssets.gte(depositAmount.sub(oneBaseUnit)),
            `Expected same-token zap deposit to stay within one base unit of ${depositAmount}, got ${userAssets}`,
        );
    });
});
