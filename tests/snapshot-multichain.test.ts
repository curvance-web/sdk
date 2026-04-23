import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { Market } from "../src/classes/Market";
import { ProtocolReader } from "../src/classes/ProtocolReader";
import { snapshotMarket, takePortfolioSnapshot } from "../src/integrations/snapshot";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000bb";
const MARKET_A = "0x00000000000000000000000000000000000000a1";
const MARKET_B = "0x00000000000000000000000000000000000000b2";
const MARKET_C = "0x00000000000000000000000000000000000000c3";
const READER = "0x00000000000000000000000000000000000000d4";

function createToken(symbol: string, isBorrowable = false) {
    return {
        address: `0x${symbol.padEnd(40, "0").slice(0, 40)}`,
        symbol,
        isBorrowable,
        getUserAssetBalance: (_inUsd: boolean) => Decimal(10),
        getUserCollateral: (_inUsd: boolean) => Decimal(4),
        getUserCollateralAssets: () => Decimal(4),
        getUserDebt: (_inUsd: boolean) => Decimal(isBorrowable ? 2 : 0),
        getPrice: (_inUsd: boolean) => Decimal(1),
        getApy: () => Decimal(0.05),
        getBorrowRate: (_inPercentage: boolean) => Decimal(0.08),
    };
}

function createRefreshDynamicMarket(address: string, tokenAddress: string) {
    return {
        address,
        tokens: [{ address: tokenAddress }],
    };
}

function createRefreshUserMarket(address: string, tokenAddress: string) {
    return {
        address,
        tokens: [{ address: tokenAddress }],
    };
}

function createSnapshotMarket({
    address,
    name,
    chain,
    reader,
    applyState,
    account = ACCOUNT,
    signer = null,
}: {
    address: string;
    name: string;
    chain: string;
    reader?: any;
    applyState?: (dynamic: { address: string }, user: { address: string }) => void;
    account?: string | null;
    signer?: { address: string } | null;
}) {
    const market = Object.create(Market.prototype) as Market;
    const token = createToken(name, true);
    market.address = address as any;
    market.account = account as any;
    market.signer = signer as any ?? null;
    market.reader = (reader ?? { batchKey: null, getAllDynamicState: async () => ({ dynamicMarket: [], userData: { markets: [] } }) }) as any;
    market.setup = { chain } as any;
    market.tokens = [token] as any;
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
    assert.equal(snapshot.totalDepositsUSD, "10");
    assert.equal(snapshot.totalDebtUSD, "2");
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

test("snapshotMarket reports collateral token amounts as assets and exposes raw shares separately", () => {
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Monad Market",
        chain: "monad-mainnet",
    });
    market.tokens = [{
        ...createToken("cMON", false),
        getUserCollateral: (inUsd: boolean) => inUsd ? Decimal(18) : Decimal(6),
        getUserCollateralAssets: () => Decimal(9),
        getPrice: () => Decimal(2),
    }] as any;

    const snapshot = snapshotMarket(market);

    assert.equal(snapshot.positions[0]?.collateralUSD, "18");
    assert.equal(snapshot.positions[0]?.collateralTokens, "9");
    assert.equal(snapshot.positions[0]?.collateralShares, "6");
});

