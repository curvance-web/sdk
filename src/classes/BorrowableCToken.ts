import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_read_provider, Percentage, TokenInput, USD, USD_WAD } from "../types";
import { CToken, ICToken, ZapperInstructions } from "./CToken";
import { DynamicMarketToken, StaticMarketToken, UserMarketToken } from "./ProtocolReader";
import { Market } from "./Market";
import { BPS, ChangeRate, contractSetup, getRateSeconds, NATIVE_ADDRESS, SECONDS_PER_YEAR, WAD } from "../helpers";
import borrowable_ctoken_abi from '../abis/BorrowableCToken.json';
import irm_abi from '../abis/IDynamicIRM.json';
import Decimal from "decimal.js";
import FormatConverter from "./FormatConverter";
import { ERC20 } from "./ERC20";
import type { Swap, SwapAndRepayQuote, Zapper } from "./Zapper";
import { validateSlippageBps } from "../validation";

const REPAY_DEBT_BUFFER_TIME = 100n;

export const REPAY_WITH_SWAP = {
    DEFAULT_VALID_FOR_SECONDS: 100n,
    MAX_VALID_FOR_SECONDS: 600n,
    DEFAULT_MIN_SUBMIT_WINDOW_SECONDS: 15n,
    DEFAULT_DEBT_BUFFER_BPS: 1n,
    DEFAULT_MAX_QUOTE_ITERATIONS: 8,
    MAX_QUOTE_ITERATIONS: 16,
} as const;

export interface RepayWithSwapOptions {
    /** Account whose debt will be repaid. Defaults to the connected signer. */
    receiver?: address;
    /** Lifetime of the quote/interest projection, measured from chain time. */
    validForSeconds?: bigint;
    /** Minimum remaining lifetime required before the SDK will submit. */
    minSubmitWindowSeconds?: bigint;
}

export interface RepayAllWithSwapOptions extends RepayWithSwapOptions {
    /** Additional refundable debt-asset coverage above projected debt. */
    debtBufferBps?: bigint;
    /** Maximum exact-input quote/rescale attempts. */
    maxQuoteIterations?: number;
    /** Optional override for the SDK's oracle-derived initial input estimate. */
    initialInputAmount?: TokenInput;
}

export type RepayWithSwapMode = "exact-input" | "repay-all";

export interface RepayWithSwapPlan {
    readonly kind: "curvance-repay-with-swap-plan";
    readonly mode: RepayWithSwapMode;
    readonly borrowableCToken: address;
    readonly debtToken: address;
    readonly zapper: address;
    readonly payer: address;
    readonly receiver: address;
    readonly inputToken: address;
    readonly swapInputToken: address;
    readonly inputDecimals: bigint;
    readonly debtDecimals: bigint;
    readonly inputAmount: bigint;
    readonly projectedDebt: bigint;
    readonly repayAssets: bigint;
    readonly minimumOutput: bigint;
    readonly expectedOutput: bigint;
    readonly slippageBps: bigint;
    readonly contractSlippage: bigint;
    readonly feeBps: bigint;
    readonly feeReceiver: address | undefined;
    readonly quotedAt: bigint;
    readonly validUntil: bigint;
    readonly minSubmitWindowSeconds: bigint;
    readonly quoteIterations: number;
    readonly swapAction: Swap;
    readonly calldata: bytes;
    readonly value: bigint;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= 0n) {
        throw new Error(`Cannot divide by non-positive denominator ${denominator}`);
    }
    return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export interface IBorrowableCToken extends ICToken {
    borrow(amount: bigint, receiver: address): Promise<TransactionResponse>;
    repay(amount: bigint): Promise<TransactionResponse>;
    interestFee(): Promise<bigint>;
    marketOutstandingDebt(): Promise<bigint>;
    assetsHeld(): Promise<bigint>;
    debtBalance(account: address): Promise<bigint>;
    IRM(): Promise<address>;
    // More functions available
}

export interface IDynamicIRM {
    ADJUSTMENT_RATE(): Promise<bigint>;
    linkedToken(): Promise<address>;
    borrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    predictedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    supplyRate(assetsHeld: bigint, debt: bigint, interestFee: bigint): Promise<bigint>;
    adjustedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<[
        ratePerSecond: bigint,
        adjustmentRate: bigint,
    ]>;
    utilizationRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
}

