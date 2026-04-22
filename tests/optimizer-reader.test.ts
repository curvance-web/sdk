import assert from "node:assert/strict";
import test from "node:test";
import { OptimizerReader } from "../src/classes/OptimizerReader";

const OPTIMIZER = "0x00000000000000000000000000000000000000aa";
const CTOKEN_A = "0x00000000000000000000000000000000000000b1";
const CTOKEN_B = "0x00000000000000000000000000000000000000b2";

function createReader(): OptimizerReader {
    return Object.create(OptimizerReader.prototype) as OptimizerReader;
}

test("getOptimizerAPY returns the raw WAD value from the contract", async () => {
    const reader = createReader();
    let capturedOptimizer: string | null = null;

    reader.contract = {
        getOptimizerAPY: async (optimizer: string) => {
            capturedOptimizer = optimizer;
            return 123_000_000_000_000_000n;
        },
    } as any;

    const apy = await reader.getOptimizerAPY(OPTIMIZER as any);

    assert.equal(capturedOptimizer, OPTIMIZER);
    assert.equal(apy, 123_000_000_000_000_000n);
});

test("optimalRebalance forwards the default slippage and decodes actions plus bounds", async () => {
    const reader = createReader();
    let captured: { optimizer: string; slippageBps: bigint } | null = null;
    const response: any = [
        [
            { cToken: CTOKEN_A, assetsOrBps: -5n },
            { cToken: CTOKEN_B, assetsOrBps: 7n },
        ],
        [
            { cToken: CTOKEN_A, minBps: 1_000n, maxBps: 2_000n },
            { cToken: CTOKEN_B, minBps: 3_000n, maxBps: 4_000n },
        ],
    ];
    response.actions = response[0];
    response.bounds = response[1];

    reader.contract = {
        optimalRebalance: async (optimizer: string, slippageBps: bigint) => {
            captured = { optimizer, slippageBps };
            return response;
        },
    } as any;

    const result = await reader.optimalRebalance(OPTIMIZER as any);

    assert.deepEqual(captured, {
        optimizer: OPTIMIZER,
        slippageBps: 0n,
    });
    assert.deepEqual(result, {
        actions: [
            { cToken: CTOKEN_A, assetsOrBps: -5n },
            { cToken: CTOKEN_B, assetsOrBps: 7n },
        ],
        bounds: [
            { cToken: CTOKEN_A, minBps: 1_000n, maxBps: 2_000n },
            { cToken: CTOKEN_B, minBps: 3_000n, maxBps: 4_000n },
        ],
    });
});

test("optimalRebalance preserves explicit slippage and tolerates legacy action field names", async () => {
    const reader = createReader();
    let captured: { optimizer: string; slippageBps: bigint } | null = null;

    reader.contract = {
        optimalRebalance: async (optimizer: string, slippageBps: bigint) => {
            captured = { optimizer, slippageBps };
            return [
                [{ cToken: CTOKEN_A, assets: -9n }],
                [{ cToken: CTOKEN_A, minBps: 0n, maxBps: 10_000n }],
            ];
        },
    } as any;

    const result = await reader.optimalRebalance(OPTIMIZER as any, 25n);

    assert.deepEqual(captured, {
        optimizer: OPTIMIZER,
        slippageBps: 25n,
    });
    assert.deepEqual(result, {
        actions: [{ cToken: CTOKEN_A, assetsOrBps: -9n }],
        bounds: [{ cToken: CTOKEN_A, minBps: 0n, maxBps: 10_000n }],
    });
});
