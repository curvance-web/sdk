"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KyberSwap = void 0;
const setup_1 = require("../../setup");
const helpers_1 = require("../../helpers");
const ERC20_1 = require("../ERC20");
const FormatConverter_1 = __importDefault(require("../FormatConverter"));
;
class KyberSwap {
    api;
    dao;
    router;
    chain;
    client_id = "curvance-sdk";
    constructor(dao = "0x0Acb7eF4D8733C719d60e0992B489b629bc55C02", router = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", chain = "monad-mainnet", api = "https://aggregator-api.kyberswap.com") {
        // KyberSwap uses 'monad' instead of 'monad-mainnet' like other providers, so we adjust here
        if (chain == "monad-mainnet") {
            chain = 'monad';
        }
        this.dao = dao;
        this.router = router;
        this.chain = chain;
        this.api = `${api}/${this.chain}`;
    }
    async getAvailableTokens(provider, query = null, page = 1, pageSize = 25) {
        let zap_tokens = [];
        let tokens_set = new Set();
        for (const market of setup_1.all_markets) {
            for (const token of market.tokens) {
                const asset = token.getAsset(true);
                if (tokens_set.has(asset.address)) {
                    continue;
                }
                tokens_set.add(asset.address);
                if (query) {
                    const lowerQuery = query.toLowerCase();
                    if (!token.name.toLowerCase().includes(lowerQuery) && !token.symbol.toLowerCase().includes(lowerQuery)) {
                        continue;
                    }
                }
                zap_tokens.push({
                    interface: token.getAsset(true),
                    type: 'simple',
                    quote: async (tokenIn, tokenOut, amount, slippage) => {
                        const signer = (0, helpers_1.validateProviderAsSigner)(provider);
                        const erc20in = new ERC20_1.ERC20(provider, tokenIn);
                        const decimalsIn = erc20in.decimals ?? await erc20in.contract.decimals();
                        const amount_bigint = (0, helpers_1.toBigInt)(amount, decimalsIn);
                        const erc20Out = new ERC20_1.ERC20(provider, tokenOut);
                        const decimalsOut = erc20Out.decimals ?? await erc20Out.contract.decimals();
                        const results = await this.quote(signer.address, tokenIn, tokenOut, amount_bigint, FormatConverter_1.default.percentageToBps(slippage));
                        return {
                            minOut_raw: results.min_out,
                            output_raw: results.out,
                            minOut: FormatConverter_1.default.bigIntToDecimal(results.min_out, decimalsOut),
                            output: FormatConverter_1.default.bigIntToDecimal(results.out, decimalsOut),
                            extra: results.raw
                        };
                    }
                });
            }
        }
        // https://ks-setting.kyberswap.com/api/v1/tokens?chainIds=143&page=1&pageSize=25&isWhitelisted=true
        return zap_tokens;
    }
    async quoteAction(wallet, tokenIn, tokenOut, amount, slippage) {
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage);
        const action = {
            inputToken: tokenIn,
            inputAmount: BigInt(amount),
            outputToken: tokenOut,
            target: quote.to,
            slippage: slippage ? FormatConverter_1.default.bpsToBpsWad(slippage) : 0n,
            call: quote.calldata
        };
        return { action, quote };
    }
    async quoteMin(wallet, tokenIn, tokenOut, amount, slippage) {
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage);
        return quote.out;
    }
    async quote(wallet, tokenIn, tokenOut, amount, slippage) {
        const params = new URLSearchParams({
            tokenIn,
            tokenOut,
            amountIn: amount.toString()
            // feeAmount
            // chargeFeeBy
            // isInBps
            // feeReceiver
        });
        const quote_response = await fetch(`${this.api}/api/v1/routes?${params.toString()}`, {
            method: 'GET',
            headers: {
                'X-Client-Id': this.client_id,
                'Content-Type': 'application/json'
            }
        });
        if (!quote_response.ok) {
            const error_return = await quote_response.json();
            throw new Error(`KyberSwap API request failed [${error_return.requestId}]: ${error_return.message} (code: ${error_return.code})`);
        }
        const quote = await quote_response.json();
        const build_response = await fetch(`${this.api}/api/v1/route/build`, {
            method: 'POST',
            headers: {
                'X-Client-Id': this.client_id,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                routeSummary: quote.data.routeSummary,
                origin: wallet,
                sender: wallet,
                recipient: wallet,
                slippageTolerance: Number(slippage),
                referral: this.dao
            })
        });
        if (!build_response.ok) {
            const error_return = await build_response.json();
            throw new Error(`KyberSwap API build request failed [${error_return.requestId}]: ${error_return.message} (code: ${error_return.code})`);
        }
        const build_data = await build_response.json();
        const min_out = BigInt(build_data.data.amountOut) * BigInt(10000n - slippage) / BigInt(10000);
        if (build_data.data.routerAddress != this.router) {
            throw new Error(`KyberSwap returned unexpected router address: ${build_data.data.routerAddress}`);
        }
        return {
            to: build_data.data.routerAddress,
            calldata: build_data.data.data,
            min_out: min_out,
            out: BigInt(build_data.data.amountOut),
            raw: build_data
        };
    }
}
exports.KyberSwap = KyberSwap;
//# sourceMappingURL=KyberSwap.js.map