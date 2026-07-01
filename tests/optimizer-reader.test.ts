import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { DEFAULT_REBALANCE_CHUNKS, OptimizerReader } from "../src/classes/OptimizerReader";

const OPTIMIZER = "0x00000000000000000000000000000000000000aa";
const CTOKEN_A = "0x00000000000000000000000000000000000000b1";
const CTOKEN_B = "0x00000000000000000000000000000000000000b2";
const CTOKEN_C = "0x00000000000000000000000000000000000000b3";
const WAD = 10n ** 18n;

function createReader(): OptimizerReader {
    return Object.create(OptimizerReader.prototype) as OptimizerReader;
}

test("OptimizerReader only exposes live contract helpers", () => {
    const reader = createReader() as any;

    assert.equal(typeof reader.getOptimizerAPY, "function");
    assert.equal(typeof reader.getOptimizerAPYBreakdown, "function");
    assert.equal(typeof reader.getOptimizerMarketData, "function");
    assert.equal(typeof reader.getOptimizerUserData, "function");
    assert.equal(typeof reader.isBad, "function");
    assert.equal(typeof reader.multiIsBadCheck, "function");
    assert.equal(typeof reader.optimalRebalance, "function");
    assert.equal(typeof reader.optimalRebalanceWithIncentiveBps, "function");
    assert.equal(typeof reader.optimalRebalanceWithMarketIncentives, "function");
    assert.equal(reader.optimalRebalanceUpdated, undefined);
    assert.equal(reader.optimalDeposit, undefined);
    assert.equal(reader.optimalWithdrawal, undefined);
});

test("getOptimizerAPY returns the raw WAD value from the contract", async () => {
    const reader = createReader();
    let capturedOptimizer: string | null = null;

    reader.contract = {
        getOptimizerAPY: Object.assign(
            async () => { throw new Error("getOptimizerAPY must use staticCall"); },
            {
                staticCall: async (optimizer: string) => {
                    capturedOptimizer = optimizer;
                    return 123_000_000_000_000_000n;
                },
            },
        ),
    } as any;

    const apy = await reader.getOptimizerAPY(OPTIMIZER as any);

    assert.equal(capturedOptimizer, OPTIMIZER);
    assert.equal(apy, 123_000_000_000_000_000n);
});

test("getOptimizerAPYBreakdown uses reader market data and weights Merkl rewards", async () => {
    const reader = createReader();
    reader.getOptimizerMarketData = async (optimizers) => {
        assert.deepEqual(optimizers, [OPTIMIZER as any]);
        return [{
            address: OPTIMIZER as any,
            asset: CTOKEN_A as any,
            totalAssets: 1_000n,
            markets: [
                {
                    address: CTOKEN_A as any,
                    allocatedAssets: 250n,
                    liquidity: 70n,
                    allocationCap: WAD / 2n,
                    allocationCapUtilizationBps: 5_000n,
                },
                {
                    address: CTOKEN_B as any,
                    allocatedAssets: 750n,
                    liquidity: 80n,
                    allocationCap: (WAD * 3n) / 4n,
                    allocationCapUtilizationBps: 10_000n,
                },
            ],
            totalLiquidity: 150n,
            sharePrice: WAD,
            exchangeRateHighWatermark: WAD,
            performanceFee: 0n,
            numApprovedMarkets: 2n,
            apy: 35_000_000_000_000_000n,
        }];
    };

    const market = {
        tokens: [
            {
                address: CTOKEN_A,
                market: { address: "0x00000000000000000000000000000000000000f1" },
                asset: { symbol: "cUSDC-A" },
                getApy: () => new Decimal("0.02"),
                incentiveSupplyApy: new Decimal("0.03"),
            },
            {
                address: CTOKEN_B,
                market: { address: "0x00000000000000000000000000000000000000f1" },
                asset: { symbol: "cUSDC-B" },
                getApy: () => new Decimal("0.04"),
                incentiveSupplyApy: new Decimal("0.01"),
            },
        ],
    };

    const breakdown = await reader.getOptimizerAPYBreakdown(OPTIMIZER as any, [market] as any);

    assert.equal(breakdown.optimizer, OPTIMIZER);
    assert.equal(breakdown.totalAssets, 1_000n);
    assert.equal(breakdown.nativeApy.toString(), "0.035");
    assert.equal(breakdown.merklApy.toString(), "0.015");
    assert.equal(breakdown.averageApy.toString(), "0.05");
    assert.deepEqual(
        breakdown.markets.map((row) => ({
            cToken: row.cToken,
            assetSymbol: row.assetSymbol,
            allocatedAssets: row.allocatedAssets,
            allocationWeight: row.allocationWeight.toString(),
            nativeApy: row.nativeApy.toString(),
            merklApy: row.merklApy.toString(),
            totalApy: row.totalApy.toString(),
        })),
        [
            {
                cToken: CTOKEN_A,
                assetSymbol: "cUSDC-A",
                allocatedAssets: 250n,
                allocationWeight: "0.25",
                nativeApy: "0.02",
                merklApy: "0.03",
                totalApy: "0.05",
            },
            {
                cToken: CTOKEN_B,
                assetSymbol: "cUSDC-B",
                allocatedAssets: 750n,
                allocationWeight: "0.75",
                nativeApy: "0.04",
                merklApy: "0.01",
                totalApy: "0.05",
            },
        ],
    );
});

