import { TransactionResponse } from "ethers";
import { Contract } from "ethers";
import { StaticMarketAsset } from "./ProtocolReader";
import { address, curvance_provider, TokenInput, USD } from "../types";
import Decimal from "decimal.js";
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
export declare class ERC20 {
    provider: curvance_provider;
    address: address;
    contract: Contract & IERC20;
    cache: StaticMarketAsset | undefined;
    constructor(provider: curvance_provider, address: address, cache?: StaticMarketAsset | undefined);
    get name(): string | undefined;
    get symbol(): string | undefined;
    get decimals(): bigint | undefined;
    get totalSupply(): bigint | undefined;
    get image(): string | undefined;
    get balance(): Decimal | undefined;
    get price(): Decimal | undefined;
    balanceOf(account: address): Promise<bigint>;
    balanceOf(account: address, in_token_input: true): Promise<TokenInput>;
    balanceOf(account: address, in_token_input: false): Promise<bigint>;
    transfer(to: address, amount: TokenInput): Promise<TransactionResponse>;
    rawTransfer(to: address, amount: bigint): Promise<TransactionResponse>;
    approve(spender: address, amount: TokenInput | null): Promise<TransactionResponse>;
    fetchName(): Promise<string>;
    fetchSymbol(): Promise<string>;
    fetchDecimals(): Promise<bigint>;
    fetchTotalSupply(): Promise<bigint>;
    allowance(owner: address, spender: address): Promise<bigint>;
    getPrice(inTokenInput: true, inUSD: boolean, getLower: boolean): Promise<USD>;
    getPrice(inTokenInput: false, inUSD: boolean, getLower: boolean): Promise<bigint>;
    private setCache;
}
//# sourceMappingURL=ERC20.d.ts.map