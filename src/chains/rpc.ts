import { JsonRpcProvider } from "ethers";
import { chains } from "../contracts";

export interface ChainRpcPolicy {
    retryCount: number;
    retryDelayMs: number;
    timeoutMs: number;
    fallbackCooldownMs: number;
    rankIntervalMs: number;
    rankSampleCount: number;
    rankTimeoutMs: number;
    rankWeights: {
        latency: number;
        stability: number;
    };
}

export interface ChainRpcConfig extends ChainRpcPolicy {
    primary: string;
    fallbacks: string[];
}

// Latency budget: primary + 1 fallback must resolve within ~17s worst case so
// users don't assume the site is broken. The fallback IS the real second try
// — retrying 3× on a dying primary before failover is double-insurance. One
// retry per provider (2 attempts each) with a 4s per-attempt timeout gives:
// primary ~8.2s + fallback ~8.2s ≈ 16.5s ceiling. Healthy RPCs respond in
// <1s so happy path is unchanged.
// See tests/retry-fallback.test.ts — "DEFAULT_RETRY_CONFIG keeps single-
// provider worst-case under 10 seconds" and "read with hanging primary..."
// lock this budget in.
export const DEFAULT_CHAIN_RPC_POLICY: ChainRpcPolicy = {
    retryCount: 1,
    retryDelayMs: 150,
    timeoutMs: 4_000,
    fallbackCooldownMs: 30_000,
    rankIntervalMs: 30_000,
    rankSampleCount: 5,
    rankTimeoutMs: 1_000,
    rankWeights: {
        latency: 0.3,
        stability: 0.7,
    },
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

export function createChainFallbackProviders(chain: SupportedRpcChain): JsonRpcProvider[] {
    return getChainRpcConfig(chain).fallbacks.map((url) => new JsonRpcProvider(url));
}
