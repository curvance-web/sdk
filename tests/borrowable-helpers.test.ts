import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { BorrowableCToken } from "../src/classes/BorrowableCToken";

const WAD = 10n ** 18n;
const OWNER = "0x00000000000000000000000000000000000000aa";
const CTOKEN = "0x00000000000000000000000000000000000000c1";
const ASSET = "0x00000000000000000000000000000000000000d1";

test("BorrowableCToken.getMaxBorrowable clamps negative and non-finite outputs to zero", async () => {
    const token = Object.create(BorrowableCToken.prototype) as BorrowableCToken;

    (token as any).market = {
        userRemainingCredit: new Decimal(-5),
    };
    (token as any).convertUsdToTokens = () => {
        throw new Error("negative credit should not attempt conversion");
    };

    assert.ok((await token.getMaxBorrowable()).eq(0));
    assert.ok((await token.getMaxBorrowable(true)).eq(0));

    (token as any).market = {
        userRemainingCredit: new Decimal(5),
    };
    (token as any).convertUsdToTokens = () => new Decimal(Infinity);

    assert.ok((await token.getMaxBorrowable()).eq(0));

    (token as any).convertUsdToTokens = () => new Decimal(2.5);

    assert.ok((await token.getMaxBorrowable()).eq(2.5));
    assert.ok((await token.getMaxBorrowable(true)).eq(5));
});

function createRepayToken(allowance: bigint, projectedDebt: bigint = 0n) {
    const token = Object.create(BorrowableCToken.prototype) as BorrowableCToken & {
        __state: {
            allowanceChecks: Array<{ owner: string; spender: string }>;
            debtChecks: Array<{ account: string; token: string; timestamp: bigint }>;
            callDataCalls: Array<{ method: string; args: unknown[] }>;
            oracleRouteCalled: boolean;
        };
    };

    (token as any).address = CTOKEN;
    (token as any).cache = {
        symbol: "cUSDC",
        asset: {
            address: ASSET,
            decimals: 18n,
        },
    };
    token.__state = {
        allowanceChecks: [],
        debtChecks: [],
        callDataCalls: [],
        oracleRouteCalled: false,
    };
    (token as any).getAccountOrThrow = () => OWNER;
    (token as any).getAsset = () => ({
        address: ASSET,
        symbol: "USDC",
        allowance: async (owner: string, spender: string) => {
            token.__state.allowanceChecks.push({ owner, spender });
            return allowance;
        },
    });
    (token as any).market = {
        reader: {
            debtBalanceAtTimestamp: async (account: string, ctoken: string, timestamp: bigint) => {
                token.__state.debtChecks.push({ account, token: ctoken, timestamp });
                return projectedDebt;
            },
        },
    };
    (token as any).getCallData = (method: string, args: unknown[]) => {
        token.__state.callDataCalls.push({ method, args });
        return "0xdeadbeef";
    };
    (token as any).oracleRoute = async () => {
        token.__state.oracleRouteCalled = true;
        return {} as any;
    };

    return token;
}

test("BorrowableCToken.repay fails before submit when debt-token allowance is missing", async () => {
    const token = createRepayToken(4n * WAD);

    await assert.rejects(
        () => token.repay(Decimal(5)),
        /Please approve the USDC token for cUSDC repay/i,
    );

    assert.deepEqual(token.__state.allowanceChecks, [{ owner: OWNER, spender: CTOKEN }]);
    assert.deepEqual(token.__state.callDataCalls, []);
    assert.equal(token.__state.oracleRouteCalled, false);
});

test("BorrowableCToken.repay preflights projected full-repay debt before encoding amount=0", async () => {
    const originalDateNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    const insufficient = createRepayToken(100n * WAD, 101n * WAD);

    try {
        await assert.rejects(
            () => insufficient.repay(Decimal(0)),
            /Please approve the USDC token for cUSDC repay/i,
        );
        assert.deepEqual(insufficient.__state.debtChecks, [{
            account: OWNER,
            token: CTOKEN,
            timestamp: 1_700_000_100n,
        }]);
        assert.equal(insufficient.__state.oracleRouteCalled, false);

        const sufficient = createRepayToken(101n * WAD, 101n * WAD);
        await sufficient.repay(Decimal(0));

        assert.deepEqual(sufficient.__state.callDataCalls, [{
            method: "repay",
            args: [0n],
        }]);
        assert.equal(sufficient.__state.oracleRouteCalled, true);
    } finally {
        Date.now = originalDateNow;
    }
});

test("BorrowableCToken refresh helpers use assetsHeld as the IRM denominator", async () => {
    const token = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
    const calls: Array<{ method: string; assetsHeld: bigint; debt: bigint; fee?: bigint }> = [];
    let assetsHeldCalls = 0;
    let debtCalls = 0;

    (token as any).cache = {
        totalAssets: 100n,
        liquidity: 99n,
        debt: 40n,
    };
    (token as any).contract = {
        assetsHeld: async () => {
            assetsHeldCalls += 1;
            return 60n;
        },
        marketOutstandingDebt: async () => {
            debtCalls += 1;
            return 40n;
        },
        interestFee: async () => 2n,
    };
    (token as any).dynamicIRM = async () => ({
        borrowRate: async (assetsHeld: bigint, debt: bigint) => {
            calls.push({ method: "borrowRate", assetsHeld, debt });
            return 1n;
        },
        predictedBorrowRate: async (assetsHeld: bigint, debt: bigint) => {
            calls.push({ method: "predictedBorrowRate", assetsHeld, debt });
            return 2n;
        },
        utilizationRate: async (assetsHeld: bigint, debt: bigint) => {
            calls.push({ method: "utilizationRate", assetsHeld, debt });
            return 3n;
        },
        supplyRate: async (assetsHeld: bigint, debt: bigint, fee: bigint) => {
            calls.push({ method: "supplyRate", assetsHeld, debt, fee });
            return 4n;
        },
    });

    assert.equal(await token.fetchBorrowRate(), 1n);
    assert.equal(await token.fetchPredictedBorrowRate(), 2n);
    assert.equal(await token.fetchUtilizationRate(), 3n);
    assert.equal(await token.fetchSupplyRate(), 4n);
    assert.equal(await token.fetchLiquidity(), 60n);

    assert.deepEqual(calls, [
        { method: "borrowRate", assetsHeld: 60n, debt: 40n },
        { method: "predictedBorrowRate", assetsHeld: 60n, debt: 40n },
        { method: "utilizationRate", assetsHeld: 60n, debt: 40n },
        { method: "supplyRate", assetsHeld: 60n, debt: 40n, fee: 2n },
    ]);
    assert.equal((token as any).cache.borrowRate, 1n);
    assert.equal((token as any).cache.predictedBorrowRate, 2n);
    assert.equal((token as any).cache.utilizationRate, 3n);
    assert.equal((token as any).cache.supplyRate, 4n);
    assert.equal((token as any).cache.liquidity, 60n);
    assert.equal(assetsHeldCalls, 5);
    assert.equal(debtCalls, 4);
});
