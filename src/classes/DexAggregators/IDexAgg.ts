import { address, bytes, curvance_read_provider } from "../../types";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import type { FeePolicy } from "../../feePolicy";
import type { Market } from "../Market";

export type QuoteArgs = [
    wallet: string,
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
    slippage: bigint,
    feeBps?: bigint,
    feeReceiver?: address,
];

export type Quote = {
    to: address;
    calldata: bytes;
    min_out: bigint;
    out: bigint;
    raw?: any;
};

export type DexQuoteErrorCode =
    | "aborted"
    | "timeout"
    | "rate-limited"
    | "unavailable"
    | "no-route"
    | "malformed-response"
    | "http";

export class DexQuoteError extends Error {
    readonly code: DexQuoteErrorCode;
    readonly provider: string;
    readonly retryable: boolean;
    readonly status: number | undefined;

    constructor(
        code: DexQuoteErrorCode,
        message: string,
        options: {
            provider?: string;
            retryable?: boolean;
            status?: number;
            cause?: unknown;
        } = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "DexQuoteError";
        this.code = code;
        this.provider = options.provider ?? "DEX aggregator";
        this.retryable = options.retryable ?? false;
        this.status = options.status;
    }
}

export type DexQuoteOptions = {
    signal?: AbortSignal;
    /** Shared mutable retry allowance so a multi-step quote cannot reset its retry budget. */
    retryBudget?: DexQuoteRetryBudget;
};

export type DexQuoteRetryBudget = {
    remaining: number;
};

export type PreparedQuote = {
    min_out: bigint;
    out: bigint;
    build(options?: DexQuoteOptions): Promise<Quote>;
};

export type PreparedQuoteArgs = [...QuoteArgs, options?: DexQuoteOptions];

export type DexAggContext = {
    markets: readonly Market[];
    feePolicy: FeePolicy;
    checkerDao?: address | undefined;
};

export default interface IDexAgg {
    dao: address;
    router: address;
    withContext?(context: DexAggContext): IDexAgg;
    getAvailableTokens(provider: curvance_read_provider, query: string | null, account?: address | null): Promise<ZapToken[]>;
    quoteAction(...args: QuoteArgs): Promise<{
        action: Swap;
        quote: Quote;
    }>;
    quoteMin(...args: QuoteArgs): Promise<bigint>;
    quote(...args: QuoteArgs): Promise<Quote>;
    /** Optional two-phase quote support. Route sizing can remain GET-only and build calldata once. */
    prepareQuote?(...args: PreparedQuoteArgs): Promise<PreparedQuote>;
}