test("snapshotMarket serializes high-precision decimal values as strings", () => {
    const precise = "900719925474099312345.123456789";
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Precision Market",
        chain: "monad-mainnet",
    });
    market.tokens = [{
        ...createToken("cBIG", true),
        getUserAssetBalance: () => Decimal(precise),
        getUserCollateral: () => Decimal(precise),
        getUserCollateralAssets: () => Decimal(precise),
        getUserDebt: () => Decimal(precise),
        getPrice: () => Decimal("123456789.123456789"),
        getApy: () => Decimal("0.123456789123456789"),
        getBorrowRate: () => Decimal("0.987654321987654321"),
    }] as any;
    Object.defineProperty(market, "userDeposits", {
        value: Decimal(precise),
        configurable: true,
    });
    Object.defineProperty(market, "userDebt", {
        value: Decimal(precise),
        configurable: true,
    });
    Object.defineProperty(market, "userNet", {
        value: Decimal("0"),
        configurable: true,
    });

    const snapshot = snapshotMarket(market);

    assert.equal(snapshot.totalDepositsUSD, precise);
    assert.equal(snapshot.positions[0]?.depositUSD, precise);
    assert.equal(snapshot.positions[0]?.assetPriceUSD, "123456789.123456789");
    assert.equal(snapshot.positions[0]?.borrowRate, "0.987654321987654321");
    assert.equal(typeof snapshot.totalDepositsUSD, "string");
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
                    createRefreshDynamicMarket(MARKET_A, marketA.tokens[0]!.address),
                    createRefreshDynamicMarket(MARKET_B, marketB.tokens[0]!.address),
                ],
                userData: {
                    markets: [
                        createRefreshUserMarket(MARKET_A, marketA.tokens[0]!.address),
                        createRefreshUserMarket(MARKET_B, marketB.tokens[0]!.address),
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
                    dynamicMarket: [createRefreshDynamicMarket(MARKET_C, marketC.tokens[0]!.address)],
                    userData: {
                        markets: [createRefreshUserMarket(MARKET_C, marketC.tokens[0]!.address)],
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
    assert.equal(marketA.account, ACCOUNT);
    assert.equal(marketB.account, ACCOUNT);
    assert.equal(marketC.account, ACCOUNT);
});

test("takePortfolioSnapshot refresh keeps same-chain readers with different providers separate", async () => {
    const calls: string[] = [];

    const readerA = new ProtocolReader(READER as any, { label: "provider-a" } as any, "monad-mainnet");
    readerA.getAllDynamicState = (async () => {
        calls.push("A");
        return {
            dynamicMarket: [createRefreshDynamicMarket(MARKET_A, marketA.tokens[0]!.address)],
            userData: { markets: [createRefreshUserMarket(MARKET_A, marketA.tokens[0]!.address)] },
        };
    }) as any;

    const readerB = new ProtocolReader(READER as any, { label: "provider-b" } as any, "monad-mainnet");
    readerB.getAllDynamicState = (async () => {
        calls.push("B");
        return {
            dynamicMarket: [createRefreshDynamicMarket(MARKET_B, marketB.tokens[0]!.address)],
            userData: { markets: [createRefreshUserMarket(MARKET_B, marketB.tokens[0]!.address)] },
        };
    }) as any;

    const marketA = createSnapshotMarket({
        address: MARKET_A,
        name: "Reader A",
        chain: "monad-mainnet",
        reader: readerA,
    });
    const marketB = createSnapshotMarket({
        address: MARKET_B,
        name: "Reader B",
        chain: "monad-mainnet",
        reader: readerB,
    });

    await takePortfolioSnapshot(ACCOUNT as any, {
        markets: [marketA, marketB],
        refresh: true,
    });

    assert.notEqual(readerA.batchKey, readerB.batchKey);
    assert.deepEqual(calls, ["A", "B"]);
});

test("takePortfolioSnapshot refresh fails closed when a refreshed market payload is missing", async () => {
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Missing Market",
        chain: "monad-mainnet",
        reader: {
            batchKey: "monad-mainnet:missing-reader",
            getAllDynamicState: async () => ({
                dynamicMarket: [],
                userData: { markets: [] },
            }),
        },
    });

    await assert.rejects(
        () => takePortfolioSnapshot(ACCOUNT as any, {
            markets: [market],
            refresh: true,
        }),
        /Fresh snapshot refresh missing market state/i,
    );
});

test("takePortfolioSnapshot refresh commits no partial state when a later grouped market is missing", async () => {
    const applied: string[] = [];
    const reader = {
        batchKey: "monad-mainnet:partial-reader",
        getAllDynamicState: async () => ({
            dynamicMarket: [createRefreshDynamicMarket(MARKET_A, marketA.tokens[0]!.address)],
            userData: { markets: [createRefreshUserMarket(MARKET_A, marketA.tokens[0]!.address)] },
        }),
    };
    const marketA = createSnapshotMarket({
        address: MARKET_A,
        name: "Market A",
        chain: "monad-mainnet",
        reader,
        applyState: (dynamic, user) => applied.push(`${dynamic.address}:${user.address}`),
    });
    const marketB = createSnapshotMarket({
        address: MARKET_B,
        name: "Market B",
        chain: "monad-mainnet",
        reader,
        applyState: (dynamic, user) => applied.push(`${dynamic.address}:${user.address}`),
    });

    await assert.rejects(
        () => takePortfolioSnapshot(OTHER_ACCOUNT as any, {
            markets: [marketA, marketB],
            refresh: true,
        }),
        /Fresh snapshot refresh missing market state/i,
    );

    assert.deepEqual(applied, []);
    assert.equal(marketA.account, ACCOUNT);
    assert.equal(marketB.account, ACCOUNT);
});

