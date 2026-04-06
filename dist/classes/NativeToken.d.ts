import { ChainRpcPrefix } from "../helpers";
import { address, curvance_provider, TokenInput, USD } from "../types";
export declare class NativeToken {
    name: string;
    symbol: string;
    provider: curvance_provider;
    address: address;
    decimals: bigint;
    constructor(chain: ChainRpcPrefix, provider: curvance_provider);
    balanceOf(account: address | null, in_token_input: true): Promise<TokenInput>;
    balanceOf(account: address | null, in_token_input: false): Promise<bigint>;
    getPrice(inTokenInput: true, inUSD: true, getLower: false): Promise<USD>;
    getPrice(inTokenInput: false, inUSD: true, getLower: false): Promise<bigint>;
}
//# sourceMappingURL=NativeToken.d.ts.map