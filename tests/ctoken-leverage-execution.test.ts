import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
    BorrowableCToken,
    CToken,
    AdaptorTypes,
    FormatConverter,
    LEVERAGE,
    Redstone,
    amplifyContractSlippage,
} from '../src';
import type { FeePolicyContext } from '../src/feePolicy';

const WAD = 10n ** 18n;
const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const RECEIVER = '0x00000000000000000000000000000000000000bb';
const COLLATERAL = '0x00000000000000000000000000000000000000c1';
const DEBT = '0x00000000000000000000000000000000000000d1';
const MANAGER = '0x0000000000000000000000000000000000000fed';

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
    borrowAsset = DEBT,
    borrowDebtCapAssets = 1_000n * WAD,
    borrowOutstandingDebtAssets = 0n,
    borrowLiquidityAssets = 1_000n * WAD,
    selectedDebtTokenBalance = toWad(userDebtUsd.toString()),
}: {
    feeByOperation?: Partial<Record<'leverage-up' | 'deposit-and-leverage' | 'leverage-down', bigint>>;
    maxLeverage?: Decimal;
    marketCollateralUsd?: Decimal;
    tokenCollateralUsd?: Decimal;
    userDebtUsd?: Decimal;
    borrowAsset?: string;
    borrowDebtCapAssets?: bigint;
    borrowOutstandingDebtAssets?: bigint;
    borrowLiquidityAssets?: bigint;
    selectedDebtTokenBalance?: bigint;
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
    const deleverageCalls: Array<{ action: unknown; slippage: bigint }> = [];
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
                    return feeByOperation[ctx.operation as 'leverage-up' | 'deposit-and-leverage' | 'leverage-down'] ?? 0n;
                },
            },
        },
    };

    const manager = {
        address: '0x0000000000000000000000000000000000000fed',
        type: 'simple',
        getLeverageCalldata(action: unknown, slippage: bigint) {
            leverageCalls.push({ action, slippage });
            return '0xleverage';
        },
        getDeleverageCalldata(action: unknown, slippage: bigint) {
            deleverageCalls.push({ action, slippage });
            return '0xdeleverage';
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
    (token as any).getPositionManagerDepositApprovalTarget = () => ({
        token: {
            symbol: 'WMON',
            allowance: async () => 10n ** 30n,
        },
        spender: manager.address,
        spenderLabel: 'simple PositionManager',
    });
    (token as any)._getLeverageSnapshot = async () => ({
        debtTokenBalance: selectedDebtTokenBalance,
        debtAssetPrice: WAD,
        collateralAssetPrice: WAD,
    });
    (token as any)._checkPositionManagerApproval = async () => {};
    (token as any)._checkTokenApproval = async () => {};
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
        asset: { address: borrowAsset, decimals: 18n },
        assetPrice: WAD,
        assetPriceLower: WAD,
        sharePrice: WAD,
        sharePriceLower: WAD,
        totalAssets: WAD,
        totalSupply: WAD,
        debtCap: borrowDebtCapAssets,
        debt: borrowOutstandingDebtAssets,
        liquidity: borrowLiquidityAssets,
    };
    (borrow as any).contract = {
        assetsHeld: async () => borrowLiquidityAssets,
        marketOutstandingDebt: async () => borrowOutstandingDebtAssets,
    };

    return { token, borrow, feeCalls, quoteCalls, leverageCalls, deleverageCalls, depositCalls };
}

