import { JsonRpcProvider } from "ethers";
import { chains } from "../contracts";

export interface ChainRpcPolicy {
    retryCount: number;
    retryDelayMs: number;
    timeoutMs: number;
    fallbackCooldownMs: number;
}

export interface ChainRpcConfig extends ChainRpcPolicy {
    primary: string;
    fallbacks: string[];
}

export const DEFAULT_CHAIN_RPC_POLICY: ChainRpcPolicy = {
    retryCount: 3,
    retryDelayMs: 150,
    timeoutMs: 10_000,
    fallbackCooldownMs: 30_000,
};

export const chain_rpc_config = {
    "monad-mainnet": {
        ...DEFAULT_CHAIN_RPC_POLICY,
        primary: "https://rpc-mainnet.monadinfra.com/",
        fallbacks: ["https://monad-mainnet.drpc.org"],
    },
    "arb-sepolia": {
        ...DEFAULT_CHAIN_RPC_POLICY,
        primary: "https://arbitrum-sepolia.drpc.org",
        fallbacks: [],
    },
} satisfies Record<keyof typeof chains, ChainRpcConfig>;

export type SupportedRpcChain = keyof typeof chain_rpc_config;

export function getChainRpcConfig(chain: SupportedRpcChain): ChainRpcConfig {
    return chain_rpc_config[chain];
}

export function createChainPrimaryProvider(chain: SupportedRpcChain): JsonRpcProvider {
    return new JsonRpcProvider(getChainRpcConfig(chain).primary);
}

export function createChainFallbackProvider(chain: SupportedRpcChain): JsonRpcProvider | null {
    const fallback = getChainRpcConfig(chain).fallbacks[0];
    return fallback ? new JsonRpcProvider(fallback) : null;
}
