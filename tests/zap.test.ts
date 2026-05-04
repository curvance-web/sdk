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

    function assertDecimalGt(actual: Decimal, expected: Decimal, label: string) {
        assert(
            actual.gt(expected),
            `${label}: expected ${actual.toString()} to be greater than ${expected.toString()}`,
        );
    }

    function assertNoDebt(token: { getUserDebt: (inUSD: false) => Decimal }, label: string) {
        const debt = token.getUserDebt(false);
        assert(
            debt.eq(0),
            `${label}: expected zap deposit to leave debt at 0, got ${debt.toString()}`,
        );
    }

    function assertClose(
        actual: Decimal,
        expected: Decimal,
        tolerance: Decimal,
        label: string,
    ) {
        assert(
            actual.sub(expected).abs().lte(tolerance),
            `${label}: expected ${actual.toString()} within ${tolerance.toString()} of ${expected.toString()}`,
        );
    }

    test('Native Vault Zap', async function() {
        const [ market, shMON ] = await framework.getMarket('shMON | WMON');
        const depositAmount = Decimal(1_000);
        const collateralBefore = shMON.getUserCollateralAssets();
        const userAssetsBefore = shMON.getUserAssetBalance(false);

        await shMON.approvePlugin('native-vault', 'zapper');
        await shMON.approveUnderlying(depositAmount);
        await settleWrite(market, await shMON.depositAsCollateral(depositAmount, 'native-vault'));

        const collateralAfter = shMON.getUserCollateralAssets();
        const userAssetsAfter = shMON.getUserAssetBalance(false);

        assertDecimalGt(collateralAfter, collateralBefore, 'native-vault collateral assets');
        assertDecimalGt(userAssetsAfter, userAssetsBefore, 'native-vault user asset balance');
        assertNoDebt(shMON, 'native-vault zap');
    });

    test('Native Simple Zap', async function() {
        const [ market, , cWMON ] = await framework.getMarket('shMON | WMON');
        const depositAmount = Decimal(1_000);
        const collateralBefore = cWMON.getUserCollateralAssets();

        await cWMON.approvePlugin('native-simple', 'zapper');
        await cWMON.approveUnderlying(depositAmount);
        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount, 'native-simple'));

        const collateralAfter = cWMON.getUserCollateralAssets();
        const collateralDelta = collateralAfter.sub(collateralBefore);

        assertClose(
            collateralDelta,
            depositAmount,
            Decimal('0.000001'),
            'native-simple collateral delta',
        );
        assertNoDebt(cWMON, 'native-simple zap');
    });

    test('SDK-004: same-token simple zap deposits without a swap route', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');
        void cWMON;
        const depositAmount = Decimal(250);
        const instructions = {
            type: 'simple' as const,
            inputToken: cUSDC.getAsset(true).address,
            slippage: Decimal(0.005),
        };
        const collateralBefore = cUSDC.getUserCollateralAssets();

        await cUSDC.approvePlugin('simple', 'zapper');
        await cUSDC.approveZapAsset(instructions, depositAmount);
        await settleWrite(market, await cUSDC.depositAsCollateral(depositAmount, instructions));

        const collateralAfter = cUSDC.getUserCollateralAssets();
        const collateralDelta = collateralAfter.sub(collateralBefore);
        const oneBaseUnit = Decimal(10).pow(-Number(cUSDC.asset.decimals));
        assertClose(
            collateralDelta,
            depositAmount,
            oneBaseUnit,
            'same-token simple zap collateral delta',
        );
        assertNoDebt(cUSDC, 'same-token simple zap');
    });
});
