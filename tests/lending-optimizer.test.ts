import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { Interface } from "ethers";
import { LendingOptimizer, PositionManager } from "../src";
import type { address } from "../src/types";

const OPTIMIZER = "0x00000000000000000000000000000000000000a1" as address;
const ASSET = "0x00000000000000000000000000000000000000a2" as address;
const SIGNER = "0x00000000000000000000000000000000000000a3" as address;
const RECEIVER = "0x00000000000000000000000000000000000000a4" as address;
const OWNER = "0x00000000000000000000000000000000000000a5" as address;
const CTOKEN = "0x00000000000000000000000000000000000000c1" as address;
const BORROWABLE = "0x00000000000000000000000000000000000000b1" as address;
const SWAP_TARGET = "0x00000000000000000000000000000000000000d1" as address;

const optimizerInterface = new Interface([
    "function deposit(uint256 assets,address receiver)",
    "function withdraw(uint256 assets,address receiver,address owner)",
    "function redeem(uint256 shares,address receiver,address owner)",
]);

const positionManagerInterface = new Interface([
    "function leverage((address borrowableCToken,uint256 borrowAssets,address cToken,uint256 expectedShares,(address inputToken,uint256 inputAmount,address outputToken,address target,uint256 slippage,bytes call) swapAction,bytes auxData) action,uint256 slippage)",
    "function depositAndLeverage(uint256 assets,(address borrowableCToken,uint256 borrowAssets,address cToken,uint256 expectedShares,(address inputToken,uint256 inputAmount,address outputToken,address target,uint256 slippage,bytes call) swapAction,bytes auxData) action,uint256 slippage)",
    "function deleverage((address cToken,uint256 collateralAssets,address borrowableCToken,uint256 repayAssets,(address inputToken,uint256 inputAmount,address outputToken,address target,uint256 slippage,bytes call)[] swapActions,bytes auxData) action,uint256 slippage)",
]);

function createLendingOptimizer(allowance: bigint = 10n ** 18n) {
    const sent: Array<{ to: string; data: string }> = [];
    const allowanceChecks: Array<{ owner: string; spender: string }> = [];
    const optimizer = Object.create(LendingOptimizer.prototype) as LendingOptimizer;

    (optimizer as any).address = OPTIMIZER;
    (optimizer as any).signer = {
        address: SIGNER,
        sendTransaction: async (tx: { to: string; data: string }) => {
            sent.push(tx);
            return { hash: `0x${sent.length}` };
        },
    };
    (optimizer as any).asset = {
        address: ASSET,
        decimals: 6n,
        symbol: "USDC",
        allowance: async (owner: string, spender: string) => {
            allowanceChecks.push({ owner, spender });
            return allowance;
        },
    };
    (optimizer as any).contract = {
        interface: optimizerInterface,
    };

    return { optimizer, sent, allowanceChecks };
}

test("LendingOptimizer.deposit checks asset allowance and submits exact overloaded calldata", async () => {
    const { optimizer, sent, allowanceChecks } = createLendingOptimizer();

    const tx = await optimizer.deposit(Decimal("1.25"), RECEIVER);

    assert.deepEqual(tx, { hash: "0x1" });
    assert.deepEqual(allowanceChecks, [{ owner: SIGNER, spender: OPTIMIZER }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, OPTIMIZER);

    const decoded = optimizerInterface.decodeFunctionData("deposit(uint256,address)", sent[0]!.data);
    assert.equal(decoded[0], 1_250_000n);
    assert.equal(decoded[1], RECEIVER);
});

test("LendingOptimizer.withdraw and redeem preserve explicit/default account routing", async () => {
    const { optimizer, sent } = createLendingOptimizer();

    await optimizer.withdraw(Decimal("2.5"), RECEIVER, OWNER);
    await optimizer.redeem(123_456_789n);

    assert.equal(sent.length, 2);

    const withdraw = optimizerInterface.decodeFunctionData("withdraw(uint256,address,address)", sent[0]!.data);
    assert.equal(withdraw[0], 2_500_000n);
    assert.equal(withdraw[1], RECEIVER);
    assert.equal(withdraw[2].toLowerCase(), OWNER.toLowerCase());

    const redeem = optimizerInterface.decodeFunctionData("redeem(uint256,address,address)", sent[1]!.data);
    assert.equal(redeem[0], 123_456_789n);
    assert.equal(redeem[1].toLowerCase(), SIGNER.toLowerCase());
    assert.equal(redeem[2].toLowerCase(), SIGNER.toLowerCase());
});

test("PositionManager calldata helpers encode exact action structs", () => {
    const manager = Object.create(PositionManager.prototype) as PositionManager;
    (manager as any).contract = { interface: positionManagerInterface };

    const swapAction = {
        inputToken: ASSET,
        inputAmount: 1_000n,
        outputToken: CTOKEN,
        target: SWAP_TARGET,
        slippage: 50n,
        call: "0x1234" as const,
    };
    const leverageAction = {
        borrowableCToken: BORROWABLE,
        borrowAssets: 2_000n,
        cToken: CTOKEN,
        expectedShares: 1_950n,
        swapAction,
        auxData: "0xabcd" as const,
    };
    const deleverageAction = {
        cToken: CTOKEN,
        collateralAssets: 3_000n,
        borrowableCToken: BORROWABLE,
        repayAssets: 2_900n,
        swapActions: [swapAction],
        auxData: "0xbeef" as const,
    };

    const leverage = positionManagerInterface.decodeFunctionData(
        "leverage",
        manager.getLeverageCalldata(leverageAction, 111n),
    );
    const depositAndLeverage = positionManagerInterface.decodeFunctionData(
        "depositAndLeverage",
        manager.getDepositAndLeverageCalldata(4_000n, leverageAction, 222n),
    );
    const deleverage = positionManagerInterface.decodeFunctionData(
        "deleverage",
        manager.getDeleverageCalldata(deleverageAction, 333n),
    );

    assert.equal(leverage[0].borrowableCToken.toLowerCase(), BORROWABLE.toLowerCase());
    assert.equal(leverage[0].swapAction.target.toLowerCase(), SWAP_TARGET.toLowerCase());
    assert.equal(leverage[1], 111n);

    assert.equal(depositAndLeverage[0], 4_000n);
    assert.equal(depositAndLeverage[1].expectedShares, 1_950n);
    assert.equal(depositAndLeverage[2], 222n);

    assert.equal(deleverage[0].repayAssets, 2_900n);
    assert.equal(deleverage[0].swapActions[0].call, "0x1234");
    assert.equal(deleverage[1], 333n);
});
