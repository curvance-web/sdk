import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
    BorrowableCToken,
    CToken,
    FormatConverter,
    LEVERAGE,
    amplifyContractSlippage,
} from '../src';
import type { FeePolicyContext } from '../src/feePolicy';

const WAD = 10n ** 18n;
const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const COLLATERAL = '0x00000000000000000000000000000000000000c1';
const DEBT = '0x00000000000000000000000000000000000000d1';

const toWad = (value: string | number) =>
    BigInt(new Decimal(value).mul(new Decimal(10).pow(18)).toFixed(0));

function expectClose(actual: Decimal, expected: Decimal.Value, tolerance = '0.0000001') {
    assert.ok(
        actual.sub(new Decimal(expected)).abs().lte(new Decimal(tolerance)),
        `expected ${actual.toString()} to be within ${tolerance} of ${expected}`,
    );
}

function createSimpleExecutionHarness({
    feeByOperation = {},
    maxLeverage = Decimal(100),
    marketCollateralUsd = Decimal(100),
    tokenCollateralUsd = Decimal(100),
    userDebtUsd = Decimal(40),
}: {
    feeByOperation?: Partial<Record<'leverage-up' | 'deposit-and-leverage', bigint>>;
    maxLeverage?: Decimal;
    marketCollateralUsd?: Decimal;
    tokenCollateralUsd?: Decimal;
    userDebtUsd?: Decimal;
} = {}) {
    const feeCalls: FeePolicyContext[] = [];
    const quoteCalls: Array<{
        manager: string;
        inputToken: string;
        outputToken: string;
        inputAmount: bigint;
        slippage: bigint;
        feeBps: bigint;
        feeReceiver: string | undefined;
    }> = [];
    const leverageCalls: Array<{ action: unknown; slippage: bigint }> = [];
    const depositCalls: Array<{ assets: bigint; action: unknown; slippage: bigint }> = [];

    const token = Object.create(CToken.prototype) as CToken;
    const borrow = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
    const tokenCollateralShares = BigInt(
        tokenCollateralUsd.div(Decimal(2)).mul(new Decimal(10).pow(18)).toFixed(0),
    );

    const market = {
        address: '0x0000000000000000000000000000000000000abc',
        account: ACCOUNT,
        signer: { address: ACCOUNT },
        userCollateral: marketCollateralUsd,
        userDebt: userDebtUsd,
        cache: {
            user: {
                collateral: toWad(marketCollateralUsd.toString()),
                debt: toWad(userDebtUsd.toString()),
            },
        },
        setup: {
            chain: 'monad-mainnet',
            feePolicy: {
                feeReceiver: ACCOUNT,
                getFeeBps(ctx: FeePolicyContext) {
                    feeCalls.push(ctx);
                    return feeByOperation[ctx.operation as 'leverage-up' | 'deposit-and-leverage'] ?? 0n;
                },
            },
        },
    };

    const manager = {
        address: '0x0000000000000000000000000000000000000fed',
        getLeverageCalldata(action: unknown, slippage: bigint) {
            leverageCalls.push({ action, slippage });
            return '0xleverage';
        },
        getDepositAndLeverageCalldata(assets: bigint, action: unknown, slippage: bigint) {
            depositCalls.push({ assets, action, slippage });
            return '0xdeposit';
        },
    };

    const chainConfig = {
        dexAgg: {
            async quoteAction(
                managerAddress: string,
                inputToken: string,
                outputToken: string,
                inputAmount: bigint,
                slippage: bigint,
                feeBps: bigint,
                feeReceiver?: string,
            ) {
                quoteCalls.push({
                    manager: managerAddress,
                    inputToken,
                    outputToken,
                    inputAmount,
                    slippage,
                    feeBps,
                    feeReceiver,
                });
                return {
                    action: { route: 'simple', inputAmount },
                    quote: { min_out: 1_000n },
                };
            },
        },
    };

    (token as any).market = market;
    (token as any).cache = {
        maxLeverage: 100_000n,
        userCollateral: tokenCollateralShares,
        decimals: 18n,
        asset: { address: COLLATERAL, decimals: 18n },
        assetPrice: WAD,
        assetPriceLower: WAD,
        sharePrice: 2n * WAD,
        sharePriceLower: 2n * WAD,
        totalAssets: 200n * WAD,
        totalSupply: 100n * WAD,
    };
    Object.defineProperty(token, 'maxLeverage', {
        configurable: true,
        get: () => maxLeverage,
    });
    (token as any).address = COLLATERAL;
    (token as any).getPositionManager = () => manager;
    (token as any)._getLeverageSnapshot = async () => ({});
    (token as any)._checkPositionManagerApproval = async () => {};
    (token as any).oracleRoute = async (calldata: string) => ({ hash: calldata });
    (token as any).ensureUnderlyingAmount = async (amount: Decimal) => amount;
    Object.defineProperty(token, 'currentChainConfig', {
        configurable: true,
        get: () => chainConfig,
    });

    (borrow as any).market = market;
    (borrow as any).address = DEBT;
    (borrow as any).cache = {
        decimals: 18n,
        asset: { address: DEBT, decimals: 18n },
        assetPrice: WAD,
        assetPriceLower: WAD,
        sharePrice: WAD,
        sharePriceLower: WAD,
        totalAssets: WAD,
        totalSupply: WAD,
    };

    return { token, borrow, feeCalls, quoteCalls, leverageCalls, depositCalls };
}

