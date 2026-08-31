import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_signer } from "../types";
import { contractSetup, EMPTY_ADDRESS, EMPTY_BYTES, NATIVE_ADDRESS, toContractSwapSlippage } from "../helpers";
import { CToken } from "./CToken";
import { Calldata } from "./Calldata";
import abi from '../abis/SimpleZapper.json';
import { Zappers } from "./Market";
import { type SetupConfigSnapshot } from "../setup";
import type IDexAgg from "./DexAggregators/IDexAgg";
import type { DexQuoteOptions, PreparedQuote, Quote } from "./DexAggregators/IDexAgg";
import { validateSlippageBps } from "../validation";
import { assertZapSwapAllowed, isZapTokenExcluded } from "../zapPolicy";

export interface Swap {
    inputToken: address,
    inputAmount: bigint,
    outputToken: address,
    target: address,
    slippage: bigint,
    call: bytes
};

export type ZapperTypes = 'none' | 'native-vault' | 'vault' | 'simple' | 'native-simple';
export const zapperTypeToName = new Map<ZapperTypes, keyof Zappers>([
    ['native-vault', 'nativeVaultZapper'],
    ['vault', 'vaultZapper'],
    ['simple', 'simpleZapper'],
    ['native-simple', 'simpleZapper'],
]);

export interface IZapper {
    swapAndDeposit(
        ctoken: address,
        depositAsWrappedNative: boolean,
        swapAction: Swap,
        expectedShares: bigint,
        collateralizeFor: boolean,
        receiver: address
    ): Promise<TransactionResponse>
    swapAndRepay(
        borrowableCToken: address,
        depositAsWrappedNative: boolean,
        swapAction: Swap,
        repayAssets: bigint,
        receiver: address
    ): Promise<TransactionResponse>
    redeemAndSwap(
        redeemAction: RedeemAction,
        swapAction: Swap,
        receiver: address
    ): Promise<TransactionResponse>
    redeemSwapAndDeposit(
        cToken: address,
        redeemAction: RedeemAction,
        swapAction: Swap,
        expectedShares: bigint,
        collateralizeFor: boolean,
        receiver: address
    ): Promise<TransactionResponse>
}

export interface RedeemAction {
    cToken: address;
    shares: bigint;
    forceRedeemCollateral: boolean;
}

/** A fully-built exact-input ERC-20 swap for a SimpleZapper redemption. */
export interface RedeemSwapQuote {
    inputToken: address;
    outputToken: address;
    inputAmount: bigint;
    minimumOutput: bigint;
    expectedOutput: bigint;
    slippageBps: bigint;
    feeBps: bigint;
    feeReceiver: address | undefined;
    action: Swap;
    quote: Quote;
}

/** GET-only redemption quote whose transaction calldata is built once on demand. */
export interface PreparedRedeemSwapQuote {
    inputToken: address;
    outputToken: address;
    inputAmount: bigint;
    minimumOutput: bigint;
    expectedOutput: bigint;
    slippageBps: bigint;
    feeBps: bigint;
    feeReceiver: address | undefined;
    build(options?: DexQuoteOptions): Promise<RedeemSwapQuote>;
}

/** A fully-built exact-input swap quote suitable for SimpleZapper.swapAndRepay. */
export interface SwapAndRepayQuote {
    inputToken: address;
    swapInputToken: address;
    outputToken: address;
    inputAmount: bigint;
    minimumOutput: bigint;
    expectedOutput: bigint;
    slippageBps: bigint;
    depositAsWrappedNative: boolean;
    feeBps: bigint;
    feeReceiver: address | undefined;
    action: Swap;
    quote: Quote;
}

/** GET-only swap preview that can build its calldata exactly once after sizing. */
export interface PreparedSwapAndRepayQuote {
    inputToken: address;
    swapInputToken: address;
    outputToken: address;
    inputAmount: bigint;
    minimumOutput: bigint;
    expectedOutput: bigint;
    slippageBps: bigint;
    depositAsWrappedNative: boolean;
    feeBps: bigint;
    feeReceiver: address | undefined;
    build(options?: DexQuoteOptions): Promise<SwapAndRepayQuote>;
}

