import { config } from "dotenv";
config({ quiet: true });
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Decimal from "decimal.js";
import { Contract, Interface } from "ethers";
import {
    ERC20,
    LendingOptimizer,
    NATIVE_ADDRESS,
    getContractAddresses,
    chain_config,
} from "../src";
import type { address, bytes } from "../src/types";
import { TestFramework } from "./utils/TestFramework";

const FORK_SKIP = (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.TEST_RPC)
    ? "Fork env not configured: set DEPLOYER_PRIVATE_KEY and TEST_RPC in .env. See tests/README.md."
    : undefined;

const optimizerZapperInterface = new Interface([
    "function swapAndDeposit(address optimizer,bool depositAsWrappedNative,(address inputToken,uint256 inputAmount,address outputToken,address target,uint256 slippage,bytes call) swapAction,uint256 expectedShares,address receiver) payable returns (uint256 shares)",
]);

function findAssetBySymbol(framework: TestFramework, symbol: string): address {
    const target = symbol.toUpperCase();
    for (const market of framework.curvance.markets) {
        for (const token of market.tokens) {
            const asset = token.getAsset(true);
            if (asset.symbol?.toUpperCase() === target) {
                return asset.address;
            }
        }
    }

    throw new Error(`Could not find live ${symbol} asset in setupChain market metadata.`);
}

function decodeOptimizerZap(calldata: bytes) {
    const decoded = optimizerZapperInterface.decodeFunctionData("swapAndDeposit", calldata);
    return {
        optimizer: decoded[0] as string,
        depositAsWrappedNative: decoded[1] as boolean,
        swap: decoded[2] as {
            inputToken: string;
            inputAmount: bigint;
            outputToken: string;
            target: string;
            slippage: bigint;
            call: string;
        },
        expectedShares: decoded[3] as bigint,
        receiver: decoded[4] as string,
    };
}

async function createLiveOptimizerContext(framework: TestFramework) {
    const contracts = getContractAddresses("monad-mainnet") as any;
    const optimizerAddress = contracts.Optimizers["cAUSD+"] as address;
    const optimizerZapperAddress = contracts.zappers.optimizerZapper as address;
    const optimizerProbe = new Contract(optimizerAddress, [
        "function asset() view returns (address)",
    ], framework.provider);
    const optimizerAsset = await optimizerProbe.getFunction("asset")() as address;
    const asset = new ERC20(
        framework.provider,
        optimizerAsset,
        undefined,
        framework.curvance.setupConfigSnapshot.contracts.OracleManager as address,
        framework.signer,
    );
    const optimizer = new LendingOptimizer(
        optimizerAddress,
        asset,
        framework.provider,
        framework.signer,
        {
            setup: framework.curvance.setupConfigSnapshot,
            dexAgg: framework.curvance.dexAgg,
        },
    );

    return {
        asset,
        optimizer,
        optimizerAddress,
        optimizerAsset,
        optimizerZapperAddress,
    };
}

async function waitForTx(txLike: unknown) {
    if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === "function") {
        await (txLike as { wait: () => Promise<unknown> }).wait();
    }
}

function decimalToRaw(amount: Decimal, decimals: bigint): bigint {
    return BigInt(
        amount
            .mul(Decimal(10).pow(Number(decimals)))
            .floor()
            .toFixed(0),
    );
}

