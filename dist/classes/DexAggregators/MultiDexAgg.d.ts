import { address, curvance_provider } from "../../types";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import IDexAgg, { Quote } from "./IDexAgg";
export interface MultiDexAggConfig {
    /** Percentage deviation from median that marks a quote as an outlier (default: 20 = 20%) */
    outlierThresholdPercent?: number;
    /** Timeout in ms for individual aggregator quotes (default: 15000) */
    quoteTimeoutMs?: number;
}
/**
 * Multi-aggregator wrapper that implements IDexAgg.
 *
 * Backwards compatible: pass a single aggregator and it behaves identically
 * to using that aggregator directly. Pass multiple and it fans out quotes
 * in parallel, filters outliers, and returns the best valid result.
 *
 * Usage:
 *   // Single (identical to before):
 *   new MultiDexAgg([new KyberSwap()])
 *
 *   // Multi:
 *   new MultiDexAgg([new KyberSwap(), new Kuru()])
 */
export declare class MultiDexAgg implements IDexAgg {
    private aggregators;
    private primary;
    private config;
    /** Exposed from primary aggregator for backwards compatibility (Zapper.ts reads this) */
    get dao(): address;
    get router(): address;
    constructor(aggregators: IDexAgg[], config?: MultiDexAggConfig);
    /**
     * Returns available tokens from all aggregators, deduplicated by address.
     * Primary aggregator's tokens take precedence on conflicts.
     */
    getAvailableTokens(provider: curvance_provider, query?: string | null): Promise<ZapToken[]>;
    /**
     * Fans out quoteAction to all aggregators, filters outliers, returns best.
     * Each aggregator is called exactly once.
     */
    quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<{
        action: Swap;
        quote: Quote;
    }>;
    /**
     * Returns the minimum output from the best quote.
     */
    quoteMin(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<BigInt>;
    /**
     * Returns the best quote across all aggregators.
     */
    quote(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<Quote>;
    private _bestQuote;
    private _bestQuoteAction;
    /**
     * Wraps a promise with a timeout.
     */
    private _withTimeout;
    /**
     * Validates a quote response has the required fields.
     */
    private _validateQuote;
    /**
     * From settled results, filter outliers and pick the best output.
     */
    private _pickBest;
    /**
     * Filters quotes whose output deviates more than the threshold from the median.
     */
    private _filterOutliers;
}
//# sourceMappingURL=MultiDexAgg.d.ts.map