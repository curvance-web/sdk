import { address, bytes, curvance_provider } from "../../types";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import IDexAgg from "./IDexAgg";
export declare class Kuru implements IDexAgg {
    api: string;
    router: address;
    jwt: string | null;
    rps: number;
    dao: address;
    constructor(dao?: address, rps?: number, router?: address, apiUrl?: string);
    loadJWT(wallet: string): Promise<void>;
    rateLimitSleep(wallet: string): Promise<void>;
    getAvailableTokens(provider: curvance_provider, query?: string | null): Promise<ZapToken[]>;
    getCurrentTime(): number;
    quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<{
        action: Swap;
        quote: {
            to: address;
            calldata: bytes;
            min_out: bigint;
            out: bigint;
        };
    }>;
    quoteMin(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<bigint>;
    quote(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<{
        to: address;
        calldata: bytes;
        min_out: bigint;
        out: bigint;
    }>;
    private getSlippage;
}
//# sourceMappingURL=Kuru.d.ts.map