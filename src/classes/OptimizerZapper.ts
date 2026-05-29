import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_signer } from "../types";
import { BPS, contractSetup, EMPTY_ADDRESS, EMPTY_BYTES, NATIVE_ADDRESS, toContractSwapSlippage } from "../helpers";
import { Calldata } from "./Calldata";
import abi from "../abis/OptimizerZapper.json";
import type { SetupConfigSnapshot } from "../setup";
import type IDexAgg from "./DexAggregators/IDexAgg";
import type { LendingOptimizer } from "./LendingOptimizer";
import type { Swap } from "./Zapper";

const OPTIMIZER_ZAP_SHARES_BUFFER_BPS = 2n;

export interface IOptimizerZapper {
    swapAndDeposit(
        optimizer: address,
        depositAsWrappedNative: boolean,
        swapAction: Swap,
        expectedShares: bigint,
        receiver: address,
    ): Promise<TransactionResponse>;
}

export class OptimizerZapper extends Calldata<IOptimizerZapper> {
    signer: curvance_signer;
    contract: Contract & IOptimizerZapper;
    address: address;
    setup: SetupConfigSnapshot;
    dexAgg: IDexAgg;

    constructor(address: address, signer: curvance_signer, setup: SetupConfigSnapshot, dexAgg: IDexAgg) {
        super();
        this.address = address;
        this.signer = signer;
        this.setup = setup;
        if (dexAgg == undefined) {
            throw new Error(
                "OptimizerZapper requires a setup-bound DEX aggregator. " +
                "Pass the dexAgg returned by setupChain(...).",
            );
        }
        this.dexAgg = dexAgg;
        this.contract = contractSetup<IOptimizerZapper>(signer, address, abi);
    }

    async deposit(
        optimizer: LendingOptimizer,
        inputToken: address,
        amount: bigint,
        slippage: bigint,
        receiver: address = this.signer.address as address,
    ): Promise<TransactionResponse> {
        const calldata = await this.getDepositCalldata(optimizer, inputToken, amount, slippage, receiver);
        const overrides = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
            ? { value: amount }
            : {};
        return this.executeCallData(calldata, overrides);
    }

    async getDepositCalldata(
        optimizer: LendingOptimizer,
        inputToken: address,
        amount: bigint,
        slippage: bigint,
        receiver: address = this.signer.address as address,
    ): Promise<bytes> {
        const outputToken = await this.getOptimizerAsset(optimizer);
        const isNative = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
        const wrappedNative = this.setup.assets.wrapped_native;

        if (isNative && outputToken.toLowerCase() === wrappedNative.toLowerCase()) {
            return this.getNativeDepositCalldata(optimizer, amount, true, receiver);
        }

        const swapInputToken = isNative ? wrappedNative : inputToken;

        if (swapInputToken.toLowerCase() === outputToken.toLowerCase()) {
            const swap: Swap = {
                inputToken: isNative ? NATIVE_ADDRESS : inputToken,
                inputAmount: amount,
                outputToken,
                target: EMPTY_ADDRESS,
                slippage: 0n,
                call: EMPTY_BYTES,
            };
            const expectedShares = await this.getExpectedShares(optimizer, amount);
            return this.getCallData("swapAndDeposit", [
                optimizer.address,
                isNative,
                swap,
                expectedShares,
                receiver,
            ]);
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
        const quote = await this.dexAgg.quote(
            this.address,
            swapInputToken,
            outputToken,
            amount,
            slippage,
            feeBps,
            feeReceiver,
        );

        const swap: Swap = {
            inputToken: isNative ? NATIVE_ADDRESS : inputToken,
            inputAmount: amount,
            outputToken,
            target: quote.to,
            slippage: toContractSwapSlippage(slippage, feeBps),
            call: quote.calldata,
        };
        const expectedShares = await this.getExpectedShares(optimizer, BigInt(quote.min_out));

        return this.getCallData("swapAndDeposit", [
            optimizer.address,
            isNative,
            swap,
            expectedShares,
            receiver,
        ]);
    }

    async getNativeDepositCalldata(
        optimizer: LendingOptimizer,
        amount: bigint,
        wrapped: boolean = false,
        receiver: address = this.signer.address as address,
    ): Promise<bytes> {
        const outputToken = wrapped ? this.setup.assets.wrapped_native : NATIVE_ADDRESS;
        const swap: Swap = {
            inputToken: NATIVE_ADDRESS,
            inputAmount: amount,
            outputToken,
            target: EMPTY_ADDRESS,
            slippage: 0n,
            call: EMPTY_BYTES,
        };
        const expectedShares = await this.getExpectedShares(optimizer, amount);

        return this.getCallData("swapAndDeposit", [
            optimizer.address,
            wrapped,
            swap,
            expectedShares,
            receiver,
        ]);
    }

    private async getOptimizerAsset(optimizer: LendingOptimizer): Promise<address> {
        return optimizer.contract.asset();
    }

    private async getExpectedShares(optimizer: LendingOptimizer, assets: bigint): Promise<bigint> {
        const shares = await optimizer.convertToShares(assets);
        return shares * (BPS - OPTIMIZER_ZAP_SHARES_BUFFER_BPS) / BPS;
    }
}