describe('CToken simple leverage execution', () => {
    test('getPriceUpdates refreshes peer Redstone assets in the same market position', async (t) => {
        const originalBuildMultiCallAction = Redstone.buildMultiCallAction;
        const calls: string[] = [];
        const makeToken = (address: string, asset: string, adapters: bigint[]) => {
            const token = Object.create(CToken.prototype) as CToken;
            (token as any).address = address;
            Object.defineProperty(token, 'adapters', {
                get: () => adapters,
            });
            (token as any).cache = { asset: { address: asset } };
            (token as any).getAsset = (asErc20: boolean) => {
                if (asErc20) {
                    throw new Error('ERC20 asset not needed in this test');
                }
                return asset;
            };
            return token;
        };
        const current = makeToken(
            '0x0000000000000000000000000000000000000101',
            '0x0000000000000000000000000000000000000a01',
            [AdaptorTypes.REDSTONE_CORE],
        );
        const peer = makeToken(
            '0x0000000000000000000000000000000000000102',
            '0x0000000000000000000000000000000000000a02',
            [AdaptorTypes.REDSTONE_CORE],
        );
        const duplicateAsset = makeToken(
            '0x0000000000000000000000000000000000000103',
            '0x0000000000000000000000000000000000000a02',
            [AdaptorTypes.REDSTONE_CORE],
        );
        const chainlinkOnly = makeToken(
            '0x0000000000000000000000000000000000000104',
            '0x0000000000000000000000000000000000000a04',
            [AdaptorTypes.CHAINLINK],
        );
        (current as any).market = {
            tokens: [current, peer, duplicateAsset, chainlinkOnly],
        };

        Redstone.buildMultiCallAction = (async (token: CToken) => {
            calls.push(token.address);
            return {
                target: token.address,
                isPriceUpdate: true,
                data: `0x${token.address.slice(2).padStart(64, '0')}`,
            } as any;
        }) as typeof Redstone.buildMultiCallAction;

        t.after(() => {
            Redstone.buildMultiCallAction = originalBuildMultiCallAction;
        });

        const updates = await current.getPriceUpdates();

        assert.deepEqual(calls, [current.address, peer.address]);
        assert.deepEqual(
            updates.map((update) => update.target),
            [current.address, peer.address],
        );
    });

    test('oracleRoute targets manager multicall action when execution is submitted to a manager', async () => {
        const token = Object.create(CToken.prototype) as CToken;
        const multicalls: unknown[] = [];
        const executeCalls: Array<{ calldata: string; override: Record<string, unknown> }> = [];
        const events: string[] = [];

        (token as any).address = COLLATERAL;
        (token as any).market = {
            reloadUserData: async () => {
                events.push('reload');
            },
        };
        (token as any).requireSigner = () => ({ address: ACCOUNT });
        (token as any).getPriceUpdates = async () => [{
            target: '0x0000000000000000000000000000000000000aaa',
            isPriceUpdate: true,
            data: '0xprice',
        }];
        (token as any).getCallData = (method: string, args: unknown[]) => {
            assert.equal(method, 'multicall');
            multicalls.push(args);
            return '0xmulticall';
        };
        (token as any).executeCallData = async (calldata: string, override: Record<string, unknown>) => {
            executeCalls.push({ calldata, override });
            return {
                hash: '0xhash',
                wait: async () => {
                    events.push('wait');
                },
            };
        };

        await token.oracleRoute('0xaction' as any, { to: MANAGER });

        assert.deepEqual(multicalls, [[[
            {
                target: '0x0000000000000000000000000000000000000aaa',
                isPriceUpdate: true,
                data: '0xprice',
            },
            {
                target: MANAGER,
                isPriceUpdate: false,
                data: '0xaction',
            },
        ]]]);
        assert.deepEqual(executeCalls, [{
            calldata: '0xmulticall',
            override: { to: MANAGER },
        }]);
        assert.deepEqual(events, ['wait', 'reload']);
    });

    test('oracleRoute fails before native-value multicalls when oracle price updates are required', async () => {
        const token = Object.create(CToken.prototype) as CToken;

        (token as any).address = COLLATERAL;
        (token as any).market = {
            reloadUserData: async () => {
                throw new Error('reload should not run');
            },
        };
        (token as any).requireSigner = () => ({ address: ACCOUNT });
        (token as any).getPriceUpdates = async () => [{
            target: '0x0000000000000000000000000000000000000aaa',
            isPriceUpdate: true,
            data: '0xprice',
        }];
        (token as any).getCallData = () => {
            throw new Error('multicall calldata should not be encoded for native value');
        };
        (token as any).executeCallData = async () => {
            throw new Error('send should not run');
        };

        await assert.rejects(
            () => token.oracleRoute('0xnativezap' as any, { to: MANAGER, value: 1n }),
            /Native gas-token zaps cannot be combined with oracle price-update multicalls/i,
        );
    });

    test('oracleRoute refreshes an explicit receiver account after execution', async () => {
        const token = Object.create(CToken.prototype) as CToken;
        const reloads: Array<{ account: string; allowSignerMismatch: boolean | undefined }> = [];
        const events: string[] = [];

        (token as any).address = COLLATERAL;
        (token as any).market = {
            reloadUserData: async (account: string, options?: { allowSignerMismatch?: boolean }) => {
                events.push('reload');
                reloads.push({ account, allowSignerMismatch: options?.allowSignerMismatch });
            },
        };
        (token as any).requireSigner = () => ({ address: ACCOUNT });
        (token as any).getPriceUpdates = async () => [];
        (token as any).executeCallData = async () => ({
            hash: '0xhash',
            wait: async () => {
                events.push('wait');
            },
        });

        await token.oracleRoute('0xdeposit' as any, {}, RECEIVER as any);

        assert.deepEqual(events, ['wait', 'reload']);
        assert.deepEqual(reloads, [{
            account: RECEIVER,
            allowSignerMismatch: true,
        }]);
    });

    test('leverageDown fails closed for unsupported position manager types before quoting', async () => {
        const { token, borrow, quoteCalls } = createSimpleExecutionHarness();

        const result = await token.leverageDown(
            borrow,
            Decimal(2),
            Decimal('1.5'),
            'vault' as any,
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Unsupported position manager type',
        });
        assert.deepEqual(quoteCalls, []);
    });

    test('simple leverageUp fails closed for same-asset debt and collateral before quoting', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            borrowAsset: COLLATERAL,
        });

        const result = await token.leverageUp(
            borrow,
            Decimal(2),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Simple leverage requires distinct collateral and borrow assets.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(leverageCalls, []);
    });

    test('simple depositAndLeverage fails closed for same-asset debt and collateral before quoting', async () => {
        const { token, borrow, quoteCalls, depositCalls } = createSimpleExecutionHarness({
            borrowAsset: COLLATERAL,
        });

        const result = await token.depositAndLeverage(
            Decimal(10),
            borrow,
            Decimal('1.60'),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Simple leverage requires distinct collateral and borrow assets.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(depositCalls, []);
    });

    test('simple leverageDown fails closed for same-asset debt and collateral before quoting', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            borrowAsset: COLLATERAL,
        });

        const result = await token.leverageDown(
            borrow,
            Decimal(2),
            Decimal('1.5'),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Simple leverage requires distinct collateral and borrow assets.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(leverageCalls, []);
    });

    test('leverageDown fails closed when the selected token lacks enough collateral for the requested mixed-collateral deleverage', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            marketCollateralUsd: Decimal(100),
            tokenCollateralUsd: Decimal(20),
            userDebtUsd: Decimal(80),
        });

        const result = await token.leverageDown(
            borrow,
            token.getLeverage() ?? Decimal(1),
            Decimal(2),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Selected collateral token does not have enough posted collateral to reach the requested leverage target.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(leverageCalls, []);
    });

    test('full leverageDown fails closed when selected collateral cannot repay all debt', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            marketCollateralUsd: Decimal(100),
            tokenCollateralUsd: Decimal(20),
            userDebtUsd: Decimal(80),
        });

        const result = await token.leverageDown(
            borrow,
            token.getLeverage() ?? Decimal(1),
            Decimal(1),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Selected collateral token does not have enough posted collateral to fully deleverage.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(leverageCalls, []);
    });

    test('partial leverageDown fails closed when selected debt token cannot absorb the requested repayment', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            marketCollateralUsd: Decimal(100),
            tokenCollateralUsd: Decimal(100),
            userDebtUsd: Decimal(50),
            selectedDebtTokenBalance: toWad(5),
        });

        const result = await token.leverageDown(
            borrow,
            Decimal(2),
            Decimal('1.5'),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Selected borrow token debt is too small for the requested deleverage target.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(leverageCalls, []);
    });

    test('leverageUp fails closed when selected borrow token capacity is below the previewed borrow', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness({
            borrowDebtCapAssets: toWad(10),
            borrowOutstandingDebtAssets: 0n,
            borrowLiquidityAssets: toWad(100),
        });

        const result = await token.leverageUp(
            borrow,
            Decimal(2),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Selected borrow token does not have enough remaining debt capacity or liquidity for this leverage operation.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(leverageCalls, []);
    });

    test('leverageUp fails closed when the target rounds to zero borrow assets', async () => {
        const { token, borrow, quoteCalls, leverageCalls } = createSimpleExecutionHarness();
        const originalPreviewLeverageUp = token.previewLeverageUp.bind(token);
        (token as any).previewLeverageUp = (
            newLeverage: Decimal,
            previewBorrow: BorrowableCToken,
            depositAmount?: bigint,
            positionManagerType?: any,
        ) => ({
            ...originalPreviewLeverageUp(newLeverage, previewBorrow, depositAmount, positionManagerType),
            borrowAmount: Decimal(0),
            borrowAssets: 0n,
        });

        const result = await token.leverageUp(
            borrow,
            Decimal(2),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Target leverage must exceed the current leverage enough to borrow more.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(leverageCalls, []);
    });

    test('depositAndLeverage fails closed when selected borrow token liquidity is below the previewed borrow', async () => {
        const { token, borrow, quoteCalls, depositCalls } = createSimpleExecutionHarness({
            borrowDebtCapAssets: toWad(100),
            borrowOutstandingDebtAssets: 0n,
            borrowLiquidityAssets: toWad(1),
        });

        const result = await token.depositAndLeverage(
            Decimal(10),
            borrow,
            Decimal('1.60'),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.deepEqual(result, {
            success: false,
            error: 'Selected borrow token does not have enough remaining debt capacity or liquidity for this leverage operation.',
        });
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(depositCalls, []);
    });

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

    test('direct leverageUp does not require cToken delegate approval to the position manager', async () => {
        const { token, borrow } = createSimpleExecutionHarness();

        (token as any)._checkPositionManagerApproval = async () => {
            throw new Error('direct leverageUp should not require cToken delegation');
        };

        const tx = await token.leverageUp(borrow, Decimal(2), 'simple', Decimal(0.01));

        assert.deepEqual(tx, { hash: '0xleverage' });
    });

    test('depositAndLeverage blocks submission when the underlying asset is not approved to the selected position manager', async () => {
        const { token, borrow, quoteCalls, depositCalls } = createSimpleExecutionHarness();
        const allowanceChecks: Array<{ owner: string; spender: string }> = [];

        (token as any)._checkTokenApproval = (CToken.prototype as any)._checkTokenApproval;
        (token as any).getPositionManagerDepositApprovalTarget = () => ({
            token: {
                symbol: 'WMON',
                allowance: async (owner: string, spender: string) => {
                    allowanceChecks.push({ owner, spender });
                    return 0n;
                },
            },
            spender: '0x0000000000000000000000000000000000000fed',
            spenderLabel: 'simple PositionManager',
        });

        const result = await token.depositAndLeverage(
            Decimal(10),
            borrow,
            Decimal('1.60'),
            'simple',
            Decimal(0.01),
            true,
        );

        assert.equal(result.success, false);
        assert.match(result.error ?? '', /Please approve the WMON token for simple PositionManager/i);
        assert.deepEqual(allowanceChecks, [{
            owner: ACCOUNT,
            spender: '0x0000000000000000000000000000000000000fed',
        }]);
        assert.deepEqual(quoteCalls, []);
        assert.deepEqual(depositCalls, []);
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

    test('direct depositAndLeverage does not require cToken delegate approval to the position manager', async () => {
        const { token, borrow } = createSimpleExecutionHarness();

        (token as any)._checkPositionManagerApproval = async () => {
            throw new Error('direct depositAndLeverage should not require cToken delegation');
        };

        const tx = await token.depositAndLeverage(Decimal(10), borrow, Decimal('1.60'), 'simple', Decimal(0.01));

        assert.deepEqual(tx, { hash: '0xdeposit' });
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

    test('direct leverageDown does not require cToken delegate approval to the position manager', async () => {
        const { token, borrow, deleverageCalls } = createSimpleExecutionHarness();

        (token as any)._checkPositionManagerApproval = async () => {
            throw new Error('direct leverageDown should not require cToken delegation');
        };

        const tx = await token.leverageDown(
            borrow,
            Decimal('1.6666666667'),
            Decimal('1.5'),
            'simple',
            Decimal(0.01),
        );

        assert.deepEqual(tx, { hash: '0xdeleverage' });
        assert.equal(deleverageCalls.length, 1);
    });

    test('partial leverageDown fee-grosses collateral with ceil rounding', async () => {
        const { token, borrow, quoteCalls, deleverageCalls } = createSimpleExecutionHarness({
            feeByOperation: {
                'leverage-down': 4n,
            },
        });
        (token as any).previewLeverageDown = () => ({
            collateralAssetReduction: 999n,
            collateralAssetReductionUsd: Decimal('0.000000000000000999'),
            leverageDiff: Decimal('0.1'),
            newDebt: Decimal(0),
            newDebtInAssets: Decimal(0),
            newCollateral: Decimal(0),
            newCollateralInAssets: Decimal(0),
            feeBps: 4n,
            feeAssets: Decimal(0),
            feeUsd: Decimal(0),
        });

        const tx = await token.leverageDown(
            borrow,
            Decimal('1.6666666667'),
            Decimal('1.5'),
            'simple',
            Decimal(0.01),
        );

        assert.deepEqual(tx, { hash: '0xdeleverage' });
        assert.equal(quoteCalls[0]?.inputAmount, 1000n);
        assert.equal(
            (deleverageCalls[0]?.action as any).collateralAssets,
            1000n,
        );
    });

    test('full leverageDown fee and overhead sizing uses ceil rounding', async () => {
        const { token, borrow, quoteCalls, deleverageCalls } = createSimpleExecutionHarness({
            feeByOperation: {
                'leverage-down': 4n,
            },
            selectedDebtTokenBalance: 999n,
        });

        const tx = await token.leverageDown(
            borrow,
            Decimal('1.6666666667'),
            Decimal(1),
            'simple',
            Decimal(0.01),
        );

        assert.deepEqual(tx, { hash: '0xdeleverage' });
        assert.equal(quoteCalls[0]?.inputAmount, 1002n);
        assert.equal(
            (deleverageCalls[0]?.action as any).collateralAssets,
            1002n,
        );
    });
});
