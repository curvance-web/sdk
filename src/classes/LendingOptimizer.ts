import { Contract, TransactionResponse } from "ethers";
import Decimal from "decimal.js";
import { contractSetup, EMPTY_ADDRESS, NATIVE_ADDRESS, requireSigner, resolveReadProvider } from "../helpers";
import type { SetupConfigSnapshot } from "../setup";
import { address, bytes, curvance_provider, curvance_read_provider, curvance_signer, Percentage, TokenInput } from "../types";
import { Calldata } from "./Calldata";
import { ERC20 } from "./ERC20";
import FormatConverter from "./FormatConverter";
import abi from "../abis/LendingOptimizer.json";
import type { AllocationBound, ReallocationAction } from "./OptimizerReader";
import type IDexAgg from "./DexAggregators/IDexAgg";
import { OptimizerZapper } from "./OptimizerZapper";
import { NativeToken } from "./NativeToken";

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
    rebalance(actions: ReallocationAction[], bounds: AllocationBound[]): Promise<TransactionResponse>;
}

export interface OptimizerRebalance {
    actions: ReallocationAction[];
    bounds: AllocationBound[];
}

export interface LendingOptimizerOptions {
    setup?: SetupConfigSnapshot;
    dexAgg?: IDexAgg;
    optimizerZapper?: address;
}

export type OptimizerZapInstructions = 'none' | {
    type: 'optimizer';
    inputToken: address;
    slippage: Percentage;
};

export interface OptimizerDepositToken {
    interface: ERC20 | NativeToken;
    type: 'none' | 'optimizer';
    quote?: (tokenIn: string, tokenOut: string, amount: TokenInput, slippage: Percentage) => Promise<{
        minOut_raw: bigint;
        output_raw: bigint;
        minOut: Decimal;
        output: Decimal;
        extra?: any;
    }>;
}

export interface OptimizerZapBuildResult {
    calldata: bytes;
    calldata_overrides: { [key: string]: any };
    zapper: OptimizerZapper | null;
    expectedShares?: bigint | undefined;
    inputAssets: bigint;
}

export class LendingOptimizer extends Calldata<ILendingOptimizer> {
    provider: curvance_read_provider;
    signer: curvance_signer | null;
    address: address;
    contract: Contract & ILendingOptimizer;
    asset: ERC20;
    setup: SetupConfigSnapshot | undefined;
    dexAgg: IDexAgg | undefined;
    optimizerZapperAddress: address | undefined;

    constructor(
        address: address,
        asset: ERC20,
        provider: curvance_provider | null = null,
        signerOrOptions?: curvance_signer | null | LendingOptimizerOptions,
        options?: LendingOptimizerOptions,
    ) {
        super();
        const signerOptions = LendingOptimizer.isOptions(signerOrOptions) ? signerOrOptions : options ?? {};
        const explicitSigner = LendingOptimizer.isOptions(signerOrOptions)
            ? null
            : signerOrOptions;
        const legacySigner = provider != null && "address" in provider
            ? provider as curvance_signer
            : null;
        const defaultReadProvider = resolveDefaultReadProvider();
        const defaultSetup = getSetupConfig();
        const assetProvider = (asset as ERC20 & { provider?: curvance_read_provider }).provider;
        const assetSigner = provider == null && assetProvider != null
            ? (asset as ERC20 & { signer?: curvance_signer | null }).signer ?? null
            : null;
        const resolvedProvider = provider == null
            ? assetProvider ?? defaultReadProvider
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
        const canInheritDefaultSigner = provider == null && (assetProvider == null || assetProvider === defaultReadProvider);
        this.signer = explicitSigner ?? legacySigner ?? assetSigner ?? (canInheritDefaultSigner ? resolveDefaultSigner() : null);
        this.address = address;
        this.asset = asset;
        this.setup = signerOptions.setup ?? (canInheritDefaultSigner ? defaultSetup : undefined);
        this.dexAgg = signerOptions.dexAgg;
        const setupZappers = this.setup?.contracts?.zappers as { optimizerZapper?: address } | undefined;
        this.optimizerZapperAddress = signerOptions.optimizerZapper ?? setupZappers?.optimizerZapper;
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
        receiver?: address | null,
    ): Promise<TransactionResponse>;
    async deposit(
        amount: TokenInput | Decimal,
        zap: OptimizerZapInstructions,
        receiver?: address | null,
    ): Promise<TransactionResponse>;
    async deposit(
        amount: TokenInput | Decimal,
        zapOrReceiver: OptimizerZapInstructions | address | null = null,
        receiver: address | null = null,
    ): Promise<TransactionResponse> {
        if (this.isOptimizerZapInstruction(zapOrReceiver)) {
            if (zapOrReceiver === 'none') {
                return this.directDeposit(amount, receiver);
            }
            return this.zapDeposit(amount, zapOrReceiver, receiver);
        }

        return this.directDeposit(amount, zapOrReceiver ?? receiver);
    }