test("getOptimizerMarketData uses reader static call and normalizes contract rows", async () => {
    const reader = createReader();
    let capturedOptimizers: string[] | null = null;

    reader.contract = {
        getOptimizerMarketData: Object.assign(
            async () => { throw new Error("getOptimizerMarketData must use staticCall"); },
            {
                staticCall: async (optimizers: string[]) => {
                    capturedOptimizers = optimizers;
                    return [{
                        _address: OPTIMIZER,
                        asset: CTOKEN_A,
                        totalAssets: 1_000n,
                        markets: [
                            {
                                _address: CTOKEN_A,
                                allocatedAssets: 200n,
                                liquidity: 70n,
                                allocationCap: WAD / 2n,
                                allocationCapUtilizationBps: 4_000n,
                            },
                            {
                                _address: CTOKEN_B,
                                allocatedAssets: 300n,
                                liquidity: 80n,
                                allocationCap: (WAD * 3n) / 4n,
                                allocationCapUtilizationBps: 4_000n,
                            },
                        ],
                        totalLiquidity: 150n,
                        sharePrice: 456n,
                        exchangeRateHighWatermark: 789n,
                        performanceFee: 7n,
                        numApprovedMarkets: 2n,
                        apy: 999n,
                    }];
                },
            },
        ),
    } as any;

    const result = await reader.getOptimizerMarketData([OPTIMIZER as any]);

    assert.deepEqual(capturedOptimizers, [OPTIMIZER]);
    assert.deepEqual(result, [{
        address: OPTIMIZER,
        asset: CTOKEN_A,
        totalAssets: 1_000n,
        markets: [
            {
                address: CTOKEN_A,
                allocatedAssets: 200n,
                liquidity: 70n,
                allocationCap: WAD / 2n,
                allocationCapUtilizationBps: 4_000n,
            },
            {
                address: CTOKEN_B,
                allocatedAssets: 300n,
                liquidity: 80n,
                allocationCap: (WAD * 3n) / 4n,
                allocationCapUtilizationBps: 4_000n,
            },
        ],
        totalLiquidity: 150n,
        sharePrice: 456n,
        exchangeRateHighWatermark: 789n,
        performanceFee: 7n,
        numApprovedMarkets: 2n,
        apy: 999n,
    }]);
});

