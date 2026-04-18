import { address, bytes, curvance_read_provider, Percentage } from "../../types";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import IDexAgg, { Quote, QuoteArgs } from "./IDexAgg";

export interface MultiDexAggConfig {
    /** Percentage deviation from median that marks a quote as an outlier (default: 20 = 20%) */
    outlierThresholdPercent?: number;
    /** Timeout in ms for individual aggregator quotes (default: 15000) */
    quoteTimeoutMs?: number;
}

interface QuoteResult {
    aggregator: IDexAgg;
    quote: Quote;
}

interface QuoteActionResult {
    aggregator: IDexAgg;
    action: Swap;
    quote: Quote;
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
export class MultiDexAgg implements IDexAgg {
    private aggregators: IDexAgg[];
    private primary: IDexAgg;
    private config: Required<MultiDexAggConfig>;

    /** Exposed from primary aggregator for backwards compatibility (Zapper.ts reads this) */
    get dao(): address { return this.primary.dao; }
    get router(): address { return this.primary.router; }

    constructor(aggregators: IDexAgg[], config: MultiDexAggConfig = {}) {
        if (aggregators.length === 0) {
            throw new Error("MultiDexAgg requires at least one aggregator");
        }

        this.aggregators = aggregators;
        this.primary = aggregators[0]!;
        this.config = {
            outlierThresholdPercent: config.outlierThresholdPercent ?? 20,
            quoteTimeoutMs: config.quoteTimeoutMs ?? 15_000,
        };
    }

    /**
     * Returns available tokens from all aggregators, deduplicated by address.
     * Primary aggregator's tokens take precedence on conflicts.
     */
    async getAvailableTokens(
        provider: curvance_read_provider,
        query: string | null = null,
        account: address | null = null,
    ): Promise<ZapToken[]> {
        if (this.aggregators.length === 1) {
            return this.primary.getAvailableTokens(provider, query, account);
        }

        const results = await Promise.allSettled(
            this.aggregators.map(agg => agg.getAvailableTokens(provider, query, account))
        );

        const seen = new Set<string>();
        const tokens: ZapToken[] = [];

        for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            for (const token of result.value) {
                const addr = token.interface.address.toLowerCase();
                if (!seen.has(addr)) {
                    seen.add(addr);
                    tokens.push(token);
                }
            }
        }

        return tokens;
    }

    /**
     * Fans out quoteAction to all aggregators, filters outliers, returns best.
     * Each aggregator is called exactly once.
     */
    async quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address): Promise<{ action: Swap; quote: Quote }> {
        if (this.aggregators.length === 1) {
            return this.primary.quoteAction(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        }

        const best = await this._bestQuoteAction(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        return { action: best.action, quote: best.quote };
    }

    /**
     * Returns the minimum output from the best quote.
     */
    async quoteMin(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address): Promise<BigInt> {
        if (this.aggregators.length === 1) {
            return this.primary.quoteMin(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        }

        const best = await this._bestQuote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        return best.quote.out;
    }

    /**
     * Returns the best quote across all aggregators.
     */
    async quote(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address): Promise<Quote> {
        if (this.aggregators.length === 1) {
            return this.primary.quote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        }

        const best = await this._bestQuote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        return best.quote;
    }

    // -----------------------------------------------------------------------
    // Internal: fan-out for quote()
    // -----------------------------------------------------------------------

    private async _bestQuote(
        wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address
    ): Promise<QuoteResult> {
        const results = await Promise.allSettled(
            this.aggregators.map(agg =>
                this._withTimeout(
                    agg.quote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver)
                        .then(quote => {
                            this._validateQuote(quote, agg);
                            return { aggregator: agg, quote } as QuoteResult;
                        }),
                    agg
                )
            )
        );

        return this._pickBest(results, tokenIn, tokenOut, amount);
    }

    // -----------------------------------------------------------------------
    // Internal: fan-out for quoteAction()
    // -----------------------------------------------------------------------

    private async _bestQuoteAction(
        wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address
    ): Promise<QuoteActionResult> {
        const results = await Promise.allSettled(
            this.aggregators.map(agg =>
                this._withTimeout(
                    agg.quoteAction(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver)
                        .then(({ action, quote }) => {
                            this._validateQuote(quote, agg);
                            return { aggregator: agg, action, quote } as QuoteActionResult;
                        }),
                    agg
                )
            )
        );

        return this._pickBest(results, tokenIn, tokenOut, amount);
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    /**
     * Wraps a promise with a timeout.
     */
    private _withTimeout<T>(promise: Promise<T>, agg: IDexAgg): Promise<T> {
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`${agg.constructor.name} timed out after ${this.config.quoteTimeoutMs}ms`)),
                this.config.quoteTimeoutMs
            )
        );
        return Promise.race([promise, timeout]);
    }

    /**
     * Validates a quote response has the required fields.
     */
    private _validateQuote(quote: Quote, agg: IDexAgg): void {
        if (!quote?.out || !quote?.calldata || !quote?.to) {
            throw new Error(`${agg.constructor.name} returned incomplete quote`);
        }
    }

    /**
     * From settled results, filter outliers and pick the best output.
     */
    private _pickBest<T extends { quote: Quote }>(
        results: PromiseSettledResult<T>[],
        tokenIn: string,
        tokenOut: string,
        amount: bigint
    ): T {
        const quotes: T[] = [];
        const errors: string[] = [];

        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            if (result.status === 'fulfilled') {
                quotes.push(result.value);
            } else {
                const aggName = this.aggregators[i]!.constructor.name;
                errors.push(`${aggName}: ${result.reason?.message || 'Unknown error'}`);
            }
        }

        if (quotes.length === 0) {
            throw new Error(
                `All ${this.aggregators.length} aggregators failed for ${tokenIn} → ${tokenOut} (amount: ${amount}):\n${errors.join('\n')}`
            );
        }

        if (quotes.length === 1) {
            return quotes[0]!;
        }

        // Filter outliers if enough data points
        const validQuotes = quotes.length >= 3
            ? this._filterOutliers(quotes)
            : quotes;

        const candidates = validQuotes.length > 0 ? validQuotes : quotes;

        // Return highest output
        let best = candidates[0]!;
        for (const candidate of candidates) {
            if (candidate.quote.out > best.quote.out) {
                best = candidate;
            }
        }

        return best;
    }

    /**
     * Filters quotes whose output deviates more than the threshold from the median.
     */
    private _filterOutliers<T extends { quote: Quote }>(quotes: T[]): T[] {
        const outputs = quotes.map(q => q.quote.out).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const median = outputs[Math.floor(outputs.length / 2)]!;

        if (median === 0n) return quotes;

        const threshold = BigInt(this.config.outlierThresholdPercent);

        return quotes.filter(q => {
            const diff = q.quote.out > median
                ? q.quote.out - median
                : median - q.quote.out;
            return (diff * 100n / median) <= threshold;
        });
    }
}
