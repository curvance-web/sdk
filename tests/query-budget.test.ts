import assert from "node:assert/strict";
import test from "node:test";
import { refreshActiveUserMarkets } from "../src/setup";
import { Market } from "../src/classes/Market";
import { ProtocolReader, type DynamicMarketData, type StaticMarketData } from "../src/classes/ProtocolReader";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const MARKET_A = "0x00000000000000000000000000000000000000a1";
const MARKET_B = "0x00000000000000000000000000000000000000b2";
const MARKET_C = "0x00000000000000000000000000000000000000c3";
const TOKEN_A = "0x00000000000000000000000000000000000000d1";

function createReader(): ProtocolReader {
    return Object.create(ProtocolReader.prototype) as ProtocolReader;
}

function createStaticMarket(address: string = MARKET_A): StaticMarketData {
    return {
        address: address as any,
        adapters: [],
        cooldownLength: 1200n,
        tokens: [{
            address: TOKEN_A as any,
            name: "Token",
            symbol: "TOK",
            decimals: 18n,
            asset: {
                address: TOKEN_A as any,
                name: "Token",
                symbol: "TOK",
                decimals: 18n,
                totalSupply: 1n,
            },
            adapters: [0n, 0n],
            isBorrowable: true,
            borrowPaused: false,
            collateralizationPaused: false,
            mintPaused: false,
            collateralCap: 0n,
            debtCap: 0n,
            isListed: true,
            collRatio: 0n,
            maxLeverage: 0n,
            collReqSoft: 0n,
            collReqHard: 0n,
            liqIncBase: 0n,
            liqIncCurve: 0n,
            liqIncMin: 0n,
            liqIncMax: 0n,
            closeFactorBase: 0n,
            closeFactorCurve: 0n,
            closeFactorMin: 0n,
            closeFactorMax: 0n,
            irmTargetRate: 0n,
            irmMaxRate: 0n,
            irmTargetUtilization: 0n,
            interestFee: 0n,
        }],
    };
}

function createDynamicMarket(address: string = MARKET_A): DynamicMarketData {
    return {
        address: address as any,
        tokens: [{
            address: TOKEN_A as any,
            exchangeRate: 2n,
            totalSupply: 10n,
            totalAssets: 20n,
            collateral: 3n,
            debt: 4n,
            sharePrice: 5n,
            assetPrice: 6n,
            sharePriceLower: 7n,
            assetPriceLower: 8n,
            borrowRate: 9n,
            predictedBorrowRate: 10n,
            utilizationRate: 11n,
            supplyRate: 12n,
            liquidity: 13n,
        }],
    };
}

function createMarket(
    address: string,
    reader: any,
    tokenCache: Partial<{
        userAssetBalance: bigint;
        userShareBalance: bigint;
        userUnderlyingBalance: bigint;
        userCollateral: bigint;
        userDebt: bigint;
    }> = {},
) {
    const market = Object.create(Market.prototype) as Market;
    market.address = address as any;
    market.reader = reader;
    market.tokens = [{
        address: TOKEN_A,
        cache: {
            userAssetBalance: 0n,
            userShareBalance: 0n,
            userUnderlyingBalance: 0n,
            userCollateral: 0n,
            userDebt: 0n,
            ...tokenCache,
        },
    }] as any;
    return market;
}

test("query budget: public boot uses static + dynamic reader calls only", async () => {
    const reader = createReader();
    const counts = {
        static: 0,
        dynamic: 0,
        combined: 0,
    };

    reader.getStaticMarketData = async () => {
        counts.static += 1;
        return [createStaticMarket()];
    };
    reader.getDynamicMarketData = async () => {
        counts.dynamic += 1;
        return [createDynamicMarket()];
    };
    reader.getAllDynamicState = async () => {
        counts.combined += 1;
        throw new Error("public boot should not request combined user state");
    };

    await reader.getAllMarketData(null);

    assert.deepEqual(counts, {
        static: 1,
        dynamic: 1,
        combined: 0,
    });
});

test("query budget: connected boot uses static + combined reader calls only", async () => {
    const reader = createReader();
    const counts = {
        static: 0,
        dynamic: 0,
        combined: 0,
    };

    reader.getStaticMarketData = async () => {
        counts.static += 1;
        return [createStaticMarket()];
    };
    reader.getDynamicMarketData = async () => {
        counts.dynamic += 1;
        throw new Error("connected boot should use the combined call");
    };
    reader.getAllDynamicState = async () => {
        counts.combined += 1;
        return {
            dynamicMarket: [createDynamicMarket()],
            userData: {
                locks: [],
                markets: [],
            },
        };
    };

    await reader.getAllMarketData(ACCOUNT as any);

    assert.deepEqual(counts, {
        static: 1,
        dynamic: 0,
        combined: 1,
    });
});

test("query budget: refreshActiveUserMarkets batches only active markets", async () => {
    const calls: Array<{ addresses: string[]; account: string }> = [];
    const applied: string[] = [];
    const reader = {
        getMarketStates: async (addresses: string[], account: string) => {
            calls.push({ addresses, account });
            return {
                dynamicMarkets: addresses.map((address) => ({ address })),
                userMarkets: addresses.map((address) => ({ address })),
            };
        },
    } as any;

    const activeDeposit = createMarket(MARKET_A, reader, { userAssetBalance: 1n });
    activeDeposit.applyState = ((dynamic: { address: string }, user: { address: string }) => {
        applied.push(`${dynamic.address}:${user.address}`);
    }) as any;

    const walletOnly = createMarket(MARKET_B, reader, { userUnderlyingBalance: 99n });
    walletOnly.applyState = (() => {
        throw new Error("wallet-only market should not be refreshed");
    }) as any;

    const activeDebt = createMarket(MARKET_C, reader, { userDebt: 5n });
    activeDebt.applyState = ((dynamic: { address: string }, user: { address: string }) => {
        applied.push(`${dynamic.address}:${user.address}`);
    }) as any;

    const refreshed = await refreshActiveUserMarkets(ACCOUNT as any, [activeDeposit, walletOnly, activeDebt]);

    assert.deepEqual(refreshed, [activeDeposit, activeDebt]);
    assert.deepEqual(calls, [{
        addresses: [MARKET_A, MARKET_C],
        account: ACCOUNT,
    }]);
    assert.deepEqual(applied, [
        `${MARKET_A}:${MARKET_A}`,
        `${MARKET_C}:${MARKET_C}`,
    ]);
});

test("query budget: reloadUserData uses one targeted market-state call", async () => {
    const calls: Array<{ addresses: string[]; account: string }> = [];
    const market = createMarket(MARKET_A, {
        getDynamicMarketData: async () => {
            throw new Error("reloadUserData should not fetch all dynamic markets");
        },
        getMarketStates: async (addresses: string[], account: string) => {
            calls.push({ addresses, account });
            return {
                dynamicMarkets: [{ address: MARKET_A }],
                userMarkets: [{ address: MARKET_A }],
            };
        },
    });
    let applied = 0;
    market.applyState = (() => {
        applied += 1;
    }) as any;

    await market.reloadUserData(ACCOUNT as any);

    assert.deepEqual(calls, [{
        addresses: [MARKET_A],
        account: ACCOUNT,
    }]);
    assert.equal(applied, 1);
});
