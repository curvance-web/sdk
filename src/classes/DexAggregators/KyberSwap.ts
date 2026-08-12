import { address, bytes, curvance_read_provider } from "../../types";
import { ZapToken } from "../CToken";
import IDexAgg, {
    DexQuoteError,
    type DexAggContext,
    type DexQuoteOptions,
    type DexQuoteRetryBudget,
    type PreparedQuote,
    type Quote,
} from "./IDexAgg";
import { Swap } from "../Zapper";
import { all_markets, setup_config } from "../../setup";
import { BPS, EMPTY_ADDRESS, toContractSwapSlippage } from "../../helpers";
import { safeBigInt, fetchWithTimeout, validateAddress, validateApiUrl, validateRouterAddress, validateSlippageBps } from "../../validation";
import { AbiCoder } from "ethers";
import { buildLocalSimpleZapTokens } from "./helpers";
import { MONAD_KYBER_SWAP_SERVICE } from "../../chains/services";

// ── Calldata validation ─────────────────────────────────────────────
// The KyberSwap API returns an opaque calldata blob. We trust the API to
// embed the fee params we requested, but verify before submitting the tx.
// Without this, a misconfigured API response silently reverts on-chain
// at the KyberSwapChecker with no user-facing explanation.

/** Required flags: _FEE_IN_BPS (0x80) so the router interprets feeAmounts
 *  as basis points, plus executor v3 indicator (0x200) which KyberSwap's
 *  API always sets on Monad. Router-inert (consumed by executor only).
 *  Must match KyberSwapChecker.REQUIRED_FLAGS on-chain. */
const REQUIRED_FLAGS = 0x280n;
const CHECKER_FEE_BPS = 4n;
const SOURCE_AMOUNT_FEE_TOLERANCE_BPS = 2n;
const KYBER_SWAP_SELECTOR = '0xe21fd0e9';
const KYBER_REQUEST_TIMEOUT_MS = 5_000;
const KYBER_MAX_REQUEST_ATTEMPTS = 2;
const KYBER_DEFAULT_RETRY_DELAY_MS = 250;

/** ABI type string for KyberSwap MetaAggregationRouterV2's SwapExecutionParams struct. */
const SWAP_PARAMS_TYPE =
    'tuple(address callTarget, address approveTarget, ' +
    'bytes targetData, ' +
    'tuple(address srcToken, address dstToken, address[] srcReceivers, ' +
    'uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, ' +
    'address dstReceiver, uint256 amount, uint256 minReturnAmount, ' +
    'uint256 flags, bytes permit) desc, ' +
    'bytes clientData)';

type KyberSwapValidationRequest = {
    tokenIn: string;
    tokenOut: string;
    amount: bigint;
    recipient: string;
    minReturnAmount: bigint;
    feeBps: bigint;
    feeReceiver?: string | undefined;
};

function normalizeCalldataAddress(value: string, context: string): string {
    return validateAddress(value, context).toLowerCase();
}

function validateEqualAddress(actual: string, expected: string, context: string): void {
    if (normalizeCalldataAddress(actual, context) !== normalizeCalldataAddress(expected, `${context} expected`)) {
        throw new Error(`KyberSwap calldata ${context}=${actual}, expected ${expected}`);
    }
}

function validateRecipientAddress(actual: string, expected: string): void {
    const normalizedActual = normalizeCalldataAddress(actual, 'dstReceiver');
    if (normalizedActual === EMPTY_ADDRESS.toLowerCase()) {
        return;
    }

    if (normalizedActual !== normalizeCalldataAddress(expected, 'dstReceiver expected')) {
        throw new Error(`KyberSwap calldata dstReceiver=${actual}, expected ${expected}`);
    }
}

function getCurrencyInFeeAmountBounds(
    amount: bigint,
    feeBps: bigint,
): { min: bigint; max: bigint } {
    if (feeBps === 0n) {
        return { min: 0n, max: 0n };
    }

    const minFeeBps = feeBps > SOURCE_AMOUNT_FEE_TOLERANCE_BPS
        ? feeBps - SOURCE_AMOUNT_FEE_TOLERANCE_BPS
        : 0n;
    const maxFeeBps = feeBps + SOURCE_AMOUNT_FEE_TOLERANCE_BPS;

    return {
        min: amount * minFeeBps / BPS,
        max: (amount * maxFeeBps + (BPS - 1n)) / BPS,
    };
}

