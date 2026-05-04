import Decimal from "decimal.js";
import { address, bytes, curvance_read_provider, TokenInput } from "../../types";
import { ERC20 } from "../ERC20";
import { EMPTY_ADDRESS, toBigInt, toContractSwapSlippage, toDecimal, WAD } from "../../helpers";
import { ZapToken } from "../CToken";
import { Swap } from "../Zapper";
import IDexAgg from "./IDexAgg";
import { safeBigInt, validateAddress, validateRouterAddress, fetchWithTimeout, validateSlippageBps } from "../../validation";
import { AbiCoder } from "ethers";

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
const KURU_EXECUTE_SWAP_SELECTOR = "0x2a45a6c3";
const KURU_SWAP_PARAMS_TYPE =
    "tuple(address tokenUserBuys,uint256 minAmountUserBuys,address tokenUserSells,uint256 amountUserSells)";
const KURU_FEE_COLLECTION_TYPE =
    "tuple(address feeCollectorAddress,uint256 feeBps,address referrerAddress,uint256 referrerFeeBps,bool isInTokenFee)";
const KURU_INVALID_NATIVE_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

type KuruSwapCalldataValidationRequest = {
    tokenIn: string;
    tokenOut: string;
    amount: bigint;
    minOut: bigint;
    feeBps: bigint;
    feeReceiver?: string | undefined;
};