export class Zapper extends Calldata<IZapper> {
    signer: curvance_signer;
    contract: Contract & IZapper;
    address: address;
    type: ZapperTypes;
    setup: SetupConfigSnapshot;
    dexAgg: IDexAgg;

    constructor(address: address, signer: curvance_signer, type: ZapperTypes, setup: SetupConfigSnapshot, dexAgg: IDexAgg) {
        super();
        this.address = address;
        this.signer = signer;
        this.type = type;
        this.setup = setup;
        if (dexAgg == undefined) {
            throw new Error(
                `${type} Zapper requires a setup-bound DEX aggregator. ` +
                `Use CToken.getZapper(...) or pass the dexAgg returned by setupChain(...).`,
            );
        }
        this.dexAgg = dexAgg;
        this.contract = contractSetup<IZapper>(signer, address, abi);
    }

    private assertCTokenBelongsToSetup(ctoken: CToken) {
        const tokenMarket = (ctoken as CToken & { market?: { address?: address; setup?: SetupConfigSnapshot } }).market;
        if (tokenMarket == undefined) {
            return;
        }

        const tokenChain = tokenMarket.setup?.chain;
        if (tokenMarket.setup === this.setup) {
            return;
        }

        throw new Error(
            `${this.type} Zapper on ${this.setup.chain} cannot build calldata for token ${ctoken.address} ` +
            `from market ${tokenMarket.address ?? "unknown"} on ${tokenChain ?? "unknown"} ` +
            `without the same setup snapshot.`
        );
    }

    async nativeZap(ctoken: CToken, amount: bigint, collateralize: boolean, receiver: address = this.signer.address as address) {
        this.assertCTokenBelongsToSetup(ctoken);
        const wrapped = this.type === 'native-simple' || ctoken.isWrappedNative;
        const calldata = await this.getNativeZapCalldata(ctoken, amount, collateralize, wrapped, receiver);
        return ctoken.oracleRoute(calldata, { value: amount, to: this.address }, receiver);
    }

    async simpleZap(ctoken: CToken, inputToken: address, outputToken: address,  amount: bigint, collateralize: boolean, slippage: bigint, receiver: address = this.signer.address as address) {
        this.assertCTokenBelongsToSetup(ctoken);
        const calldata = await this.getSimpleZapCalldata(ctoken, inputToken, outputToken, amount, collateralize, slippage, receiver);
        const isNative = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
        return ctoken.oracleRoute(calldata, isNative ? { value: amount, to: this.address } : { to: this.address }, receiver);
    }

