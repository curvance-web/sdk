import { address } from "../types";
import { UnsupportedDexAgg } from "../classes/DexAggregators/UnsupportedDexAgg";
import { ChainConfig } from ".";
import { createChainFallbackProviders, createChainPrimaryProvider, getChainRpcConfig } from "./rpc";

export const testnet: ChainConfig = {
    chainId: 421614,
    dexAgg: new UnsupportedDexAgg("arb-sepolia"),
    rpc: getChainRpcConfig("arb-sepolia"),
    provider: createChainPrimaryProvider("arb-sepolia"),
    fallbackProviders: createChainFallbackProviders("arb-sepolia"),
    native_symbol: 'ETH',
    native_name: 'Ether',
    wrapped_native: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73' as address,
    native_vaults: [],
    vaults: []
}
