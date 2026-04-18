import { address, bytes, curvance_read_provider } from "../../types";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";

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

export default interface IDexAgg {
    dao: address;
    router: address;
    getAvailableTokens(provider: curvance_read_provider, query: string | null, account?: address | null): Promise<ZapToken[]>;
    quoteAction(...args: QuoteArgs): Promise<{
        action: Swap;
        quote: Quote;
    }>;
    quoteMin(...args: QuoteArgs): Promise<BigInt>;
    quote(...args: QuoteArgs): Promise<Quote>;
}
