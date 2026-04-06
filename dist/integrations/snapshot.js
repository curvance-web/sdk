"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotMarket = snapshotMarket;
exports.takePortfolioSnapshot = takePortfolioSnapshot;
const setup_1 = require("../setup");
// ── Functions ────────────────────────────────────────────────────────────────
/**
 * Snapshot a single market's user positions into plain numbers for JSON serialization.
 */
function snapshotMarket(market) {
    const positions = [];
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
                ? token.getBorrowRate(true).toNumber()
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
async function takePortfolioSnapshot(account, options) {
    if (options?.refresh && setup_1.all_markets.length > 0) {
        // Fetch all dynamic + user data in 2 RPC calls (not 2×N).
        // Each market's reload fetches ALL markets then filters — so we call
        // once via the shared reader and distribute results ourselves.
        const reader = setup_1.all_markets[0].reader;
        const [dynamicData, userData] = await Promise.all([
            reader.getDynamicMarketData(),
            reader.getUserData(account),
        ]);
        for (const market of setup_1.all_markets) {
            const dynamic = dynamicData.find((m) => m.address === market.address);
            const user = userData.markets.find((m) => m.address === market.address);
            if (!dynamic || !user)
                continue;
            market.cache.dynamic = dynamic;
            market.cache.user = user;
            for (const token of market.tokens) {
                const dynToken = dynamic.tokens.find((t) => t.address === token.address);
                const usrToken = user.tokens.find((t) => t.address === token.address);
                if (dynToken)
                    token.cache = { ...token.cache, ...dynToken };
                if (usrToken)
                    token.cache = { ...token.cache, ...usrToken };
            }
        }
    }
    const marketSnapshots = [];
    let totalDepositsUSD = 0;
    let totalDebtUSD = 0;
    let dailyEarnings = 0;
    let dailyCost = 0;
    for (const market of setup_1.all_markets) {
        const snap = snapshotMarket(market);
        marketSnapshots.push(snap);
        totalDepositsUSD += snap.totalDepositsUSD;
        totalDebtUSD += snap.totalDebtUSD;
        dailyEarnings += snap.dailyEarnings;
        dailyCost += snap.dailyCost;
    }
    return {
        account,
        chain: setup_1.setup_config.chain,
        timestamp: Date.now(),
        totalDepositsUSD,
        totalDebtUSD,
        netUSD: totalDepositsUSD - totalDebtUSD,
        dailyEarnings,
        dailyCost,
        markets: marketSnapshots,
    };
}
//# sourceMappingURL=snapshot.js.map