    /**
     * Previews an exact-input swap into `ctoken`'s debt asset. Aggregators with
     * two-phase support only fetch route summaries here; calldata is built by
     * the returned `build` function after repay-all sizing has converged.
     */
    async prepareSwapAndRepay(
        ctoken: CToken,
        inputToken: address,
        amount: bigint,
        slippage: bigint,
        options: DexQuoteOptions = {},
    ): Promise<PreparedSwapAndRepayQuote> {
        this.assertCTokenBelongsToSetup(ctoken);
        validateSlippageBps(slippage, "swapAndRepay quote");
        if (amount <= 0n) {
            throw new Error(`swapAndRepay input amount must be positive, got ${amount}`);
        }

        const outputToken = ctoken.getAsset(false);
        const isNative = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
        const wrappedNative = this.setup.assets.wrapped_native;
        const swapInputToken = isNative ? wrappedNative : inputToken;
        const depositAsWrappedNative = isNative;
        assertZapSwapAllowed(
            this.setup.assets,
            swapInputToken,
            outputToken,
            "swapAndRepay",
        );

        if (swapInputToken.toLowerCase() === outputToken.toLowerCase()) {
            const action: Swap = {
                inputToken: isNative ? NATIVE_ADDRESS : inputToken,
                inputAmount: amount,
                outputToken,
                target: EMPTY_ADDRESS,
                slippage: 0n,
                call: EMPTY_BYTES,
            };
            const quote: Quote = {
                to: EMPTY_ADDRESS,
                calldata: EMPTY_BYTES,
                min_out: amount,
                out: amount,
            };

            const prepared: PreparedSwapAndRepayQuote = {
                inputToken,
                swapInputToken,
                outputToken,
                inputAmount: amount,
                minimumOutput: amount,
                expectedOutput: amount,
                slippageBps: slippage,
                depositAsWrappedNative,
                feeBps: 0n,
                feeReceiver: undefined,
                build: async () => ({
                    inputToken,
                    swapInputToken,
                    outputToken,
                    inputAmount: amount,
                    minimumOutput: amount,
                    expectedOutput: amount,
                    slippageBps: slippage,
                    depositAsWrappedNative,
                    feeBps: 0n,
                    feeReceiver: undefined,
                    action,
                    quote,
                }),
            };
            return prepared;
        }

        const feeBps = this.setup.feePolicy.getFeeBps({
            operation: "zap",
            inputToken: isNative ? NATIVE_ADDRESS as address : inputToken,
            outputToken,
            inputAmount: amount,
            currentLeverage: null,
            targetLeverage: null,
        });
        const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;
        const quoteArgs = [
            this.address,
            swapInputToken,
            outputToken,
            amount,
            slippage,
            feeBps,
            feeReceiver,
        ] as const;
        let preparedQuote: PreparedQuote;
        if (this.dexAgg.prepareQuote != undefined) {
            preparedQuote = await this.dexAgg.prepareQuote(...quoteArgs, options);
        } else {
            const quote = await this.dexAgg.quote(...quoteArgs);
            preparedQuote = {
                min_out: quote.min_out,
                out: quote.out,
                build: async () => quote,
            };
        }

        if (preparedQuote.min_out <= 0n) {
            throw new Error("swapAndRepay quote returned zero guaranteed output");
        }
        if (preparedQuote.out < preparedQuote.min_out) {
            throw new Error(
                `swapAndRepay expected output ${preparedQuote.out} is below minimum output ${preparedQuote.min_out}`,
            );
        }

        return {
            inputToken,
            swapInputToken,
            outputToken,
            inputAmount: amount,
            minimumOutput: preparedQuote.min_out,
            expectedOutput: preparedQuote.out,
            slippageBps: slippage,
            depositAsWrappedNative,
            feeBps,
            feeReceiver,
            build: async (buildOptions: DexQuoteOptions = {}) => {
                const signal = buildOptions.signal ?? options.signal;
                const quote = await preparedQuote.build(
                    signal == undefined ? buildOptions : { ...buildOptions, signal },
                );
                if (quote.min_out <= 0n) {
                    throw new Error("swapAndRepay quote returned zero guaranteed output");
                }
                if (quote.out < quote.min_out) {
                    throw new Error(
                        `swapAndRepay expected output ${quote.out} is below minimum output ${quote.min_out}`,
                    );
                }
                const action: Swap = {
                    inputToken: isNative ? NATIVE_ADDRESS : inputToken,
                    inputAmount: amount,
                    outputToken,
                    target: quote.to,
                    slippage: toContractSwapSlippage(slippage, feeBps),
                    call: quote.calldata,
                };

                return {
                    inputToken,
                    swapInputToken,
                    outputToken,
                    inputAmount: amount,
                    minimumOutput: quote.min_out,
                    expectedOutput: quote.out,
                    slippageBps: slippage,
                    depositAsWrappedNative,
                    feeBps,
                    feeReceiver,
                    action,
                    quote,
                };
            },
        };
    }

    /** Fully builds an exact-input quote for callers that do not need two-phase sizing. */
    async quoteSwapAndRepay(
        ctoken: CToken,
        inputToken: address,
        amount: bigint,
        slippage: bigint,
        options: DexQuoteOptions = {},
    ): Promise<SwapAndRepayQuote> {
        const prepared = await this.prepareSwapAndRepay(
            ctoken,
            inputToken,
            amount,
            slippage,
            options,
        );
        return prepared.build(options);
    }

