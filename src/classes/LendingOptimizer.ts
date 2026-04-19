import { Contract, TransactionResponse } from "ethers";
import Decimal from "decimal.js";
import { contractSetup, requireSigner } from "../helpers";
import { setup_config } from "../setup";
import { address, bytes, curvance_read_provider, curvance_signer, TokenInput } from "../types";
import { Calldata } from "./Calldata";
import { ERC20 } from "./ERC20";
import FormatConverter from "./FormatConverter";
import abi from "../abis/LendingOptimizer.json";

export interface ILendingOptimizer {
    asset(): Promise<address>;
    decimals(): Promise<bigint>;
    totalAssets(): Promise<bigint>;
    totalSupply(): Promise<bigint>;
    balanceOf(account: address): Promise<bigint>;
    convertToShares(assets: bigint): Promise<bigint>;
    convertToAssets(shares: bigint): Promise<bigint>;
    maxDeposit(receiver: address): Promise<bigint>;
    maxWithdraw(owner: address): Promise<bigint>;
    mintPaused(): Promise<bigint>;
    "deposit(uint256,address)"(assets: bigint, receiver: address): Promise<TransactionResponse>;
    "withdraw(uint256,address,address)"(assets: bigint, receiver: address, owner: address): Promise<TransactionResponse>;
    "redeem(uint256,address,address)"(shares: bigint, receiver: address, owner: address): Promise<TransactionResponse>;
}

export class LendingOptimizer extends Calldata<ILendingOptimizer> {
    provider: curvance_read_provider;
    signer: curvance_signer | null;
    address: address;
    contract: Contract & ILendingOptimizer;
    asset: ERC20;

    constructor(
        address: address,
        asset: ERC20,
        provider: curvance_read_provider = setup_config.readProvider,
        signer: curvance_signer | null = setup_config.signer,
    ) {
        super();
        this.provider = provider;
        this.signer = signer;
        this.address = address;
        this.asset = asset;
        this.contract = contractSetup<ILendingOptimizer>(provider, address, abi);
    }

    async totalAssets(): Promise<bigint> {
        return this.contract.totalAssets();
    }

    async balanceOf(account: address): Promise<bigint> {
        return this.contract.balanceOf(account);
    }

    async convertToShares(assets: bigint): Promise<bigint> {
        return this.contract.convertToShares(assets);
    }

    async convertToAssets(shares: bigint): Promise<bigint> {
        return this.contract.convertToAssets(shares);
    }

    async maxDeposit(receiver: address): Promise<bigint> {
        return this.contract.maxDeposit(receiver);
    }

    async maxWithdraw(owner: address): Promise<bigint> {
        return this.contract.maxWithdraw(owner);
    }

    async deposit(
        amount: TokenInput | Decimal,
        receiver: address | null = null,
    ): Promise<TransactionResponse> {
        const signer = requireSigner(this.signer);
        const from = signer.address as address;
        receiver ??= from;

        const decimals = this.asset.decimals ?? await this.asset.fetchDecimals();
        const assets = FormatConverter.decimalToBigInt(new Decimal(amount), decimals);
        if (assets === 0n) {
            throw new Error("LendingOptimizer.deposit: amount resolves to zero");
        }

        if (setup_config.approval_protection) {
            const allowance = await this.asset.allowance(from, this.address);
            if (allowance < assets) {
                const symbol = this.asset.symbol ?? "asset";
                throw new Error(`Please approve the ${symbol} token for LendingOptimizer`);
            }
        }

        const calldata = this.contract.interface.encodeFunctionData(
            "deposit(uint256,address)",
            [assets, receiver],
        ) as bytes;

        return this.executeCallData(calldata);
    }

    async withdraw(
        amount: TokenInput | Decimal,
        receiver: address | null = null,
        owner: address | null = null,
    ): Promise<TransactionResponse> {
        const signer = requireSigner(this.signer);
        const from = signer.address as address;
        receiver ??= from;
        owner ??= from;

        const decimals = this.asset.decimals ?? await this.asset.fetchDecimals();
        const assets = FormatConverter.decimalToBigInt(new Decimal(amount), decimals);
        if (assets === 0n) {
            throw new Error("LendingOptimizer.withdraw: amount resolves to zero");
        }

        const calldata = this.contract.interface.encodeFunctionData(
            "withdraw(uint256,address,address)",
            [assets, receiver, owner],
        ) as bytes;
        return this.executeCallData(calldata);
    }

    /**
     * Redeem shares directly. Bigint-only so callers can pass the exact
     * on-chain share balance (e.g. from OptimizerReader.getOptimizerUserData)
     * without any Decimal conversion rounding — this is the dust-free path
     * for the "Max" UX.
     */
    async redeem(
        shares: bigint,
        receiver: address | null = null,
        owner: address | null = null,
    ): Promise<TransactionResponse> {
        const signer = requireSigner(this.signer);
        const from = signer.address as address;
        receiver ??= from;
        owner ??= from;

        if (shares === 0n) {
            throw new Error("LendingOptimizer.redeem: shares is zero");
        }

        const calldata = this.contract.interface.encodeFunctionData(
            "redeem(uint256,address,address)",
            [shares, receiver, owner],
        ) as bytes;
        return this.executeCallData(calldata);
    }
}