function isValidSourceAmountTotal(totalSourceAmount: bigint, expected: KyberSwapValidationRequest): boolean {
    if (totalSourceAmount === expected.amount) {
        return true;
    }
    if (expected.feeBps === 0n || totalSourceAmount > expected.amount) {
        return false;
    }

    const feeAmount = expected.amount - totalSourceAmount;
    const bounds = getCurrencyInFeeAmountBounds(expected.amount, expected.feeBps);
    return feeAmount >= bounds.min && feeAmount <= bounds.max;
}

/**
 * Decode and validate checker-bound fields in KyberSwap swap calldata.
 * Catches API misconfigurations before the tx hits the on-chain checker.
 *
 * @param calldata - Raw calldata from KyberSwap build API
 * @param expected - Swap parameters the build calldata must preserve
 */
function validateSwapCalldata(
    calldata: string,
    expected: KyberSwapValidationRequest,
): void {
    try {
        const selector = calldata.slice(0, 10).toLowerCase();
        if (selector !== KYBER_SWAP_SELECTOR) {
            throw new Error(
                `KyberSwap calldata selector=${selector}, expected ${KYBER_SWAP_SELECTOR}`
            );
        }

        // Strip 4-byte selector (0x + 8 hex chars = 10 chars)
        const encoded = '0x' + calldata.slice(10);
        const coder = AbiCoder.defaultAbiCoder();
        const [execution] = coder.decode([SWAP_PARAMS_TYPE], encoded);
        const desc = execution.desc;

        validateEqualAddress(desc.srcToken, expected.tokenIn, 'srcToken');
        validateEqualAddress(desc.dstToken, expected.tokenOut, 'dstToken');
        validateRecipientAddress(desc.dstReceiver, expected.recipient);

        if (BigInt(desc.amount) !== expected.amount) {
            throw new Error(
                `KyberSwap calldata amount=${desc.amount}, expected ${expected.amount}`
            );
        }

        if (BigInt(desc.minReturnAmount) < expected.minReturnAmount) {
            throw new Error(
                `KyberSwap calldata minReturnAmount=${desc.minReturnAmount}, expected at least ${expected.minReturnAmount}`
            );
        }

        // Validate _FEE_IN_BPS flag — without it, feeAmounts[0]=4 means
        // 4 wei instead of 4 BPS
        const flags = BigInt(desc.flags);
        if (flags !== REQUIRED_FLAGS) {
            throw new Error(
                `KyberSwap calldata flags=${flags} (0x${flags.toString(16)}), ` +
                `expected ${REQUIRED_FLAGS} (0x${REQUIRED_FLAGS.toString(16)}). ` +
                `Without _FEE_IN_BPS, fee is interpreted as absolute tokens.`
            );
        }

        if (normalizeCalldataAddress(execution.approveTarget, 'approveTarget') !== EMPTY_ADDRESS.toLowerCase()) {
            throw new Error(
                `KyberSwap calldata approveTarget=${execution.approveTarget}, expected ${EMPTY_ADDRESS}`
            );
        }

        if (normalizeCalldataAddress(execution.callTarget, 'callTarget') === EMPTY_ADDRESS.toLowerCase()) {
            throw new Error(`KyberSwap calldata callTarget cannot be ${EMPTY_ADDRESS}`);
        }

        if (execution.targetData.length === 0 || execution.targetData === '0x') {
            throw new Error('KyberSwap calldata targetData cannot be empty');
        }

        if (desc.permit.length !== 0 && desc.permit !== '0x') {
            throw new Error('KyberSwap calldata permit must be empty');
        }

        if (desc.srcReceivers.length === 0 || desc.srcReceivers.length !== desc.srcAmounts.length) {
            throw new Error(
                `KyberSwap calldata srcReceivers/srcAmounts length mismatch: ${desc.srcReceivers.length}/${desc.srcAmounts.length}`
            );
        }

        for (const receiver of desc.srcReceivers) {
            if (normalizeCalldataAddress(receiver, 'srcReceiver') === EMPTY_ADDRESS.toLowerCase()) {
                throw new Error(`KyberSwap calldata srcReceiver cannot be ${EMPTY_ADDRESS}`);
            }
        }

        const totalSourceAmount = desc.srcAmounts.reduce(
            (total: bigint, amount: bigint | string | number) => total + BigInt(amount),
            0n,
        );
        if (!isValidSourceAmountTotal(totalSourceAmount, expected)) {
            const bounds = getCurrencyInFeeAmountBounds(expected.amount, expected.feeBps);
            throw new Error(
                `KyberSwap calldata srcAmounts total=${totalSourceAmount}, ` +
                `expected ${expected.amount} or fee deduction ` +
                `${bounds.min}-${bounds.max} wei`
            );
        }

        // Validate fee receiver
        if (desc.feeReceivers.length !== 1) {
            throw new Error(
                `KyberSwap calldata has ${desc.feeReceivers.length} fee receivers, expected 1`
            );
        }
        if (!expected.feeReceiver) {
            throw new Error('KyberSwap calldata feeReceiver expected but no fee receiver was configured');
        }
        if (desc.feeReceivers[0].toLowerCase() !== expected.feeReceiver.toLowerCase()) {
            throw new Error(
                `KyberSwap calldata feeReceiver=${desc.feeReceivers[0]}, ` +
                `expected ${expected.feeReceiver}`
            );
        }

        // Validate fee amount
        if (desc.feeAmounts.length !== 1 || BigInt(desc.feeAmounts[0]) !== expected.feeBps) {
            throw new Error(
                `KyberSwap calldata feeAmount=${desc.feeAmounts[0]}, expected ${expected.feeBps}`
            );
        }
    } catch (e: any) {
        // If this is our own validation error, rethrow
        if (e.message?.startsWith('KyberSwap calldata')) throw e;
        // ABI decode failure — calldata structure doesn't match expected format.
        // The on-chain checker remains the final guard, but the SDK should
        // fail before returning malformed checker-rejected calldata.
        throw new Error(`KyberSwap calldata could not be decoded for fee validation: ${e.message}`);
    }
}

