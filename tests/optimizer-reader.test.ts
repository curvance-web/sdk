import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getAddress } from "ethers";
import Decimal from "decimal.js";
import { OptimizerReader } from "../src/classes/OptimizerReader";

const OPTIMIZER = "0x00000000000000000000000000000000000000aa";
const CTOKEN_A = "0x00000000000000000000000000000000000000b1";
const CTOKEN_B = "0x00000000000000000000000000000000000000b2";
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
    assert.equal(typeof reader.assetsAtTimestamp, "function");
    assert.equal(typeof reader.isBad, "function");
    assert.equal(typeof reader.multiIsBadCheck, "function");
    assert.equal(typeof reader.optimalRebalance, "function");
    assert.equal(typeof reader.optimalRebalanceAt, "function");
    assert.equal(reader.optimalDeposit, undefined);
    assert.equal(reader.optimalWithdrawal, undefined);
});

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
            performanceFee: 0n,
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

test("getOptimizerMarketData reads optimizer and cToken contracts directly", async () => {
    const reader = createReader();
    const optimizerIface = new Interface([
        "function asset() view returns (address)",
        "function totalAssets() view returns (uint256)",
        "function exchangeRate() view returns (uint256)",
        "function exchangeRateUpdated() returns (uint256)",
        "function fee() view returns (uint256)",
        "function getApprovedMarkets() view returns (address[])",
        "function allocationCaps(address cToken) view returns (uint256)",
    ]);
    const cTokenIface = new Interface([
        "function balanceOf(address owner) view returns (uint256)",
        "function convertToAssets(uint256 shares) view returns (uint256)",
        "function assetsHeld() view returns (uint256)",
    ]);
    const selectors = {
        asset: optimizerIface.getFunction("asset")!.selector,
        totalAssets: optimizerIface.getFunction("totalAssets")!.selector,
        exchangeRate: optimizerIface.getFunction("exchangeRate")!.selector,
        exchangeRateUpdated: optimizerIface.getFunction("exchangeRateUpdated")!.selector,
        fee: optimizerIface.getFunction("fee")!.selector,
        getApprovedMarkets: optimizerIface.getFunction("getApprovedMarkets")!.selector,
        allocationCaps: optimizerIface.getFunction("allocationCaps")!.selector,
        balanceOf: cTokenIface.getFunction("balanceOf")!.selector,
        convertToAssets: cTokenIface.getFunction("convertToAssets")!.selector,
        assetsHeld: cTokenIface.getFunction("assetsHeld")!.selector,
    };
    const selectorNames = new Map(Object.entries(selectors).map(([name, selector]) => [selector, name]));
    const providerCalls: Array<{ target: string | undefined; method: string | undefined }> = [];
    const sharesByMarket = new Map<string, bigint>([
        [CTOKEN_A.toLowerCase(), 20n],
        [CTOKEN_B.toLowerCase(), 30n],
    ]);
    const assetsByMarket = new Map<string, bigint>([
        [CTOKEN_A.toLowerCase(), 200n],
        [CTOKEN_B.toLowerCase(), 300n],
    ]);
    const liquidityByMarket = new Map<string, bigint>([
        [CTOKEN_A.toLowerCase(), 70n],
        [CTOKEN_B.toLowerCase(), 80n],
    ]);
    const capsByMarket = new Map<string, bigint>([
        [CTOKEN_A.toLowerCase(), WAD / 2n],
        [CTOKEN_B.toLowerCase(), (WAD * 3n) / 4n],
    ]);

    reader.contract = {
        getOptimizerAPY: async () => 999n,
    } as any;
    reader.provider = {
        async call(tx: { to?: string; data?: string }) {
            const selector = tx.data?.slice(0, 10);
            const target = tx.to?.toLowerCase();
            providerCalls.push({ target, method: selector == null ? undefined : selectorNames.get(selector) });

            if (target === OPTIMIZER.toLowerCase()) {
                switch (selector) {
                    case selectors.asset:
                        return optimizerIface.encodeFunctionResult("asset", [CTOKEN_A]);
                    case selectors.totalAssets:
                        return optimizerIface.encodeFunctionResult("totalAssets", [1_000n]);
                    case selectors.exchangeRate:
                        return optimizerIface.encodeFunctionResult("exchangeRate", [456n]);
                    case selectors.exchangeRateUpdated:
                        throw new Error("direct reads must not call exchangeRateUpdated");
                    case selectors.fee:
                        return optimizerIface.encodeFunctionResult("fee", [7n]);
                    case selectors.getApprovedMarkets:
                        return optimizerIface.encodeFunctionResult("getApprovedMarkets", [[CTOKEN_A, CTOKEN_B]]);
                    case selectors.allocationCaps: {
                        const [market] = optimizerIface.decodeFunctionData("allocationCaps", tx.data!);
                        return optimizerIface.encodeFunctionResult(
                            "allocationCaps",
                            [capsByMarket.get(String(market).toLowerCase()) ?? 0n],
                        );
                    }
                    default:
                        break;
                }
            }

            if (target != null && sharesByMarket.has(target)) {
                switch (selector) {
                    case selectors.balanceOf:
                        return cTokenIface.encodeFunctionResult("balanceOf", [sharesByMarket.get(target)!]);
                    case selectors.convertToAssets:
                        return cTokenIface.encodeFunctionResult("convertToAssets", [assetsByMarket.get(target)!]);
                    case selectors.assetsHeld:
                        return cTokenIface.encodeFunctionResult("assetsHeld", [liquidityByMarket.get(target)!]);
                    default:
                        break;
                }
            }

            throw new Error(`Unexpected optimizer market-data call: ${tx.to} ${tx.data}`);
        },
        async resolveName(name: string) {
            return name;
        },
    } as any;

    const result = await reader.getOptimizerMarketData([OPTIMIZER as any]);
    const sortedCalls = providerCalls
        .map((call) => `${call.target}:${call.method}`)
        .sort();

    assert.deepEqual(result, [{
        address: OPTIMIZER,
        asset: getAddress(CTOKEN_A),
        totalAssets: 1_000n,
        markets: [
            {
                address: getAddress(CTOKEN_A),
                allocatedAssets: 200n,
                liquidity: 70n,
                allocationCap: WAD / 2n,
                allocationCapUtilizationBps: 4_000n,
            },
            {
                address: getAddress(CTOKEN_B),
                allocatedAssets: 300n,
                liquidity: 80n,
                allocationCap: (WAD * 3n) / 4n,
                allocationCapUtilizationBps: 4_000n,
            },
        ],
        totalLiquidity: 150n,
        sharePrice: 456n,
        performanceFee: 7n,
        apy: 999n,
    }]);
    assert.deepEqual(sortedCalls, [
        `${OPTIMIZER.toLowerCase()}:allocationCaps`,
        `${OPTIMIZER.toLowerCase()}:allocationCaps`,
        `${OPTIMIZER.toLowerCase()}:asset`,
        `${OPTIMIZER.toLowerCase()}:exchangeRate`,
        `${OPTIMIZER.toLowerCase()}:fee`,
        `${OPTIMIZER.toLowerCase()}:getApprovedMarkets`,
        `${OPTIMIZER.toLowerCase()}:totalAssets`,
        `${CTOKEN_A.toLowerCase()}:assetsHeld`,
        `${CTOKEN_A.toLowerCase()}:balanceOf`,
        `${CTOKEN_A.toLowerCase()}:convertToAssets`,
        `${CTOKEN_B.toLowerCase()}:assetsHeld`,
        `${CTOKEN_B.toLowerCase()}:balanceOf`,
        `${CTOKEN_B.toLowerCase()}:convertToAssets`,
    ]);
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

test("optimalRebalanceAt forwards the timestamp and decodes actions plus bounds", async () => {
    const reader = createReader();
    let captured: { optimizer: string; slippageBps: bigint; timestamp: bigint } | null = null;
    const response: any = [
        [{ cToken: CTOKEN_A, assetsOrBps: -5n }],
        [{ cToken: CTOKEN_A, minBps: 1_000n, maxBps: 2_000n }],
    ];
    response.actions = response[0];
    response.bounds = response[1];

    reader.contract = {
        optimalRebalanceAt: async (optimizer: string, slippageBps: bigint, timestamp: bigint) => {
            captured = { optimizer, slippageBps, timestamp };
            return response;
        },
    } as any;

    const result = await reader.optimalRebalanceAt(OPTIMIZER as any, 25n, 123456n);

    assert.deepEqual(captured, {
        optimizer: OPTIMIZER,
        slippageBps: 25n,
        timestamp: 123456n,
    });
    assert.deepEqual(result, {
        actions: [{ cToken: CTOKEN_A, assetsOrBps: -5n }],
        bounds: [{ cToken: CTOKEN_A, minBps: 1_000n, maxBps: 2_000n }],
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

test("assetsAtTimestamp returns the raw projected asset amount", async () => {
    const reader = createReader();
    let captured: { account: string; cToken: string; timestamp: bigint } | null = null;

    reader.contract = {
        assetsAtTimestamp: async (account: string, cToken: string, timestamp: bigint) => {
            captured = { account, cToken, timestamp };
            return 12345n;
        },
    } as any;

    const result = await reader.assetsAtTimestamp(OPTIMIZER as any, CTOKEN_A as any, 789n);

    assert.deepEqual(captured, {
        account: OPTIMIZER,
        cToken: CTOKEN_A,
        timestamp: 789n,
    });
    assert.equal(result, 12345n);
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