type KuruTokenListItem = {
    address: string;
    decimals?: unknown;
    name?: unknown;
    ticker?: unknown;
    imageurl?: unknown;
    balance?: unknown;
    last_price?: unknown;
    total_supply?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKuruCalldataAddress(value: string, context: string): string {
    return validateAddress(value, context).toLowerCase();
}

function validateKuruEqualAddress(actual: string, expected: string, context: string): void {
    if (normalizeKuruCalldataAddress(actual, context) !== normalizeKuruCalldataAddress(expected, `${context} expected`)) {
        throw new Error(`Kuru calldata ${context}=${actual}, expected ${expected}`);
    }
}

function validateKuruNativePlaceholder(value: string, context: string): void {
    if (normalizeKuruCalldataAddress(value, context) === KURU_INVALID_NATIVE_PLACEHOLDER) {
        throw new Error(`Kuru calldata ${context} uses unsupported native placeholder ${value}`);
    }
}

function validateKuruSwapCalldata(
    calldata: string,
    expected: KuruSwapCalldataValidationRequest,
): void {
    try {
        const selector = calldata.slice(0, 10).toLowerCase();
        if (selector !== KURU_EXECUTE_SWAP_SELECTOR) {
            throw new Error(
                `Kuru calldata selector=${selector}, expected ${KURU_EXECUTE_SWAP_SELECTOR}`
            );
        }

        const encoded = `0x${calldata.slice(10)}`;
        const coder = AbiCoder.defaultAbiCoder();
        const [swapIntent, feeCollection] = coder.decode(
            [KURU_SWAP_PARAMS_TYPE, KURU_FEE_COLLECTION_TYPE, "bytes"],
            encoded,
        );

        validateKuruEqualAddress(swapIntent.tokenUserSells, expected.tokenIn, "tokenUserSells");
        validateKuruEqualAddress(swapIntent.tokenUserBuys, expected.tokenOut, "tokenUserBuys");
        validateKuruNativePlaceholder(swapIntent.tokenUserSells, "tokenUserSells");
        validateKuruNativePlaceholder(swapIntent.tokenUserBuys, "tokenUserBuys");

        if (BigInt(swapIntent.amountUserSells) !== expected.amount) {
            throw new Error(
                `Kuru calldata amountUserSells=${swapIntent.amountUserSells}, expected ${expected.amount}`
            );
        }

        if (BigInt(swapIntent.minAmountUserBuys) < expected.minOut) {
            throw new Error(
                `Kuru calldata minAmountUserBuys=${swapIntent.minAmountUserBuys}, expected at least ${expected.minOut}`
            );
        }

        const feeBps = BigInt(feeCollection.feeBps);
        if (feeBps !== 0n) {
            if (expected.feeReceiver) {
                validateKuruEqualAddress(feeCollection.feeCollectorAddress, expected.feeReceiver, "feeCollectorAddress");
            }

            throw new Error(
                `Kuru calldata feeBps=${feeBps}, expected 0`
            );
        }

        if (feeCollection.isInTokenFee !== false) {
            throw new Error(
                `Kuru calldata isInTokenFee=${feeCollection.isInTokenFee}, expected false`
            );
        }

        const referrerFeeBps = BigInt(feeCollection.referrerFeeBps);
        if (referrerFeeBps !== expected.feeBps) {
            throw new Error(
                `Kuru calldata referrerFeeBps=${referrerFeeBps}, expected ${expected.feeBps}`
            );
        }

        if (expected.feeBps > 0n) {
            if (!expected.feeReceiver) {
                throw new Error("Kuru calldata feeReceiver expected but no fee receiver was configured");
            }

            validateKuruEqualAddress(feeCollection.referrerAddress, expected.feeReceiver, "referrerAddress");
        }
    } catch (e: any) {
        if (e.message?.startsWith("Kuru calldata")) throw e;
        throw new Error(`Kuru calldata could not be decoded for validation: ${e.message}`);
    }
}

function requireKuruQuoteResponse(data: unknown): KuruQuoteResponse {
    if (data == null || typeof data !== "object") {
        throw new Error("Malformed Kuru quote response: expected object");
    }

    const quote = data as {
        output?: unknown;
        minOut?: unknown;
        transaction?: {
            calldata?: unknown;
            value?: unknown;
            to?: unknown;
        };
    };

    if (quote.transaction == null || typeof quote.transaction !== "object") {
        throw new Error("Malformed Kuru quote response: missing transaction");
    }
    if (typeof quote.transaction.to !== "string") {
        throw new Error("Malformed Kuru quote response: missing transaction.to");
    }
    if (typeof quote.transaction.calldata !== "string") {
        throw new Error("Malformed Kuru quote response: missing transaction.calldata");
    }
    if (quote.transaction.value == null) {
        throw new Error("Malformed Kuru quote response: missing transaction.value");
    }
    if (quote.minOut == null) {
        throw new Error("Malformed Kuru quote response: missing minOut");
    }
    if (quote.output == null) {
        throw new Error("Malformed Kuru quote response: missing output");
    }

    return data as KuruQuoteResponse;
}

function requireKuruTokenList(data: unknown): KuruTokenListItem[] {
    if (!isRecord(data) || !isRecord(data.data) || !Array.isArray(data.data.data)) {
        throw new Error("Malformed Kuru token list response: missing data.data");
    }

    return data.data.data.filter((token): token is KuruTokenListItem => {
        return isRecord(token) && typeof token.address === "string";
    });
}

function requireKuruJWTResponse(data: unknown): KuruJWTResponse {
    if (!isRecord(data)) {
        throw new Error("Malformed Kuru JWT response: expected object");
    }
    if (typeof data.token !== "string" || data.token.length === 0) {
        throw new Error("Malformed Kuru JWT response: missing token");
    }
    if (typeof data.expires_at !== "number" || !Number.isFinite(data.expires_at)) {
        throw new Error("Malformed Kuru JWT response: missing expires_at");
    }
    if (!isRecord(data.rate_limit)) {
        throw new Error("Malformed Kuru JWT response: missing rate_limit");
    }
    if (
        typeof data.rate_limit.rps !== "number" ||
        !Number.isFinite(data.rate_limit.rps) ||
        data.rate_limit.rps <= 0
    ) {
        throw new Error("Malformed Kuru JWT response: invalid rate_limit.rps");
    }

    return data as unknown as KuruJWTResponse;
}

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

    private cacheKey(wallet: string): string {
        return `${this.api}:${wallet.toLowerCase()}`;
    }

    async loadJWT(wallet: string) {
        const cacheKey = this.cacheKey(wallet);
        if(cached_jwt.has(cacheKey)) {
            const cached = cached_jwt.get(cacheKey)!;
            const currentTime = this.getCurrentTime();

            if(cached.expires_at > currentTime) {
                this.jwt = cached.token;
                this.rps = cached.rate_limit.rps;
                return;
            } else {
                cached_jwt.delete(cacheKey);
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

        const data = requireKuruJWTResponse(await resp.json());

        this.jwt = data.token;
        this.rps = data.rate_limit.rps;
        cached_jwt.set(cacheKey, data);
    }

    async rateLimitSleep(wallet: string) {
        const cacheKey = this.cacheKey(wallet);
        while (true) {
            const now = this.getCurrentTime();
            const requests = cached_requests.get(cacheKey) || [];
            const windowStart = now - 2;

            // Trim old entries to prevent unbounded growth.
            const recentRequests = requests.filter(timestamp => timestamp > windowStart);

            if(recentRequests.length < this.rps) {
                recentRequests.push(now);
                cached_requests.set(cacheKey, recentRequests);
                return;
            }

            const earliestRequest = Math.min(...recentRequests);
            const sleepTime = Math.max(0, (earliestRequest + 2) - now);
            cached_requests.set(cacheKey, recentRequests);
            await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));
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

        const list = requireKuruTokenList(await resp.json());
        
        let tokens: ZapToken[] = [];
        for(const token of list) {
            let tokenAddress: address;
            try {
                tokenAddress = validateAddress(token.address, 'Kuru token list');
            } catch {
                console.warn(`Skipping token with invalid address from Kuru: ${token.address}`);
                continue;
            }

            try {
                const tokenMetadata = {
                    address: tokenAddress,
                    name: typeof token.name === "string" ? token.name : "",
                    symbol: typeof token.ticker === "string" ? token.ticker : "",
                    decimals: safeBigInt(token.decimals ?? 18, 'Kuru token decimals'),
                    totalSupply: safeBigInt(token.total_supply ?? 0, 'Kuru token totalSupply'),
                    balance: safeBigInt(token.balance ?? 0, 'Kuru token balance'),
                    price: Decimal(typeof token.last_price === "string" || typeof token.last_price === "number" ? token.last_price : 0).div(WAD),
                    ...(typeof token.imageurl === "string" ? { image: token.imageurl } : {}),
                };

                const erc20 = new ERC20(
                    provider,
                    tokenAddress,
                    tokenMetadata,
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
            } catch (e: any) {
                console.warn(`Skipping token with invalid metadata from Kuru: ${token.address} (${e.message})`);
            }
        }

        return tokens;
    }

    // Get current time in seconds
    getCurrentTime() {
        return Math.floor(Date.now() / 1000);
    }

    async quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
        const actionSlippage = toContractSwapSlippage(slippage, feeBps);
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        const action = {
            inputToken: tokenIn,
            inputAmount: BigInt(amount),
            outputToken: tokenOut,
            target: quote.to,
            slippage: actionSlippage,
            call: quote.calldata
        } as Swap;

        return { action, quote };
    }

    async quoteMin(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);
        return quote.min_out;
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
                cached_jwt.delete(this.cacheKey(wallet));
                this.jwt = null;
            }
            throw new Error(`Failed to fetch quote: ${resp.status} ${resp.statusText}`);
        }

        const data = requireKuruQuoteResponse(await resp.json());

        // Validate router address matches expected — prevents a compromised API
        // from routing swaps through an arbitrary contract
        const validatedRouter = validateRouterAddress(data.transaction.to, this.router, 'Kuru');

        // Normalize calldata prefix — Kuru may or may not include 0x
        const rawCalldata = data.transaction.calldata;
        const calldata = rawCalldata.startsWith('0x') ? rawCalldata : `0x${rawCalldata}`;
        const minOut = safeBigInt(data.minOut, 'Kuru quote minOut');
        const out = safeBigInt(data.output, 'Kuru quote output');
        const transactionValue = safeBigInt(data.transaction.value, 'Kuru quote transaction value');
        if (transactionValue !== 0n) {
            throw new Error(`Kuru quote transaction value=${transactionValue}, expected 0`);
        }

        validateKuruSwapCalldata(calldata, {
            tokenIn,
            tokenOut,
            amount,
            minOut,
            feeBps: feeBps ?? 0n,
            feeReceiver,
        });

        return {
            to: validatedRouter,
            calldata: calldata as bytes,
            min_out: minOut,
            out,
        };
    }

    private getSlippage(output: bigint, min_output: bigint) {
        const diff = output - min_output;
        const decimal = Decimal(diff).div(output).mul(100);
        return decimal ?? Decimal(100);
    }
}