function validateCheckerFeePolicy(
    dao: address,
    feeBps: bigint | undefined,
    feeReceiver: address | undefined,
): void {
    if (feeBps !== CHECKER_FEE_BPS || !feeReceiver || feeReceiver.toLowerCase() !== dao.toLowerCase()) {
        throw new Error(
            `KyberSwap checker requires feeBps=${CHECKER_FEE_BPS} and feeReceiver=${dao}; ` +
            `got feeBps=${feeBps?.toString() ?? "undefined"} ` +
            `feeReceiver=${feeReceiver ?? "undefined"}`,
        );
    }
}

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
        },
        routerAddress: string;
    },
    requestId: string;
};

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
        },
        data: string;
        routerAddress: string;
        transactionValue: string;
    },
    requestId: string;
}

export class KyberSwap implements IDexAgg {
    api: string;
    dao: address;
    router: address;
    chain: string;
    client_id: string = "curvance-sdk";
    private readonly apiBase: string;
    private readonly context: DexAggContext | undefined;

    constructor(
        dao: address = EMPTY_ADDRESS,
        router: address = MONAD_KYBER_SWAP_SERVICE.router,
        chain: string = MONAD_KYBER_SWAP_SERVICE.chainSlug,
        api: string = MONAD_KYBER_SWAP_SERVICE.apiBase,
        context?: DexAggContext,
    ) {
        // KyberSwap uses 'monad' instead of 'monad-mainnet' like other providers, so we adjust here
        if(chain == "monad-mainnet") {
            chain = 'monad';
        }

        this.dao = dao;
        this.router = router;
        this.chain = chain;
        this.apiBase = validateApiUrl(api).replace(/\/+$/, "");
        this.api = `${this.apiBase}/${this.chain}`;
        this.context = context;
    }

    withContext(context: DexAggContext): KyberSwap {
        return new KyberSwap(context.checkerDao ?? this.dao, this.router, this.chain, this.apiBase, context);
    }

