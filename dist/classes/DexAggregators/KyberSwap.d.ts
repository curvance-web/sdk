import { address, bytes, curvance_provider } from "../../types";
import { ZapToken } from "../CToken";
import IDexAgg from "./IDexAgg";
import { Swap } from "../Zapper";
export interface KyperSwapErrorResponse {
    code: number;
    message: string;
    requestId: string;
}
export interface KyberSwapQuoteResponse {
    message: string;
    data: {
        routeSummary: {
            tokenIn: string;
            amountIn: string;
            amountInUsd: string;
            tokenOut: string;
            amountOut: string;
            amountOutUsd: string;
            gas: string;
            gasPrice: string;
            gasUsd: string;
            l1FeeUsd: string;
            routeID: string;
            checksum: string;
            timestamp: number;
            extraFee: {
                feeAmount: string;
                chargeFeeBy: string;
                isInBps: boolean;
                feeReceiver: string;
            };
            route: [
                {
                    pool: string;
                    tokenIn: string;
                    tokenOut: string;
                    swapAmount: string;
                    amountOut: string;
                    exchange: string;
                    poolType: string;
                    poolExtra: any;
                    extra: any;
                }[]
            ];
        };
        routerAddress: string;
    };
    requestId: string;
}
export interface KyperSwapBuildResponse {
    code: number;
    message: string;
    data: {
        amountIn: string;
        amountInUsd: string;
        amountOut: string;
        amountOutUsd: string;
        gas: string;
        gasUsd: string;
        additionalCostUsd: string;
        additionalCostMessage: string;
        outputChange: {
            amount: string;
            percent: number;
            level: number;
        };
        data: string;
        routerAddress: string;
        transactionValue: string;
    };
    requestId: string;
}
export declare class KyberSwap implements IDexAgg {
    api: string;
    dao: address;
    router: address;
    chain: string;
    client_id: string;
    constructor(dao?: address, router?: address, chain?: string, api?: string);
    getAvailableTokens(provider: curvance_provider, query?: string | null, page?: number, pageSize?: number): Promise<ZapToken[]>;
    quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<{
        action: Swap;
        quote: {
            to: `0x${string}`;
            calldata: bytes;
            min_out: bigint;
            out: bigint;
            raw: KyperSwapBuildResponse;
        };
    }>;
    quoteMin(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<bigint>;
    quote(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint): Promise<{
        to: `0x${string}`;
        calldata: bytes;
        min_out: bigint;
        out: bigint;
        raw: KyperSwapBuildResponse;
    }>;
}
//# sourceMappingURL=KyberSwap.d.ts.map