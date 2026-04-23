import assert from "node:assert/strict";
import test from "node:test";
import { CToken, LEVERAGE, NATIVE_ADDRESS } from "../src";
import { Zapper } from "../src/classes/Zapper";
import type { address } from "../src/types";

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
