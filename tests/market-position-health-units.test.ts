import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Decimal from 'decimal.js';
import { CToken, Market, UINT256_MAX } from '../src';
import { BorrowableCToken } from '../src/classes/BorrowableCToken';

const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const MARKET = '0x00000000000000000000000000000000000000bb';
const CTOKEN = '0x00000000000000000000000000000000000000cc';
const WAD = 10n ** 18n;

const toWad = (value: string | number) =>
    BigInt(new Decimal(value).mul(new Decimal(10).pow(18)).toFixed(0));

describe('Market position health units', () => {
    test('previewPositionHealthRedeem passes underlying assets to the reader while enforcing share balance locally', async () => {
        const market = Object.create(Market.prototype) as Market;
        const token = Object.create(CToken.prototype) as CToken;
        let capturedCollateralAssets: bigint | null = null;

        (market as any).address = MARKET;
        (market as any).account = ACCOUNT;
        (market as any).getAccountOrThrow = () => ACCOUNT;
        (market as any).reader = {
            getPositionHealth: async (
                _market: string,
                _account: string,
                _ctoken: string,
                _borrowable: string,
                _isDeposit: boolean,
                collateralAssets: bigint,
            ) => {
                capturedCollateralAssets = collateralAssets;
                return {
                    positionHealth: 2n * WAD,
                    errorCodeHit: false,
                };
            },
        };

        (token as any).address = CTOKEN;
        (token as any).cache = {
            asset: { decimals: 18 },
            userCollateral: toWad(10),
        };
        (token as any).convertTokenInputToShares = (amount: Decimal.Value) =>
            BigInt(new Decimal(amount).div(2).mul(new Decimal(10).pow(18)).toFixed(0));

        const result = await market.previewPositionHealthRedeem(token, Decimal(10));

        assert.equal(capturedCollateralAssets, toWad(10));
        assert.equal(result?.toString(), '1');
    });

    test('previewPositionHealthRedeem still rejects when the redeem shares exceed posted collateral', async () => {
        const market = Object.create(Market.prototype) as Market;
        const token = Object.create(CToken.prototype) as CToken;

        (market as any).address = MARKET;
        (market as any).account = ACCOUNT;
        (market as any).getAccountOrThrow = () => ACCOUNT;
        (market as any).reader = {
            getPositionHealth: async () => {
                throw new Error('reader should not be called');
            },
        };

        (token as any).address = CTOKEN;
        (token as any).cache = {
            asset: { decimals: 18 },
            userCollateral: toWad(4),
        };
        (token as any).convertTokenInputToShares = (amount: Decimal.Value) =>
            BigInt(new Decimal(amount).div(2).mul(new Decimal(10).pow(18)).toFixed(0));

        await assert.rejects(
            market.previewPositionHealthRedeem(token, Decimal(10)),
            /Insufficient collateral/,
        );
    });

    test('previewPositionHealthRedeem respects token user-cache freshness', async () => {
        const market = Object.create(Market.prototype) as Market;
        const token = Object.create(CToken.prototype) as CToken;

        (market as any).address = MARKET;
        (market as any).account = ACCOUNT;
        (market as any).getAccountOrThrow = () => ACCOUNT;
        (market as any).reader = {
            getPositionHealth: async () => {
                throw new Error('reader should not be called with stale token cache');
            },
        };

        (token as any).address = CTOKEN;
        (token as any).market = market;
        (token as any).cache = {
            asset: { decimals: 18 },
            userCollateral: toWad(100),
        };
        (token as any).convertTokenInputToShares = () => toWad(1);
        token.invalidateUserCache(['userCollateral' as any]);

        await assert.rejects(
            market.previewPositionHealthRedeem(token, Decimal(1)),
            /summary-only refresh on market/i,
        );
    });

    test('previewPositionHealthRepay passes the reader closeout sentinel for Decimal(0)', async () => {
        const market = Object.create(Market.prototype) as Market;
        const token = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
        let capturedDebtAssets: bigint | null = null;

        (market as any).address = MARKET;
        (market as any).account = ACCOUNT;
        (market as any).getAccountOrThrow = () => ACCOUNT;
        (market as any).reader = {
            getPositionHealth: async (
                _market: string,
                _account: string,
                _depositToken: string,
                _borrowToken: string,
                _isDeposit: boolean,
                _collateralAssets: bigint,
                _isRepay: boolean,
                debtAssets: bigint,
            ) => {
                capturedDebtAssets = debtAssets;
                return {
                    positionHealth: 2n * WAD,
                    errorCodeHit: false,
                };
            },
        };

        (token as any).address = CTOKEN;
        (token as any).cache = {
            decimals: 18n,
            asset: { decimals: 18 },
        };
        const result = await market.previewPositionHealthRepay(token, Decimal(0));

        assert.equal(capturedDebtAssets, UINT256_MAX);
        assert.equal(result?.toString(), '1');
    });

    test('previewAssetImpact recomputes borrow impact with the new borrow included in utilization', async () => {
        const market = Object.create(Market.prototype) as Market;
        const collateral = Object.create(CToken.prototype) as CToken;
        const debt = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
        let borrowRateArgs: { assetsHeld: bigint; debt: bigint } | null = null;

        (market as any).reader = {
            previewAssetImpact: async () => ({
                supply: 0n,
                borrow: 0n,
            }),
        };
        (collateral as any).address = '0x00000000000000000000000000000000000000c1';
        (collateral as any).cache = { asset: { decimals: 0n } };
        (collateral as any).convertTokensToUsd = (amount: bigint) => new Decimal(amount.toString());
        (debt as any).address = '0x00000000000000000000000000000000000000d1';
        (debt as any).cache = { asset: { decimals: 0n } };
        (debt as any).convertTokensToUsd = (amount: bigint) => new Decimal(amount.toString());
        (debt as any).contract = {
            assetsHeld: async () => 100n,
            marketOutstandingDebt: async () => 20n,
        };
        (debt as any).dynamicIRM = async () => ({
            borrowRate: async (assetsHeld: bigint, nextDebt: bigint) => {
                borrowRateArgs = { assetsHeld, debt: nextDebt };
                return WAD;
            },
        });

        const result = await market.previewAssetImpact(
            ACCOUNT as any,
            collateral,
            debt,
            Decimal(0),
            Decimal(30),
            'year' as any,
        );

        assert.deepEqual(borrowRateArgs, { assetsHeld: 70n, debt: 50n });
        assert.ok(result.borrow.percent.gt(0));
        assert.ok(result.borrow.change.gt(0));
    });

    test('previewPositionHealthLeverageDown removes fee-gross collateral but credits net repay output', async () => {
        const market = Object.create(Market.prototype) as Market;
        const deposit = Object.create(CToken.prototype) as CToken;
        const borrow = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
        let capturedDepositAmount: Decimal | null = null;
        let capturedDebtAmount: Decimal | null = null;
        let capturedBorrowArg: BorrowableCToken | null = null;

        (market as any).previewPositionHealth = async (
            _deposit: CToken,
            _borrow: BorrowableCToken,
            _isDeposit: boolean,
            depositAmount: Decimal,
            _isRepay: boolean,
            debtAmount: Decimal,
        ) => {
            capturedDepositAmount = depositAmount;
            capturedDebtAmount = debtAmount;
            return new Decimal(2);
        };
        (deposit as any).cache = { asset: { decimals: 0n } };
        (deposit as any).convertTokensToUsd = (amount: bigint) => new Decimal(amount.toString());
        (deposit as any).previewLeverageDown = (
            _newLeverage: Decimal,
            _currentLeverage: Decimal,
            borrowArg?: BorrowableCToken,
        ) => {
            capturedBorrowArg = borrowArg ?? null;
            return {
                collateralAssetReduction: 10_000n,
                feeBps: 4n,
            };
        };
        (borrow as any).convertUsdToTokens = (amount: Decimal) => amount;

        const result = await market.previewPositionHealthLeverageDown(
            deposit,
            borrow,
            Decimal('1.5'),
            Decimal(2),
        );

        assert.equal(result?.toString(), '2');
        assert.equal(capturedBorrowArg, borrow);
        assert.notEqual(capturedDepositAmount, null);
        assert.equal((capturedDepositAmount as unknown as Decimal).toString(), '10004');
        assert.notEqual(capturedDebtAmount, null);
        assert.equal((capturedDebtAmount as unknown as Decimal).toString(), '10000');
    });

    test('cooldown helpers return null for expired unlock times', async () => {
        const originalNow = Date.now;
        Date.now = () => 2_000_000_000;

        try {
            const market = Object.create(Market.prototype) as Market;
            const active = Object.create(Market.prototype) as Market;
            const expired = Object.create(Market.prototype) as Market;
            const sentinel = Object.create(Market.prototype) as Market;
            const cooldownLength = 1200n;

            for (const [instance, address] of [
                [market, MARKET],
                [active, '0x00000000000000000000000000000000000000a1'],
                [expired, '0x00000000000000000000000000000000000000a2'],
                [sentinel, '0x00000000000000000000000000000000000000a3'],
            ] as const) {
                (instance as any).address = address;
                (instance as any).cache = {
                    static: { cooldownLength },
                    user: { cooldown: 0n },
                };
            }

            (market as any).cache.user.cooldown = 2_000_010n;
            assert.equal(market.cooldown?.getTime(), 2_000_010_000);
            (market as any).cache.user.cooldown = 1_999_999n;
            assert.equal(market.cooldown, null);
            (market as any).cache.user.cooldown = cooldownLength;
            assert.equal(market.cooldown, null);

            (market as any).account = ACCOUNT;
            (market as any).contract = {
                accountAssets: async () => 1_998_700n,
                MIN_HOLD_PERIOD: async () => cooldownLength,
            };
            assert.equal(await market.expiresAt(ACCOUNT as any), null);
            (market as any).contract.accountAssets = async () => 1_999_000n;
            assert.equal((await market.expiresAt(ACCOUNT as any))?.getTime(), 2_000_200_000);

            (market as any).reader = {
                marketMultiCooldown: async () => [
                    2_000_200n,
                    1_999_999n,
                    cooldownLength,
                ],
            };
            const result = await market.multiHoldExpiresAt([active, expired, sentinel]);
            assert.equal(result[active.address]?.getTime(), 2_000_200_000);
            assert.equal(result[expired.address], null);
            assert.equal(result[sentinel.address], null);
        } finally {
            Date.now = originalNow;
        }
    });
});
