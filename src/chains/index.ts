import { mainnet as monad_mainnet } from "./monad";
import { testnet as arb_testnet } from './arbitrum';
import IDexAgg from "../classes/DexAggregators/IDexAgg";
import { JsonRpcProvider } from "ethers";
import { address } from "../types";
import { ChainRpcPrefix } from "../helpers";
import { ChainRpcConfig } from "./rpc";
import type { KyberSwapServiceConfig } from "./services";

export type ChainConfig = {
    chainId: number;
    environment: ChainEnvironment;
    services: ChainServiceConfig;
    dexAgg: IDexAgg;
    rpc: ChainRpcConfig;
    provider: JsonRpcProvider;
    fallbackProviders: JsonRpcProvider[];
} & ChainAssetConfig;

export type ChainAssetConfig = {
    native_symbol: string;
    native_name: string;
    wrapped_native: address;
    native_vaults: { name: string; contract: address }[];
    vaults: { name: string; contract: address; underlying: address }[];
    excluded_zap_symbols: string[];
};

export type ChainEnvironment = "production-mainnet" | "testnet" | "local";

export type ChainServiceConfig = {
    curvanceApi: {
        rewardsSlug: string;
        rewardChainAliases: string[];
        nativeYieldSlug: string | null;
        suppressedNativeYieldSymbols: string[];
    };
    dexAggregators: {
        kyberSwap: KyberSwapServiceConfig | null;
    };
};

export const chain_config: Record<ChainRpcPrefix, ChainConfig> = {
    'monad-mainnet': monad_mainnet,
    'arb-sepolia': arb_testnet
}

export * from "./rpc";
export type { KyberSwapServiceConfig } from "./services";
