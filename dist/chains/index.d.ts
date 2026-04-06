import IDexAgg from "../classes/DexAggregators/IDexAgg";
import { JsonRpcProvider } from "ethers";
import { address } from "../types";
import { ChainRpcPrefix } from "../helpers";
export type ChainConfig = {
    chainId: number;
    dexAgg: IDexAgg;
    provider: JsonRpcProvider;
    native_symbol: string;
    native_name: string;
    wrapped_native: address;
    native_vaults: {
        name: string;
        contract: address;
    }[];
    vaults: {
        name: string;
        contract: address;
        underlying: address;
    }[];
};
export declare const chain_config: Record<ChainRpcPrefix, ChainConfig>;
//# sourceMappingURL=index.d.ts.map