import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_signer } from "../types";
import { CToken } from "./CToken";
import { Calldata } from "./Calldata";
import { Zappers } from "./Market";
export interface Swap {
    inputToken: address;
    inputAmount: bigint;
    outputToken: address;
    target: address;
    slippage: bigint;
    call: bytes;
}
export type ZapperTypes = 'none' | 'native-vault' | 'vault' | 'simple' | 'native-simple';
export declare const zapperTypeToName: Map<ZapperTypes, keyof Zappers>;
export interface IZapper {
    swapAndDeposit(ctoken: address, depositAsWrappedNative: boolean, swapAction: Swap, expectedShares: bigint, collateralizeFor: boolean, receiver: address): Promise<TransactionResponse>;
}
export declare class Zapper extends Calldata<IZapper> {
    provider: curvance_signer;
    contract: Contract & IZapper;
    address: address;
    type: ZapperTypes;
    constructor(address: address, provider: curvance_signer, type: ZapperTypes);
    nativeZap(ctoken: CToken, amount: bigint, collateralize: boolean): Promise<TransactionResponse>;
    simpleZap(ctoken: CToken, inputToken: address, outputToken: address, amount: bigint, collateralize: boolean, slippage: bigint): Promise<TransactionResponse>;
    getSimpleZapCalldata(ctoken: CToken, inputToken: address, outputToken: address, amount: bigint, collateralize: boolean, slippage: bigint): Promise<`0x${string}`>;
    getVaultZapCalldata(ctoken: CToken, amount: bigint, collateralize: boolean, wrapped?: boolean): Promise<`0x${string}`>;
    getZapVaultData(ctoken: CToken, amount: bigint): Promise<{
        underlying_address: `0x${string}`;
        expected_shares: bigint;
    }>;
    getNativeZapCalldata(ctoken: CToken, amount: bigint, collateralize: boolean, wrapped?: boolean): Promise<`0x${string}`>;
}
//# sourceMappingURL=Zapper.d.ts.map