export class BorrowableCToken extends CToken {
    override contract: Contract & IBorrowableCToken;

    constructor(
        provider: curvance_read_provider,
        address: address,
        cache: StaticMarketToken & DynamicMarketToken & UserMarketToken,
        market: Market
    ) {
        super(provider, address, cache, market);
        this.contract = contractSetup<IBorrowableCToken>(this.provider, address, borrowable_ctoken_abi);
    }

    protected override getWriteContract() {
        return contractSetup<IBorrowableCToken>(this.requireSigner(), this.address, borrowable_ctoken_abi);
    }

    getLiquidity(inUSD: true): USD;
    getLiquidity(inUSD: false): USD_WAD;
    getLiquidity(inUSD: boolean): USD | USD_WAD {
        return inUSD ? this.convertTokensToUsd(this.cache.liquidity) : this.cache.liquidity;
    }

    getPredictedBorrowRate(inPercentage: true): Percentage;
    getPredictedBorrowRate(inPercentage: false): bigint;
    getPredictedBorrowRate(inPercentage: boolean) {
        return inPercentage ? Decimal(this.cache.predictedBorrowRate).div(WAD).mul(SECONDS_PER_YEAR) : this.cache.predictedBorrowRate;
    }

    getUtilizationRate(inPercentage: true): Percentage;
    getUtilizationRate(inPercentage: false): bigint;
    getUtilizationRate(inPercentage: boolean) {
        return inPercentage ? Decimal(this.cache.utilizationRate).div(WAD) : this.cache.utilizationRate;
    }

    borrowChange(amount: USD, rateType: ChangeRate) {
        const rate = this.getBorrowRate(false);
        const rate_seconds = getRateSeconds(rateType);
        const rate_percent = Decimal(rate * rate_seconds).div(WAD);

        return amount.mul(rate_percent);
    }


    async getMaxBorrowable(): Promise<TokenInput>;
    async getMaxBorrowable(inUSD: false): Promise<TokenInput>;
    async getMaxBorrowable(inUSD: true): Promise<USD>;
    async getMaxBorrowable(inUSD: boolean = false): Promise<USD | TokenInput> {
        const credit_usd = this.market.userRemainingCredit;
        const safeCreditUsd =
            credit_usd.isFinite() && credit_usd.greaterThan(0)
                ? credit_usd
                : new Decimal(0);
        const remainingDebtCap = this.cache.debtCap > this.cache.debt
            ? this.cache.debtCap - this.cache.debt
            : 0n;
        const availableLiquidity = this.cache.liquidity > 0n ? this.cache.liquidity : 0n;
        const tokenCapacity = remainingDebtCap < availableLiquidity
            ? remainingDebtCap
            : availableLiquidity;
        const tokenCapacityUsd = this.convertTokensToUsd(tokenCapacity);
        const cappedCreditUsd = Decimal.min(safeCreditUsd, tokenCapacityUsd);

        if (inUSD) {
            return cappedCreditUsd.isFinite() && cappedCreditUsd.greaterThan(0)
                ? cappedCreditUsd
                : new Decimal(0);
        }

        if (cappedCreditUsd.eq(0)) {
            return new Decimal(0);
        }

        const maxBorrowable = this.convertUsdToTokens(cappedCreditUsd, true);
        return maxBorrowable.isFinite() && maxBorrowable.greaterThan(0)
            ? maxBorrowable
            : new Decimal(0);
    };

    override async depositAsCollateral(amount: TokenInput, zap: ZapperInstructions = 'none',  receiver: address | null = null) {
        const signer = this.requireSigner();
        const collateralReceiver = receiver ?? signer.address as address;
        const receiverDebt = collateralReceiver.toLowerCase() === (signer.address as string).toLowerCase()
            ? this.readFreshUserCache("userDebt", "depositing as collateral")
            : await this.debtBalance(collateralReceiver);

        if(receiverDebt > 0n) {
            throw new Error("Cannot deposit as collateral when there is outstanding debt");
        }
        return super.depositAsCollateral(amount, zap, receiver);
    }

    override async postCollateral(amount: TokenInput) {
        if(this.readFreshUserCache("userDebt", "posting collateral") > 0n) {
            throw new Error("Cannot post collateral when there is outstanding debt");
        }
        return super.postCollateral(amount);
    }