test("takePortfolioSnapshot refresh commits no partial state when a later reader group fails", async () => {
    const applied: string[] = [];
    const marketA = createSnapshotMarket({
        address: MARKET_A,
        name: "Market A",
        chain: "monad-mainnet",
        reader: {
            batchKey: "monad-mainnet:first-reader",
            getAllDynamicState: async () => ({
                dynamicMarket: [createRefreshDynamicMarket(MARKET_A, marketA.tokens[0]!.address)],
                userData: { markets: [createRefreshUserMarket(MARKET_A, marketA.tokens[0]!.address)] },
            }),
        },
        applyState: (dynamic, user) => applied.push(`${dynamic.address}:${user.address}`),
    });
    const marketB = createSnapshotMarket({
        address: MARKET_B,
        name: "Market B",
        chain: "arb-sepolia",
        reader: {
            batchKey: "arb-sepolia:second-reader",
            getAllDynamicState: async () => {
                throw new Error("later reader failed");
            },
        },
        applyState: (dynamic, user) => applied.push(`${dynamic.address}:${user.address}`),
    });

    await assert.rejects(
        () => takePortfolioSnapshot(OTHER_ACCOUNT as any, {
            markets: [marketA, marketB],
            refresh: true,
        }),
        /later reader failed/i,
    );

    assert.deepEqual(applied, []);
    assert.equal(marketA.account, ACCOUNT);
    assert.equal(marketB.account, ACCOUNT);
});

test("takePortfolioSnapshot refresh does not bind account when state application fails", async () => {
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Malformed Refresh Market",
        chain: "monad-mainnet",
        account: ACCOUNT,
        reader: {
            batchKey: "monad-mainnet:malformed-reader",
            getAllDynamicState: async () => ({
                dynamicMarket: [createRefreshDynamicMarket(MARKET_A, market.tokens[0]!.address)],
                userData: { markets: [createRefreshUserMarket(MARKET_A, market.tokens[0]!.address)] },
            }),
        },
        applyState: () => {
            throw new Error("malformed token rows");
        },
    });

    await assert.rejects(
        () => takePortfolioSnapshot(OTHER_ACCOUNT as any, {
            markets: [market],
            refresh: true,
        }),
        /malformed token rows/i,
    );
    assert.equal(market.account, ACCOUNT);
});

test("takePortfolioSnapshot refresh rejects signer-backed markets for a different account before RPC", async () => {
    let readerCalled = false;
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Signer Market",
        chain: "monad-mainnet",
        account: ACCOUNT,
        signer: { address: ACCOUNT },
        reader: {
            batchKey: "monad-mainnet:signer-reader",
            getAllDynamicState: async () => {
                readerCalled = true;
                throw new Error("reader should not be called for signer/account mismatch");
            },
        },
    });

    await assert.rejects(
        () => takePortfolioSnapshot(OTHER_ACCOUNT as any, {
            markets: [market],
            refresh: true,
        }),
        /Cannot refresh signer-backed market/i,
    );
    assert.equal(readerCalled, false);
    assert.equal(market.account, ACCOUNT);
});

test("takePortfolioSnapshot rejects full caches bound to a different account unless refreshed", async () => {
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Wrong Account Market",
        chain: "monad-mainnet",
        account: "0x00000000000000000000000000000000000000bb",
    });

    await assert.rejects(
        () => takePortfolioSnapshot(ACCOUNT as any, {
            markets: [market],
        }),
        /cache is bound to 0x00000000000000000000000000000000000000bb/i,
    );
});

test("takePortfolioSnapshot promotes summary-scoped markets back to full user data", async () => {
    let scope: "summary" | "full" = "summary";
    let reloads = 0;

    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Summary Market",
        chain: "monad-mainnet",
        reader: {
            batchKey: "monad-mainnet:summary-reader",
            getMarketStates: async () => {
                reloads += 1;
                return {
                    dynamicMarkets: [createRefreshDynamicMarket(MARKET_A, market.tokens[0]!.address)],
                    userMarkets: [createRefreshUserMarket(MARKET_A, market.tokens[0]!.address)],
                };
            },
        },
        applyState: () => {
            scope = "full";
        },
    });

    Object.defineProperty(market, "userDataScope", {
        get: () => scope,
        configurable: true,
    });

    const snapshot = await takePortfolioSnapshot(ACCOUNT as any, {
        markets: [market],
    });

    assert.equal(reloads, 1);
    assert.equal(scope, "full");
    assert.equal(snapshot.markets[0]?.marketAddress, MARKET_A);
});

test("snapshot helpers fail clearly after a summary-only refresh", () => {
    const market = createSnapshotMarket({
        address: MARKET_A,
        name: "Summary Market",
        chain: "monad-mainnet",
    });
    Object.defineProperty(market, "userDataScope", {
        value: "summary",
        configurable: true,
    });

    assert.throws(
        () => snapshotMarket(market),
        /summary-refreshed market/i,
    );
});
