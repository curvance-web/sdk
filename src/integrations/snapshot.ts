import { Market } from "../classes/Market";
import { BorrowableCToken } from "../classes/BorrowableCToken";
import { all_markets, setup_config } from "../setup";
import { address } from "../types";
import { Decimal } from "decimal.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PositionSnapshot {
    tokenAddress: string;
    tokenSymbol: string;
    isBorrowable: boolean;
    depositUSD: string;
    depositTokens: string;
    collateralUSD: string;
    collateralTokens: string;
    collateralShares: string;
    debtUSD: string;
    debtTokens: string;
    assetPriceUSD: string;
    supplyAPY: string;
    borrowRate: string;
}

export interface MarketSnapshot {
    marketAddress: string;
    marketName: string;
    totalDepositsUSD: string;
    totalDebtUSD: string;
    netUSD: string;
    positionHealth: string | null;
    dailyEarnings: string;
    dailyCost: string;
    positions: PositionSnapshot[];
}

export interface PortfolioSnapshot {
    account: string;
    chain: string;
    timestamp: number;
    totalDepositsUSD: string;
    totalDebtUSD: string;
    netUSD: string;
    dailyEarnings: string;
    dailyCost: string;
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

function assertSnapshotCompatibleMarket(market: Market) {
    if (market.userDataScope !== "summary") {
        return;
    }

    throw new Error(
        `snapshotMarket requires full user token data for ${market.address}. ` +
        `Call market.reloadUserData(account), Market.reloadUserMarkets(...), or ` +
        `takePortfolioSnapshot(account, { refresh: true }) before snapshotting a summary-refreshed market.`,
    );
}

function assertSnapshotAccount(market: Market, account: address) {
    if (market.account?.toLowerCase() === account.toLowerCase()) {
        return;
    }

    throw new Error(
        `takePortfolioSnapshot cannot snapshot ${market.address} for ${account} ` +
        `because the market cache is bound to ${market.account ?? "no account"}. ` +
        `Call takePortfolioSnapshot(account, { refresh: true }) or reload the market for this account first.`,
    );
}

// ── Functions ────────────────────────────────────────────────────────────────

function decimalSnapshot(value: Decimal): string {
    return value.toString();
}

/**
 * Snapshot a single market's user positions into decimal strings for JSON serialization.
 */
export function snapshotMarket(market: Market): MarketSnapshot {
    assertSnapshotCompatibleMarket(market);

    const positions: PositionSnapshot[] = [];

    for (const token of market.tokens) {
        const isBorrowable = token.isBorrowable;

        positions.push({
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            isBorrowable,
            depositUSD: decimalSnapshot(token.getUserAssetBalance(true)),
            depositTokens: decimalSnapshot(token.getUserAssetBalance(false)),
            collateralUSD: decimalSnapshot(token.getUserCollateral(true)),
            collateralTokens: decimalSnapshot(token.getUserCollateralAssets()),
            collateralShares: decimalSnapshot(token.getUserCollateral(false)),
            debtUSD: decimalSnapshot(token.getUserDebt(true)),
            debtTokens: decimalSnapshot(token.getUserDebt(false)),
            assetPriceUSD: decimalSnapshot(token.getPrice(true)),
            supplyAPY: decimalSnapshot(token.getApy()),
            borrowRate: isBorrowable
                ? decimalSnapshot((token as BorrowableCToken).getBorrowRate(true))
                : "0",
        });
    }

    const health = market.positionHealth;

    return {
        marketAddress: market.address,
        marketName: market.name,
        totalDepositsUSD: decimalSnapshot(market.userDeposits),
        totalDebtUSD: decimalSnapshot(market.userDebt),
        netUSD: decimalSnapshot(market.userNet),
        positionHealth: health !== null ? decimalSnapshot(health) : null,
        dailyEarnings: decimalSnapshot(market.getUserDepositsChange("day")),
        dailyCost: decimalSnapshot(market.getUserDebtChange("day")),
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
        for (const market of markets) {
            market.assertRefreshAccountCompatible(account);
        }

        const plans: Array<{
            market: Market;
            dynamic: Parameters<Market["applyState"]>[0];
            user: NonNullable<Parameters<Market["applyState"]>[1]>;
        }> = [];

        for (const { reader, markets: groupedMarkets } of groupMarketsByReaderDeployment(markets)) {
            const { dynamicMarket, userData } = await reader.getAllDynamicState(account);
            const dynamicByAddress = new Map(dynamicMarket.map((market) => [market.address.toLowerCase(), market]));
            const userByAddress = new Map(userData.markets.map((market) => [market.address.toLowerCase(), market]));

            for (const market of groupedMarkets) {
                const dynamic = dynamicByAddress.get(market.address.toLowerCase());
                const user = userByAddress.get(market.address.toLowerCase());
                if (!dynamic || !user) {
                    throw new Error(
                        `Fresh snapshot refresh missing market state for ${market.address}.`,
                    );
                }
                market.validateRefreshState(dynamic, user);
                plans.push({ market, dynamic, user });
            }
        }

        for (const { market, dynamic, user } of plans) {
            market.applyState(dynamic, user);
            market.bindRefreshedAccount(account);
        }
    } else {
        const summaryScopedMarkets = markets.filter((market) => market.userDataScope === "summary");
        if (summaryScopedMarkets.length > 0) {
            await Market.reloadUserMarkets(summaryScopedMarkets, account);
        }
    }

    const marketSnapshots: MarketSnapshot[] = [];
    let totalDepositsUSD = Decimal(0);
    let totalDebtUSD = Decimal(0);
    let dailyEarnings = Decimal(0);
    let dailyCost = Decimal(0);

    for (const market of markets) {
        assertSnapshotAccount(market, account);
        const snap = snapshotMarket(market);
        marketSnapshots.push(snap);
        totalDepositsUSD = totalDepositsUSD.plus(snap.totalDepositsUSD);
        totalDebtUSD = totalDebtUSD.plus(snap.totalDebtUSD);
        dailyEarnings = dailyEarnings.plus(snap.dailyEarnings);
        dailyCost = dailyCost.plus(snap.dailyCost);
    }

    return {
        account,
        chain: options.chain ?? inferSnapshotChain(markets),
        timestamp: Date.now(),
        totalDepositsUSD: decimalSnapshot(totalDepositsUSD),
        totalDebtUSD: decimalSnapshot(totalDebtUSD),
        netUSD: decimalSnapshot(totalDepositsUSD.sub(totalDebtUSD)),
        dailyEarnings: decimalSnapshot(dailyEarnings),
        dailyCost: decimalSnapshot(dailyCost),
        markets: marketSnapshots,
    };
}
