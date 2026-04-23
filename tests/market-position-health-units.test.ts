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
});