    private async directDeposit(
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

    getOptimizerZapper(): OptimizerZapper {
        const signer = requireSigner(this.signer);
        const { setup, dexAgg, optimizerZapper } = this.requireOptimizerZapContext();
        return new OptimizerZapper(optimizerZapper, signer, setup, dexAgg);
    }

    async getZapDepositCalldata(
        amount: TokenInput | Decimal,
        zap: OptimizerZapInstructions,
        receiver: address | null = null,
    ): Promise<OptimizerZapBuildResult> {
        const signer = requireSigner(this.signer);
        receiver ??= signer.address as address;

        if (zap === 'none') {
            const decimals = this.asset.decimals ?? await this.asset.fetchDecimals();
            const assets = FormatConverter.decimalToBigInt(new Decimal(amount), decimals);
            if (assets === 0n) {
                throw new Error("LendingOptimizer.deposit: amount resolves to zero");
            }

            return {
                calldata: this.contract.interface.encodeFunctionData(
                    "deposit(uint256,address)",
                    [assets, receiver],
                ) as bytes,
                calldata_overrides: {},
                zapper: null,
                inputAssets: assets,
            };
        }

        const inputAssets = await this.getZapAssetAmount(amount, zap);
        if (inputAssets === 0n) {
            throw new Error("LendingOptimizer.deposit: amount resolves to zero");
        }

        const zapper = this.getOptimizerZapper();
        const slippage = FormatConverter.percentageToBps(zap.slippage);
        const calldata = await zapper.getDepositCalldata(
            this,
            zap.inputToken,
            inputAssets,
            slippage,
            receiver,
        );
        const calldata_overrides = zap.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
            ? { value: inputAssets }
            : {};

        return {
            calldata,
            calldata_overrides,
            zapper,
            expectedShares: this.getOptimizerZapExpectedShares(zapper, calldata),
            inputAssets,
        };
    }

    async approveZapAsset(instructions: OptimizerZapInstructions, amount: TokenInput | null) {
        const approvalTarget = await this.resolveZapApprovalTarget(instructions);
        if (approvalTarget == null) {
            return;
        }

        return approvalTarget.token.approve(approvalTarget.spender, amount);
    }

    async isZapAssetApproved(instructions: OptimizerZapInstructions, amount: bigint): Promise<boolean> {
        const approvalTarget = await this.resolveZapApprovalTarget(instructions);
        if (approvalTarget == null) {
            return true;
        }

        const owner = requireSigner(this.signer).address as address;
        const allowance = await approvalTarget.token.allowance(owner, approvalTarget.spender);
        return allowance >= amount;
    }

    async getDepositTokens(search: string | null = null): Promise<OptimizerDepositToken[]> {
        let tokens: OptimizerDepositToken[] = [{
            interface: this.asset,
            type: 'none',
        }];
        const tokensExclude = [this.asset.address.toLowerCase()];
        const setup = this.setup;
        const dexAgg = this.dexAgg;
        const canZap = this.optimizerZapperAddress != null
            && this.optimizerZapperAddress.toLowerCase() !== EMPTY_ADDRESS.toLowerCase()
            && typeof dexAgg?.router === "string"
            && dexAgg.router.toLowerCase() !== EMPTY_ADDRESS.toLowerCase()
            && setup != null;

        if (canZap) {
            const account = (this.signer?.address as address | undefined) ?? setup.account;
            const dexTokens = await dexAgg.getAvailableTokens(this.provider, search, account);
            const optimizerTokens = dexTokens
                .filter((token) => !tokensExclude.includes(token.interface.address.toLowerCase()))
                .map((token) => {
                    const optimizerToken: OptimizerDepositToken = {
                        interface: token.interface,
                        type: 'optimizer',
                    };
                    if (token.quote != undefined) {
                        optimizerToken.quote = token.quote;
                    }
                    return optimizerToken;
                });
            tokens = tokens.concat(optimizerTokens);

            if (!tokensExclude.includes(NATIVE_ADDRESS.toLowerCase())) {
                tokens.push({
                    interface: new NativeToken(
                        setup.chain,
                        this.provider,
                        setup.contracts.OracleManager as address,
                        this.signer,
                        account,
                        setup.assets,
                    ),
                    type: 'optimizer',
                });
            }
        }

        if (search) {
            const lowerSearch = search.toLowerCase();
            tokens = tokens.filter(token =>
                (token.interface.name ?? '').toLowerCase().includes(lowerSearch) ||
                (token.interface.symbol ?? '').toLowerCase().includes(lowerSearch)
            );
        }

        return tokens;
    }

    private async zapDeposit(
        amount: TokenInput | Decimal,
        zap: Exclude<OptimizerZapInstructions, 'none'>,
        receiver: address | null,
    ): Promise<TransactionResponse> {
        const inputAssets = await this.getZapAssetAmount(amount, zap);
        if (inputAssets === 0n) {
            throw new Error("LendingOptimizer.deposit: amount resolves to zero");
        }

        await this.checkZapAssetApproval(zap, inputAssets);
        const { calldata, calldata_overrides, zapper } = await this.getZapDepositCalldata(amount, zap, receiver);
        if (zapper == null) {
            throw new Error("Optimizer zapper is not configured");
        }

        return zapper.executeCallData(calldata, calldata_overrides);
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

    async rebalance(
        rebalance: OptimizerRebalance,
    ): Promise<TransactionResponse> {
        const calldata = this.contract.interface.encodeFunctionData(
            "rebalance",
            [rebalance.actions, rebalance.bounds],
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

    private static isOptions(value: unknown): value is LendingOptimizerOptions {
        return typeof value === "object"
            && value != null
            && !("address" in value);
    }

    private isOptimizerZapInstruction(value: unknown): value is OptimizerZapInstructions {
        return value === 'none'
            || (typeof value === "object" && value != null && (value as { type?: unknown }).type === 'optimizer');
    }

    private requireOptimizerZapContext(): {
        setup: SetupConfigSnapshot;
        dexAgg: IDexAgg;
        optimizerZapper: address;
    } {
        if (this.setup == null) {
            throw new Error(
                "LendingOptimizer optimizer zaps require a setup snapshot. " +
                "Pass { setup: setupResult.setupConfigSnapshot, dexAgg: setupResult.dexAgg } to the constructor.",
            );
        }
        if (this.dexAgg == null) {
            throw new Error(
                "LendingOptimizer optimizer zaps require a setup-bound DEX aggregator. " +
                "Pass the dexAgg returned by setupChain(...).",
            );
        }
        if (
            this.optimizerZapperAddress == null ||
            this.optimizerZapperAddress.toLowerCase() === EMPTY_ADDRESS.toLowerCase()
        ) {
            throw new Error(`OptimizerZapper is not configured for ${this.setup.chain}.`);
        }

        return {
            setup: this.setup,
            dexAgg: this.dexAgg,
            optimizerZapper: this.optimizerZapperAddress,
        };
    }

    private async getZapInputDecimals(instructions: OptimizerZapInstructions): Promise<bigint> {
        if (instructions === 'none') {
            return this.asset.decimals ?? await this.asset.fetchDecimals();
        }
        if (instructions.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
            return 18n;
        }
        if (instructions.inputToken.toLowerCase() === this.asset.address.toLowerCase()) {
            return this.asset.decimals ?? await this.asset.fetchDecimals();
        }

        const inputErc20 = new ERC20(
            this.provider,
            instructions.inputToken,
            undefined,
            this.setup?.contracts.OracleManager as address | undefined,
            this.signer,
        );
        return inputErc20.decimals ?? await inputErc20.fetchDecimals();
    }

    private async getZapAssetAmount(amount: TokenInput | Decimal, instructions: OptimizerZapInstructions): Promise<bigint> {
        return FormatConverter.decimalToBigInt(new Decimal(amount), await this.getZapInputDecimals(instructions));
    }

    private async resolveZapApprovalTarget(instructions: OptimizerZapInstructions): Promise<{
        token: ERC20;
        spender: address;
        spenderLabel: string;
    } | null> {
        if (instructions === 'none') {
            throw new Error("Optimizer zap instructions must be provided");
        }
        if (instructions.inputToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
            return null;
        }

        const { optimizerZapper } = this.requireOptimizerZapContext();
        return {
            token: new ERC20(
                this.provider,
                instructions.inputToken,
                undefined,
                this.setup?.contracts.OracleManager as address | undefined,
                this.signer,
            ),
            spender: optimizerZapper,
            spenderLabel: "OptimizerZapper",
        };
    }

    private async checkZapAssetApproval(instructions: OptimizerZapInstructions, amount: bigint) {
        const approvalTarget = await this.resolveZapApprovalTarget(instructions);
        if (approvalTarget == null) {
            return;
        }

        const owner = requireSigner(this.signer).address as address;
        const allowance = await approvalTarget.token.allowance(owner, approvalTarget.spender);
        if (allowance >= amount) {
            return;
        }

        let tokenLabel = approvalTarget.token.symbol ?? approvalTarget.token.address;
        if (approvalTarget.token.symbol == undefined) {
            try {
                tokenLabel = await approvalTarget.token.fetchSymbol();
            } catch {
                tokenLabel = approvalTarget.token.address;
            }
        }

        throw new Error(`Please approve the ${tokenLabel} token for ${approvalTarget.spenderLabel}`);
    }

    private getOptimizerZapExpectedShares(zapper: OptimizerZapper, calldata: bytes): bigint | undefined {
        try {
            const decoded = zapper.contract.interface.decodeFunctionData("swapAndDeposit", calldata);
            const expectedShares = decoded[3];
            return typeof expectedShares === "bigint" ? expectedShares : BigInt(expectedShares);
        } catch {
            return undefined;
        }
    }
}