    async getAvailableTokens(
        provider: curvance_read_provider,
        query: string | null = null,
        account: address | null = null,
        page: number = 1,
        pageSize: number = 25,
    ): Promise<ZapToken[]> {
        void page;
        void pageSize;

        const markets = this.context?.markets ?? all_markets;
        const feePolicy = this.context?.feePolicy ?? setup_config?.feePolicy;

        return buildLocalSimpleZapTokens(
            markets,
            provider,
            query,
            account,
            (wallet, tokenIn, tokenOut, amount, formattedSlippage, feeBps, feeReceiver) =>
                this.quote(wallet, tokenIn, tokenOut, amount, formattedSlippage, feeBps, feeReceiver),
            (tokenIn, tokenOut, amount) => {
                if (feePolicy == null) {
                    return { feeBps: 0n };
                }

                const feeBps = feePolicy.getFeeBps({
                    operation: 'zap',
                    inputToken: tokenIn as address,
                    outputToken: tokenOut as address,
                    inputAmount: amount,
                    currentLeverage: null,
                    targetLeverage: null,
                });

                return {
                    feeBps,
                    feeReceiver: feeBps > 0n ? feePolicy.feeReceiver : undefined,
                };
            },
        );
    }

    async quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
        const actionSlippage = toContractSwapSlippage(slippage, feeBps);
        const quote = await this.quote(wallet, tokenIn, tokenOut, amount, slippage, feeBps, feeReceiver);

        // Fee-aware slippage expansion: KyberSwap deducts its `currency_in`
        // fee before the swap executes, so on-chain `_swapSafe` measures
        // (valueIn − valueOut) / valueIn counting the fee as "slippage".
        // Routed through the shared `toContractSwapSlippage` helper so every
        // aggregator adapter gets identical behavior. Raw user slippage
        // still gates `minReturnAmount` inside the build payload (DEX-level
        // protection stays tight).
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

    private abortError(stage: string): DexQuoteError {
        return new DexQuoteError(
            "aborted",
            `KyberSwap ${stage} was cancelled.`,
            { provider: "KyberSwap" },
        );
    }

    private normalizeRequestError(error: unknown, stage: string, signal?: AbortSignal): DexQuoteError {
        if (error instanceof DexQuoteError) {
            return error;
        }
        if (signal?.aborted) {
            return this.abortError(stage);
        }
        if ((error as { name?: string } | undefined)?.name === "AbortError") {
            return new DexQuoteError(
                "timeout",
                `KyberSwap ${stage} request timed out.`,
                { provider: "KyberSwap", retryable: true, cause: error },
            );
        }
        return new DexQuoteError(
            "unavailable",
            `KyberSwap ${stage} request failed: ${(error as Error | undefined)?.message ?? String(error)}`,
            { provider: "KyberSwap", retryable: true, cause: error },
        );
    }

    private async readErrorDetail(response: Response): Promise<string> {
        let detail = `${response.status} ${response.statusText}`;
        try {
            const body = await response.json() as Partial<KyperSwapErrorResponse>;
            const requestId = body.requestId ? `[${body.requestId}]: ` : "";
            const code = body.code == undefined ? "" : ` (code: ${body.code})`;
            detail = `${requestId}${body.message ?? detail}${code}`;
        } catch { /* non-JSON error body (for example an HTML 502 page) */ }
        return detail;
    }

