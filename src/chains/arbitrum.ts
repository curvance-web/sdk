import { address } from "../types";
import { KyberSwap } from "../classes/DexAggregators/KyberSwap";
import { ChainConfig } from ".";
import { createChainFallbackProvider, createChainPrimaryProvider, getChainRpcConfig } from "./rpc";

export const testnet: ChainConfig = {
    chainId: 421614,
    dexAgg: new KyberSwap(),
    rpc: getChainRpcConfig("arb-sepolia"),
    provider: createChainPrimaryProvider("arb-sepolia"),
    fallbackProvider: createChainFallbackProvider("arb-sepolia"),
    native_symbol: 'ETH',
    native_name: 'Ether',
    wrapped_native: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as address,
    native_vaults: [],
    vaults: []
}