    getSwapAndRepayCalldataFromQuote(
        ctoken: CToken,
        quotedSwap: SwapAndRepayQuote,
        repayAssets: bigint,
        receiver: address = this.signer.address as address,
    ) {
        this.assertCTokenBelongsToSetup(ctoken);
        if (repayAssets <= 0n) {
            throw new Error(`swapAndRepay repayment floor must be positive, got ${repayAssets}`);
        }
        const debtAsset = ctoken.getAsset(false);
        const policyInputToken = quotedSwap.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
            ? this.setup.assets.wrapped_native
            : quotedSwap.inputToken;
        if (quotedSwap.swapInputToken.toLowerCase() !== policyInputToken.toLowerCase()) {
            throw new Error("swapAndRepay quote swap input does not match its declared input token");
        }
        assertZapSwapAllowed(
            this.setup.assets,
            policyInputToken,
            quotedSwap.outputToken,
            "swapAndRepay",
        );
        if (quotedSwap.outputToken.toLowerCase() !== debtAsset.toLowerCase()) {
            throw new Error(
                `swapAndRepay quote output ${quotedSwap.outputToken} does not match debt asset ${debtAsset}`,
            );
        }
        if (quotedSwap.minimumOutput < repayAssets) {
            throw new Error(
                `swapAndRepay minimum output ${quotedSwap.minimumOutput} does not cover repayment floor ${repayAssets}`,
            );
        }
        if (
            quotedSwap.action.inputToken.toLowerCase() !== quotedSwap.inputToken.toLowerCase() ||
            quotedSwap.action.inputAmount !== quotedSwap.inputAmount ||
            quotedSwap.action.outputToken.toLowerCase() !== quotedSwap.outputToken.toLowerCase()
        ) {
            throw new Error("swapAndRepay quote action does not match its declared tokens and amount");
        }

        return this.getCallData("swapAndRepay", [
            ctoken.address,
            quotedSwap.depositAsWrappedNative,
            quotedSwap.action,
            repayAssets,
            receiver,
        ]);
    }

    async getSwapAndRepayCalldata(
        ctoken: CToken,
        inputToken: address,
        amount: bigint,
        repayAssets: bigint,
        slippage: bigint,
        receiver: address = this.signer.address as address,
    ) {
        const quote = await this.quoteSwapAndRepay(ctoken, inputToken, amount, slippage);
        return this.getSwapAndRepayCalldataFromQuote(ctoken, quote, repayAssets, receiver);
    }

    async swapAndRepay(
        ctoken: CToken,
        inputToken: address,
        amount: bigint,
        repayAssets: bigint,
        slippage: bigint,
        receiver: address = this.signer.address as address,
    ) {
        const calldata = await this.getSwapAndRepayCalldata(
            ctoken,
            inputToken,
            amount,
            repayAssets,
            slippage,
            receiver,
        );
        const isNative = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
        const overrides = isNative
            ? { value: amount, to: this.address }
            : { to: this.address };
        return ctoken.oracleRoute(calldata, overrides, receiver);
    }

