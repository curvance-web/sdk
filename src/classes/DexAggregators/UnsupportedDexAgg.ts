import { EMPTY_ADDRESS } from "../../helpers";
import { address, curvance_read_provider } from "../../types";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import IDexAgg, { Quote, QuoteArgs } from "./IDexAgg";

export class UnsupportedDexAgg implements IDexAgg {
    dao: address = EMPTY_ADDRESS;
    router: address = EMPTY_ADDRESS;

    constructor(private readonly chain: string) {}

    async getAvailableTokens(
        _provider: curvance_read_provider,
        _query: string | null = null,
        _account: address | null = null,
    ): Promise<ZapToken[]> {
        return [];
    }

    async quoteAction(..._args: QuoteArgs): Promise<{ action: Swap; quote: Quote }> {
        throw this.unsupportedError();
    }

    async quoteMin(..._args: QuoteArgs): Promise<bigint> {
        throw this.unsupportedError();
    }

    async quote(..._args: QuoteArgs): Promise<Quote> {
        throw this.unsupportedError();
    }

    private unsupportedError() {
        return new Error(`DEX aggregation is not configured for ${this.chain}.`);
    }
}
