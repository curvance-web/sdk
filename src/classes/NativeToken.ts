import Decimal from "decimal.js";
import { ChainRpcPrefix, requireAccount, resolveReadProvider, WAD } from "../helpers";
import { address, curvance_provider, curvance_read_provider, curvance_signer, TokenInput, USD } from "../types";
import { OracleManager } from "./OracleManager";
import { chain_config } from "../chains";

function getSetupConfig() {
    return (require("../setup") as typeof import("../setup")).setup_config;
}

function resolveDefaultOracleManagerAddress(): address | undefined {
    return (getSetupConfig() as any)?.contracts?.OracleManager as address | undefined;
}

function resolveDefaultSigner(): curvance_signer | null {
    return (getSetupConfig() as any)?.signer ?? null;
}

function resolveDefaultAccount(): address | null {
    return (getSetupConfig() as any)?.account ?? null;
}

function resolveDefaultReadProvider(): curvance_read_provider | undefined {
    return (getSetupConfig() as any)?.readProvider as curvance_read_provider | undefined;
}

export class NativeToken {
    name   : string;
    symbol  : string;
    provider: curvance_read_provider;
    signer: curvance_signer | null;
    account: address | null;
    private oracleManagerAddress: address | undefined;
    address  = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as address;
    decimals = 18n;

    constructor(
        chain: ChainRpcPrefix,
        provider: curvance_provider,
        oracleManagerAddress?: address,
        signer?: curvance_signer | null,
        account?: address | null,
    ) {
        const config = chain_config[chain];
        const legacySigner = "address" in provider ? provider as curvance_signer : null;
        const legacyAccount = legacySigner?.address as address | undefined;
        const resolvedProvider =
            legacySigner == null
                ? provider as curvance_read_provider
                : resolveReadProvider(provider, `NativeToken ${chain}`);

        this.symbol = config.native_symbol;
        this.name = config.native_name || config.native_symbol;
        this.provider = resolvedProvider;
        this.signer = signer ?? legacySigner ?? resolveDefaultSigner();
        this.account = account ?? legacyAccount ?? resolveDefaultAccount();
        this.oracleManagerAddress = oracleManagerAddress ?? resolveDefaultOracleManagerAddress();
    }

    
    async balanceOf(account: address | null, in_token_input: true): Promise<TokenInput>;
    async balanceOf(account: address | null, in_token_input: false): Promise<bigint>;
    async balanceOf(account: address | null = null, in_token_input = false): Promise<bigint | TokenInput> {
        const resolvedAccount = requireAccount(account ?? this.account, this.signer);
        const balance = await this.provider.getBalance(resolvedAccount);

        return in_token_input ? Decimal(balance).div(WAD) : balance;
    }

    async getPrice(inTokenInput: true, inUSD: true, getLower: false): Promise<USD>
    async getPrice(inTokenInput: false, inUSD: true, getLower: false): Promise<bigint>
    async getPrice(inTokenInput: boolean, inUSD = true, getLower = false): Promise<USD | bigint> {
        const oracleManagerAddress = this.oracleManagerAddress;
        if (oracleManagerAddress == undefined) {
            throw new Error(
                `OracleManager address is not configured for native token ${this.symbol}. ` +
                `Pass oracleManagerAddress explicitly or initialize setupChain() before constructing this token.`
            );
        }

        const oracle_manager = new OracleManager(oracleManagerAddress, this.provider);
        const price = await oracle_manager.getPrice(this.address, inUSD, getLower);
        return inTokenInput ? Decimal(price).div(WAD) : price;
    }
}
