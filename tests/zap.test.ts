import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, afterEach, after } from 'node:test';
import { address } from '../src/types';
import Decimal from 'decimal.js';
import { TestFramework } from './utils/TestFramework';
import { fastForwardTime, MARKET_HOLD_PERIOD_SECS } from './utils/helper';
import { ERC20 } from '../src';
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

    test('Simple Zap', async function() {
        const [ market, cWMON ] = await framework.getMarket('WMON | USDC');
        const depositAmount = Decimal(1_000);

        const first_available_token = (await cWMON.getDepositTokens())[2]!;

        await cWMON.approvePlugin('simple', 'zapper');
        await cWMON.approveUnderlying(depositAmount);

        // Not required for native token zaps
        if(first_available_token.interface instanceof ERC20) {
            await first_available_token.interface.approve(cWMON.getPluginAddress('simple', 'zapper') as address, depositAmount);
        }

        await settleWrite(market, await cWMON.depositAsCollateral(depositAmount, {
            type: 'simple',
            inputToken: first_available_token.interface.address,
            slippage: Decimal(0.005)
        }));

        assert(cWMON.getUserAssetBalance(false).gt(0), 'Expected simple zap to post asset balance');
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
        assert(
            userAssets.gte(depositAmount),
            `Expected same-token zap deposit to post assets, got ${userAssets}`,
        );
    });

    // SDK-003: getAvailableTokens quote closure converted output amounts
    // using the INPUT token's decimals instead of the OUTPUT token's decimals.
    // For cross-decimal swaps (e.g. MON 18dec → USDC 6dec), the formatted
    // output was off by 10^12.
    test('SDK-003: cross-decimal zap quote formats output with correct decimals', async function() {
        const [ market, cWMON, cUSDC ] = await framework.getMarket('WMON | USDC');

        const wmonAddress = cWMON.getAsset(true).address;
        const usdcAddress = cUSDC.getAsset(true).address;
        const wmonDecimals = cWMON.getAsset(true).decimals!;
        const usdcDecimals = cUSDC.getAsset(true).decimals!;

        console.log(`WMON decimals: ${wmonDecimals}, USDC decimals: ${usdcDecimals}`);
        assert.notEqual(wmonDecimals, usdcDecimals, 'Test requires tokens with different decimals');

        const zapTokens = await framework.curvance.dexAgg.getAvailableTokens(framework.provider, null);
        const wmonZap = zapTokens.find((z: any) => z.interface.address.toLowerCase() === wmonAddress.toLowerCase());
        assert(wmonZap, `Could not find zap token for WMON (${wmonAddress})`);
        assert(wmonZap!.quote, `Zap token for WMON has no quote function`);

        // Quote: swap 1 WMON → USDC
        const result = await wmonZap!.quote!(wmonAddress, usdcAddress, Decimal(1), Decimal(0.01));

        console.log(`Raw output: ${result.output_raw}`);
        console.log(`Formatted output: ${result.output}`);
        console.log(`Formatted minOut: ${result.minOut}`);

        // Formatted output should be in a sane USDC range
        assert(result.output.gt(Decimal(0.001)), `Output ${result.output} is suspiciously small — likely using wrong decimals`);
        assert(result.output.lt(Decimal(1_000_000)), `Output ${result.output} is suspiciously large — likely using wrong decimals`);

        // Verify: formatted value = raw / 10^outputDecimals
        const expectedOutput = Decimal(result.output_raw.toString()).div(Decimal(10).pow(usdcDecimals));
        assert(result.output.eq(expectedOutput), `Formatted output ${result.output} does not match raw/${10**Number(usdcDecimals)} = ${expectedOutput}`);

        const expectedMinOut = Decimal(result.minOut_raw.toString()).div(Decimal(10).pow(usdcDecimals));
        assert(result.minOut.eq(expectedMinOut), `Formatted minOut ${result.minOut} does not match raw/${10**Number(usdcDecimals)} = ${expectedMinOut}`);
    });
});
