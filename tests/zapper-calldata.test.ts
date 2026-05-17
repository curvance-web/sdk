import assert from "node:assert/strict";
import test from "node:test";
import { CToken, LEVERAGE, NATIVE_ADDRESS, chain_config, toContractSwapSlippage } from "../src";
import { Zapper } from "../src/classes/Zapper";
import type { address } from "../src/types";
import Decimal from "decimal.js";

const CTOKEN = "0x00000000000000000000000000000000000000c1" as address;
const ZAPPER = "0x00000000000000000000000000000000000000b1" as address;
const TOKEN = "0x00000000000000000000000000000000000000d1" as address;
const RECEIVER = "0x00000000000000000000000000000000000000f2" as address;

function createBufferedToken() {
    const calls: Array<{ assets: bigint; bufferBps: bigint }> = [];
    const token = Object.create(CToken.prototype) as CToken;
    (token as any).address = CTOKEN;
    (token as any).isVault = false;
    (token as any).isNativeVault = false;
    (token as any).convertToShares = async (
        assets: bigint,
        bufferBps: bigint = LEVERAGE.SHARES_BUFFER_BPS,
    ) => {
        calls.push({ assets, bufferBps });
        return (assets * (10000n - bufferBps)) / 10000n;
    };

    return { token, calls };
}

function createZapper(feeBps: bigint = 0n, dexAgg: any = chain_config["monad-mainnet"].dexAgg) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const zapper = Object.create(Zapper.prototype) as Zapper;
    (zapper as any).address = ZAPPER;
    (zapper as any).signer = { address: RECEIVER };
    (zapper as any).dexAgg = dexAgg;
    (zapper as any).setup = {
        chain: "monad-mainnet",
        feePolicy: {
            getFeeBps: () => feeBps,
            feeReceiver: feeBps > 0n ? RECEIVER : undefined,
        },
    };
    (zapper as any).getCallData = (method: string, args: unknown[]) => {
        calls.push({ method, args });
        return "0xencoded";
    };

    return { zapper, calls };
}

function installDexQuoteStub() {
    const originalDexAgg = chain_config["monad-mainnet"].dexAgg;
    const quoteCalls: Array<{
        wallet: string;
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        slippage: bigint;
        feeBps: bigint | undefined;
        feeReceiver: address | undefined;
    }> = [];

    (chain_config["monad-mainnet"] as any).dexAgg = {
        quote: async (
            wallet: string,
            tokenIn: string,
            tokenOut: string,
            amount: bigint,
            slippage: bigint,
            feeBps?: bigint,
            feeReceiver?: address,
        ) => {
            quoteCalls.push({ wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver });
            return {
                to: "0x00000000000000000000000000000000000000e1" as address,
                min_out: amount - 100n,
                out: amount,
                calldata: "0x1234",
            };
        },
    };

    return {
        quoteCalls,
        restore: () => {
            (chain_config["monad-mainnet"] as any).dexAgg = originalDexAgg;
        },
    };
}

test("CToken.convertToShares applies the default share-drift buffer", async () => {
    const token = Object.create(CToken.prototype) as CToken;
    (token as any).contract = {
        convertToShares: async () => 10_000n,
    };

    assert.equal(await token.convertToShares(1n), 9_998n);
});

test("simple same-token zap expectedShares uses buffered convertToShares", async () => {
    const { token, calls: shareCalls } = createBufferedToken();
    const { zapper, calls: calldataCalls } = createZapper();

    await zapper.getSimpleZapCalldata(token, TOKEN, TOKEN, 10_000n, false, 50n, RECEIVER);

    assert.deepEqual(shareCalls, [{
        assets: 10_000n,
        bufferBps: LEVERAGE.SHARES_BUFFER_BPS,
    }]);
    const args = calldataCalls[0]?.args as any[];
    assert.equal(calldataCalls[0]?.method, "swapAndDeposit");
    assert.equal(args[3], 9_998n);
});

