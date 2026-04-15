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
    options?: { refresh?: boolean }
): Promise<PortfolioSnapshot> {
    if (options?.refresh && all_markets.length > 0) {
        // Fetch all dynamic + user data in 2 RPC calls (not 2×N).
        // Each market's reload fetches ALL markets then filters — so we call
        // once via the shared reader and distribute results ourselves.
        const reader = all_markets[0]!.reader;
        const [dynamicData, userData] = await Promise.all([
            reader.getDynamicMarketData(),
            reader.getUserData(account),
        ]);

        for (const market of all_markets) {
            const dynamic = dynamicData.find((m) => m.address === market.address);
            const user = userData.markets.find((m) => m.address === market.address);
            if (!dynamic || !user) continue;

            market.cache.dynamic = dynamic;
            market.cache.user = user;

            for (const token of market.tokens) {
                const dynToken = dynamic.tokens.find((t) => t.address === token.address);
                const usrToken = user.tokens.find((t) => t.address === token.address);
                if (dynToken) token.cache = { ...token.cache, ...dynToken };
                if (usrToken) token.cache = { ...token.cache, ...usrToken };
            }
        }
    }

    const marketSnapshots: MarketSnapshot[] = [];
    let totalDepositsUSD = 0;
    let totalDebtUSD = 0;
    let dailyEarnings = 0;
    let dailyCost = 0;

    for (const market of all_markets) {
        const snap = snapshotMarket(market);
        marketSnapshots.push(snap);
        totalDepositsUSD += snap.totalDepositsUSD;
        totalDebtUSD += snap.totalDebtUSD;
        dailyEarnings += snap.dailyEarnings;
        dailyCost += snap.dailyCost;
    }

    return {
        account,
        chain: setup_config.chain,
        timestamp: Date.now(),
        totalDepositsUSD,
        totalDebtUSD,
        netUSD: totalDepositsUSD - totalDebtUSD,
        dailyEarnings,
        dailyCost,
        markets: marketSnapshots,
    };
}
