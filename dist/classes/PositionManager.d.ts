import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_signer, TokenInput } from "../types";
import { Calldata } from "./Calldata";
import { Swap } from "./Zapper";
import { CToken } from "./CToken";
export type PositionManagerTypes = 'native-vault' | 'simple' | 'vault';
export interface LeverageAction {
    borrowableCToken: address;
    borrowAssets: bigint;
    cToken: address;
    expectedShares: bigint;
    swapAction?: Swap;
    auxData?: bytes;
}
export interface DeleverageAction {
    cToken: address;
    collateralAssets: bigint;
    borrowableCToken: address;
    repayAssets: bigint;
    swapActions?: Swap[];
    auxData?: bytes;
}
export interface IPositionManager {
    leverage(action: LeverageAction, slippage: bigint): Promise<TransactionResponse>;
    depositAndLeverage(assets: bigint, action: LeverageAction, slippage: bigint): Promise<TransactionResponse>;
    deleverage(action: DeleverageAction, slippage: bigint): Promise<TransactionResponse>;
}
export declare class PositionManager extends Calldata<IPositionManager> {
    provider: curvance_signer;
    contract: IPositionManager & Contract;
    address: address;
    type: PositionManagerTypes;
    constructor(address: address, provider: curvance_signer, type: PositionManagerTypes);
    static emptySwapAction(): Swap;
    static getExpectedShares(deposit_ctoken: CToken, amount: bigint): Promise<bigint>;
    static getVaultExpectedShares(deposit_ctoken: CToken, borrow_ctoken: CToken, borrow_amount: TokenInput): Promise<bigint>;
    getDeleverageCalldata(action: DeleverageAction, slippage: bigint): `0x${string}`;
    getLeverageCalldata(action: LeverageAction, slippage: bigint): `0x${string}`;
    getDepositAndLeverageCalldata(assets: bigint, action: LeverageAction, slippage: bigint): `0x${string}`;
}
//# sourceMappingURL=PositionManager.d.ts.map