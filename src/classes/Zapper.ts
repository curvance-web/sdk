import { Contract, N, TransactionResponse } from "ethers";
import { address, bytes, curvance_signer } from "../types";
import { contractSetup, EMPTY_ADDRESS, EMPTY_BYTES, getChainConfig, NATIVE_ADDRESS } from "../helpers";
import { CToken } from "./CToken";
import { Calldata } from "./Calldata";
import abi from '../abis/SimpleZapper.json';
import { Zappers } from "./Market";

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
}

export class Zapper extends Calldata<IZapper> {
    provider: curvance_signer;
    contract: Contract & IZapper;
    address: address;
    type: ZapperTypes;

    constructor(address: address, provider: curvance_signer, type: ZapperTypes) {
        super();
        this.address = address;
        this.provider = provider;
        this.type = type;
        this.contract = contractSetup<IZapper>(provider, address, abi);
    }

    async nativeZap(ctoken: CToken, amount: bigint, collateralize: boolean) {
        const calldata = await this.getNativeZapCalldata(ctoken, amount, collateralize);
        return this.executeCallData(calldata, { value: amount });
    }

    async simpleZap(ctoken: CToken, inputToken: address, outputToken: address,  amount: bigint, collateralize: boolean, slippage: bigint) {
        const calldata = await this.getSimpleZapCalldata(ctoken, inputToken, outputToken, amount, collateralize, slippage);
        return this.executeCallData(calldata);
    }

    async getSimpleZapCalldata(ctoken: CToken, inputToken: address, outputToken: address, amount: bigint, collateralize: boolean, slippage: bigint) {
        const isNative = inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
        const config = getChainConfig();

        // For native MON: if the deposit token IS wrapped native, just wrap (no swap needed)
        if (isNative && outputToken.toLowerCase() === config.wrapped_native.toLowerCase()) {
            return this.getNativeZapCalldata(ctoken, amount, collateralize, true);
        }

        // For native MON into non-WMON tokens: wrap first, then swap WMON → target
        // The contract handles wrapping when depositAsWrappedNative=true
        const swapInputToken = isNative ? config.wrapped_native as address : inputToken;
        const quote = await config.dexAgg.quote(this.address, swapInputToken, outputToken, amount, slippage);

        const swap: Swap = {
            inputToken: isNative ? NATIVE_ADDRESS : inputToken,
            inputAmount: amount,
            outputToken: outputToken,
            target: quote.to,
            slippage: slippage,
            call: quote.calldata
        };

        const expected_shares = await ctoken.convertToShares(BigInt(quote.min_out));

        return this.getCallData("swapAndDeposit", [
            ctoken.address,
            isNative,
            swap,
            expected_shares,
            collateralize,
            this.provider.address as address
        ]);
    }

    async getVaultZapCalldata(ctoken: CToken, amount: bigint, collateralize: boolean, wrapped: boolean = false) {
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
            this.provider.address as address
        ]);
    }

    async getZapVaultData(ctoken: CToken, amount: bigint) {
        const vault = await ctoken.getUnderlyingVault();
        const vault_underlying = await vault.fetchAsset(false);
        const expected_shares = await ctoken.convertToShares(await vault.previewDeposit(amount));

        return {
            underlying_address: vault_underlying,
            expected_shares: expected_shares
        }
    }

    async getNativeZapCalldata(ctoken: CToken, amount: bigint, collateralize: boolean, wrapped: boolean = false) {
        const vaultAssets = (ctoken.isVault || ctoken.isNativeVault)
            ? await ctoken.getUnderlyingVault().previewDeposit(amount)
            : amount;
        const expected_shares = await ctoken.convertToShares(vaultAssets);
        const config = getChainConfig();

        const swap: Swap = {
            inputToken: NATIVE_ADDRESS,
            inputAmount: amount,
            outputToken: wrapped ? config.wrapped_native : NATIVE_ADDRESS,
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
            this.provider.address as address
        ]);
    }
}