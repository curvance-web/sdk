import assert from "node:assert/strict";
import test from "node:test";
import { CToken, LEVERAGE, NATIVE_ADDRESS } from "../src";
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

function createZapper() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const zapper = Object.create(Zapper.prototype) as Zapper;
    (zapper as any).address = ZAPPER;
    (zapper as any).signer = { address: RECEIVER };
    (zapper as any).setup = {
        chain: "monad-mainnet",
        feePolicy: {
            getFeeBps: () => 0n,
            feeReceiver: undefined,
        },
    };
    (zapper as any).getCallData = (method: string, args: unknown[]) => {
        calls.push({ method, args });
        return "0xencoded";
    };

    return { zapper, calls };
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
    const executeCalls: Array<{ calldata: unknown; overrides: Record<string, unknown> }> = [];

    (token as any).isWrappedNative = true;
    (zapper as any).type = "native-simple";
    (zapper as any).executeCallData = async (calldata: unknown, overrides: Record<string, unknown>) => {
        executeCalls.push({ calldata, overrides });
        return { hash: "0xnative" };
    };

    const tx = await zapper.nativeZap(token, 20_000n, false, RECEIVER);

    assert.deepEqual(tx, { hash: "0xnative" });
    assert.deepEqual(executeCalls, [{
        calldata: "0xencoded",
        overrides: { value: 20_000n },
    }]);
    const args = calldataCalls[0]?.args as any[];
    assert.equal(args[1], true);
    assert.equal(args[2].inputToken, NATIVE_ADDRESS);
    assert.notEqual(args[2].outputToken.toLowerCase(), NATIVE_ADDRESS.toLowerCase());
});

test("Zapper.simpleZap forwards native input value to the zapper call", async () => {
    const { token } = createBufferedToken();
    const { zapper } = createZapper();
    const executeCalls: Array<{ calldata: unknown; overrides: Record<string, unknown> }> = [];

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
    (zapper as any).executeCallData = async (calldata: unknown, overrides: Record<string, unknown>) => {
        executeCalls.push({ calldata, overrides });
        return { hash: "0xsimple-native" };
    };

    const tx = await zapper.simpleZap(token, NATIVE_ADDRESS, TOKEN, 20_000n, false, 50n, RECEIVER);

    assert.deepEqual(tx, { hash: "0xsimple-native" });
    assert.deepEqual(executeCalls, [{
        calldata: "0xencoded",
        overrides: { value: 20_000n },
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
