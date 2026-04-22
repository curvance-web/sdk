import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { CToken } from '../src';

type RemovalHarness = {
    token: CToken;
    getCallDataCalls: Array<{ method: string; shares: bigint }>;
    oracleRouteCalls: string[];
    fetchUserCollateralCalls: number;
    maxRedemptionCalls: Array<{ account: string; bufferTime: bigint }>;
};

function createRemovalHarness({
    maxCollateralShares,
    maxUncollateralizedShares = 0n,
    convertedShares,
    totalAssets = 100_000n,
    totalSupply = 100_000n,
    userDebt = new Decimal(1),
    errorCodeHit = false,
}: {
    maxCollateralShares: bigint;
    maxUncollateralizedShares?: bigint;
    convertedShares: bigint;
    totalAssets?: bigint;
    totalSupply?: bigint;
    userDebt?: Decimal;
    errorCodeHit?: boolean;
}): RemovalHarness {
    const token = Object.create(CToken.prototype) as CToken;
    const getCallDataCalls: Array<{ method: string; shares: bigint }> = [];
    const oracleRouteCalls: string[] = [];
    const maxRedemptionCalls: Array<{ account: string; bufferTime: bigint }> = [];
    let fetchUserCollateralCalls = 0;

    (token as any).cache = {
        totalAssets,
        totalSupply,
        asset: { decimals: 18n },
        decimals: 18n,
    };
    (token as any).market = {
        userDebt,
        account: '0x00000000000000000000000000000000000000aa',
        signer: null,
        reader: {
            maxRedemptionOf: async (account: string, _ctoken: CToken, bufferTime: bigint) => {
                maxRedemptionCalls.push({ account, bufferTime });
                return {
                    maxCollateralizedShares: maxCollateralShares,
                    maxUncollateralizedShares,
                    errorCodeHit,
                };
            },
        },
    };
    (token as any).fetchUserCollateral = async () => {
        fetchUserCollateralCalls += 1;
        return maxCollateralShares;
    };
    (token as any).convertTokenInputToShares = () => convertedShares;
    (token as any).getCallData = (method: string, [shares]: [bigint]) => {
        getCallDataCalls.push({ method, shares });
        return `0xremove${shares.toString()}`;
    };
    (token as any).oracleRoute = async (calldata: string) => {
        oracleRouteCalls.push(calldata);
        return { hash: '0xRemoveCollateral' };
    };

    return {
        token,
        getCallDataCalls,
        oracleRouteCalls,
        get fetchUserCollateralCalls() {
            return fetchUserCollateralCalls;
        },
        maxRedemptionCalls,
    };
}

describe('CToken collateral removal APIs', () => {
    test('maxRemovableCollateral returns the explicit reader value in shares', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 99_950n,
            convertedShares: 1n,
        });

        const shares = await harness.token.maxRemovableCollateral(true);

        assert.equal(shares, 99_950n);
        assert.deepEqual(harness.maxRedemptionCalls, [
            {
                account: '0x00000000000000000000000000000000000000aa',
                bufferTime: 0n,
            },
        ]);
    });

    test('maxRemovableCollateral converts reader shares into asset units', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 50_000n,
            convertedShares: 1n,
            totalAssets: 200_000n,
            totalSupply: 100_000n,
        });

        const assets = await harness.token.maxRemovableCollateral(false);

        assert.equal(assets.equals(new Decimal('0.0000000000001')), true);
    });

    test('maxRemovableCollateral ignores the uncollateralized redemption slice', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 25_000n,
            maxUncollateralizedShares: 900_000n,
            convertedShares: 1n,
        });

        const shares = await harness.token.maxRemovableCollateral(true);

        assert.equal(shares, 25_000n);
        assert.deepEqual(harness.maxRedemptionCalls, [
            {
                account: '0x00000000000000000000000000000000000000aa',
                bufferTime: 0n,
            },
        ]);
    });

    test('maxRemovableCollateral fails closed when the reader signals an oracle error', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 25_000n,
            convertedShares: 1n,
            errorCodeHit: true,
        });

        await assert.rejects(
            harness.token.maxRemovableCollateral(true),
            /Error fetching max redemption\. Possible stale price or other issues\.\.\./,
        );
    });

    test('caps near-max exact removal to the safe removable collateral instead of full posted collateral', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 99_950n,
            convertedShares: 99_901n,
        });

        const tx = await harness.token.removeCollateralExact(new Decimal('99.901'));

        assert.deepEqual(harness.maxRedemptionCalls, [
            {
                account: '0x00000000000000000000000000000000000000aa',
                bufferTime: 100n,
            },
        ]);
        assert.deepEqual(harness.getCallDataCalls, [
            { method: 'removeCollateral', shares: 99_950n },
        ]);
        assert.deepEqual(harness.oracleRouteCalls, ['0xremove99950']);
        assert.equal(harness.fetchUserCollateralCalls, 1);
        assert.deepEqual(tx, { hash: '0xRemoveCollateral' });
    });

    test('removeMaxCollateral resolves to the explicit safe removable collateral when debt exists', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 99_950n,
            convertedShares: 1n,
        });

        await harness.token.removeMaxCollateral();

        assert.deepEqual(harness.getCallDataCalls, [
            { method: 'removeCollateral', shares: 99_950n },
        ]);
        assert.deepEqual(harness.oracleRouteCalls, ['0xremove99950']);
    });

    test('removeMaxCollateral uses no execution buffer when the account has no debt', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 88_000n,
            convertedShares: 1n,
            userDebt: new Decimal(0),
        });

        await harness.token.removeMaxCollateral();

        assert.deepEqual(harness.maxRedemptionCalls, [
            {
                account: '0x00000000000000000000000000000000000000aa',
                bufferTime: 0n,
            },
        ]);
        assert.deepEqual(harness.getCallDataCalls, [
            { method: 'removeCollateral', shares: 88_000n },
        ]);
    });

    test('preserves partial exact removals that are materially below the safe cap', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 80_000n,
            convertedShares: 70_000n,
        });

        await harness.token.removeCollateralExact(new Decimal(70));

        assert.deepEqual(harness.getCallDataCalls, [
            { method: 'removeCollateral', shares: 70_000n },
        ]);
        assert.deepEqual(harness.oracleRouteCalls, ['0xremove70000']);
    });

    test('still removes the full posted collateral when the safe removable amount equals the posted balance', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 100_000n,
            convertedShares: 99_950n,
        });

        await harness.token.removeCollateralExact(new Decimal('99.95'));

        assert.deepEqual(harness.getCallDataCalls, [
            { method: 'removeCollateral', shares: 100_000n },
        ]);
        assert.deepEqual(harness.oracleRouteCalls, ['0xremove100000']);
    });

    test('throws before submitting a zero-share max removal', async () => {
        const harness = createRemovalHarness({
            maxCollateralShares: 0n,
            convertedShares: 1n,
        });

        await assert.rejects(
            harness.token.removeMaxCollateral(),
            /No removable collateral available\./,
        );
        assert.deepEqual(harness.getCallDataCalls, []);
        assert.deepEqual(harness.oracleRouteCalls, []);
    });
});
