import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { Market } from "../src/classes/Market";
import { takePortfolioSnapshot } from "../src/integrations/snapshot";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const MARKET_A = "0x00000000000000000000000000000000000000a1";
const MARKET_B = "0x00000000000000000000000000000000000000b2";
const MARKET_C = "0x00000000000000000000000000000000000000c3";

function createToken(symbol: string, isBorrowable = false) {
    return {
        address: `0x${symbol.padEnd(40, "0").slice(0, 40)}`,
        symbol,
        isBorrowable,
        getUserAssetBalance: (_inUsd: boolean) => Decimal(10),
        getUserCollateral: (_inUsd: boolean) => Decimal(4),
        getUserDebt: (_inUsd: boolean) => Decimal(isBorrowable ? 2 : 0),
        getPrice: (_inUsd: boolean) => Decimal(1),
        getApy: () => Decimal(0.05),
        getBorrowRate: (_inPercentage: boolean) => Decimal(0.08),
    };
}

function createSnapshotMarket({
    address,
    name,
    chain,
    reader,
    applyState,
}: {
    address: string;
    name: string;
    chain: string;
    reader?: any;
    applyState?: (dynamic: { address: string }, user: { address: string }) => void;
}) {
    const market = Object.create(Market.prototype) as Market;
    market.address = address as any;
    market.reader = (reader ?? { batchKey: null, getAllDynamicState: async () => ({ dynamicMarket: [], userData: { markets: [] } }) }) as any;
    market.setup = { chain } as any;
    market.tokens = [createToken(name, true)] as any;
    market.applyState = (applyState ?? (() => undefined)) as any;

    Object.defineProperty(market, "name", {
        value: name,
        configurable: true,
    });
    Object.defineProperty(market, "positionHealth", {
        value: Decimal(1.25),
        configurable: true,
    });
    Object.defineProperty(market, "userDeposits", {
        value: Decimal(10),
        configurable: true,
    });
    Object.defineProperty(market, "userDebt", {
        value: Decimal(2),
        configurable: true,
    });
    Object.defineProperty(market, "userNet", {
        value: Decimal(8),
        configurable: true,
    });

    market.getUserDepositsChange = (() => Decimal(0.5)) as any;
    market.getUserDebtChange = (() => Decimal(0.1)) as any;

    return market;
}

test("takePortfolioSnapshot uses explicit markets and infers a single-chain label", async () => {
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Monad Market",
        chain: "monad-mainnet",
    });

    const snapshot = await takePortfolioSnapshot(ACCOUNT as any, {
        markets: [market],
    });

    assert.equal(snapshot.chain, "monad-mainnet");
    assert.equal(snapshot.markets.length, 1);
    assert.equal(snapshot.markets[0]?.marketAddress, MARKET_A);
    assert.equal(snapshot.totalDepositsUSD, 10);
    assert.equal(snapshot.totalDebtUSD, 2);
});

test("takePortfolioSnapshot labels mixed explicit market sets as multi", async () => {
    const monadMarket = createSnapshotMarket({
        address: MARKET_A,
        name: "Monad Market",
        chain: "monad-mainnet",
    });
    const arbMarket = createSnapshotMarket({
        address: MARKET_B,
        name: "Arbitrum Market",
        chain: "arb-sepolia",
    });

    const snapshot = await takePortfolioSnapshot(ACCOUNT as any, {
        markets: [monadMarket, arbMarket],
    });

    assert.equal(snapshot.chain, "multi");
    assert.equal(snapshot.markets.length, 2);
});

test("takePortfolioSnapshot refresh groups explicit markets by deployment key", async () => {
    const calls: Array<{ source: string; account: string }> = [];
    const applied: string[] = [];
    const sharedBatchKey = "monad-mainnet:0xreader";

    const readerA = {
        batchKey: sharedBatchKey,
        getAllDynamicState: async (account: string) => {
            calls.push({ source: "A", account });
            return {
                dynamicMarket: [
                    { address: MARKET_A },
                    { address: MARKET_B },
                ],
                userData: {
                    markets: [
                        { address: MARKET_A },
                        { address: MARKET_B },
                    ],
                },
            };
        },
    };

    const readerB = {
        batchKey: sharedBatchKey,
        getAllDynamicState: async () => {
            calls.push({ source: "B", account: ACCOUNT });
            throw new Error("same deployment should refresh through the first reader instance");
        },
    };

    const marketA = createSnapshotMarket({
        address: MARKET_A,
        name: "Market A",
        chain: "monad-mainnet",
        reader: readerA,
        applyState: (dynamic, user) => applied.push(`${dynamic.address}:${user.address}`),
    });
    const marketB = createSnapshotMarket({
        address: MARKET_B,
        name: "Market B",
        chain: "monad-mainnet",
        reader: readerB,
        applyState: (dynamic, user) => applied.push(`${dynamic.address}:${user.address}`),
    });
    const marketC = createSnapshotMarket({
        address: MARKET_C,
        name: "Market C",
        chain: "arb-sepolia",
        reader: {
            batchKey: "arb-sepolia:0xreader",
            getAllDynamicState: async (account: string) => {
                calls.push({ source: "C", account });
                return {
                    dynamicMarket: [{ address: MARKET_C }],
                    userData: {
                        markets: [{ address: MARKET_C }],
                    },
                };
            },
        },
        applyState: (dynamic, user) => applied.push(`${dynamic.address}:${user.address}`),
    });

    const snapshot = await takePortfolioSnapshot(ACCOUNT as any, {
        markets: [marketA, marketB, marketC],
        refresh: true,
    });

    assert.equal(snapshot.chain, "multi");
    assert.deepEqual(calls, [
        { source: "A", account: ACCOUNT },
        { source: "C", account: ACCOUNT },
    ]);
    assert.deepEqual(applied, [
        `${MARKET_A}:${MARKET_A}`,
        `${MARKET_B}:${MARKET_B}`,
        `${MARKET_C}:${MARKET_C}`,
    ]);
});
