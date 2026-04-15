import Decimal from "decimal.js";
import { ChainRpcPrefix, validateProviderAsSigner, WAD } from "../helpers";
import { setup_config } from "../setup";
import { address, curvance_provider, TokenInput, USD } from "../types";
import { OracleManager } from "./OracleManager";
import { chain_config } from "../chains";

export class NativeToken {
    name   : string;
    symbol  : string;
    provider: curvance_provider;
    address  = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as address;
    decimals = 18n;

    constructor(chain: ChainRpcPrefix, provider: curvance_provider) {
        const config = chain_config[chain];
        this.symbol = config.native_symbol;
        this.name = config.native_name || config.native_symbol;
        this.provider = provider;
    }

    
    async balanceOf(account: address | null, in_token_input: true): Promise<TokenInput>;
    async balanceOf(account: address | null, in_token_input: false): Promise<bigint>;
    async balanceOf(account: address | null = null, in_token_input = false): Promise<bigint | TokenInput> {
        if(account == null) {
            const signer = validateProviderAsSigner(this.provider);
            account = signer.address as address;
        }

        let balance = 0n;
        if ('provider' in this.provider && this.provider.provider) {
            balance = await this.provider.provider.getBalance(account);
        } else if ('getBalance' in this.provider) {
            balance = await this.provider.getBalance(account);
        } else {
            throw new Error("Provider does not support balance queries");
        }

        return in_token_input ? Decimal(balance).div(WAD) : balance;
    }

    async getPrice(inTokenInput: true, inUSD: true, getLower: false): Promise<USD>
    async getPrice(inTokenInput: false, inUSD: true, getLower: false): Promise<bigint>
    async getPrice(inTokenInput: boolean, inUSD = true, getLower = false): Promise<USD | bigint> {
        const oracle_manager = new OracleManager(setup_config.contracts.OracleManager as address, this.provider);
        const price = await oracle_manager.getPrice(this.address, inUSD, getLower);
        return inTokenInput ? Decimal(price).div(WAD) : price;
    }
}