"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Kuru = void 0;
const decimal_js_1 = __importDefault(require("decimal.js"));
const ERC20_1 = require("../ERC20");
const helpers_1 = require("../../helpers");
const cached_jwt = new Map();
const cached_requests = new Map();
class Kuru {
    api;
    router;
    jwt = null;
    rps;
    dao;
    constructor(dao = "0x0Acb7eF4D8733C719d60e0992B489b629bc55C02", rps = 1, router = "0xb3e6778480b2E488385E8205eA05E20060B813cb", apiUrl = "https://ws.kuru.io/api") {
        this.api = apiUrl;
        this.router = router;
        this.rps = rps;
        this.dao = dao;
    }
    async loadJWT(wallet) {
        if (cached_jwt.has(wallet)) {
            const cached = cached_jwt.get(wallet);
            const currentTime = this.getCurrentTime();
            if (cached.expires_at > currentTime) {
                this.jwt = cached.token;
                this.rps = cached.rate_limit.rps;
                return;
            }
            else {
                cached_jwt.delete(wallet);
            }
        }
        const resp = await fetch(`${this.api}/generate-token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                user_address: wallet,
            }),
            keepalive: true
        });
        if (!resp.ok) {
            throw new Error(`Failed to fetch JWT: ${resp.status} ${resp.statusText}`);
        }
        const data = await resp.json();
        this.jwt = data.token;
        this.rps = data.rate_limit.rps;
        cached_jwt.set(wallet, data);
    }
    async rateLimitSleep(wallet) {
        const now = this.getCurrentTime();
        const requests = cached_requests.get(wallet) || [];
        const windowStart = now - 2;
        const recentRequests = requests.filter(timestamp => timestamp > windowStart);
        if (recentRequests.length >= this.rps) {
            const earliestRequest = Math.min(...recentRequests);
            const sleepTime = (earliestRequest + 2) - now;
            await new Promise(resolve => setTimeout(resolve, sleepTime * 2000));
        }
    }
    async getAvailableTokens(provider, query = null) {
        const signer = (0, helpers_1.validateProviderAsSigner)(provider);
        const userAddress = signer.address;
        let endpoint = `https://api.kuru.io/api/v2/tokens/search?limit=20&userAddress=${userAddress}`;
        if (query) {
            endpoint += `&q=${encodeURIComponent(query)}`;
        }
        const resp = await fetch(endpoint, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            }
        });
        if (!resp.ok) {
            throw new Error(`Failed to fetch available tokens: ${resp.status} ${resp.statusText}`);
        }
        const list = await resp.json();
        let tokens = [];
        for (const token of list.data.data) {
            const erc20 = new ERC20_1.ERC20(provider, token.address, {
                address: token.address,
                name: token.name,
                symbol: token.ticker,
                decimals: BigInt(token.decimals ?? 18),
                totalSupply: BigInt(token.total_supply ?? 0),
                balance: BigInt(token.balance ?? 0),
                image: token.imageurl,
                price: (0, decimal_js_1.default)(token.last_price).div(helpers_1.WAD)
            });
            tokens.push({
                interface: erc20,
                type: 'simple',
                // quote: async(tokenIn: string, tokenOut: string, amount: TokenInput, slippage: bigint) => {
                //     const raw_amount = toBigInt(amount, 18n);
                //     const data = await this.quote(signer.address, tokenIn, tokenOut, raw_amount, slippage);
                //     return {
                //         out: toDecimal(BigInt(data.out ?? 0), BigInt(token.decimals ?? 18)),
                //         min_out: toDecimal(BigInt(data.min_out ?? 0), BigInt(token.decimals ?? 18)),
                //     };
                // }
            });
        }
        return tokens;
    }
    // Get current time in seconds
    getCurrentTime() {
        return Math.floor(Date.now() / 1000);
    }
    async quoteAction(wallet, tokenIn, tokenOut, amount, slippage) {
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage);
        const action = {
            inputToken: tokenIn,
            inputAmount: BigInt(amount),
            outputToken: tokenOut,
            target: quote.to,
            slippage: slippage ?? 0n,
            call: quote.calldata
        };
        return { action, quote };
    }
    async quoteMin(wallet, tokenIn, tokenOut, amount, slippage) {
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage);
        return quote.out;
    }
    async quote(wallet, tokenIn, tokenOut, amount, slippage) {
        await this.loadJWT(wallet);
        await this.rateLimitSleep(wallet);
        const payload = {
            userAddress: wallet,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amount: amount.toString(),
            referrerAddress: this.dao,
            referrerFeeBps: 10,
            slippage_tolerance: Number(slippage)
        };
        cached_requests.set(wallet, (cached_requests.get(wallet) || []).concat(this.getCurrentTime()));
        const resp = await fetch(`${this.api}/quote`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.jwt}`
            },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            throw new Error(`Failed to fetch quote: ${resp.status} ${resp.statusText}`);
        }
        const data = await resp.json();
        return {
            to: data.transaction.to,
            calldata: `0x${data.transaction.calldata}`,
            min_out: BigInt(data.minOut),
            out: BigInt(data.output)
        };
    }
    getSlippage(output, min_output) {
        const diff = output - min_output;
        const decimal = (0, decimal_js_1.default)(diff).div(output).mul(100);
        return decimal ?? (0, decimal_js_1.default)(100);
    }
}
exports.Kuru = Kuru;
//# sourceMappingURL=Kuru.js.map