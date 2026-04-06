"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiDexAgg = void 0;
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
class MultiDexAgg {
    aggregators;
    primary;
    config;
    /** Exposed from primary aggregator for backwards compatibility (Zapper.ts reads this) */
    get dao() { return this.primary.dao; }
    get router() { return this.primary.router; }
    constructor(aggregators, config = {}) {
        if (aggregators.length === 0) {
            throw new Error("MultiDexAgg requires at least one aggregator");
        }
        this.aggregators = aggregators;
        this.primary = aggregators[0];
        this.config = {
            outlierThresholdPercent: config.outlierThresholdPercent ?? 20,
            quoteTimeoutMs: config.quoteTimeoutMs ?? 15_000,
        };
    }
    /**
     * Returns available tokens from all aggregators, deduplicated by address.
     * Primary aggregator's tokens take precedence on conflicts.
     */
    async getAvailableTokens(provider, query = null) {
        if (this.aggregators.length === 1) {
            return this.primary.getAvailableTokens(provider, query);
        }
        const results = await Promise.allSettled(this.aggregators.map(agg => agg.getAvailableTokens(provider, query)));
        const seen = new Set();
        const tokens = [];
        for (const result of results) {
            if (result.status !== 'fulfilled')
                continue;
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
    async quoteAction(wallet, tokenIn, tokenOut, amount, slippage) {
        if (this.aggregators.length === 1) {
            return this.primary.quoteAction(wallet, tokenIn, tokenOut, amount, slippage);
        }
        const best = await this._bestQuoteAction(wallet, tokenIn, tokenOut, amount, slippage);
        return { action: best.action, quote: best.quote };
    }
    /**
     * Returns the minimum output from the best quote.
     */
    async quoteMin(wallet, tokenIn, tokenOut, amount, slippage) {
        if (this.aggregators.length === 1) {
            return this.primary.quoteMin(wallet, tokenIn, tokenOut, amount, slippage);
        }
        const best = await this._bestQuote(wallet, tokenIn, tokenOut, amount, slippage);
        return best.quote.out;
    }
    /**
     * Returns the best quote across all aggregators.
     */
    async quote(wallet, tokenIn, tokenOut, amount, slippage) {
        if (this.aggregators.length === 1) {
            return this.primary.quote(wallet, tokenIn, tokenOut, amount, slippage);
        }
        const best = await this._bestQuote(wallet, tokenIn, tokenOut, amount, slippage);
        return best.quote;
    }
    // -----------------------------------------------------------------------
    // Internal: fan-out for quote()
    // -----------------------------------------------------------------------
    async _bestQuote(wallet, tokenIn, tokenOut, amount, slippage) {
        const results = await Promise.allSettled(this.aggregators.map(agg => this._withTimeout(agg.quote(wallet, tokenIn, tokenOut, amount, slippage)
            .then(quote => {
            this._validateQuote(quote, agg);
            return { aggregator: agg, quote };
        }), agg)));
        return this._pickBest(results, tokenIn, tokenOut, amount);
    }
    // -----------------------------------------------------------------------
    // Internal: fan-out for quoteAction()
    // -----------------------------------------------------------------------
    async _bestQuoteAction(wallet, tokenIn, tokenOut, amount, slippage) {
        const results = await Promise.allSettled(this.aggregators.map(agg => this._withTimeout(agg.quoteAction(wallet, tokenIn, tokenOut, amount, slippage)
            .then(({ action, quote }) => {
            this._validateQuote(quote, agg);
            return { aggregator: agg, action, quote };
        }), agg)));
        return this._pickBest(results, tokenIn, tokenOut, amount);
    }
    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------
    /**
     * Wraps a promise with a timeout.
     */
    _withTimeout(promise, agg) {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${agg.constructor.name} timed out after ${this.config.quoteTimeoutMs}ms`)), this.config.quoteTimeoutMs));
        return Promise.race([promise, timeout]);
    }
    /**
     * Validates a quote response has the required fields.
     */
    _validateQuote(quote, agg) {
        if (!quote?.out || !quote?.calldata || !quote?.to) {
            throw new Error(`${agg.constructor.name} returned incomplete quote`);
        }
    }
    /**
     * From settled results, filter outliers and pick the best output.
     */
    _pickBest(results, tokenIn, tokenOut, amount) {
        const quotes = [];
        const errors = [];
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled') {
                quotes.push(result.value);
            }
            else {
                const aggName = this.aggregators[i].constructor.name;
                errors.push(`${aggName}: ${result.reason?.message || 'Unknown error'}`);
            }
        }
        if (quotes.length === 0) {
            throw new Error(`All ${this.aggregators.length} aggregators failed for ${tokenIn} → ${tokenOut} (amount: ${amount}):\n${errors.join('\n')}`);
        }
        if (quotes.length === 1) {
            return quotes[0];
        }
        // Filter outliers if enough data points
        const validQuotes = quotes.length >= 3
            ? this._filterOutliers(quotes)
            : quotes;
        const candidates = validQuotes.length > 0 ? validQuotes : quotes;
        // Return highest output
        let best = candidates[0];
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
    _filterOutliers(quotes) {
        const outputs = quotes.map(q => q.quote.out).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const median = outputs[Math.floor(outputs.length / 2)];
        if (median === 0n)
            return quotes;
        const threshold = BigInt(this.config.outlierThresholdPercent);
        return quotes.filter(q => {
            const diff = q.quote.out > median
                ? q.quote.out - median
                : median - q.quote.out;
            return (diff * 100n / median) <= threshold;
        });
    }
}
exports.MultiDexAgg = MultiDexAgg;
//# sourceMappingURL=MultiDexAgg.js.map