test("real simple zap encodes WAD swapSafe slippage with fee expansion", async () => {
    const { token, calls: shareCalls } = createBufferedToken();
    const dex = installDexQuoteStub();
    const { zapper, calls: calldataCalls } = createZapper(4n);

    try {
        await zapper.getSimpleZapCalldata(token, TOKEN, "0x00000000000000000000000000000000000000d2" as address, 10_000n, false, 50n, RECEIVER);
    } finally {
        dex.restore();
    }

    assert.deepEqual(dex.quoteCalls, [{
        wallet: ZAPPER,
        tokenIn: TOKEN,
        tokenOut: "0x00000000000000000000000000000000000000d2",
        amount: 10_000n,
        slippage: 50n,
        feeBps: 4n,
        feeReceiver: RECEIVER,
    }]);
    assert.deepEqual(shareCalls, [{
        assets: 9_900n,
        bufferBps: LEVERAGE.SHARES_BUFFER_BPS,
    }]);
    const args = calldataCalls[0]?.args as any[];
    assert.equal(calldataCalls[0]?.method, "swapAndDeposit");
    assert.notEqual(args[2].slippage, 50n);
    assert.equal(args[2].slippage, toContractSwapSlippage(50n, 4n));
    assert.equal(args[2].target, "0x00000000000000000000000000000000000000e1");
    assert.equal(args[2].call, "0x1234");
    assert.equal(args[3], 9_898n);
});

test("CToken.getZapper binds simple zap quotes to the market DEX aggregator", async () => {
    const { token, calls: shareCalls } = createBufferedToken();
    const originalDexAgg = chain_config["monad-mainnet"].dexAgg;
    const marketQuoteCalls: Array<{
        wallet: string;
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        slippage: bigint;
        feeBps: bigint | undefined;
        feeReceiver: address | undefined;
    }> = [];
    const marketDexAgg = {
        quote: async (
            wallet: string,
            tokenIn: string,
            tokenOut: string,
            amount: bigint,
            slippage: bigint,
            feeBps?: bigint,
            feeReceiver?: address,
        ) => {
            marketQuoteCalls.push({ wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver });
            return {
                to: "0x00000000000000000000000000000000000000e2" as address,
                min_out: amount - 200n,
                out: amount,
                calldata: "0x5678",
            };
        },
    };

    (chain_config["monad-mainnet"] as any).dexAgg = {
        quote: async () => {
            throw new Error("chain singleton DEX aggregator should not be used");
        },
    };
    (token as any).market = {
        signer: { address: RECEIVER },
        dexAgg: marketDexAgg,
        setup: {
            chain: "monad-mainnet",
            contracts: {
                zappers: {
                    simpleZapper: ZAPPER,
                },
            },
            feePolicy: {
                getFeeBps: () => 4n,
                feeReceiver: RECEIVER,
            },
        },
    };
    (token as any).getCallData = () => "0xtoken";

    try {
        const zapper = token.getZapper("simple");
        assert.ok(zapper);

        const calldata = await zapper.getSimpleZapCalldata(
            token,
            TOKEN,
            "0x00000000000000000000000000000000000000d2" as address,
            10_000n,
            false,
            50n,
            RECEIVER,
        );

        assert.match(calldata, /^0x/);
    } finally {
        (chain_config["monad-mainnet"] as any).dexAgg = originalDexAgg;
    }

    assert.deepEqual(marketQuoteCalls, [{
        wallet: ZAPPER,
        tokenIn: TOKEN,
        tokenOut: "0x00000000000000000000000000000000000000d2",
        amount: 10_000n,
        slippage: 50n,
        feeBps: 4n,
        feeReceiver: RECEIVER,
    }]);
    assert.deepEqual(shareCalls, [{
        assets: 9_800n,
        bufferBps: LEVERAGE.SHARES_BUFFER_BPS,
    }]);
});

test("native simple zap expectedShares uses buffered convertToShares", async () => {
    const { token, calls: shareCalls } = createBufferedToken();
    const { zapper, calls: calldataCalls } = createZapper();

    await zapper.getNativeZapCalldata(token, 20_000n, false, true, RECEIVER);

    assert.deepEqual(shareCalls, [{
        assets: 20_000n,
        bufferBps: LEVERAGE.SHARES_BUFFER_BPS,
    }]);
    const args = calldataCalls[0]?.args as any[];
    assert.equal(calldataCalls[0]?.method, "swapAndDeposit");
    assert.equal(args[3], 19_996n);
    assert.equal(args[2].inputToken, NATIVE_ADDRESS);
});

