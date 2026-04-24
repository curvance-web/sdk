import { address, bytes, curvance_read_provider } from "../../types";
import { ZapToken } from "../CToken";
import IDexAgg from "./IDexAgg";
import { Swap } from "../Zapper";
import { all_markets, setup_config } from "../../setup";
import { EMPTY_ADDRESS, toContractSwapSlippage } from "../../helpers";
import { safeBigInt, fetchWithTimeout, validateAddress, validateRouterAddress, validateSlippageBps } from "../../validation";
import { AbiCoder } from "ethers";
import { buildLocalSimpleZapTokens } from "./helpers";

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
        min: amount * minFeeBps / 10000n,
        max: (amount * maxFeeBps + 9999n) / 10000n,
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

    constructor(
        dao: address = "0x0Acb7eF4D8733C719d60e0992B489b629bc55C02",
        router: address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        chain: string = "monad-mainnet",
        api: string = "https://aggregator-api.kyberswap.com"
    ) {
        // KyberSwap uses 'monad' instead of 'monad-mainnet' like other providers, so we adjust here
        if(chain == "monad-mainnet") {
            chain = 'monad';
        }

        this.dao = dao;
        this.router = router;
        this.chain = chain;
        this.api = `${api}/${this.chain}`;
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

        return buildLocalSimpleZapTokens(
            all_markets,
            provider,
            query,
            account,
            (wallet, tokenIn, tokenOut, amount, formattedSlippage, feeBps, feeReceiver) =>
                this.quote(wallet, tokenIn, tokenOut, amount, formattedSlippage, feeBps, feeReceiver),
            (tokenIn, tokenOut, amount) => {
                const feePolicy = setup_config?.feePolicy;
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

    async quote(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
        validateSlippageBps(slippage, 'KyberSwap quote');
        validateCheckerFeePolicy(this.dao, feeBps, feeReceiver);

        const params = new URLSearchParams({
            tokenIn,
            tokenOut,
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
            params.set('feeReceiver', feeReceiver);
        }

        const quote_response = await fetchWithTimeout(`${this.api}/api/v1/routes?${params.toString()}`, {
            method: 'GET',
            headers: {
                'X-Client-Id': this.client_id,
                'Content-Type': 'application/json'
            }
        });
        if (!quote_response.ok) {
            let detail = `${quote_response.status} ${quote_response.statusText}`;
            try {
                const body = await quote_response.json() as KyperSwapErrorResponse;
                detail = `[${body.requestId}]: ${body.message} (code: ${body.code})`;
            } catch { /* non-JSON error body (e.g. HTML 502 page) */ }
            throw new Error(`KyberSwap quote failed: ${detail}`);
        }
        const quote = await quote_response.json() as KyberSwapQuoteResponse;

        const build_response = await fetchWithTimeout(`${this.api}/api/v1/route/build`, {
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
            let detail = `${build_response.status} ${build_response.statusText}`;
            try {
                const body = await build_response.json() as KyperSwapErrorResponse;
                detail = `[${body.requestId}]: ${body.message} (code: ${body.code})`;
            } catch { /* non-JSON error body */ }
            throw new Error(`KyberSwap build failed: ${detail}`);
        }
        const build_data = await build_response.json() as KyperSwapBuildResponse;

        const amountOut = safeBigInt(build_data.data.amountOut, 'KyberSwap amountOut');
        const min_out = amountOut * (10000n - slippage) / 10000n;

        // Case-insensitive router comparison via validateRouterAddress — also
        // enforces address format/checksum. Matches Kuru's router gate.
        const validatedRouter = validateRouterAddress(build_data.data.routerAddress, this.router, 'KyberSwap');

        // Validate that the API actually embedded the fee params we requested.
        // Without this, a misconfigured API response silently reverts on-chain.
        validateSwapCalldata(build_data.data.data, {
            tokenIn,
            tokenOut,
            amount,
            recipient: wallet,
            minReturnAmount: min_out,
            feeBps: feeBps ?? 0n,
            feeReceiver,
        });

        return {
            to: validatedRouter,
            calldata: build_data.data.data as bytes,
            min_out: min_out,
            out: amountOut,
            raw: build_data
        }
    }
}
