import { Market } from "../classes/Market";
import { address } from "../types";
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
/**
 * Snapshot a single market's user positions into plain numbers for JSON serialization.
 */
export declare function snapshotMarket(market: Market): MarketSnapshot;
/**
 * Take a full portfolio snapshot across all markets.
 *
 * @param account - Wallet address to snapshot
 * @param options.refresh - When true, reloads on-chain market + user data before reading cache.
 *                          Use this for indexer/cron jobs that need fresh data.
 */
export declare function takePortfolioSnapshot(account: address, options?: {
    refresh?: boolean;
}): Promise<PortfolioSnapshot>;
//# sourceMappingURL=snapshot.d.ts.map