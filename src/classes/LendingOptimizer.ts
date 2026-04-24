import { Contract, TransactionResponse } from "ethers";
import Decimal from "decimal.js";
import { contractSetup, requireSigner, resolveReadProvider } from "../helpers";
import type { SetupConfigSnapshot } from "../setup";
import { address, bytes, curvance_provider, curvance_read_provider, curvance_signer, TokenInput } from "../types";
import { Calldata } from "./Calldata";
import { ERC20 } from "./ERC20";
import FormatConverter from "./FormatConverter";
import abi from "../abis/LendingOptimizer.json";

function getSetupConfig(): SetupConfigSnapshot | undefined {
    return (require("../setup") as typeof import("../setup")).setup_config;
}

function resolveDefaultReadProvider(): curvance_read_provider | undefined {
    return getSetupConfig()?.readProvider;
}

function resolveDefaultSigner(): curvance_signer | null {
    return getSetupConfig()?.signer ?? null;
}

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
        provider: curvance_provider | null = null,
        signer?: curvance_signer | null,
    ) {
        super();
        const legacySigner = provider != null && "address" in provider
            ? provider as curvance_signer
            : null;
        const resolvedProvider = provider == null
            ? resolveDefaultReadProvider()
            : legacySigner == null
                ? provider as curvance_read_provider
                : resolveReadProvider(provider, `LendingOptimizer ${address}`);

        if (resolvedProvider == undefined) {
            throw new Error(
                `Read provider is not configured for LendingOptimizer ${address}. ` +
                `Pass a provider explicitly or initialize setupChain() first.`,
            );
        }

        this.provider = resolvedProvider;
        this.signer = signer ?? legacySigner ?? resolveDefaultSigner();
        this.address = address;
        this.asset = asset;
        this.contract = contractSetup<ILendingOptimizer>(resolvedProvider, address, abi);
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

        const allowance = await this.asset.allowance(from, this.address);
        if (allowance < assets) {
            const symbol = await this.getAssetLabel();
            throw new Error(`Please approve the ${symbol} token for LendingOptimizer`);
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
     * without any Decimal conversion rounding. This is the dust-free path
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

    private async getAssetLabel(): Promise<string> {
        if (this.asset.symbol != undefined) {
            return this.asset.symbol;
        }

        try {
            return await this.asset.fetchSymbol();
        } catch {
            return this.asset.address;
        }
    }
}
