import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
    BorrowableCToken,
    CToken,
    FormatConverter,
    LEVERAGE,
    PositionManager,
    amplifyContractSlippage,
} from '../src';

const WAD = 10n ** 18n;
const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const COLLATERAL = '0x00000000000000000000000000000000000000c1';
const DEBT = '0x00000000000000000000000000000000000000d1';

function createPreviewStub(targetLeverage: Decimal) {
    return {
        currentLeverage: Decimal(1),
        effectiveCurrentLeverage: Decimal(1),
        targetLeverage,
        borrowAmount: Decimal('12.5'),
        borrowAssets: 12_500_000_000_000_000_000n,
        debtIncrease: Decimal('12.5'),
        debtIncreaseInAssets: Decimal('12.5'),
        newDebt: Decimal('12.5'),
        newDebtInAssets: Decimal('12.5'),
        collateralIncrease: Decimal('12.5'),
        collateralIncreaseInAssets: Decimal('12.5'),
        newCollateral: Decimal('12.5'),
        newCollateralInAssets: Decimal('12.5'),
        feeBps: 0n,
        feeAssets: Decimal(0),
        feeUsd: Decimal(0),
    };
}

function createVaultExecutionHarness() {
    const token = Object.create(CToken.prototype) as CToken;
    const borrow = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
    const leverageCalls: Array<{ action: unknown; slippage: bigint }> = [];
    const depositCalls: Array<{ assets: bigint; action: unknown; slippage: bigint }> = [];

    const manager = {
        address: '0x0000000000000000000000000000000000000abc',
        getLeverageCalldata(action: unknown, slippage: bigint) {
            leverageCalls.push({ action, slippage });
            return '0xleverage';
        },
        getDepositAndLeverageCalldata(assets: bigint, action: unknown, slippage: bigint) {
            depositCalls.push({ assets, action, slippage });
            return '0xdeposit';
        },
    };

    (token as any).market = {
        address: '0x0000000000000000000000000000000000000def',
        signer: { address: ACCOUNT },
        cache: { user: { debt: 0n } },
        setup: {
            chain: 'monad-mainnet',
            feePolicy: {
                feeReceiver: ACCOUNT,
                getFeeBps: () => 0n,
            },
        },
    };
    (token as any).cache = {
        asset: { address: COLLATERAL, decimals: 18n },
        decimals: 18n,
        maxLeverage: 100_000n,
        userCollateral: 1n,
        assetPrice: WAD,
        assetPriceLower: WAD,
        sharePrice: WAD,
        sharePriceLower: WAD,
        totalAssets: WAD,
        totalSupply: WAD,
    };
    (token as any).address = COLLATERAL;
    (token as any).requireSigner = () => ({ address: ACCOUNT });
    (token as any).getPositionManager = () => manager;
    (token as any)._getLeverageSnapshot = async () => ({});
    (token as any)._checkPositionManagerApproval = async () => {};
    (token as any).oracleRoute = async () => ({ hash: '0x1' });
    (token as any).ensureUnderlyingAmount = async (amount: Decimal) => amount;
    (token as any).previewLeverageUp = (_newLeverage: Decimal) => createPreviewStub(_newLeverage);
    (token as any).previewDepositAndLeverage = (_newLeverage: Decimal) => createPreviewStub(_newLeverage);

    (borrow as any).market = (token as any).market;
    (borrow as any).address = DEBT;
    (borrow as any).cache = {
        asset: { address: DEBT, decimals: 18n },
        decimals: 18n,
        assetPrice: WAD,
        assetPriceLower: WAD,
        sharePrice: WAD,
        sharePriceLower: WAD,
        totalAssets: WAD,
        totalSupply: WAD,
    };

    return { token, borrow, leverageCalls, depositCalls };
}

describe('vault leverage behavior', () => {
    test('leverageUp vault applies the drift slippage buffer', async () => {
        const { token, borrow, leverageCalls } = createVaultExecutionHarness();
        const original = PositionManager.getVaultExpectedShares;
        PositionManager.getVaultExpectedShares = async () => 123n;

        try {
            await token.leverageUp(borrow, Decimal(3), 'vault', Decimal(0.01));
        } finally {
            PositionManager.getVaultExpectedShares = original;
        }

        assert.equal(leverageCalls.length, 1);
        const expectedSlippage = FormatConverter.bpsToBpsWad(
            amplifyContractSlippage(110n, Decimal(2), LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS),
        );
        assert.equal(leverageCalls[0]?.slippage, expectedSlippage);
        assert.deepEqual(leverageCalls[0]?.action, {
            borrowableCToken: DEBT,
            borrowAssets: 12_500_000_000_000_000_000n,
            cToken: COLLATERAL,
            expectedShares: 123n,
            swapAction: PositionManager.emptySwapAction(),
            auxData: '0x',
        });
    });

    test('leverageUp native-vault shares the same drift buffer behavior', async () => {
        const { token, borrow, leverageCalls } = createVaultExecutionHarness();
        const original = PositionManager.getVaultExpectedShares;
        PositionManager.getVaultExpectedShares = async () => 321n;

        try {
            await token.leverageUp(borrow, Decimal(3), 'native-vault', Decimal(0.01));
        } finally {
            PositionManager.getVaultExpectedShares = original;
        }

        assert.equal(leverageCalls.length, 1);
        const expectedSlippage = FormatConverter.bpsToBpsWad(
            amplifyContractSlippage(110n, Decimal(2), LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS),
        );
        assert.equal(leverageCalls[0]?.slippage, expectedSlippage);
        assert.equal((leverageCalls[0]?.action as any).expectedShares, 321n);
    });

    test('depositAndLeverage vault applies the drift slippage buffer', async () => {
        const { token, borrow, depositCalls } = createVaultExecutionHarness();
        const original = PositionManager.getVaultExpectedShares;
        PositionManager.getVaultExpectedShares = async () => 456n;

        try {
            await token.depositAndLeverage(Decimal(5), borrow, Decimal(3), 'vault', Decimal(0.01));
        } finally {
            PositionManager.getVaultExpectedShares = original;
        }

        assert.equal(depositCalls.length, 1);
        const expectedSlippage = FormatConverter.bpsToBpsWad(
            amplifyContractSlippage(110n, Decimal(2), LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS),
        );
        assert.equal(depositCalls[0]?.slippage, expectedSlippage);
        assert.equal(depositCalls[0]?.assets, 5_000_000_000_000_000_000n);
        assert.equal((depositCalls[0]?.action as any).expectedShares, 456n);
    });

    test('getVaultExpectedShares buffers the inner previewDeposit result before convertToShares', async () => {
        const depositToken = Object.create(CToken.prototype) as CToken;
        const borrowToken = Object.create(CToken.prototype) as CToken;
        const convertCalls: bigint[] = [];

        (depositToken as any).cache = {
            asset: { address: COLLATERAL, decimals: 18n },
            decimals: 18n,
        };
        (depositToken as any).getUnderlyingVault = () => ({
            previewDeposit: async (assets: bigint) => {
                assert.equal(assets, 1_000_000_000_000_000_000n);
                return 50_000n;
            },
        });
        (depositToken as any).convertToShares = async (assets: bigint) => {
            convertCalls.push(assets);
            return assets + 1n;
        };

        (borrowToken as any).cache = {
            asset: { address: DEBT, decimals: 18n },
            decimals: 18n,
        };

        const expectedShares = await PositionManager.getVaultExpectedShares(
            depositToken,
            borrowToken,
            Decimal(1),
        );

        assert.equal(expectedShares, 49_991n);
        assert.deepEqual(convertCalls, [49_990n]);
    });
});
