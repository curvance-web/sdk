import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { Interface } from "ethers";
import {
    EMPTY_ADDRESS,
    EMPTY_BYTES,
    ERC20,
    LendingOptimizer,
    NATIVE_ADDRESS,
    OptimizerZapper,
    chain_config,
    toContractSwapSlippage,
} from "../src";
import type { address, bytes } from "../src/types";

const OPTIMIZER = "0x00000000000000000000000000000000000000a1" as address;
const ASSET = "0x00000000000000000000000000000000000000a2" as address;
const INPUT = "0x00000000000000000000000000000000000000c1" as address;
const ZAPPER = "0x00000000000000000000000000000000000000b1" as address;
const SIGNER = "0x00000000000000000000000000000000000000a3" as address;
const RECEIVER = "0x00000000000000000000000000000000000000a4" as address;
const FEE_RECEIVER = "0x00000000000000000000000000000000000000f1" as address;
const SWAP_TARGET = "0x00000000000000000000000000000000000000d1" as address;
const WRAPPED_NATIVE = chain_config["monad-mainnet"].wrapped_native;

const optimizerInterface = new Interface([
    "function asset() view returns (address)",
    "function convertToShares(uint256 assets) view returns (uint256)",
    "function deposit(uint256 assets,address receiver)",
]);

const optimizerZapperInterface = new Interface([
    "function swapAndDeposit(address optimizer,bool depositAsWrappedNative,(address inputToken,uint256 inputAmount,address outputToken,address target,uint256 slippage,bytes call) swapAction,uint256 expectedShares,address receiver) payable returns (uint256 shares)",
]);

function createSetup(feeBps: bigint = 0n) {
    return {
        chain: "monad-mainnet",
        chainId: 143,
        environment: "production-mainnet",
        readProvider: {},
        signer: null,
        account: SIGNER,
        provider: {},
        api_url: "https://api.example",
        contracts: {
            OracleManager: "0x00000000000000000000000000000000000000e1",
            zappers: {
                optimizerZapper: ZAPPER,
            },
        },
        assets: {
            native_symbol: "MON",
            native_name: "Monad",
            wrapped_native: WRAPPED_NATIVE,
            native_vaults: [],
            vaults: [],
            excluded_zap_symbols: [],
        },
        services: {
            curvanceApi: {
                rewardsSlug: "monad-mainnet",
                rewardChainAliases: ["monad"],
                nativeYieldSlug: "monad",
                suppressedNativeYieldSymbols: [],
            },
            dexAggregators: {
                kyberSwap: null,
            },
        },
        feePolicy: {
            chain: "monad-mainnet",
            feeReceiver: feeBps > 0n ? FEE_RECEIVER : undefined,
            getFeeBps: () => feeBps,
        },
    } as any;
}

