import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_signer, TokenInput } from "../types";
import { Calldata } from "./Calldata";
import { Swap } from "./Zapper";
import { contractSetup, EMPTY_ADDRESS } from "../helpers";
import abi from '../abis/SimplePositionManager.json';
import { CToken, LEVERAGE } from "./CToken";
import FormatConverter from "./FormatConverter";

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

export class PositionManager extends Calldata<IPositionManager> {
    signer: curvance_signer;
    contract: IPositionManager & Contract;
    address: address;
    type: PositionManagerTypes;

    constructor(address: address, signer: curvance_signer, type: PositionManagerTypes) {
        super();
        this.address = address;
        this.signer = signer;
        this.type = type;
        this.contract = contractSetup<IPositionManager>(signer, address, abi);
    }

    static emptySwapAction(): Swap {
        return {
            inputToken: EMPTY_ADDRESS,
            inputAmount: 0n,
            outputToken: EMPTY_ADDRESS,
            target: EMPTY_ADDRESS,
            slippage: 0n,
            call: "0x"
        }
    }

    static async getExpectedShares(deposit_ctoken: CToken, amount: bigint) {
        return deposit_ctoken.convertToShares(amount);
    }

    private static assertVaultExpectedSharesTokensMatch(deposit_ctoken: CToken, borrow_ctoken: CToken) {
        const depositMarket = (deposit_ctoken as CToken & { market?: any }).market;
        const borrowMarket = (borrow_ctoken as CToken & { market?: any }).market;

        if (depositMarket == undefined || borrowMarket == undefined) {
            return;
        }

        if (depositMarket === borrowMarket) {
            return;
        }

        const depositChain = depositMarket.setup?.chain;
        const borrowChain = borrowMarket.setup?.chain;
        const sameMarket = depositMarket.address?.toLowerCase() === borrowMarket.address?.toLowerCase();
        const sameChain = depositChain != null && borrowChain != null && depositChain === borrowChain;
        const depositReaderKey = depositMarket.reader?.batchKey ?? null;
        const borrowReaderKey = borrowMarket.reader?.batchKey ?? null;
        const sameReaderDeployment =
            depositMarket.reader === borrowMarket.reader ||
            (depositReaderKey != null && depositReaderKey === borrowReaderKey);

        if (!sameMarket || !sameChain || !sameReaderDeployment) {
            throw new Error(
                `Vault expected shares for deposit token ${deposit_ctoken.address} on ` +
                `${depositChain ?? "unknown"} market ${depositMarket.address ?? "unknown"} cannot use ` +
                `borrow token ${borrow_ctoken.address} from ${borrowChain ?? "unknown"} ` +
                `market ${borrowMarket.address ?? "unknown"} with a different reader deployment.`
            );
        }
    }

    static async getVaultExpectedShares(deposit_ctoken: CToken, borrow_ctoken: CToken, borrow_amount: TokenInput) {
        PositionManager.assertVaultExpectedSharesTokensMatch(deposit_ctoken, borrow_ctoken);
        const borrow_amount_as_bn = FormatConverter.decimalToBigInt(borrow_amount, borrow_ctoken.asset.decimals);
        return deposit_ctoken.getExpectedVaultShares(borrow_amount_as_bn);
    }

    getDeleverageCalldata(action: DeleverageAction, slippage: bigint) {
        return this.getCallData("deleverage", [action, slippage]);
    }

    getLeverageCalldata(action: LeverageAction, slippage: bigint) {
        return this.getCallData("leverage", [action, slippage]);
    }

    getDepositAndLeverageCalldata(assets: bigint, action: LeverageAction, slippage: bigint) {
        return this.getCallData("depositAndLeverage", [assets, action, slippage]);
    }
}
