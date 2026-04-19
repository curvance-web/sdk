import { Market } from "../classes/Market";
import { BorrowableCToken } from "../classes/BorrowableCToken";
import { all_markets, setup_config } from "../setup";
import { address } from "../types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PositionSnapshot {
    tokenAddress: string;
    tokenSymbol: string;
    isBorrowable: boolean;
    depositUSD: number;
    depositTokens: number;
    collateralUSD: number;
    collateralTokens: number;
    debtUSD: number;
    debtTokens: number;
    assetPriceUSD: number;
    supplyAPY: number;
    borrowRate: number;
}

export interface MarketSnapshot {
    marketAddress: string;
    marketName: string;
    totalDepositsUSD: number;
    totalDebtUSD: number;
    netUSD: number;
    positionHealth: number | null;
    dailyEarnings: number;
    dailyCost: number;
    positions: PositionSnapshot[];
}

export interface PortfolioSnapshot {
    account: string;
    chain: string;
    timestamp: number;
    totalDepositsUSD: number;
    totalDebtUSD: number;
    netUSD: number;
    dailyEarnings: number;
    dailyCost: number;
    markets: MarketSnapshot[];
}

export interface PortfolioSnapshotOptions {
    refresh?: boolean;
    markets?: Market[];
    chain?: string;
}

function inferSnapshotChain(markets: Market[]): string {
    if (markets.length === 0) {
        return setup_config?.chain ?? "unknown";
    }

    const chains = new Set(markets.map((market) => market.setup.chain));
    return chains.size === 1 ? markets[0]!.setup.chain : "multi";
}

function groupMarketsByReaderDeployment(markets: Market[]) {
    const groups = new Map<string | Market["reader"], { reader: Market["reader"]; markets: Market[] }>();

    for (const market of markets) {
        const key = market.reader.batchKey ?? market.reader;
        const existing = groups.get(key);
        if (existing) {
            existing.markets.push(market);
        } else {
            groups.set(key, { reader: market.reader, markets: [market] });
        }
    }

    return groups.values();
}

// ── Functions ────────────────────────────────────────────────────────────────

/**
 * Snapshot a single market's user positions into plain numbers for JSON serialization.
 */
export function snapshotMarket(market: Market): MarketSnapshot {
    const positions: PositionSnapshot[] = [];

    for (const token of market.tokens) {
        const isBorrowable = token.isBorrowable;

        positions.push({
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            isBorrowable,
            depositUSD: token.getUserAssetBalance(true).toNumber(),
            depositTokens: token.getUserAssetBalance(false).toNumber(),
            collateralUSD: token.getUserCollateral(true).toNumber(),
            collateralTokens: token.getUserCollateral(false).toNumber(),
            debtUSD: token.getUserDebt(true).toNumber(),
            debtTokens: token.getUserDebt(false).toNumber(),
            assetPriceUSD: token.getPrice(true).toNumber(),
            supplyAPY: token.getApy().toNumber(),
            borrowRate: isBorrowable
                ? (token as BorrowableCToken).getBorrowRate(true).toNumber()
                : 0,
        });
    }

    const health = market.positionHealth;

    return {
        marketAddress: market.address,
        marketName: market.name,
        totalDepositsUSD: market.userDeposits.toNumber(),
        totalDebtUSD: market.userDebt.toNumber(),
        netUSD: market.userNet.toNumber(),
        positionHealth: health !== null ? health.toNumber() : null,
        dailyEarnings: market.getUserDepositsChange("day").toNumber(),
        dailyCost: market.getUserDebtChange("day").toNumber(),
        positions,
    };
}

/**
 * Take a full portfolio snapshot across all markets.
 *
 * @param account - Wallet address to snapshot
 * @param options.refresh - When true, reloads on-chain market + user data before reading cache.
 *                          Use this for indexer/cron jobs that need fresh data.
 */
export async function takePortfolioSnapshot(
    account: address,
    options: PortfolioSnapshotOptions = {},
): Promise<PortfolioSnapshot> {
    const markets = options.markets ?? all_markets;

    if (options.refresh && markets.length > 0) {
        for (const { reader, markets: groupedMarkets } of groupMarketsByReaderDeployment(markets)) {
            const { dynamicMarket, userData } = await reader.getAllDynamicState(account);

            for (const market of groupedMarkets) {
                const dynamic = dynamicMarket.find((m) => m.address === market.address);
                const user = userData.markets.find((m) => m.address === market.address);
                if (!dynamic || !user) continue;
                market.applyState(dynamic, user);
            }
        }
    }

    const marketSnapshots: MarketSnapshot[] = [];
    let totalDepositsUSD = 0;
    let totalDebtUSD = 0;
    let dailyEarnings = 0;
    let dailyCost = 0;

    for (const market of markets) {
        const snap = snapshotMarket(market);
        marketSnapshots.push(snap);
        totalDepositsUSD += snap.totalDepositsUSD;
        totalDebtUSD += snap.totalDebtUSD;
        dailyEarnings += snap.dailyEarnings;
        dailyCost += snap.dailyCost;
    }

    return {
        account,
        chain: options.chain ?? inferSnapshotChain(markets),
        timestamp: Date.now(),
        totalDepositsUSD,
        totalDebtUSD,
        netUSD: totalDepositsUSD - totalDebtUSD,
        dailyEarnings,
        dailyCost,
        markets: marketSnapshots,
    };
}