function createHarness({
    feeBps = 0n,
    directAllowance = 10n ** 18n,
    zapAllowance = 10n ** 18n,
}: {
    feeBps?: bigint;
    directAllowance?: bigint;
    zapAllowance?: bigint;
} = {}) {
    const sent: Array<{ to: string; data: string; value?: bigint }> = [];
    const quoteCalls: Array<{
        wallet: string;
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        slippage: bigint;
        feeBps: bigint | undefined;
        feeReceiver: address | undefined;
    }> = [];
    const allowanceChecks: Array<{ owner: string; spender: string; token: string }> = [];
    const setup = createSetup(feeBps);
    const signer = {
        address: SIGNER,
        sendTransaction: async (tx: { to: string; data: string; value?: bigint }) => {
            sent.push(tx);
            return { hash: `0x${sent.length}`, ...tx };
        },
    } as any;
    const dexAgg = {
        dao: FEE_RECEIVER,
        router: SWAP_TARGET,
        getAvailableTokens: async () => [],
        quoteAction: async () => {
            throw new Error("quoteAction should not be used by optimizer zaps");
        },
        quoteMin: async () => 0n,
        quote: async (
            wallet: string,
            tokenIn: string,
            tokenOut: string,
            amount: bigint,
            slippage: bigint,
            quotedFeeBps?: bigint,
            feeReceiver?: address,
        ) => {
            quoteCalls.push({ wallet, tokenIn, tokenOut, amount, slippage, feeBps: quotedFeeBps, feeReceiver });
            return {
                to: SWAP_TARGET,
                calldata: "0x1234" as bytes,
                min_out: amount - 10_000n,
                out: amount,
            };
        },
    };
    const optimizer = Object.create(LendingOptimizer.prototype) as LendingOptimizer;
    (optimizer as any).address = OPTIMIZER;
    (optimizer as any).provider = {};
    (optimizer as any).signer = signer;
    (optimizer as any).setup = setup;
    (optimizer as any).dexAgg = dexAgg;
    (optimizer as any).optimizerZapperAddress = ZAPPER;
    (optimizer as any).asset = {
        address: ASSET,
        decimals: 6n,
        symbol: "AUSD",
        allowance: async (owner: string, spender: string) => {
            allowanceChecks.push({ owner, spender, token: ASSET });
            return directAllowance;
        },
    };
    (optimizer as any).contract = {
        interface: optimizerInterface,
        asset: async () => ASSET,
        convertToShares: async (assets: bigint) => assets,
    };

    const zapper = Object.create(OptimizerZapper.prototype) as OptimizerZapper;
    (zapper as any).address = ZAPPER;
    (zapper as any).signer = signer;
    (zapper as any).setup = setup;
    (zapper as any).dexAgg = dexAgg;
    (zapper as any).contract = {
        interface: optimizerZapperInterface,
    };
    (optimizer as any).getOptimizerZapper = () => zapper;

    const originalAllowance = ERC20.prototype.allowance;
    ERC20.prototype.allowance = async function (owner, spender) {
        allowanceChecks.push({ owner, spender, token: this.address });
        return zapAllowance;
    };

    return {
        optimizer,
        zapper,
        sent,
        quoteCalls,
        allowanceChecks,
        restore: () => {
            ERC20.prototype.allowance = originalAllowance;
        },
    };
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

test("same-token optimizer zap skips DEX and encodes swapAndDeposit", async () => {
    const { optimizer, quoteCalls, restore } = createHarness();
    try {
        const built = await optimizer.getZapDepositCalldata(
            new Decimal("1.5"),
            { type: "optimizer", inputToken: ASSET, slippage: new Decimal("0.005") },
            RECEIVER,
        );
        const decoded = decodeOptimizerZap(built.calldata);

        assert.deepEqual(quoteCalls, []);
        assert.equal(decoded.optimizer.toLowerCase(), OPTIMIZER.toLowerCase());
        assert.equal(decoded.depositAsWrappedNative, false);
        assert.equal(decoded.swap.inputToken.toLowerCase(), ASSET.toLowerCase());
        assert.equal(decoded.swap.inputAmount, 1_500_000n);
        assert.equal(decoded.swap.outputToken.toLowerCase(), ASSET.toLowerCase());
        assert.equal(decoded.swap.target, EMPTY_ADDRESS);
        assert.equal(decoded.swap.slippage, 0n);
        assert.equal(decoded.swap.call, EMPTY_BYTES);
        assert.equal(decoded.expectedShares, 1_499_700n);
        assert.equal(built.expectedShares, 1_499_700n);
        assert.equal(decoded.receiver.toLowerCase(), RECEIVER.toLowerCase());
    } finally {
        restore();
    }
});

test("ERC20 optimizer zap uses setup-bound DEX adapter and fee policy", async () => {
    const { optimizer, quoteCalls, restore } = createHarness({ feeBps: 4n });
    const originalFetchDecimals = ERC20.prototype.fetchDecimals;
    ERC20.prototype.fetchDecimals = async function () {
        assert.equal(this.address.toLowerCase(), INPUT.toLowerCase());
        return 6n;
    };

    try {
        const built = await optimizer.getZapDepositCalldata(
            new Decimal("1"),
            { type: "optimizer", inputToken: INPUT, slippage: new Decimal("0.005") },
            RECEIVER,
        );
        const decoded = decodeOptimizerZap(built.calldata);

        assert.deepEqual(quoteCalls, [{
            wallet: ZAPPER,
            tokenIn: INPUT,
            tokenOut: ASSET,
            amount: 1_000_000n,
            slippage: 50n,
            feeBps: 4n,
            feeReceiver: FEE_RECEIVER,
        }]);
        assert.equal(decoded.depositAsWrappedNative, false);
        assert.equal(decoded.swap.inputToken.toLowerCase(), INPUT.toLowerCase());
        assert.equal(decoded.swap.outputToken.toLowerCase(), ASSET.toLowerCase());
        assert.equal(decoded.swap.target.toLowerCase(), SWAP_TARGET.toLowerCase());
        assert.equal(decoded.swap.call, "0x1234");
        assert.equal(decoded.swap.slippage, toContractSwapSlippage(50n, 4n));
        assert.equal(decoded.expectedShares, 989_802n);
    } finally {
        ERC20.prototype.fetchDecimals = originalFetchDecimals;
        restore();
    }
});

test("native optimizer zap forwards value and wraps through setup wrapped native", async () => {
    const { optimizer, sent, quoteCalls, restore } = createHarness();

    try {
        const tx = await optimizer.deposit(
            new Decimal("2"),
            { type: "optimizer", inputToken: NATIVE_ADDRESS, slippage: new Decimal("0.01") },
            RECEIVER,
        );
        const decoded = decodeOptimizerZap(sent[0]!.data as bytes);

        assert.deepEqual(tx, {
            hash: "0x1",
            to: ZAPPER,
            data: sent[0]!.data,
            value: 2_000_000_000_000_000_000n,
        });
        assert.deepEqual(quoteCalls, [{
            wallet: ZAPPER,
            tokenIn: WRAPPED_NATIVE,
            tokenOut: ASSET,
            amount: 2_000_000_000_000_000_000n,
            slippage: 100n,
            feeBps: 0n,
            feeReceiver: undefined,
        }]);
        assert.equal(decoded.depositAsWrappedNative, true);
        assert.equal(decoded.swap.inputToken.toLowerCase(), NATIVE_ADDRESS.toLowerCase());
        assert.equal(decoded.swap.outputToken.toLowerCase(), ASSET.toLowerCase());
        assert.equal(sent[0]!.to.toLowerCase(), ZAPPER.toLowerCase());
    } finally {
        restore();
    }
});

test("optimizer zap approvals target input token and optimizer zapper", async () => {
    const { optimizer, allowanceChecks, restore } = createHarness({ zapAllowance: 123n });
    const approveCalls: Array<{ token: string; spender: string; amount: string | null }> = [];
    const originalApprove = ERC20.prototype.approve;
    const originalFetchDecimals = ERC20.prototype.fetchDecimals;

    ERC20.prototype.fetchDecimals = async () => 6n;
    ERC20.prototype.approve = async function (spender, amount) {
        approveCalls.push({
            token: this.address,
            spender,
            amount: amount == null ? null : amount.toString(),
        });
        return { hash: "0xapprove" } as any;
    };

    try {
        const instructions = { type: "optimizer", inputToken: INPUT, slippage: new Decimal("0.01") } as const;
        assert.equal(await optimizer.isZapAssetApproved(instructions, 124n), false);
        assert.equal(await optimizer.isZapAssetApproved(instructions, 123n), true);
        await optimizer.approveZapAsset(instructions, new Decimal("1.25"));
        assert.equal(await optimizer.isZapAssetApproved({ type: "optimizer", inputToken: NATIVE_ADDRESS, slippage: new Decimal("0.01") }, 1n), true);

        assert.deepEqual(allowanceChecks, [
            { owner: SIGNER, spender: ZAPPER, token: INPUT },
            { owner: SIGNER, spender: ZAPPER, token: INPUT },
        ]);
        assert.deepEqual(approveCalls, [{
            token: INPUT,
            spender: ZAPPER,
            amount: "1.25",
        }]);
    } finally {
        ERC20.prototype.approve = originalApprove;
        ERC20.prototype.fetchDecimals = originalFetchDecimals;
        restore();
    }
});

test("direct LendingOptimizer deposit still targets the optimizer", async () => {
    const { optimizer, sent, allowanceChecks, restore } = createHarness();
    try {
        await optimizer.deposit(new Decimal("3.25"), RECEIVER);
        const decoded = optimizerInterface.decodeFunctionData("deposit(uint256,address)", sent[0]!.data);

        assert.equal(sent[0]!.to.toLowerCase(), OPTIMIZER.toLowerCase());
        assert.equal(decoded[0], 3_250_000n);
        assert.equal(String(decoded[1]).toLowerCase(), RECEIVER.toLowerCase());
        assert.deepEqual(allowanceChecks, [{
            owner: SIGNER,
            spender: OPTIMIZER,
            token: ASSET,
        }]);
    } finally {
        restore();
    }
});
