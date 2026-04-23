import { EMPTY_ADDRESS, toBigInt } from "../../helpers";
import { address, Percentage, TokenInput, curvance_read_provider } from "../../types";
import { ZapToken } from "../CToken";
import { ERC20 } from "../ERC20";
import FormatConverter from "../FormatConverter";
import type { Quote } from "./IDexAgg";

type MarketTokenSource = {
    name: string;
    symbol: string;
    getAsset: (asErc20: true) => ERC20;
};

type MarketSource = {
    tokens: MarketTokenSource[];
};

type ZapQuoteResult = Quote & { raw?: any };

type QuoteFn = (
    wallet: string,
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
    slippage: bigint,
    feeBps?: bigint,
    feeReceiver?: address,
) => Promise<ZapQuoteResult>;

type QuoteFeeResolver = (
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
) => { feeBps: bigint; feeReceiver?: address | undefined };

export function createSimpleZapQuote(
    provider: curvance_read_provider,
    account: address | null,
    quoteFn: QuoteFn,
    resolveFee?: QuoteFeeResolver,
) {
    return async (
        tokenIn: string,
        tokenOut: string,
        amount: TokenInput,
        slippage: Percentage,
    ) => {
        const wallet = account ?? EMPTY_ADDRESS;
        const erc20In = new ERC20(provider, tokenIn as address, undefined, undefined, null);
        const decimalsIn = erc20In.decimals ?? await erc20In.contract.decimals();
        const amountBigInt = toBigInt(amount, decimalsIn);
        const erc20Out = new ERC20(provider, tokenOut as address, undefined, undefined, null);
        const decimalsOut = erc20Out.decimals ?? await erc20Out.contract.decimals();
        const fee = resolveFee?.(tokenIn, tokenOut, amountBigInt) ?? { feeBps: 0n };

        const results = await quoteFn(
            wallet,
            tokenIn,
            tokenOut,
            amountBigInt,
            FormatConverter.percentageToBps(slippage),
            fee.feeBps,
            fee.feeReceiver,
        );

        return {
            minOut_raw: results.min_out,
            output_raw: results.out,
            minOut: FormatConverter.bigIntToDecimal(results.min_out, decimalsOut),
            output: FormatConverter.bigIntToDecimal(results.out, decimalsOut),
            extra: results.raw,
        };
    };
}

export function buildLocalSimpleZapTokens(
    markets: MarketSource[],
    provider: curvance_read_provider,
    query: string | null,
    account: address | null,
    quoteFn: QuoteFn,
    resolveFee?: QuoteFeeResolver,
): ZapToken[] {
    const zapTokens: ZapToken[] = [];
    const seen = new Set<string>();

    for (const market of markets) {
        for (const token of market.tokens) {
            const asset = token.getAsset(true);
            const assetKey = asset.address.toLowerCase();
            if (seen.has(assetKey)) {
                continue;
            }
            seen.add(assetKey);

            if (query) {
                const lowerQuery = query.toLowerCase();
                if (
                    !token.name.toLowerCase().includes(lowerQuery) &&
                    !token.symbol.toLowerCase().includes(lowerQuery)
                ) {
                    continue;
                }
            }

            zapTokens.push({
                interface: asset,
                type: "simple",
                quote: createSimpleZapQuote(provider, account, quoteFn, resolveFee),
            });
        }
    }

    return zapTokens;
}
