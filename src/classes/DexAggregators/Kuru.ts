import Decimal from "decimal.js";
import { address, bytes, curvance_read_provider, TokenInput } from "../../types";
import { ERC20 } from "../ERC20";
import { EMPTY_ADDRESS, toBigInt, toDecimal, WAD } from "../../helpers";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import IDexAgg from "./IDexAgg";
import { safeBigInt, validateAddress, validateRouterAddress, fetchWithTimeout, validateSlippageBps } from "../../validation";
import FormatConverter from "../FormatConverter";

interface KuruJWTResponse {
    token: string;
    expires_at: number;
    rate_limit: {
        rps: number;
        burst: number;
    }
}

interface KuruQuoteResponse {
    type: string;
    status: string;
    output: string;
    minOut: string;
    transaction: {
        calldata: string;
        value: string;
        to: string;
    };
    gasPrices: {
        slow: string;
        standard: string;
        fast: string;
        rapid: string;
        extreme: string;
    };
}

const cached_jwt = new Map<string, KuruJWTResponse>();
const cached_requests = new Map<string, number[]>();

export class Kuru implements IDexAgg {
    api: string;
    router: address;
    jwt: string | null = null;
    rps: number;
    dao: address;

    constructor(
        dao: address = "0x0Acb7eF4D8733C719d60e0992B489b629bc55C02", 
        rps: number = 1, 
        router: address = "0xb3e6778480b2E488385E8205eA05E20060B813cb", 
        apiUrl: string = "https://ws.kuru.io/api"
    ) {
        this.api = apiUrl;
        this.router = router;
        this.rps = rps;
        this.dao = dao;
    }

    async loadJWT(wallet: string) {
        if(cached_jwt.has(wallet)) {
            const cached = cached_jwt.get(wallet)!;
            const currentTime = this.getCurrentTime();

            if(cached.expires_at > currentTime) {
                this.jwt = cached.token;
                this.rps = cached.rate_limit.rps;
                return;
            } else {
                cached_jwt.delete(wallet);
            }
        }

        const resp = await fetchWithTimeout(`${this.api}/generate-token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                user_address: wallet,
            }),
            keepalive: true
        });

        if(!resp.ok) {
            throw new Error(`Failed to fetch JWT: ${resp.status} ${resp.statusText}`);
        }

        const data = await resp.json() as KuruJWTResponse;

        this.jwt = data.token;
        this.rps = data.rate_limit.rps;
        cached_jwt.set(wallet, data);
    }

    async rateLimitSleep(wallet: string) {
        const now = this.getCurrentTime();
        const requests = cached_requests.get(wallet) || [];
        const windowStart = now - 2;

        // Trim old entries to prevent unbounded growth
        const recentRequests = requests.filter(timestamp => timestamp > windowStart);
        cached_requests.set(wallet, recentRequests);

        if(recentRequests.length >= this.rps) {
            const earliestRequest = Math.min(...recentRequests);
            const sleepTime = (earliestRequest + 2) - now;
            await new Promise(resolve => setTimeout(resolve, sleepTime * 2000));
        }
    }

    async getAvailableTokens(
        provider: curvance_read_provider,
        query: string | null = null,
        account: address | null = null,
    ) {
        const userAddress = account ?? EMPTY_ADDRESS;
        let endpoint = `https://api.kuru.io/api/v2/tokens/search?limit=20&userAddress=${userAddress}`;
        if(query) {
            endpoint += `&q=${encodeURIComponent(query)}`;
        }

        const resp = await fetchWithTimeout(endpoint, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            }
        });

        if(!resp.ok) {
            throw new Error(`Failed to fetch available tokens: ${resp.status} ${resp.statusText}`);
        }

        const list = await resp.json() as {
            success: boolean;
            code: number;
            timestamp: number;
            data: {
                data: Array<{
                    address: string;
                    decimals: number;
                    name: string;
                    ticker: string;
                    imageurl: string,
                    twitter: string,
                    website: string,
                    is_verified: boolean,
                    contract_renounced: boolean,
                    is_erc20: boolean,
                    is_mintable: boolean,
                    is_strict: boolean,
                    balance: string,
                    last_price: string,
                    quote_asset: string,
                    market_address: string,
                    total_supply: string,
                    burned_supply: string
                }>
            }
        };
        