test("Zapper.nativeZap wraps native input for native-simple wrapped-native deposits", async () => {
    const { token } = createBufferedToken();
    const { zapper, calls: calldataCalls } = createZapper();
    const oracleRouteCalls: Array<{ calldata: unknown; overrides: Record<string, unknown>; receiver: address }> = [];

    (token as any).isWrappedNative = true;
    (zapper as any).type = "native-simple";
    (token as any).oracleRoute = async (calldata: unknown, overrides: Record<string, unknown>, receiver: address) => {
        oracleRouteCalls.push({ calldata, overrides, receiver });
        return { hash: "0xnative" };
    };

    const tx = await zapper.nativeZap(token, 20_000n, false, RECEIVER);

    assert.deepEqual(tx, { hash: "0xnative" });
    assert.deepEqual(oracleRouteCalls, [{
        calldata: "0xencoded",
        overrides: { value: 20_000n, to: ZAPPER },
        receiver: RECEIVER,
    }]);
    const args = calldataCalls[0]?.args as any[];
    assert.equal(args[1], true);
    assert.equal(args[2].inputToken, NATIVE_ADDRESS);
    assert.notEqual(args[2].outputToken.toLowerCase(), NATIVE_ADDRESS.toLowerCase());
});

test("Zapper.simpleZap forwards native input value to the zapper call", async () => {
    const { token } = createBufferedToken();
    const { zapper } = createZapper();
    const oracleRouteCalls: Array<{ calldata: unknown; overrides: Record<string, unknown>; receiver: address }> = [];

    (zapper as any).getSimpleZapCalldata = async (
        _ctoken: unknown,
        inputToken: address,
        _outputToken: address,
        amount: bigint,
        _collateralize: boolean,
        _slippage: bigint,
        receiver: address,
    ) => {
        assert.equal(inputToken, NATIVE_ADDRESS);
        assert.equal(amount, 20_000n);
        assert.equal(receiver, RECEIVER);
        return "0xencoded";
    };
    (token as any).oracleRoute = async (calldata: unknown, overrides: Record<string, unknown>, receiver: address) => {
        oracleRouteCalls.push({ calldata, overrides, receiver });
        return { hash: "0xsimple-native" };
    };

    const tx = await zapper.simpleZap(token, NATIVE_ADDRESS, TOKEN, 20_000n, false, 50n, RECEIVER);

    assert.deepEqual(tx, { hash: "0xsimple-native" });
    assert.deepEqual(oracleRouteCalls, [{
        calldata: "0xencoded",
        overrides: { value: 20_000n, to: ZAPPER },
        receiver: RECEIVER,
    }]);
});

test("Zapper.simpleZap routes ERC20 input through cToken oracleRoute without native value", async () => {
    const { token } = createBufferedToken();
    const { zapper } = createZapper();
    const oracleRouteCalls: Array<{ calldata: unknown; overrides: Record<string, unknown>; receiver: address }> = [];

    (zapper as any).getSimpleZapCalldata = async () => "0xencoded";
    (token as any).oracleRoute = async (calldata: unknown, overrides: Record<string, unknown>, receiver: address) => {
        oracleRouteCalls.push({ calldata, overrides, receiver });
        return { hash: "0xsimple-erc20" };
    };

    const tx = await zapper.simpleZap(token, TOKEN, CTOKEN, 20_000n, true, 50n, RECEIVER);

    assert.deepEqual(tx, { hash: "0xsimple-erc20" });
    assert.deepEqual(oracleRouteCalls, [{
        calldata: "0xencoded",
        overrides: { to: ZAPPER },
        receiver: RECEIVER,
    }]);
});

test("object zap slippage floors fractional BPS through the shared converter", async () => {
    const token = Object.create(CToken.prototype) as CToken;
    const calls: Array<{ slippage: bigint }> = [];

    (token as any).cache = { asset: { address: TOKEN } };
    (token as any).getZapper = () => ({
        address: ZAPPER,
        getSimpleZapCalldata: async (
            _ctoken: CToken,
            _inputToken: address,
            _outputToken: address,
            _assets: bigint,
            _collateralize: boolean,
            slippage: bigint,
        ) => {
            calls.push({ slippage });
            return "0xencoded";
        },
    });

    const result = await token.zap(
        100n,
        {
            type: "simple",
            inputToken: TOKEN,
            slippage: new Decimal("0.000151"),
        },
        false,
        "0xdefault",
        RECEIVER,
    );

    assert.equal(result.calldata, "0xencoded");
    assert.deepEqual(calls, [{ slippage: 1n }]);
});