async function runLiveOptimizerZap({
    framework,
    account,
    inputTokenAddress,
    inputSymbol,
    amount,
}: {
    framework: TestFramework;
    account: address;
    inputTokenAddress: address;
    inputSymbol: string;
    amount: Decimal;
}) {
    const {
        optimizer,
        optimizerAddress,
        optimizerAsset,
        optimizerZapperAddress,
    } = await createLiveOptimizerContext(framework);
    const isNative = inputTokenAddress.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
    const inputToken = isNative
        ? null
        : new ERC20(
            framework.provider,
            inputTokenAddress,
            undefined,
            framework.curvance.setupConfigSnapshot.contracts.OracleManager as address,
            framework.signer,
        );
    const inputDecimals = inputToken == null ? 18n : inputToken.decimals ?? await inputToken.fetchDecimals();
    const rawAmount = decimalToRaw(amount, inputDecimals);
    const zap = {
        type: "optimizer" as const,
        inputToken: inputTokenAddress,
        slippage: new Decimal("0.03"),
    };

    const inputBefore = inputToken == null
        ? await framework.provider.getBalance(account)
        : await inputToken.balanceOf(account);
    const sharesBefore = await optimizer.balanceOf(account);
    const totalAssetsBefore = await optimizer.totalAssets();
    assert(
        inputBefore >= rawAmount,
        `Test account needs at least ${rawAmount} ${inputSymbol} base units, got ${inputBefore}`,
    );

    const built = await optimizer.getZapDepositCalldata(amount, zap, account);
    const decoded = decodeOptimizerZap(built.calldata);
    assert.equal(decoded.optimizer.toLowerCase(), optimizerAddress.toLowerCase());
    assert.equal(decoded.depositAsWrappedNative, isNative);
    assert.equal(decoded.swap.inputToken.toLowerCase(), inputTokenAddress.toLowerCase());
    assert.equal(decoded.swap.inputAmount, rawAmount);
    assert.equal(decoded.swap.outputToken.toLowerCase(), optimizerAsset.toLowerCase());
    assert.equal(decoded.swap.target.toLowerCase(), chain_config["monad-mainnet"].services.dexAggregators.kyberSwap!.router.toLowerCase());
    assert.notEqual(decoded.swap.call, "0x");
    assert.equal(decoded.receiver.toLowerCase(), account.toLowerCase());
    assert.equal(built.zapper?.address.toLowerCase(), optimizerZapperAddress.toLowerCase());
    if (isNative) {
        assert.equal(built.calldata_overrides.value, rawAmount);
    } else {
        assert.deepEqual(built.calldata_overrides, {});
    }

    await waitForTx(await optimizer.approveZapAsset(zap, amount));

    const originalBuilder = optimizer.getZapDepositCalldata.bind(optimizer);
    (optimizer as any).getZapDepositCalldata = async () => built;
    let tx;
    try {
        tx = await optimizer.deposit(amount, zap, account);
    } finally {
        (optimizer as any).getZapDepositCalldata = originalBuilder;
    }
    assert.equal(tx.to?.toLowerCase(), optimizerZapperAddress.toLowerCase());
    if (isNative) {
        assert.equal(tx.value, rawAmount);
    }
    await tx.wait();

    const inputAfter = inputToken == null
        ? await framework.provider.getBalance(account)
        : await inputToken.balanceOf(account);
    const sharesAfter = await optimizer.balanceOf(account);
    const totalAssetsAfter = await optimizer.totalAssets();

    assert(inputAfter < inputBefore, `${inputSymbol} balance should decrease after zap`);
    assert(sharesAfter > sharesBefore, "optimizer share balance should increase after zap");
    assert(totalAssetsAfter >= totalAssetsBefore, "optimizer total assets should not decrease after zap");
}

describe("Optimizer Zapper Monad fork", { skip: FORK_SKIP }, () => {
    let framework: TestFramework;
    let account: address;

    before(async () => {
        framework = await TestFramework.init(process.env.DEPLOYER_PRIVATE_KEY as string, "monad-mainnet", {
            seedNativeBalance: true,
            seedUnderlying: true,
            snapshot: true,
            log: false,
        });
        account = framework.account;
    });

    after(async () => {
        await framework?.destroy();
    });

    test("uses KyberSwap to zap USDC into the deployed AUSD optimizer", async () => {
        await runLiveOptimizerZap({
            framework,
            account,
            inputTokenAddress: findAssetBySymbol(framework, "USDC"),
            inputSymbol: "USDC",
            amount: new Decimal("1"),
        });
    });

    test("uses KyberSwap to zap WMON into the deployed AUSD optimizer", async () => {
        await runLiveOptimizerZap({
            framework,
            account,
            inputTokenAddress: chain_config["monad-mainnet"].wrapped_native,
            inputSymbol: "WMON",
            amount: new Decimal("1"),
        });
    });

    test("uses KyberSwap to zap native MON into the deployed AUSD optimizer", async () => {
        await runLiveOptimizerZap({
            framework,
            account,
            inputTokenAddress: NATIVE_ADDRESS,
            inputSymbol: "MON",
            amount: new Decimal("1"),
        });
    });
});