    async hypotheticalBorrowOf(amount: TokenInput) {
        const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        return this.market.reader.hypotheticalBorrowOf(
            this.getAccountOrThrow(),
            this,
            assets
        )
    }

    async fetchDebt(inUSD: true): Promise<USD>;
    async fetchDebt(inUSD: false): Promise<bigint>;
    async fetchDebt(inUSD = true): Promise<USD | bigint> {
        const totalDebt = await this.contract.marketOutstandingDebt();
        return inUSD ? this.fetchConvertTokensToUsd(totalDebt) : totalDebt;
    }

    async borrow(amount: TokenInput, receiver: address | null = null) {
        const signer = this.requireSigner();
        receiver ??= signer.address as address;
        if (this.readFreshUserCache("userCollateral", "borrowing") > 0n) {
            throw new Error("Cannot borrow from a token that is currently posted as collateral.");
        }

        const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        if(assets <= 0n) {
            throw new Error("Borrow amount must be greater than zero.");
        }

        const calldata = this.getCallData("borrow", [ assets, receiver ]);
        return this.oracleRoute(calldata);
    }

    async dynamicIRM() {
        const irm_addr = await this.contract.IRM();
        return contractSetup<IDynamicIRM>(this.provider, irm_addr, irm_abi);
    }

    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove'): Promise<Percentage>;
    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage: false ): Promise<bigint>;
    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage: true ): Promise<Percentage>;
    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage = true ): Promise<Percentage | bigint> {
        const assets_as_bn = FormatConverter.decimalToBigInt(assets, this.asset.decimals);
        const irm = await this.dynamicIRM();
        const assets_held = direction == 'add'
            ? this.cache.liquidity + assets_as_bn
            : assets_as_bn >= this.cache.liquidity ? 0n : this.cache.liquidity - assets_as_bn;
        const newRate = await irm.utilizationRate(assets_held, this.cache.debt);

        return inPercentage ? Decimal(newRate).div(WAD) : newRate;
    }

    async fetchDebtBalanceAtTimestamp(): Promise<USD>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint): Promise<USD>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: true): Promise<USD>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: false): Promise<bigint>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint = 0n, asUSD: boolean = true): Promise<USD | bigint> {
        const debt = await this.market.reader.debtBalanceAtTimestamp(this.getAccountOrThrow(), this.address, timestamp);
        return asUSD ? this.fetchConvertTokensToUsd(debt) : debt;
    }

    async fetchBorrowRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = await this.contract.assetsHeld();
        const debt = await this.contract.marketOutstandingDebt();
        const borrowRate = (await irm.borrowRate(assetsHeld, debt));
        this.cache.borrowRate = borrowRate;
        return borrowRate;
    }

    async fetchPredictedBorrowRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = await this.contract.assetsHeld();
        const debt = await this.contract.marketOutstandingDebt();
        const predictedBorrowRate = (await irm.predictedBorrowRate(assetsHeld, debt));
        this.cache.predictedBorrowRate = predictedBorrowRate;
        return predictedBorrowRate;
    }

    async fetchUtilizationRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = await this.contract.assetsHeld();
        const debt = await this.contract.marketOutstandingDebt();
        const utilizationRate = (await irm.utilizationRate(assetsHeld, debt));
        this.cache.utilizationRate = utilizationRate;
        return utilizationRate;
    }

    async fetchSupplyRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = await this.contract.assetsHeld();
        const debt = await this.contract.marketOutstandingDebt();
        const fee = await this.fetchInterestFee();
        const supplyRate = (await irm.supplyRate(assetsHeld, debt, fee));
        this.cache.supplyRate = supplyRate;
        return supplyRate;
    }

    async fetchLiquidity() {
        const liquidity = await this.contract.assetsHeld();
        this.cache.liquidity = liquidity;
        return liquidity;
    }

    private async checkRepayApproval(assets: bigint) {
        const asset = this.getAsset(true);
        const owner = this.getAccountOrThrow();
        const allowance = await asset.allowance(owner, this.address);
        if (allowance >= assets) {
            return;
        }

        let tokenLabel = asset.symbol ?? asset.address;
        if(asset.symbol == undefined) {
            try {
                tokenLabel = await asset.fetchSymbol();
            } catch {
                tokenLabel = asset.address;
            }
        }

        throw new Error(`Please approve the ${tokenLabel} token for ${this.symbol} repay`);
    }

    async repay(amount: TokenInput) {
        const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        const repayAssets = assets === 0n
            ? await this.fetchDebtBalanceAtTimestamp(this.getBufferedRepayTimestamp(), false)
            : assets;
        await this.checkRepayApproval(repayAssets);
        const calldata = this.getCallData("repay", [ assets ]);
        return this.oracleRoute(calldata);
    }

    /**
     * Builds an exact-input zap repayment. The user fixes the payment-token
     * amount; the DEX quote determines the minimum and expected debt credit.
     */
    async quoteRepayWithSwap(
        inputToken: address,
        inputAmount: TokenInput,
        slippage: Percentage,
        options: RepayWithSwapOptions = {},
    ): Promise<RepayWithSwapPlan> {
        const context = await this.getRepayWithSwapContext(options);
        const inputDecimals = await this.getRepayWithSwapInputDecimals(inputToken);
        const inputAmountRaw = FormatConverter.decimalToBigInt(inputAmount, inputDecimals);
        if (inputAmountRaw <= 0n) {
            throw new Error("Zap repay input amount must be greater than zero.");
        }

        const quote = await context.zapper.quoteSwapAndRepay(
            this,
            inputToken,
            inputAmountRaw,
            context.slippageBps(slippage),
        );
        if (quote.minimumOutput <= 0n) {
            throw new Error("Zap repay quote returned zero guaranteed output.");
        }

        const projectedDebt = await this.fetchProjectedDebtFor(
            context.receiver,
            context.validUntil,
        );
        this.assertOutstandingProjectedDebt(projectedDebt, context.receiver);

        return this.buildRepayWithSwapPlan({
            mode: "exact-input",
            context,
            inputDecimals,
            projectedDebt,
            repayAssets: quote.minimumOutput,
            quote,
            quoteIterations: 1,
        });
    }

    /**
     * Builds a target-driven repay-all plan. Debt is projected to the plan
     * deadline, buffered, then an exact-input DEX quote is iteratively resized
     * until its guaranteed minimum output covers that repayment floor.
     */
    async quoteRepayAllWithSwap(
        inputToken: address,
        slippage: Percentage,
        options: RepayAllWithSwapOptions = {},
    ): Promise<RepayWithSwapPlan> {
        const context = await this.getRepayWithSwapContext(options);
        const inputDecimals = await this.getRepayWithSwapInputDecimals(inputToken);
        const projectedDebt = await this.fetchProjectedDebtFor(
            context.receiver,
            context.validUntil,
        );
        this.assertOutstandingProjectedDebt(projectedDebt, context.receiver);

        const debtBufferBps = options.debtBufferBps ?? REPAY_WITH_SWAP.DEFAULT_DEBT_BUFFER_BPS;
        if (debtBufferBps < 0n || debtBufferBps >= BPS) {
            throw new Error(`Repay-all debt buffer must be in [0, ${BPS}), got ${debtBufferBps}`);
        }
        // The BPS margin absorbs rate/utilization drift; the extra base unit
        // protects the floor from integer rounding at the projection boundary.
        const repayAssets = ceilDiv(projectedDebt * (BPS + debtBufferBps), BPS) + 1n;
        const maxQuoteIterations = options.maxQuoteIterations
            ?? REPAY_WITH_SWAP.DEFAULT_MAX_QUOTE_ITERATIONS;
        if (
            !Number.isInteger(maxQuoteIterations) ||
            maxQuoteIterations <= 0 ||
            maxQuoteIterations > REPAY_WITH_SWAP.MAX_QUOTE_ITERATIONS
        ) {
            throw new Error(
                `Repay-all maxQuoteIterations must be an integer in [1, ${REPAY_WITH_SWAP.MAX_QUOTE_ITERATIONS}], ` +
                `got ${maxQuoteIterations}`,
            );
        }

        const initialInputAmount = options.initialInputAmount == undefined
            ? await this.estimateRepayAllInputAmount(inputToken, inputDecimals, repayAssets)
            : FormatConverter.decimalToBigInt(options.initialInputAmount, inputDecimals);
        if (initialInputAmount <= 0n) {
            throw new Error("Repay-all initial input amount must be greater than zero.");
        }

        const solved = await this.solveRepayAllInput({
            zapper: context.zapper,
            inputToken,
            initialInputAmount,
            repayAssets,
            slippageBps: context.slippageBps(slippage),
            maxQuoteIterations,
        });

        return this.buildRepayWithSwapPlan({
            mode: "repay-all",
            context,
            inputDecimals,
            projectedDebt,
            repayAssets,
            quote: solved.quote,
            quoteIterations: solved.iterations,
        });
    }

    async isRepayWithSwapApproved(plan: RepayWithSwapPlan): Promise<boolean> {
        this.assertRepayWithSwapPlanBinding(plan);
        if (this.isNativeRepayInput(plan.inputToken)) {
            return true;
        }

        const token = this.getRepayWithSwapInputToken(plan.inputToken);
        return (await token.allowance(plan.payer, plan.zapper)) >= plan.inputAmount;
    }

    async isRepayAllWithSwapApproved(plan: RepayWithSwapPlan): Promise<boolean> {
        this.assertRepayAllPlan(plan);
        return this.isRepayWithSwapApproved(plan);
    }

    async approveRepayWithSwap(
        plan: RepayWithSwapPlan,
        amount?: TokenInput | null,
    ): Promise<TransactionResponse | undefined> {
        this.assertRepayWithSwapPlanBinding(plan);
        if (this.isNativeRepayInput(plan.inputToken)) {
            return undefined;
        }

        const token = this.getRepayWithSwapInputToken(plan.inputToken);
        const approvalAmount = amount === undefined
            ? FormatConverter.bigIntToDecimal(plan.inputAmount, plan.inputDecimals)
            : amount;
        return token.approve(plan.zapper, approvalAmount);
    }

    async approveRepayAllWithSwap(
        plan: RepayWithSwapPlan,
        amount?: TokenInput | null,
    ): Promise<TransactionResponse | undefined> {
        this.assertRepayAllPlan(plan);
        return this.approveRepayWithSwap(plan, amount);
    }

    async simulateRepayWithSwap(
        plan: RepayWithSwapPlan,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const overrides = await this.preflightRepayWithSwap(plan);
            return await this.simulateOracleRoute(plan.calldata, overrides);
        } catch (error: any) {
            return {
                success: false,
                error: error?.reason || error?.message || String(error),
            };
        }
    }

    async simulateRepayAllWithSwap(
        plan: RepayWithSwapPlan,
    ): Promise<{ success: boolean; error?: string }> {
        this.assertRepayAllPlan(plan);
        return this.simulateRepayWithSwap(plan);
    }

    async repayWithSwap(plan: RepayWithSwapPlan): Promise<TransactionResponse> {
        const overrides = await this.preflightRepayWithSwap(plan);
        const simulation = await this.simulateOracleRoute(plan.calldata, overrides);
        if (!simulation.success) {
            throw new Error(
                `Zap repay simulation failed${simulation.error ? `: ${simulation.error}` : "."}`,
            );
        }
        return this.oracleRoute(plan.calldata, overrides, plan.receiver);
    }

    async repayAllWithSwap(plan: RepayWithSwapPlan): Promise<TransactionResponse> {
        this.assertRepayAllPlan(plan);
        return this.repayWithSwap(plan);
    }

    private async getRepayWithSwapContext(options: RepayWithSwapOptions) {
        const signer = this.requireSigner();
        const payer = signer.address as address;
        const receiver = options.receiver ?? payer;
        const validForSeconds = options.validForSeconds
            ?? REPAY_WITH_SWAP.DEFAULT_VALID_FOR_SECONDS;
        const minSubmitWindowSeconds = options.minSubmitWindowSeconds
            ?? REPAY_WITH_SWAP.DEFAULT_MIN_SUBMIT_WINDOW_SECONDS;
        if (validForSeconds <= 0n || validForSeconds > REPAY_WITH_SWAP.MAX_VALID_FOR_SECONDS) {
            throw new Error(
                `Zap repay validity must be in [1, ${REPAY_WITH_SWAP.MAX_VALID_FOR_SECONDS}] seconds, ` +
                `got ${validForSeconds}`,
            );
        }
        if (minSubmitWindowSeconds < 0n || minSubmitWindowSeconds >= validForSeconds) {
            throw new Error(
                `Zap repay minimum submit window must be non-negative and shorter than validity, ` +
                `got ${minSubmitWindowSeconds}`,
            );
        }

        const quotedAt = await this.getRepayWithSwapChainTimestamp();
        const zapper = this.getZapper("simple");
        if (zapper == null) {
            throw new Error(`Simple Zapper is not configured for ${this.symbol}.`);
        }

        return {
            payer,
            receiver,
            quotedAt,
            validUntil: quotedAt + validForSeconds,
            minSubmitWindowSeconds,
            zapper,
            slippageBps: (slippage: Percentage) => {
                const bps = FormatConverter.percentageToBps(slippage);
                validateSlippageBps(bps, "swapAndRepay quote");
                return bps;
            },
        };
    }

    private async getRepayWithSwapChainTimestamp(): Promise<bigint> {
        const block = await this.provider.getBlock("latest");
        if (block == null) {
            throw new Error("Could not read the latest block for zap repay planning.");
        }
        return BigInt(block.timestamp);
    }

    private async fetchProjectedDebtFor(receiver: address, timestamp: bigint): Promise<bigint> {
        return this.market.reader.debtBalanceAtTimestamp(receiver, this.address, timestamp);
    }

    private assertOutstandingProjectedDebt(projectedDebt: bigint, receiver: address) {
        if (projectedDebt <= 0n) {
            throw new Error(`Account ${receiver} has no outstanding ${this.symbol} debt to repay.`);
        }
    }

    private isNativeRepayInput(inputToken: address): boolean {
        return inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
    }

    private getRepayWithSwapInputToken(inputToken: address): ERC20 {
        return new ERC20(
            this.provider,
            inputToken,
            undefined,
            this.market.setup.contracts.OracleManager as address,
            this.signer,
        );
    }

    private async getRepayWithSwapInputDecimals(inputToken: address): Promise<bigint> {
        if (this.isNativeRepayInput(inputToken)) {
            return 18n;
        }
        if (inputToken.toLowerCase() === this.asset.address.toLowerCase()) {
            return this.asset.decimals;
        }
        return this.getRepayWithSwapInputToken(inputToken).fetchDecimals();
    }

    private async estimateRepayAllInputAmount(
        inputToken: address,
        inputDecimals: bigint,
        repayAssets: bigint,
    ): Promise<bigint> {
        if (
            inputToken.toLowerCase() === this.asset.address.toLowerCase() ||
            (
                this.isNativeRepayInput(inputToken) &&
                this.asset.address.toLowerCase() === this.market.setup.assets.wrapped_native.toLowerCase()
            )
        ) {
            return repayAssets;
        }

        const inputPrice = await this.market.oracle_manager.getPrice(inputToken, true, true);
        const debtPrice = await this.market.oracle_manager.getPrice(this.asset.address, true, false);
        if (inputPrice <= 0n || debtPrice <= 0n) {
            throw new Error(
                `Cannot estimate repay-all input from non-positive oracle prices ` +
                `(input=${inputPrice}, debt=${debtPrice}).`,
            );
        }

        const inputScale = 10n ** inputDecimals;
        const debtScale = 10n ** this.asset.decimals;
        return ceilDiv(repayAssets * debtPrice * inputScale, debtScale * inputPrice);
    }

    private async solveRepayAllInput({
        zapper,
        inputToken,
        initialInputAmount,
        repayAssets,
        slippageBps,
        maxQuoteIterations,
    }: {
        zapper: Zapper;
        inputToken: address;
        initialInputAmount: bigint;
        repayAssets: bigint;
        slippageBps: bigint;
        maxQuoteIterations: number;
    }): Promise<{ quote: SwapAndRepayQuote; iterations: number }> {
        let candidate = initialInputAmount;
        let best: SwapAndRepayQuote | undefined;

        for (let iteration = 1; iteration <= maxQuoteIterations; iteration++) {
            const quote = await zapper.quoteSwapAndRepay(
                this,
                inputToken,
                candidate,
                slippageBps,
            );
            if (quote.minimumOutput <= 0n) {
                throw new Error("Repay-all quote returned zero guaranteed output.");
            }

            if (quote.minimumOutput >= repayAssets) {
                best = quote;
                const smallerCandidate = ceilDiv(candidate * repayAssets, quote.minimumOutput);
                if (smallerCandidate >= candidate || candidate - smallerCandidate <= 1n) {
                    return { quote, iterations: iteration };
                }
                candidate = smallerCandidate;
                continue;
            }

            const largerCandidate = ceilDiv(candidate * repayAssets, quote.minimumOutput);
            candidate = largerCandidate > candidate ? largerCandidate : candidate + 1n;
        }

        if (best != undefined) {
            return { quote: best, iterations: maxQuoteIterations };
        }
        throw new Error(
            `Could not find a repay-all swap whose minimum output covers ${repayAssets} ` +
            `within ${maxQuoteIterations} quotes.`,
        );
    }

    private buildRepayWithSwapPlan({
        mode,
        context,
        inputDecimals,
        projectedDebt,
        repayAssets,
        quote,
        quoteIterations,
    }: {
        mode: RepayWithSwapMode;
        context: Awaited<ReturnType<BorrowableCToken["getRepayWithSwapContext"]>>;
        inputDecimals: bigint;
        projectedDebt: bigint;
        repayAssets: bigint;
        quote: SwapAndRepayQuote;
        quoteIterations: number;
    }): RepayWithSwapPlan {
        const calldata = context.zapper.getSwapAndRepayCalldataFromQuote(
            this,
            quote,
            repayAssets,
            context.receiver,
        );
        const plan: RepayWithSwapPlan = {
            kind: "curvance-repay-with-swap-plan",
            mode,
            borrowableCToken: this.address,
            debtToken: this.asset.address,
            zapper: context.zapper.address,
            payer: context.payer,
            receiver: context.receiver,
            inputToken: quote.inputToken,
            swapInputToken: quote.swapInputToken,
            inputDecimals,
            debtDecimals: this.asset.decimals,
            inputAmount: quote.inputAmount,
            projectedDebt,
            repayAssets,
            minimumOutput: quote.minimumOutput,
            expectedOutput: quote.expectedOutput,
            slippageBps: quote.slippageBps,
            contractSlippage: quote.action.slippage,
            feeBps: quote.feeBps,
            feeReceiver: quote.feeReceiver,
            quotedAt: context.quotedAt,
            validUntil: context.validUntil,
            minSubmitWindowSeconds: context.minSubmitWindowSeconds,
            quoteIterations,
            swapAction: Object.freeze({ ...quote.action }),
            calldata,
            value: this.isNativeRepayInput(quote.inputToken) ? quote.inputAmount : 0n,
        };
        return Object.freeze(plan);
    }

    private assertRepayAllPlan(plan: RepayWithSwapPlan) {
        if (plan.mode !== "repay-all") {
            throw new Error(`Expected a repay-all swap plan, got ${plan.mode}.`);
        }
    }

    private assertRepayWithSwapPlanBinding(plan: RepayWithSwapPlan) {
        if (plan.kind !== "curvance-repay-with-swap-plan") {
            throw new Error("Invalid zap repay plan kind.");
        }
        if (plan.borrowableCToken.toLowerCase() !== this.address.toLowerCase()) {
            throw new Error(
                `Zap repay plan targets cToken ${plan.borrowableCToken}, expected ${this.address}.`,
            );
        }
        if (plan.debtToken.toLowerCase() !== this.asset.address.toLowerCase()) {
            throw new Error(
                `Zap repay plan targets debt asset ${plan.debtToken}, expected ${this.asset.address}.`,
            );
        }
        const payer = this.requireSigner().address as address;
        if (plan.payer.toLowerCase() !== payer.toLowerCase()) {
            throw new Error(`Zap repay plan payer ${plan.payer} does not match signer ${payer}.`);
        }
        const zapper = this.getZapper("simple");
        if (zapper == null || plan.zapper.toLowerCase() !== zapper.address.toLowerCase()) {
            throw new Error("Zap repay plan does not match the configured Simple Zapper.");
        }
        if (plan.inputAmount <= 0n || plan.repayAssets <= 0n) {
            throw new Error("Zap repay plan amounts must be positive.");
        }
        if (plan.minimumOutput < plan.repayAssets) {
            throw new Error(
                `Zap repay plan minimum output ${plan.minimumOutput} does not cover ${plan.repayAssets}.`,
            );
        }
        if (plan.expectedOutput < plan.minimumOutput) {
            throw new Error(
                `Zap repay plan expected output ${plan.expectedOutput} is below minimum ${plan.minimumOutput}.`,
            );
        }
        if (
            plan.projectedDebt <= 0n ||
            plan.quotedAt >= plan.validUntil ||
            plan.minSubmitWindowSeconds < 0n ||
            plan.minSubmitWindowSeconds >= plan.validUntil - plan.quotedAt
        ) {
            throw new Error("Zap repay plan has invalid debt projection or timing bounds.");
        }
        if (plan.mode === "repay-all" && plan.repayAssets <= plan.projectedDebt) {
            throw new Error("Repay-all plan floor must exceed its projected debt.");
        }
        if (
            plan.swapAction.inputToken.toLowerCase() !== plan.inputToken.toLowerCase() ||
            plan.swapAction.outputToken.toLowerCase() !== plan.debtToken.toLowerCase() ||
            plan.swapAction.inputAmount !== plan.inputAmount ||
            plan.swapAction.slippage !== plan.contractSlippage
        ) {
            throw new Error("Zap repay plan swap action does not match its declared tokens and amount.");
        }
        const expectedSwapInput = this.isNativeRepayInput(plan.inputToken)
            ? this.market.setup.assets.wrapped_native
            : plan.inputToken;
        if (plan.swapInputToken.toLowerCase() !== expectedSwapInput.toLowerCase()) {
            throw new Error("Zap repay plan swap input does not match native wrapping rules.");
        }
        const expectedValue = this.isNativeRepayInput(plan.inputToken) ? plan.inputAmount : 0n;
        if (plan.value !== expectedValue) {
            throw new Error(`Zap repay plan native value ${plan.value} does not match ${expectedValue}.`);
        }

        let decoded;
        try {
            decoded = zapper.contract.interface.decodeFunctionData("swapAndRepay", plan.calldata);
        } catch (error: any) {
            throw new Error(`Zap repay plan calldata is not swapAndRepay: ${error?.message ?? String(error)}`);
        }
        const decodedSwap = decoded.swapAction;
        if (
            decoded.borrowableCToken.toLowerCase() !== plan.borrowableCToken.toLowerCase() ||
            decoded.depositAsWrappedNative !== this.isNativeRepayInput(plan.inputToken) ||
            BigInt(decoded.repayAssets) !== plan.repayAssets ||
            decoded.receiver.toLowerCase() !== plan.receiver.toLowerCase() ||
            decodedSwap.inputToken.toLowerCase() !== plan.swapAction.inputToken.toLowerCase() ||
            BigInt(decodedSwap.inputAmount) !== plan.swapAction.inputAmount ||
            decodedSwap.outputToken.toLowerCase() !== plan.swapAction.outputToken.toLowerCase() ||
            decodedSwap.target.toLowerCase() !== plan.swapAction.target.toLowerCase() ||
            BigInt(decodedSwap.slippage) !== plan.swapAction.slippage ||
            decodedSwap.call.toLowerCase() !== plan.swapAction.call.toLowerCase()
        ) {
            throw new Error("Zap repay plan calldata does not match its declared transaction fields.");
        }
    }

    private async preflightRepayWithSwap(plan: RepayWithSwapPlan) {
        this.assertRepayWithSwapPlanBinding(plan);
        const now = await this.getRepayWithSwapChainTimestamp();
        if (now + plan.minSubmitWindowSeconds > plan.validUntil) {
            throw new Error(
                `Zap repay plan is expired or too close to expiry; re-quote before submitting.`,
            );
        }

        const freshProjectedDebt = await this.fetchProjectedDebtFor(plan.receiver, plan.validUntil);
        this.assertOutstandingProjectedDebt(freshProjectedDebt, plan.receiver);
        if (plan.mode === "repay-all" && freshProjectedDebt > plan.repayAssets) {
            throw new Error(
                `Projected debt increased to ${freshProjectedDebt}, above repay-all floor ${plan.repayAssets}; re-quote.`,
            );
        }
        if (!(await this.isRepayWithSwapApproved(plan))) {
            throw new Error(
                `Please approve input token ${plan.inputToken} for Simple Zapper ${plan.zapper}.`,
            );
        }

        return this.isNativeRepayInput(plan.inputToken)
            ? { value: plan.value, to: plan.zapper }
            : { to: plan.zapper };
    }

    private getBufferedRepayTimestamp(): bigint {
        return BigInt(Math.floor(Date.now() / 1000)) + REPAY_DEBT_BUFFER_TIME;
    }

    async fetchInterestFee() {
        return this.contract.interestFee();
    }

    async marketOutstandingDebt() {
        return this.contract.marketOutstandingDebt();
    }

    async debtBalance(account: address) {
        return this.contract.debtBalance(account);
    }
}