test("optimalRebalance forwards default slippage and chunks, then decodes actions plus bounds", async () => {
    const reader = createReader();
    let captured: { optimizer: string; slippageBps: bigint; rebalanceChunks: bigint } | null = null;
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
        optimalRebalance: Object.assign(
            async () => { throw new Error("optimalRebalance must use staticCall"); },
            {
                staticCall: async (optimizer: string, slippageBps: bigint, rebalanceChunks: bigint) => {
                    captured = { optimizer, slippageBps, rebalanceChunks };
                    return response;
                },
            },
        ),
    } as any;

    const result = await reader.optimalRebalance(OPTIMIZER as any);

    assert.deepEqual(captured, {
        optimizer: OPTIMIZER,
        slippageBps: 0n,
        rebalanceChunks: DEFAULT_REBALANCE_CHUNKS,
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

test("optimalRebalance preserves explicit slippage and chunks, and tolerates legacy action field names", async () => {
    const reader = createReader();
    let captured: { optimizer: string; slippageBps: bigint; rebalanceChunks: bigint } | null = null;

    reader.contract = {
        optimalRebalance: async (optimizer: string, slippageBps: bigint, rebalanceChunks: bigint) => {
            captured = { optimizer, slippageBps, rebalanceChunks };
            return [
                [{ cToken: CTOKEN_A, assets: -9n }],
                [{ cToken: CTOKEN_A, minBps: 0n, maxBps: 10_000n }],
            ];
        },
    } as any;

    const result = await reader.optimalRebalance(OPTIMIZER as any, 25n, 123n);

    assert.deepEqual(captured, {
        optimizer: OPTIMIZER,
        slippageBps: 25n,
        rebalanceChunks: 123n,
    });
    assert.deepEqual(result, {
        actions: [{ cToken: CTOKEN_A, assetsOrBps: -9n }],
        bounds: [{ cToken: CTOKEN_A, minBps: 0n, maxBps: 10_000n }],
    });
});

test("optimalRebalanceWithIncentiveBps forwards explicit BPS incentives", async () => {
    const reader = createReader();
    let captured: {
        optimizer: string;
        slippageBps: bigint;
        rebalanceChunks: bigint;
        marketIncentiveAPYsBps: bigint[];
    } | null = null;
    const response: any = [
        [{ cToken: CTOKEN_A, assetsOrBps: -3n }],
        [{ cToken: CTOKEN_A, minBps: 100n, maxBps: 9_000n }],
    ];
    response.actions = response[0];
    response.bounds = response[1];

    reader.contract = {
        optimalRebalanceWithIncentives: Object.assign(
            async () => { throw new Error("optimalRebalanceWithIncentives must use staticCall"); },
            {
                staticCall: async (
                    optimizer: string,
                    slippageBps: bigint,
                    rebalanceChunks: bigint,
                    marketIncentiveAPYsBps: bigint[],
                ) => {
                    captured = { optimizer, slippageBps, rebalanceChunks, marketIncentiveAPYsBps };
                    return response;
                },
            },
        ),
    } as any;

    const result = await reader.optimalRebalanceWithIncentiveBps(
        OPTIMIZER as any,
        [319n, 150n, 0n],
        25n,
        123n,
    );

    assert.deepEqual(captured, {
        optimizer: OPTIMIZER,
        slippageBps: 25n,
        rebalanceChunks: 123n,
        marketIncentiveAPYsBps: [319n, 150n, 0n],
    });
    assert.deepEqual(result, {
        actions: [{ cToken: CTOKEN_A, assetsOrBps: -3n }],
        bounds: [{ cToken: CTOKEN_A, minBps: 100n, maxBps: 9_000n }],
    });
});

test("optimalRebalanceWithMarketIncentives derives BPS incentives in approved-market order", async () => {
    const reader = createReader();
    let captured: {
        optimizer: string;
        slippageBps: bigint;
        rebalanceChunks: bigint;
        marketIncentiveAPYsBps: bigint[];
    } | null = null;

    reader.getOptimizerMarketData = async (optimizers) => {
        assert.deepEqual(optimizers, [OPTIMIZER as any]);
        return [{
            address: OPTIMIZER as any,
            asset: CTOKEN_A as any,
            totalAssets: 1_000n,
            markets: [
                {
                    address: CTOKEN_A as any,
                    allocatedAssets: 100n,
                    liquidity: 70n,
                    allocationCap: WAD / 2n,
                    allocationCapUtilizationBps: 2_000n,
                },
                {
                    address: CTOKEN_B as any,
                    allocatedAssets: 200n,
                    liquidity: 80n,
                    allocationCap: (WAD * 3n) / 4n,
                    allocationCapUtilizationBps: 3_000n,
                },
                {
                    address: CTOKEN_C as any,
                    allocatedAssets: 300n,
                    liquidity: 90n,
                    allocationCap: WAD,
                    allocationCapUtilizationBps: 4_000n,
                },
            ],
            totalLiquidity: 240n,
            sharePrice: WAD,
            exchangeRateHighWatermark: WAD,
            performanceFee: 0n,
            numApprovedMarkets: 3n,
            apy: 0n,
        }];
    };

    reader.contract = {
        optimalRebalanceWithIncentives: Object.assign(
            async () => { throw new Error("optimalRebalanceWithIncentives must use staticCall"); },
            {
                staticCall: async (
                    optimizer: string,
                    slippageBps: bigint,
                    rebalanceChunks: bigint,
                    marketIncentiveAPYsBps: bigint[],
                ) => {
                    captured = { optimizer, slippageBps, rebalanceChunks, marketIncentiveAPYsBps };
                    return [
                        [{ cToken: CTOKEN_B, assetsOrBps: 11n }],
                        [{ cToken: CTOKEN_B, minBps: 0n, maxBps: 10_000n }],
                    ];
                },
            },
        ),
    } as any;

    const market = {
        tokens: [
            {
                address: CTOKEN_B,
                getApy: () => new Decimal(0),
                incentiveSupplyApy: new Decimal("0.01505"),
            },
            {
                address: CTOKEN_A,
                getApy: () => new Decimal(0),
                incentiveSupplyApy: new Decimal("0.0319"),
            },
            {
                address: CTOKEN_C,
                getApy: () => new Decimal(0),
            },
        ],
    };

    const result = await reader.optimalRebalanceWithMarketIncentives(
        OPTIMIZER as any,
        [market] as any,
        42n,
        88n,
    );

    assert.deepEqual(captured, {
        optimizer: OPTIMIZER,
        slippageBps: 42n,
        rebalanceChunks: 88n,
        marketIncentiveAPYsBps: [319n, 150n, 0n],
    });
    assert.deepEqual(result, {
        actions: [{ cToken: CTOKEN_B, assetsOrBps: 11n }],
        bounds: [{ cToken: CTOKEN_B, minBps: 0n, maxBps: 10_000n }],
    });
});

test("optimalRebalanceWithMarketIncentives fails when an approved market token is missing", async () => {
    const reader = createReader();
    reader.getOptimizerMarketData = async () => [{
        address: OPTIMIZER as any,
        asset: CTOKEN_A as any,
        totalAssets: 1_000n,
        markets: [
            {
                address: CTOKEN_A as any,
                allocatedAssets: 100n,
                liquidity: 70n,
                allocationCap: WAD,
                allocationCapUtilizationBps: 1_000n,
            },
        ],
        totalLiquidity: 70n,
        sharePrice: WAD,
        exchangeRateHighWatermark: WAD,
        performanceFee: 0n,
        numApprovedMarkets: 1n,
        apy: 0n,
    }];

    await assert.rejects(
        () => reader.optimalRebalanceWithMarketIncentives(OPTIMIZER as any, []),
        /approved market .* is not present in the provided SDK markets/,
    );
});

test("bad-market helpers forward optimizer arrays", async () => {
    const reader = createReader();
    let capturedSingle: string | null = null;
    let capturedMulti: string[] | null = null;

    reader.contract = {
        isBad: async (optimizer: string) => {
            capturedSingle = optimizer;
            return [CTOKEN_A];
        },
        multiIsBadCheck: async (optimizers: string[]) => {
            capturedMulti = optimizers;
            return [[CTOKEN_A], [CTOKEN_B]];
        },
    } as any;

    const bad = await reader.isBad(OPTIMIZER as any);
    const multi = await reader.multiIsBadCheck([OPTIMIZER as any, CTOKEN_B as any]);

    assert.equal(capturedSingle, OPTIMIZER);
    assert.deepEqual(capturedMulti, [OPTIMIZER, CTOKEN_B]);
    assert.deepEqual(bad, [CTOKEN_A]);
    assert.deepEqual(multi, [[CTOKEN_A], [CTOKEN_B]]);
});
