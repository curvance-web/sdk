import { address, bytes, curvance_read_provider, Percentage, TokenInput } from "../../types";
import { ZapToken } from "../CToken";
import IDexAgg from "./IDexAgg";
import { Swap } from "../Zapper";
import { all_markets } from "../../setup";
import { EMPTY_ADDRESS, toBigInt, toContractSwapSlippage } from "../../helpers";
import { ERC20 } from "../ERC20";
import FormatConverter from "../FormatConverter";
import { safeBigInt, fetchWithTimeout, validateRouterAddress, validateSlippageBps } from "../../validation";
import { AbiCoder } from "ethers";
import { CURVANCE_FEE_BPS, CURVANCE_DAO_FEE_RECEIVER } from "../../feePolicy";

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

/** ABI type string for KyberSwap's SwapExecutionParams struct. */
const SWAP_PARAMS_TYPE =
    'tuple(address callTarget, address approveTarget, ' +
    'tuple(address srcToken, address dstToken, address[] srcReceivers, ' +
    'uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, ' +
    'address dstReceiver, uint256 amount, uint256 minReturnAmount, ' +
    'uint256 flags, bytes permit) desc, ' +
    'bytes targetData, bytes clientData)';

/**
 * Decode and validate fee-related fields in KyberSwap swap calldata.
 * Catches API misconfigurations before the tx hits the on-chain checker.
 *
 * @param calldata - Raw calldata from KyberSwap build API
 * @param feeBps - Expected fee BPS (0n to skip fee validation)
 * @param feeReceiver - Expected fee receiver address (undefined to skip)
 */
function validateSwapCalldata(
    calldata: string,
    feeBps: bigint,
    feeReceiver: string | undefined
): void {
    // No fee configured — nothing to validate in the calldata
    if (!feeBps || feeBps === 0n || !feeReceiver) return;

    try {
        // Strip 4-byte selector (0x + 8 hex chars = 10 chars)
        const encoded = '0x' + calldata.slice(10);
        const coder = AbiCoder.defaultAbiCoder();
        const [execution] = coder.decode([SWAP_PARAMS_TYPE], encoded);
        const desc = execution.desc;

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

        // Validate fee receiver
        if (desc.feeReceivers.length !== 1) {
            throw new Error(
                `KyberSwap calldata has ${desc.feeReceivers.length} fee receivers, expected 1`
            );
        }
        if (desc.feeReceivers[0].toLowerCase() !== feeReceiver.toLowerCase()) {
            throw new Error(
                `KyberSwap calldata feeReceiver=${desc.feeReceivers[0]}, ` +
                `expected ${feeReceiver}`
            );
        }

        // Validate fee amount
        if (desc.feeAmounts.length !== 1 || BigInt(desc.feeAmounts[0]) !== feeBps) {
            throw new Error(
                `KyberSwap calldata feeAmount=${desc.feeAmounts[0]}, expected ${feeBps}`
            );
        }
    } catch (e: any) {
        // If this is our own validation error, rethrow
        if (e.message?.startsWith('KyberSwap calldata')) throw e;
        // ABI decode failure — calldata structure doesn't match expected format.
        // Log but don't block — the on-chain checker will catch structural issues.
        console.warn('Failed to validate KyberSwap calldata structure:', e.message);
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
        let zap_tokens: ZapToken[] = [];

        let tokens_set = new Set<string>();
        for(const market of all_markets) {
            for(const token of market.tokens) {
                const asset = token.getAsset(true);
                if(tokens_set.has(asset.address)) {
                    continue;
                }
                tokens_set.add(asset.address);

                if(query) {
                    const lowerQuery = query.toLowerCase();
                    if(!token.name.toLowerCase().includes(lowerQuery) && !token.symbol.toLowerCase().includes(lowerQuery)) {
                        continue;
                    }
                }

                zap_tokens.push({
                    interface: token.getAsset(true),
                    type: 'simple',
                    quote: async (tokenIn: string, tokenOut: string, amount: TokenInput, slippage: Percentage) => {
                        const wallet = account ?? EMPTY_ADDRESS;
                        const erc20in = new ERC20(provider, tokenIn as address, undefined, undefined, null);
                        const decimalsIn = erc20in.decimals ?? await erc20in.contract.decimals();
                        const amount_bigint = toBigInt(amount, decimalsIn);
                        const erc20Out = new ERC20(provider, tokenOut as address, undefined, undefined, null);
                        const decimalsOut = erc20Out.decimals ?? await erc20Out.contract.decimals();

                        const results = await this.quote(wallet, tokenIn, tokenOut, amount_bigint, FormatConverter.percentageToBps(slippage));
                        return {
                            minOut_raw: results.min_out,
                            output_raw: results.out,
                            minOut: FormatConverter.bigIntToDecimal(results.min_out, decimalsOut),
                            output: FormatConverter.bigIntToDecimal(results.out, decimalsOut),
                            extra: results.raw
                        }
                    }
                });
            }
        }

        // https://ks-setting.kyberswap.com/api/v1/tokens?chainIds=143&page=1&pageSize=25&isWhitelisted=true
        return zap_tokens;
    }

    async quoteAction(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippage: bigint, feeBps?: bigint, feeReceiver?: address) {
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
            slippage: toContractSwapSlippage(slippage, feeBps),
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
        validateSwapCalldata(build_data.data.data, feeBps ?? 0n, feeReceiver);

        return {
            to: validatedRouter,
            calldata: build_data.data.data as bytes,
            min_out: min_out,
            out: amountOut,
            raw: build_data
        }
    }
}
