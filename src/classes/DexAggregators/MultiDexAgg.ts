import { address, bytes, curvance_read_provider, Percentage } from "../../types";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import IDexAgg, { DexAggContext, Quote, QuoteArgs } from "./IDexAgg";
import { EMPTY_ADDRESS } from "../../helpers";
import { validateAddress, validateSlippageBps } from "../../validation";

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

type QuoteValueSelector = (quote: Quote) => bigint;
type ValidatedQuoteRequest = {
    wallet: address;
    tokenIn: address;
    tokenOut: address;
    amount: bigint;
    slippage: bigint;
    feeReceiver: address | undefined;
};

function assertNonnegativeInteger(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`MultiDexAgg ${label} must be a non-negative integer.`);
    }
}

function assertPositiveInteger(value: number, label: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`MultiDexAgg ${label} must be a positive integer.`);
    }
}

function validateQuoteRequest(
    wallet: string,
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
    slippage: bigint,
    feeReceiver?: address,
): ValidatedQuoteRequest {
    if (amount <= 0n) {
        throw new Error(`MultiDexAgg quote amount must be positive, got ${amount}`);
    }
    validateSlippageBps(slippage, "MultiDexAgg quote");

    return {
        wallet: validateAddress(wallet, "MultiDexAgg wallet"),
        tokenIn: validateAddress(tokenIn, "MultiDexAgg tokenIn"),
        tokenOut: validateAddress(tokenOut, "MultiDexAgg tokenOut"),
        amount,
        slippage,
        feeReceiver: feeReceiver == undefined
            ? undefined
            : validateAddress(feeReceiver, "MultiDexAgg feeReceiver"),
    };
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
 *   new MultiDexAgg([new KyberSwap(), anotherAggregator])
 */
export class MultiDexAgg implements IDexAgg {
    private aggregators: IDexAgg[];
    private primary: IDexAgg;
    private config: Required<MultiDexAggConfig>;

    /** Exposed for backwards compatibility with route-advertisement checks. */
    get dao(): address { return this.executablePrimary.dao; }
    get router(): address { return this.executablePrimary.router; }

    private get executablePrimary(): IDexAgg {
        return this.aggregators.find((agg) => agg.router.toLowerCase() !== EMPTY_ADDRESS.toLowerCase()) ?? this.primary;
    }

    constructor(aggregators: IDexAgg[], config: MultiDexAggConfig = {}) {
        if (aggregators.length === 0) {
            throw new Error("MultiDexAgg requires at least one aggregator");
        }

        const outlierThresholdPercent = config.outlierThresholdPercent ?? 20;
        const quoteTimeoutMs = config.quoteTimeoutMs ?? 15_000;
        assertNonnegativeInteger(outlierThresholdPercent, "outlierThresholdPercent");
        assertPositiveInteger(quoteTimeoutMs, "quoteTimeoutMs");

        this.aggregators = aggregators;
        this.primary = aggregators[0]!;
        this.config = {
            outlierThresholdPercent,
            quoteTimeoutMs,
        };
    }

    withContext(context: DexAggContext): MultiDexAgg {
        return new MultiDexAgg(
            this.aggregators.map((agg) => agg.withContext?.(context) ?? agg),
            this.config,
        );
    }

    /**
     * Returns available tokens from all aggregators, deduplicated by address.
     * Primary aggregator's tokens take precedence unless a later duplicate is
     * the first quoteable option for that address.
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

        const seen = new Map<string, number>();
        const tokens: ZapToken[] = [];

        for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            for (const token of result.value) {
                const addr = token.interface.address.toLowerCase();
                const existingIndex = seen.get(addr);
                if (existingIndex == undefined) {
                    seen.set(addr, tokens.length);
                    tokens.push(token);
                } else if (tokens[existingIndex]?.quote == undefined && token.quote != undefined) {
                    tokens[existingIndex] = token;
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
        const request = validateQuoteRequest(wallet, tokenIn, tokenOut, amount, slippage, feeReceiver);
        if (this.aggregators.length === 1) {
            return this.primary.quoteAction(request.wallet, request.tokenIn, request.tokenOut, request.amount, request.slippage, feeBps, request.feeReceiver);
        }

        const best = await this._bestQuoteAction(request.wallet, request.tokenIn, request.tokenOut, request.amount, request.slippage, feeBps, request.feeReceiver);
        return { action: best.action, quote: best.quote };
    }

    /**
     * Returns the minimum output from the best quote.
     */
    async quoteMin(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address): Promise<bigint> {
        const request = validateQuoteRequest(wallet, tokenIn, tokenOut, amount, slippage, feeReceiver);
        if (this.aggregators.length === 1) {
            return this.primary.quoteMin(request.wallet, request.tokenIn, request.tokenOut, request.amount, request.slippage, feeBps, request.feeReceiver);
        }

        const best = await this._bestQuoteByValue(
            request.wallet,
            request.tokenIn,
            request.tokenOut,
            request.amount,
            request.slippage,
            (quote) => quote.min_out,
            feeBps,
            request.feeReceiver,
        );
        return best.quote.min_out;
    }

    /**
     * Returns the best quote across all aggregators.
     */
    async quote(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address): Promise<Quote> {
        const request = validateQuoteRequest(wallet, tokenIn, tokenOut, amount, slippage, feeReceiver);
        if (this.aggregators.length === 1) {
            return this.primary.quote(request.wallet, request.tokenIn, request.tokenOut, request.amount, request.slippage, feeBps, request.feeReceiver);
        }

        const best = await this._bestQuoteByValue(
            request.wallet,
            request.tokenIn,
            request.tokenOut,
            request.amount,
            request.slippage,
            (quote) => quote.min_out,
            feeBps,
            request.feeReceiver,
        );
        return best.quote;
    }

    // -----------------------------------------------------------------------
    // Internal: fan-out for quote()
    // -----------------------------------------------------------------------

    private async _bestQuoteByValue(
        wallet: string,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        slippage: bigint,
        selectValue: QuoteValueSelector,
        feeBps?: bigint,
        feeReceiver?: address,
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

        return this._pickBest(results, tokenIn, tokenOut, amount, selectValue);
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

        return this._pickBest(results, tokenIn, tokenOut, amount, (quote) => quote.min_out);
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    /**
     * Wraps a promise with a timeout.
     */
    private _withTimeout<T>(promise: Promise<T>, agg: IDexAgg): Promise<T> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error(`${agg.constructor.name} timed out after ${this.config.quoteTimeoutMs}ms`)),
                this.config.quoteTimeoutMs
            );
        });
        return Promise.race([promise, timeout]).finally(() => {
            if (timeoutId != undefined) {
                clearTimeout(timeoutId);
            }
        });
    }

    /**
     * Validates a quote response has the required fields.
     */
    private _validateQuote(quote: Quote, agg: IDexAgg): void {
        if (
            quote == null ||
            quote.out == undefined ||
            quote.min_out == undefined ||
            quote.calldata == undefined ||
            quote.to == undefined
        ) {
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
        amount: bigint,
        selectValue: QuoteValueSelector,
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
            ? this._filterOutliers(quotes, selectValue)
            : quotes;

        const candidates = validQuotes.length > 0 ? validQuotes : quotes;

        // Return highest selected value.
        let best = candidates[0]!;
        for (const candidate of candidates) {
            if (selectValue(candidate.quote) > selectValue(best.quote)) {
                best = candidate;
            }
        }

        return best;
    }

    /**
     * Filters quotes whose output deviates more than the threshold from the median.
     */
    private _filterOutliers<T extends { quote: Quote }>(
        quotes: T[],
        selectValue: QuoteValueSelector,
    ): T[] {
        const outputs = quotes.map((quote) => selectValue(quote.quote)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const median = outputs[Math.floor(outputs.length / 2)]!;

        if (median === 0n) return quotes;

        const threshold = BigInt(this.config.outlierThresholdPercent);

        return quotes.filter(q => {
            const value = selectValue(q.quote);
            const diff = value > median
                ? value - median
                : median - value;
            return (diff * 100n / median) <= threshold;
        });
    }
}
