import { TransactionResponse } from "ethers";
import { contractSetup, toBigInt, toDecimal, UINT256_MAX, validateProviderAsSigner, WAD } from "../helpers";
import { Contract } from "ethers";
import { StaticMarketAsset } from "./ProtocolReader";
import { address, curvance_provider, TokenInput, USD } from "../types";
import { setup_config } from "../setup";
import { OracleManager } from "./OracleManager";
import Decimal from "decimal.js";
import FormatConverter from "./FormatConverter";

export interface IERC20 {
    balanceOf(account: address): Promise<bigint>;
    transfer(to: address, amount: bigint): Promise<TransactionResponse>;
    approve(spender: address, amount: bigint): Promise<TransactionResponse>;
    name(): Promise<string>;
    symbol(): Promise<string>;
    decimals(): Promise<bigint>;
    totalSupply(): Promise<bigint>;
    allowance(owner: address, spender: address): Promise<bigint>;
}

export class ERC20 {
    provider: curvance_provider;
    address: address;
    contract: Contract & IERC20;
    cache: StaticMarketAsset | undefined = undefined;

    constructor(
        provider: curvance_provider,
        address: address,
        cache: StaticMarketAsset | undefined = undefined
    ) {
        this.provider = provider;
        this.address = address;
        this.cache = cache;
        this.contract = contractSetup<IERC20>(provider, address, [
            "function balanceOf(address owner) view returns (uint256)",
            "function transfer(address to, uint256 amount) returns (bool)",
            "function approve(address spender, uint256 amount) returns (bool)",
            "function name() view returns (string)",
            "function symbol() view returns (string)",
            "function decimals() view returns (uint8)",
            "function allowance(address owner, address spender) view returns (uint256)",
        ]);
    }

    get name() { return this.cache?.name; }
    get symbol() { return this.cache?.symbol; }
    get decimals() { return this.cache?.decimals; }
    get totalSupply() { return this.cache?.totalSupply; }
    get image() { return this.cache?.image; }
    get balance() { return this.cache?.balance ? toDecimal(this.cache.balance, this.cache.decimals) : undefined; }
    get price() { return this.cache?.price; }

    async balanceOf(account: address): Promise<bigint>
    async balanceOf(account: address, in_token_input: true): Promise<TokenInput>
    async balanceOf(account: address, in_token_input: false): Promise<bigint>
    async balanceOf(account: address, in_token_input: boolean = false): Promise<bigint | TokenInput> {
        const amount = await this.contract.balanceOf(account);

        const decimals = this.decimals ?? await this.fetchDecimals();
        return in_token_input ? FormatConverter.bigIntToDecimal(amount, decimals) : amount;
    }

    async transfer(to: address, amount: TokenInput) {
        const decimals = this.decimals ?? await this.fetchDecimals();
        const tokens = toBigInt(amount, decimals);
        return this.contract.transfer(to, tokens);
    }

    async rawTransfer(to: address, amount: bigint) {
        return this.contract.transfer(to, amount);
    }

    async approve(spender: address, amount: TokenInput | null) {
        const decimals = this.decimals ?? await this.fetchDecimals();
        const tokens = amount == null ? UINT256_MAX : toBigInt(amount, decimals);
        return this.contract.approve(spender, tokens);
    }

    async fetchName() {
        const name = await this.contract.name();
        this.setCache('name', name);
        return name;
    }

    async fetchSymbol() {
        const symbol = await this.contract.symbol();
        this.setCache('symbol', symbol);
        return symbol;
    }

    async fetchDecimals() {
        const decimals = await this.contract.decimals();
        this.setCache('decimals', decimals);
        return decimals;
    }

    async fetchTotalSupply() {
        const totalSupply = await this.contract.totalSupply();
        this.setCache('totalSupply', totalSupply);
        return totalSupply;
    }

    async allowance(owner: address, spender: address) {
        return this.contract.allowance(owner, spender);
    }

    async getPrice(inTokenInput: true, inUSD: boolean, getLower: boolean): Promise<USD>
    async getPrice(inTokenInput: false, inUSD: boolean, getLower: boolean): Promise<bigint>
    async getPrice(inTokenInput: boolean, inUSD = true, getLower = false): Promise<USD | bigint> {
        const oracle_manager = new OracleManager(setup_config.contracts.OracleManager as address, this.provider);
        const price = await oracle_manager.getPrice(this.address, inUSD, getLower);

        return inTokenInput ? Decimal(price).div(WAD) : price;
    }

    private setCache<K extends keyof StaticMarketAsset>(key: K, value: StaticMarketAsset[K]) {
        if (!this.cache) {
            this.cache = {} as StaticMarketAsset;
        }
        this.cache[key] = value;
    }
}