        let tokens: ZapToken[] = [];
        for(const token of list.data.data) {
            let tokenAddress: address;
            try {
                tokenAddress = validateAddress(token.address, 'Kuru token list');
            } catch {
                console.warn(`Skipping token with invalid address from Kuru: ${token.address}`);
                continue;
            }

            const erc20 = new ERC20(
                provider, 
                tokenAddress,
                {
                    address: tokenAddress,
                    name: token.name,
                    symbol: token.ticker,
                    decimals: safeBigInt(token.decimals ?? 18, 'Kuru token decimals'),
                    totalSupply: safeBigInt(token.total_supply ?? 0, 'Kuru token totalSupply'),
                    balance: safeBigInt(token.balance ?? 0, 'Kuru token balance'),
                    image: token.imageurl,
                    price: Decimal(token.last_price).div(WAD)
                },
                undefined,
                null,
            );

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

    async quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        const action = {
            inputToken: tokenIn,
            inputAmount: BigInt(amount),
            outputToken: tokenOut,
            target: quote.to,
            slippage: slippage ? FormatConverter.bpsToBpsWad(slippage) : 0n,
            call: quote.calldata
        } as Swap;

        return { action, quote };
    }

    async quoteMin(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        return quote.out;
    }

    async quote(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
        validateSlippageBps(slippage, 'Kuru quote');

        await this.loadJWT(wallet);
        await this.rateLimitSleep(wallet);

        const payload: {
            userAddress: string;
            tokenIn: string;
            tokenOut: string;
            amount: string;
            referrerAddress?: string;
            referrerFeeBps?: number;
            slippage_tolerance?: number;
            autoSlippage?: boolean;
        } = {
            userAddress: wallet,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amount: amount.toString(),
            slippage_tolerance: Number(slippage),
        };

        // Fee plumbing: Kuru charges via referrerAddress + referrerFeeBps,
        // mirroring KyberSwap's currency_in fee model. We only include these
        // fields when a fee is actually being charged — Kuru's API treats
        // missing fields as "no referrer fee" which matches the NO_FEE_POLICY
        // semantics. The previous hardcoded `referrerFeeBps: 10` to `this.dao`
        // is removed so Kuru and KyberSwap behave consistently under the
        // same fee policy.
        if (feeBps !== undefined && feeBps > 0n && feeReceiver) {
            payload.referrerAddress = feeReceiver;
            payload.referrerFeeBps = Number(feeBps);
        }

        cached_requests.set(wallet, (cached_requests.get(wallet) || []).concat(this.getCurrentTime()));
        const resp = await fetchWithTimeout(`${this.api}/quote`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.jwt}`
            },
            body: JSON.stringify(payload),
        });

        if(!resp.ok) {
            // Clear cached JWT on auth failure so next call fetches a fresh token
            if(resp.status === 401 || resp.status === 403) {
                cached_jwt.delete(wallet);
                this.jwt = null;
            }
            throw new Error(`Failed to fetch quote: ${resp.status} ${resp.statusText}`);
        }

        const data = await resp.json() as KuruQuoteResponse;

        // Validate router address matches expected — prevents a compromised API
        // from routing swaps through an arbitrary contract
        const validatedRouter = validateRouterAddress(data.transaction.to, this.router, 'Kuru');

        // Normalize calldata prefix — Kuru may or may not include 0x
        const rawCalldata = data.transaction.calldata;
        const calldata = rawCalldata.startsWith('0x') ? rawCalldata : `0x${rawCalldata}`;

        return {
            to: validatedRouter,
            calldata: calldata as bytes,
            min_out: safeBigInt(data.minOut, 'Kuru quote minOut'),
            out: safeBigInt(data.output, 'Kuru quote output')
        };
    }

    private getSlippage(output: bigint, min_output: bigint) {
        const diff = output - min_output;
        const decimal = Decimal(diff).div(output).mul(100);
        return decimal ?? Decimal(100);
    }
}