    private getRetryAfterMs(response: Response): number {
        const value = response.headers?.get?.("Retry-After");
        if (!value) return KYBER_DEFAULT_RETRY_DELAY_MS;

        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.ceil(seconds * 1_000);
        }
        const dateMs = Date.parse(value);
        return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : KYBER_DEFAULT_RETRY_DELAY_MS;
    }

    private async waitForRetry(delayMs: number, signal: AbortSignal | undefined, stage: string): Promise<void> {
        if (signal?.aborted) throw this.abortError(stage);
        if (delayMs <= 0) return;

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, delayMs);
            const onAbort = () => {
                clearTimeout(timer);
                reject(this.abortError(stage));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    private async requestJson<T>(
        url: string,
        init: RequestInit,
        stage: "quote" | "build",
        retryBudget: DexQuoteRetryBudget,
        signal?: AbortSignal,
    ): Promise<T> {
        for (let attempt = 1; attempt <= KYBER_MAX_REQUEST_ATTEMPTS; attempt++) {
            if (signal?.aborted) throw this.abortError(stage);

            let retryAfterMs = KYBER_DEFAULT_RETRY_DELAY_MS;
            let requestError: DexQuoteError;
            try {
                const requestInit: RequestInit = signal == undefined
                    ? init
                    : { ...init, signal };
                const response = await fetchWithTimeout(url, requestInit, KYBER_REQUEST_TIMEOUT_MS);
                if (!response.ok) {
                    const detail = await this.readErrorDetail(response);
                    retryAfterMs = this.getRetryAfterMs(response);
                    const status = response.status;
                    const isNoRoute = status >= 400 && status < 500 && status !== 408 && status !== 429 &&
                        /route|liquidity|not found|no path/i.test(detail);
                    if (status === 429) {
                        requestError = new DexQuoteError(
                            "rate-limited",
                            `KyberSwap ${stage} was rate limited: ${detail}`,
                            { provider: "KyberSwap", retryable: true, status },
                        );
                    } else if (status === 408) {
                        requestError = new DexQuoteError(
                            "timeout",
                            `KyberSwap ${stage} timed out: ${detail}`,
                            { provider: "KyberSwap", retryable: true, status },
                        );
                    } else if (status >= 500) {
                        requestError = new DexQuoteError(
                            "unavailable",
                            `KyberSwap ${stage} is unavailable: ${detail}`,
                            { provider: "KyberSwap", retryable: true, status },
                        );
                    } else if (isNoRoute) {
                        requestError = new DexQuoteError(
                            "no-route",
                            `KyberSwap could not find a route: ${detail}`,
                            { provider: "KyberSwap", status },
                        );
                    } else {
                        requestError = new DexQuoteError(
                            "http",
                            `KyberSwap ${stage} failed: ${detail}`,
                            { provider: "KyberSwap", status },
                        );
                    }
                } else {
                    try {
                        return await response.json() as T;
                    } catch (error) {
                        throw new DexQuoteError(
                            "malformed-response",
                            `KyberSwap ${stage} returned malformed JSON.`,
                            { provider: "KyberSwap", cause: error },
                        );
                    }
                }
            } catch (error) {
                requestError = this.normalizeRequestError(error, stage, signal);
            }

            if (
                !requestError.retryable ||
                attempt === KYBER_MAX_REQUEST_ATTEMPTS ||
                retryBudget.remaining <= 0
            ) {
                throw requestError;
            }
            retryBudget.remaining--;
            await this.waitForRetry(retryAfterMs, signal, stage);
        }

        throw new DexQuoteError("unavailable", `KyberSwap ${stage} failed.`, { provider: "KyberSwap" });
    }

    private malformed(stage: "quote" | "build", error: unknown): DexQuoteError {
        return new DexQuoteError(
            "malformed-response",
            `KyberSwap ${stage} response was malformed: ${(error as Error | undefined)?.message ?? String(error)}`,
            { provider: "KyberSwap", cause: error },
        );
    }

    async prepareQuote(
        wallet: string,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        slippage: bigint,
        feeBps?: bigint,
        feeReceiver?: address,
        options: DexQuoteOptions = {},
    ): Promise<PreparedQuote> {
        validateSlippageBps(slippage, 'KyberSwap quote');
        if (amount <= 0n) {
            throw new Error(`KyberSwap quote amount must be positive, got ${amount}`);
        }
        const validatedWallet = validateAddress(wallet, 'KyberSwap wallet');
        const validatedTokenIn = validateAddress(tokenIn, 'KyberSwap tokenIn');
        const validatedTokenOut = validateAddress(tokenOut, 'KyberSwap tokenOut');
        const validatedFeeReceiver = feeReceiver == undefined
            ? undefined
            : validateAddress(feeReceiver, 'KyberSwap feeReceiver');
        validateCheckerFeePolicy(this.dao, feeBps, validatedFeeReceiver);
        const retryBudget = options.retryBudget ?? { remaining: 1 };
        if (!Number.isInteger(retryBudget.remaining) || retryBudget.remaining < 0 || retryBudget.remaining > 1) {
            throw new Error(`KyberSwap retry budget must be 0 or 1, got ${retryBudget.remaining}`);
        }

        const params = new URLSearchParams({
            tokenIn: validatedTokenIn,
            tokenOut: validatedTokenOut,
            amountIn: amount.toString(),
        });

        // Optional fee parameters: charge in input currency, BPS-denominated.
        // KyberSwap deducts the fee from the input amount before swapping and
        // routes it to feeReceiver. See:
        // https://docs.kyberswap.com/reference/swap-aggregator-api#extra-fee-handling
        if (feeBps && feeBps > 0n && feeReceiver) {
            params.set('feeAmount', feeBps.toString());
            params.set('chargeFeeBy', 'currency_in');
            params.set('isInBps', 'true');
            params.set('feeReceiver', validatedFeeReceiver!);
        }

        const quote = await this.requestJson<KyberSwapQuoteResponse>(`${this.api}/api/v1/routes?${params.toString()}`, {
            method: 'GET',
            headers: {
                'X-Client-Id': this.client_id,
                'Content-Type': 'application/json'
            }
        }, "quote", retryBudget, options.signal);

        let routeSummary: KyberSwapQuoteResponse["data"]["routeSummary"];
        let previewAmountOut: bigint;
        try {
            routeSummary = quote.data.routeSummary;
            if (routeSummary == null || typeof routeSummary !== "object") {
                throw new Error("missing routeSummary");
            }
            validateEqualAddress(routeSummary.tokenIn, validatedTokenIn, "route tokenIn");
            validateEqualAddress(routeSummary.tokenOut, validatedTokenOut, "route tokenOut");
            const routeAmountIn = safeBigInt(routeSummary.amountIn, "KyberSwap route amountIn");
            if (routeAmountIn !== amount) {
                throw new Error(`KyberSwap route amountIn=${routeAmountIn}, expected ${amount}`);
            }
            previewAmountOut = safeBigInt(routeSummary.amountOut, "KyberSwap route amountOut");
            if (previewAmountOut === 0n) {
                throw new DexQuoteError(
                    "no-route",
                    "KyberSwap could not find a route with positive output.",
                    { provider: "KyberSwap" },
                );
            }
            validateRouterAddress(quote.data.routerAddress, this.router, "KyberSwap");
        } catch (error) {
            if (error instanceof DexQuoteError) throw error;
            throw this.malformed("quote", error);
        }

        const previewMinOut = previewAmountOut * (BPS - slippage) / BPS;
        return {
            min_out: previewMinOut,
            out: previewAmountOut,
            build: async (buildOptions: DexQuoteOptions = {}): Promise<Quote> => {
                const signal = buildOptions.signal ?? options.signal;
                const buildData = await this.requestJson<KyperSwapBuildResponse>(`${this.api}/api/v1/route/build`, {
                    method: 'POST',
                    headers: {
                        'X-Client-Id': this.client_id,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        routeSummary,
                        origin: validatedWallet,
                        sender: validatedWallet,
                        recipient: validatedWallet,
                        slippageTolerance: Number(slippage),
                        referral: this.dao
                    })
                }, "build", retryBudget, signal);

                try {
                    const amountOut = safeBigInt(buildData.data.amountOut, 'KyberSwap amountOut');
                    if (amountOut === 0n) {
                        throw new DexQuoteError(
                            "no-route",
                            "KyberSwap build returned zero output.",
                            { provider: "KyberSwap" },
                        );
                    }
                    const transactionValue = safeBigInt(buildData.data.transactionValue, 'KyberSwap transactionValue');
                    if (transactionValue !== 0n) {
                        throw new Error(`KyberSwap quote transactionValue=${transactionValue}, expected 0`);
                    }
                    const min_out = amountOut * (BPS - slippage) / BPS;
                    const validatedRouter = validateRouterAddress(buildData.data.routerAddress, this.router, 'KyberSwap');

                    validateSwapCalldata(buildData.data.data, {
                        tokenIn: validatedTokenIn,
                        tokenOut: validatedTokenOut,
                        amount,
                        recipient: validatedWallet,
                        minReturnAmount: min_out,
                        feeBps: feeBps ?? 0n,
                        feeReceiver: validatedFeeReceiver,
                    });

                    return {
                        to: validatedRouter,
                        calldata: buildData.data.data as bytes,
                        min_out,
                        out: amountOut,
                        raw: buildData,
                    };
                } catch (error) {
                    if (error instanceof DexQuoteError) throw error;
                    throw this.malformed("build", error);
                }
            },
        };
    }

    async quote(
        wallet: string,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        slippage: bigint,
        feeBps?: bigint,
        feeReceiver?: address,
    ): Promise<Quote> {
        const prepared = await this.prepareQuote(
            wallet,
            tokenIn,
            tokenOut,
            amount,
            slippage,
            feeBps,
            feeReceiver,
        );
        return prepared.build();
    }
}
