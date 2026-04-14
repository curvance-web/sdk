import Decimal from "decimal.js";
import { ChainRpcPrefix, requireAccount, WAD } from "../helpers";
import { setup_config } from "../setup";
import { address, curvance_read_provider, curvance_signer, TokenInput, USD } from "../types";
import { OracleManager } from "./OracleManager";
import { chain_config } from "../chains";

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
        provider: curvance_read_provider,
        oracleManagerAddress: address | undefined = undefined,
        signer: curvance_signer | null = setup_config.signer,
        account: address | null = setup_config.account,
    ) {
        const config = chain_config[chain];
        this.symbol = config.native_symbol;
        this.name = config.native_name || config.native_symbol;
        this.provider = provider;
        this.signer = signer;
        this.account = account;
        this.oracleManagerAddress = oracleManagerAddress;
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
        const oracleManagerAddress =
            this.oracleManagerAddress ?? (setup_config.contracts.OracleManager as address);
        const oracle_manager = new OracleManager(oracleManagerAddress, this.provider);
        const price = await oracle_manager.getPrice(this.address, inUSD, getLower);
        return inTokenInput ? Decimal(price).div(WAD) : price;
    }
}