    /**
     * Prepares an exact-input ERC-20 swap for a redemption. Native output is
     * intentionally unsupported: SimpleZapper wraps native transfers, while
     * exit-zap callers need an unambiguous ERC-20 result.
     */
    async prepareRedeemSwap(
        ctoken: CToken,
        outputToken: address,
        amount: bigint,
        slippage: bigint,
        options: DexQuoteOptions = {},
    ): Promise<PreparedRedeemSwapQuote> {
        this.assertCTokenBelongsToSetup(ctoken);
        validateSlippageBps(slippage, "redemption swap quote");
        if (amount <= 0n) {
            throw new Error(`Redemption swap input amount must be positive, got ${amount}`);
        }
        if (
            outputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase() ||
            outputToken.toLowerCase() === EMPTY_ADDRESS.toLowerCase()
        ) {
            throw new Error("Redemption swap output must be a nonzero ERC-20 address.");
        }
        if (isZapTokenExcluded(this.setup.assets, ctoken.asset)) {
            throw new Error(
                `Redemption swap does not support excluded source asset ${ctoken.asset.symbol}.`,
            );
        }

        const inputToken = ctoken.getAsset(false);
        assertZapSwapAllowed(this.setup.assets, inputToken, outputToken, "redemption swap");

        if (inputToken.toLowerCase() === outputToken.toLowerCase()) {
            const action: Swap = {
                inputToken,
                inputAmount: amount,
                outputToken,
                target: EMPTY_ADDRESS,
                slippage: 0n,
                call: EMPTY_BYTES,
            };
            const quote: Quote = {
                to: EMPTY_ADDRESS,
                calldata: EMPTY_BYTES,
                min_out: amount,
                out: amount,
            };
            return {
                inputToken,
                outputToken,
                inputAmount: amount,
                minimumOutput: amount,
                expectedOutput: amount,
                slippageBps: slippage,
                feeBps: 0n,
                feeReceiver: undefined,
                build: async () => ({
                    inputToken,
                    outputToken,
                    inputAmount: amount,
                    minimumOutput: amount,
                    expectedOutput: amount,
                    slippageBps: slippage,
                    feeBps: 0n,
                    feeReceiver: undefined,
                    action,
                    quote,
                }),
            };
        }

        const feeBps = this.setup.feePolicy.getFeeBps({
            operation: "zap",
            inputToken,
            outputToken,
            inputAmount: amount,
            currentLeverage: null,
            targetLeverage: null,
        });
        const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;
        const quoteArgs = [
            this.address,
            inputToken,
            outputToken,
            amount,
            slippage,
            feeBps,
            feeReceiver,
        ] as const;
        let preparedQuote: PreparedQuote;
        if (this.dexAgg.prepareQuote != undefined) {
            preparedQuote = await this.dexAgg.prepareQuote(...quoteArgs, options);
        } else {
            const quote = await this.dexAgg.quote(...quoteArgs);
            preparedQuote = {
                min_out: quote.min_out,
                out: quote.out,
                build: async () => quote,
            };
        }
        this.assertRedeemSwapOutput(preparedQuote.min_out, preparedQuote.out);

        return {
            inputToken,
            outputToken,
            inputAmount: amount,
            minimumOutput: preparedQuote.min_out,
            expectedOutput: preparedQuote.out,
            slippageBps: slippage,
            feeBps,
            feeReceiver,
            build: async (buildOptions: DexQuoteOptions = {}) => {
                const signal = buildOptions.signal ?? options.signal;
                const quote = await preparedQuote.build(
                    signal == undefined ? buildOptions : { ...buildOptions, signal },
                );
                this.assertRedeemSwapOutput(quote.min_out, quote.out);
                return {
                    inputToken,
                    outputToken,
                    inputAmount: amount,
                    minimumOutput: quote.min_out,
                    expectedOutput: quote.out,
                    slippageBps: slippage,
                    feeBps,
                    feeReceiver,
                    action: {
                        inputToken,
                        inputAmount: amount,
                        outputToken,
                        target: quote.to,
                        slippage: toContractSwapSlippage(slippage, feeBps),
                        call: quote.calldata,
                    },
                    quote,
                };
            },
        };
    }

    async quoteRedeemSwap(
        ctoken: CToken,
        outputToken: address,
        amount: bigint,
        slippage: bigint,
        options: DexQuoteOptions = {},
    ): Promise<RedeemSwapQuote> {
        return (await this.prepareRedeemSwap(
            ctoken,
            outputToken,
            amount,
            slippage,
            options,
        )).build(options);
    }

    getRedeemAndSwapCalldataFromQuote(
        ctoken: CToken,
        quotedSwap: RedeemSwapQuote,
        shares: bigint,
        receiver: address = this.signer.address as address,
    ): bytes {
        this.assertCTokenBelongsToSetup(ctoken);
        this.assertRedeemSwapQuoteBinding(ctoken, quotedSwap);
        if (shares <= 0n) {
            throw new Error(`Redemption shares must be positive, got ${shares}`);
        }
        return this.getCallData("redeemAndSwap", [{
            cToken: ctoken.address,
            shares,
            forceRedeemCollateral: false,
        }, quotedSwap.action, receiver]);
    }

