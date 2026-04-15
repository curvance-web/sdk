import { mainnet as monad_mainnet } from "./monad";
import { testnet as arb_testnet } from './arbitrum';
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
    native_vaults: { name: string; contract: address }[];
    vaults: { name: string; contract: address; underlying: address }[];
}

export const chain_config: Record<ChainRpcPrefix, ChainConfig> = {
    'monad-mainnet': monad_mainnet,
    'arb-sepolia': arb_testnet
}