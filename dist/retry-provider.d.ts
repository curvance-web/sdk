import { curvance_provider } from "./types";
export interface RetryConfig {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    backoffMultiplier: number;
    retryableErrors: string[];
    onRetry?: (attempt: number, error: Error, delay: number) => void;
}
export declare const DEFAULT_RETRY_CONFIG: RetryConfig;
declare class RetryableProvider {
    private config;
    constructor(config?: Partial<RetryConfig>);
    private sleep;
    private calculateDelay;
    private isRetryableError;
    private executeWithRetry;
    wrapProvider(provider: curvance_provider): curvance_provider;
    private isRpcMethod;
    updateConfig(newConfig: Partial<RetryConfig>): void;
    getConfig(): RetryConfig;
}
/**
 * Configure global retry settings for all RPC calls
 */
export declare function configureRetries(config?: Partial<RetryConfig>): void;
/**
 * Create a provider with retry capabilities
 */
export declare function createRetryableProvider(provider: curvance_provider, config?: Partial<RetryConfig>): curvance_provider;
/**
 * Wrap a provider with the global retry configuration
 */
export declare function wrapProviderWithRetries(provider: curvance_provider): curvance_provider;
/**
 * Utility function to check if a provider is already wrapped with retries
 */
export declare function isRetryableProvider(provider: curvance_provider): boolean;
/**
 * Utility function to classify error types for debugging
 */
export declare function classifyError(error: any): {
    type: 'contract' | 'network' | 'rpc' | 'rate_limit' | 'unknown';
    isRetryable: boolean;
    message: string;
};
export { RetryableProvider };
//# sourceMappingURL=retry-provider.d.ts.map