    getRedeemSwapAndDepositCalldataFromQuote(
        source: CToken,
        destination: CToken,
        quotedSwap: RedeemSwapQuote,
        shares: bigint,
        expectedShares: bigint,
        collateralizeFor: boolean,
        receiver: address = this.signer.address as address,
    ): bytes {
        this.assertCTokenBelongsToSetup(source);
        this.assertCTokenBelongsToSetup(destination);
        this.assertRedeemSwapQuoteBinding(source, quotedSwap);
        if (source.address.toLowerCase() === destination.address.toLowerCase()) {
            throw new Error("Move destination cToken must differ from the source cToken.");
        }
        if (quotedSwap.outputToken.toLowerCase() !== destination.getAsset(false).toLowerCase()) {
            throw new Error(
                `Move quote output ${quotedSwap.outputToken} does not match destination asset ${destination.getAsset(false)}.`,
            );
        }
        if (shares <= 0n || expectedShares <= 0n) {
            throw new Error("Move redemption and expected destination shares must be positive.");
        }
        return this.getCallData("redeemSwapAndDeposit", [
            destination.address,
            {
                cToken: source.address,
                shares,
                forceRedeemCollateral: false,
            },
            quotedSwap.action,
            expectedShares,
            collateralizeFor,
            receiver,
        ]);
    }

    private assertRedeemSwapOutput(minimumOutput: bigint, expectedOutput: bigint) {
        if (minimumOutput <= 0n) {
            throw new Error("Redemption swap quote returned zero guaranteed output.");
        }
        if (expectedOutput < minimumOutput) {
            throw new Error(
                `Redemption swap expected output ${expectedOutput} is below minimum output ${minimumOutput}.`,
            );
        }
    }

    private assertRedeemSwapQuoteBinding(ctoken: CToken, quote: RedeemSwapQuote) {
        const inputToken = ctoken.getAsset(false);
        if (
            quote.inputToken.toLowerCase() !== inputToken.toLowerCase() ||
            quote.action.inputToken.toLowerCase() !== inputToken.toLowerCase() ||
            quote.action.inputAmount !== quote.inputAmount ||
            quote.action.outputToken.toLowerCase() !== quote.outputToken.toLowerCase()
        ) {
            throw new Error("Redemption swap action does not match its declared tokens and amount.");
        }
        if (
            quote.outputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase() ||
            quote.outputToken.toLowerCase() === EMPTY_ADDRESS.toLowerCase()
        ) {
            throw new Error("Redemption swap output must be a nonzero ERC-20 address.");
        }
        this.assertRedeemSwapOutput(quote.minimumOutput, quote.expectedOutput);
        assertZapSwapAllowed(this.setup.assets, inputToken, quote.outputToken, "redemption swap");
    }