describe('CToken simple leverage execution', () => {
    test('leverageUp uses leverage-up fee policy output in quote and calldata', async () => {
        const { token, borrow, feeCalls, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            feeByOperation: {
                'leverage-up': 11n,
                'deposit-and-leverage': 37n,
            },
        });

        const tx = await token.leverageUp(borrow, Decimal(2), 'simple', Decimal(0.01));

        assert.deepEqual(tx, { hash: '0xleverage' });
        assert.equal(feeCalls.length, 1);
        assert.equal(feeCalls[0]?.operation, 'leverage-up');
        expectClose(feeCalls[0]?.currentLeverage ?? Decimal(0), '1.6666666667');

        assert.deepEqual(quoteCalls, [{
            manager: '0x0000000000000000000000000000000000000fed',
            inputToken: DEBT,
            outputToken: COLLATERAL,
            inputAmount: toWad(20),
            slippage: 110n,
            feeBps: 11n,
            feeReceiver: ACCOUNT,
        }]);

        assert.equal(leverageCalls.length, 1);
        assert.deepEqual(leverageCalls[0]?.action, {
            borrowableCToken: DEBT,
            borrowAssets: toWad(20),
            cToken: COLLATERAL,
            expectedShares: token.virtualConvertToShares(1_000n, LEVERAGE.SHARES_BUFFER_BPS),
            swapAction: { route: 'simple', inputAmount: toWad(20) },
            auxData: '0x',
        });
        assert.equal(
            leverageCalls[0]?.slippage,
            FormatConverter.bpsToBpsWad(
                amplifyContractSlippage(110n, Decimal(1), 11n),
            ),
        );
    });

    test('depositAndLeverage uses deposit-and-leverage fee policy output and post-deposit target in quote and calldata', async () => {
        const { token, borrow, feeCalls, quoteCalls, depositCalls } = createSimpleExecutionHarness({
            feeByOperation: {
                'leverage-up': 11n,
                'deposit-and-leverage': 37n,
            },
        });

        const tx = await token.depositAndLeverage(Decimal(10), borrow, Decimal('1.60'), 'simple', Decimal(0.01));

        assert.deepEqual(tx, { hash: '0xdeposit' });
        assert.equal(feeCalls.length, 1);
        assert.equal(feeCalls[0]?.operation, 'deposit-and-leverage');
        expectClose(feeCalls[0]?.currentLeverage ?? Decimal(0), '1.5714285714');

        assert.deepEqual(quoteCalls, [{
            manager: '0x0000000000000000000000000000000000000fed',
            inputToken: DEBT,
            outputToken: COLLATERAL,
            inputAmount: toWad(2),
            slippage: 110n,
            feeBps: 37n,
            feeReceiver: ACCOUNT,
        }]);

        assert.equal(depositCalls.length, 1);
        assert.equal(depositCalls[0]?.assets, toWad(10));
        assert.deepEqual(depositCalls[0]?.action, {
            borrowableCToken: DEBT,
            borrowAssets: toWad(2),
            cToken: COLLATERAL,
            expectedShares: token.virtualConvertToShares(1_000n, LEVERAGE.SHARES_BUFFER_BPS),
            swapAction: { route: 'simple', inputAmount: toWad(2) },
            auxData: '0x',
        });
        assert.equal(
            depositCalls[0]?.slippage,
            FormatConverter.bpsToBpsWad(
                amplifyContractSlippage(110n, Decimal('0.6'), 37n),
            ),
        );
    });

    test('depositAndLeverage fails closed below the post-deposit baseline before quoting', async () => {
        const { token, borrow, quoteCalls, depositCalls } = createSimpleExecutionHarness({
            feeByOperation: {
                'deposit-and-leverage': 37n,
            },
        });

        const result = await token.depositAndLeverage(
            Decimal(10),
            borrow,
            Decimal('1.55'),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Target leverage must exceed the post-deposit leverage to borrow more.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(depositCalls, []);
    });

    test('depositAndLeverage caps requested leverage at maxLeverage before quote and calldata', async () => {
        const { token, borrow, feeCalls, quoteCalls, depositCalls } = createSimpleExecutionHarness({
            feeByOperation: {
                'deposit-and-leverage': 37n,
            },
            maxLeverage: Decimal('1.58'),
        });

        const tx = await token.depositAndLeverage(Decimal(10), borrow, Decimal('2.25'), 'simple', Decimal(0.01));

        assert.deepEqual(tx, { hash: '0xdeposit' });
        assert.equal(feeCalls.length, 1);
        expectClose(feeCalls[0]?.targetLeverage ?? Decimal(0), '1.58');
        assert.deepEqual(quoteCalls, [{
            manager: '0x0000000000000000000000000000000000000fed',
            inputToken: DEBT,
            outputToken: COLLATERAL,
            inputAmount: toWad('0.6'),
            slippage: 110n,
            feeBps: 37n,
            feeReceiver: ACCOUNT,
        }]);
        assert.equal(depositCalls.length, 1);
        assert.deepEqual(depositCalls[0]?.action, {
            borrowableCToken: DEBT,
            borrowAssets: toWad('0.6'),
            cToken: COLLATERAL,
            expectedShares: token.virtualConvertToShares(1_000n, LEVERAGE.SHARES_BUFFER_BPS),
            swapAction: { route: 'simple', inputAmount: toWad('0.6') },
            auxData: '0x',
        });
        assert.equal(
            depositCalls[0]?.slippage,
            FormatConverter.bpsToBpsWad(
                amplifyContractSlippage(110n, Decimal('0.58'), 37n),
            ),
        );
    });

    test('depositAndLeverage fails closed when maxLeverage drops below the post-deposit baseline', async () => {
        const { token, borrow, quoteCalls, depositCalls } = createSimpleExecutionHarness({
            feeByOperation: {
                'deposit-and-leverage': 37n,
            },
            maxLeverage: Decimal('1.55'),
        });

        const result = await token.depositAndLeverage(
            Decimal(10),
            borrow,
            Decimal('2.25'),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Target leverage must exceed the post-deposit leverage to borrow more.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(depositCalls, []);
    });

    test('leverageUp executes against aggregate market collateral when the position spans multiple collateral tokens', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            marketCollateralUsd: Decimal(100),
            tokenCollateralUsd: Decimal(50),
        });

        const tx = await token.leverageUp(borrow, Decimal(2), 'simple', Decimal(0.01));

        assert.deepEqual(tx, { hash: '0xleverage' });
        assert.deepEqual(quoteCalls, [{
            manager: '0x0000000000000000000000000000000000000fed',
            inputToken: DEBT,
            outputToken: COLLATERAL,
            inputAmount: toWad(20),
            slippage: 110n,
            feeBps: 0n,
            feeReceiver: undefined,
        }]);
        assert.equal(leverageCalls.length, 1);
        assert.deepEqual(leverageCalls[0]?.action, {
            borrowableCToken: DEBT,
            borrowAssets: toWad(20),
            cToken: COLLATERAL,
            expectedShares: token.virtualConvertToShares(1_000n, LEVERAGE.SHARES_BUFFER_BPS),
            swapAction: { route: 'simple', inputAmount: toWad(20) },
            auxData: '0x',
        });
    });
});