    async getSimpleZapCalldata(ctoken: CToken, inputToken: address, outputToken: address, amount: bigint, collateralize: boolean, slippage: bigint, receiver: address = this.signer.address as address) {
        this.assertCTokenBelongsToSetup(ctoken);
        const isNative = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
        const wrappedNative = this.setup.assets.wrapped_native;

        // For native MON: if the deposit token IS wrapped native, just wrap (no swap needed)
        if (isNative && outputToken.toLowerCase() === wrappedNative.toLowerCase()) {
            return this.getNativeZapCalldata(ctoken, amount, collateralize, true, receiver);
        }

        // For native MON into non-WMON tokens: wrap first, then swap WMON → target
        // The contract handles wrapping when depositAsWrappedNative=true
        const swapInputToken = isNative ? wrappedNative : inputToken;
        assertZapSwapAllowed(
            this.setup.assets,
            swapInputToken,
            outputToken,
            "SimpleZapper",
        );

        // No-op short-circuit: same-token zap (e.g., USDC → USDC market). The
        // SimpleZapper.swapAndDeposit contract handles this on-chain via
        // _isMatchingToken (line 80-85). Mirror that here so we don't waste a
        // DEX RPC call and don't accidentally charge a fee on a no-op.
        if (swapInputToken.toLowerCase() === outputToken.toLowerCase()) {
            const swap: Swap = {
                inputToken: isNative ? NATIVE_ADDRESS : inputToken,
                inputAmount: amount,
                outputToken: outputToken,
                target: EMPTY_ADDRESS,
                slippage: 0n,
                call: EMPTY_BYTES,
            };
            const expected_shares = await ctoken.convertToShares(amount);
            return this.getCallData("swapAndDeposit", [
                ctoken.address,
                isNative,
                swap,
                expected_shares,
                collateralize,
                receiver
            ]);
        }

        // Resolve fee from policy. The policy already exempts no-ops via
        // same-token + native↔wrapped checks, so the only way feeBps > 0 here
        // is for a real swap.
        const feeBps = this.setup.feePolicy.getFeeBps({
            operation: 'zap',
            inputToken: isNative ? NATIVE_ADDRESS as address : inputToken,
            outputToken: outputToken,
            inputAmount: amount,
            currentLeverage: null,
            targetLeverage: null,
        });
        const feeReceiver = feeBps > 0n ? this.setup.feePolicy.feeReceiver : undefined;

        const quote = await this.dexAgg.quote(this.address, swapInputToken, outputToken, amount, slippage, feeBps, feeReceiver);

        const swap: Swap = {
            inputToken: isNative ? NATIVE_ADDRESS : inputToken,
            inputAmount: amount,
            outputToken: outputToken,
            target: quote.to,
            slippage: toContractSwapSlippage(slippage, feeBps),
            call: quote.calldata
        };

        const expected_shares = await ctoken.convertToShares(BigInt(quote.min_out));

        return this.getCallData("swapAndDeposit", [
            ctoken.address,
            isNative,
            swap,
            expected_shares,
            collateralize,
            receiver
        ]);
    }

    async getVaultZapCalldata(ctoken: CToken, amount: bigint, collateralize: boolean, wrapped: boolean = false, receiver: address = this.signer.address as address) {
        this.assertCTokenBelongsToSetup(ctoken);
        const { underlying_address, expected_shares } = await this.getZapVaultData(ctoken, amount);

        const swap: Swap = {
            inputToken: underlying_address,
            inputAmount: amount,
            outputToken: underlying_address,
            target: EMPTY_ADDRESS,
            slippage: 0n,
            call: EMPTY_BYTES
        };

        return this.getCallData("swapAndDeposit", [
            ctoken.address,
            wrapped,
            swap,
            expected_shares,
            collateralize,
            receiver
        ]);
    }

    async getZapVaultData(ctoken: CToken, amount: bigint) {
        this.assertCTokenBelongsToSetup(ctoken);
        const vault = await ctoken.getUnderlyingVault();
        const vault_underlying = await vault.fetchAsset(false);
        const expected_shares = await ctoken.getExpectedVaultShares(amount);

        return {
            underlying_address: vault_underlying,
            expected_shares: expected_shares
        }
    }

    async getNativeZapCalldata(ctoken: CToken, amount: bigint, collateralize: boolean, wrapped: boolean = false, receiver: address = this.signer.address as address) {
        this.assertCTokenBelongsToSetup(ctoken);
        const vaultAssets = (ctoken.isVault || ctoken.isNativeVault)
            ? await ctoken.getExpectedVaultShares(amount)
            : amount;
        const expected_shares = (ctoken.isVault || ctoken.isNativeVault)
            ? vaultAssets
            : await ctoken.convertToShares(vaultAssets);
        const wrappedNative = this.setup.assets.wrapped_native;

        const swap: Swap = {
            inputToken: NATIVE_ADDRESS,
            inputAmount: amount,
            outputToken: wrapped ? wrappedNative : NATIVE_ADDRESS,
            target: EMPTY_ADDRESS,
            slippage: 0n,
            call: EMPTY_BYTES
        };

        return this.getCallData("swapAndDeposit", [
            ctoken.address,
            wrapped,
            swap,
            expected_shares,
            collateralize,
            receiver
        ]);
    }
}
