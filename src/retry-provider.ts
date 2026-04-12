import { JsonRpcProvider, JsonRpcSigner, Wallet } from "ethers";
import { curvance_provider } from "./types";

export interface RetryConfig {
    maxRetries: number;
    baseDelay: number; // Base delay in milliseconds
    maxDelay: number; // Maximum delay in milliseconds
    backoffMultiplier: number;
    retryableErrors: string[]; // Error messages/codes that should trigger retries
    onRetry?: (attempt: number, error: Error, delay: number) => void;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 10000, // 10 seconds
    backoffMultiplier: 2,
    retryableErrors: [
        // Rate limiting
        'rate limit',
        'too many requests',
        '429', // Rate limit HTTP status
        
        // Network connectivity issues
        'timeout',
        'network error',
        'connection',
        'ECONNRESET',
        'ENOTFOUND',
        'ETIMEDOUT',
        'socket hang up',
        'request timeout',
        'network timeout',
        'connect timeout',
        
        // Server/infrastructure errors
        'server error',
        'internal server error',
        'bad gateway',
        'service unavailable',
        'gateway timeout',
        'proxy error',
        'upstream error',
        '500', // Internal server error
        '502', // Bad gateway
        '503', // Service unavailable
        '504', // Gateway timeout
        
        // RPC-specific errors
        'rpc error',
        'node error',
        'provider error',
        'endpoint error',
        
        // Temporary blockchain node issues
        'header not found', // Sometimes temporary
        'missing trie node',
        
        // Generic temporary failures
        'temporary failure',
        'temporarily unavailable',
        'try again'
    ]
};

class RetryableProvider {
    private config: RetryConfig;

    constructor(config: Partial<RetryConfig> = {}) {
        this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private calculateDelay(attempt: number): number {
        const base = this.config.baseDelay * Math.pow(this.config.backoffMultiplier, attempt);
        const capped = Math.min(base, this.config.maxDelay);
        // Add jitter to prevent thundering herd when multiple clients retry simultaneously
        return capped * (0.5 + Math.random() * 0.5);
    }

    private isRetryableError(error: any): boolean {
        // First check for non-retryable smart contract errors
        const errorMessage = error?.message?.toLowerCase() || '';
        const errorCode = error?.code?.toString() || '';
        
        // These are contract execution errors that should NOT be retried
        const nonRetryablePatterns = [
            'revert',
            'execution reverted',
            'transaction reverted',
            'insufficient funds',
            'gas required exceeds allowance',
            'nonce too high',
            'nonce too low',
            'replacement transaction underpriced',
            'already pending',
            'invalid opcode',
            'stack overflow',
            'stack underflow',
            'out of gas',
            'call_exception',
            'unpredictable_gas_limit',
            'invalid_argument',
            'missing_argument',
            'unexpected_argument',
            'numeric_fault',
            'user rejected',
            'user denied',
            'user cancelled',
            'action_rejected',
            '4001'
        ];
        
        // If it's a contract execution error, don't retry
        const isContractError = nonRetryablePatterns.some(pattern => 
            errorMessage.includes(pattern) || errorCode.includes(pattern)
        );
        
        if (isContractError) {
            return false;
        }
        
        // Now check for retryable network/RPC errors
        const errorStatus = error?.response?.status?.toString() || '';
        
        return this.config.retryableErrors.some(retryableError => 
            errorMessage.includes(retryableError.toLowerCase()) ||
            errorCode.includes(retryableError) ||
            errorStatus.includes(retryableError)
        );
    }

    private async executeWithRetry<T>(
        operation: () => Promise<T>,
        context: string = 'RPC call'
    ): Promise<T> {
        let lastError: Error;
        
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error: any) {
                lastError = error;
                
                const isRetryable = this.isRetryableError(error);
                
                // Don't retry on the last attempt or if error is not retryable
                if (attempt === this.config.maxRetries || !isRetryable) {
                    if (!isRetryable && attempt === 0) {
                        // Log that this error is not retryable for debugging
                        console.debug(`${context} failed with non-retryable error: ${error.message}`);
                    }
                    throw error;
                }
                
                const delay = this.calculateDelay(attempt);
                
                // Call retry callback if provided
                if (this.config.onRetry) {
                    this.config.onRetry(attempt + 1, error, delay);
                }
                
                console.debug(`${context} failed (attempt ${attempt + 1}/${this.config.maxRetries + 1}): ${error.message}. Retrying in ${delay}ms...`);
                
                await this.sleep(delay);
            }
        }
        
        throw lastError!;
    }

    wrapProvider(provider: curvance_provider): curvance_provider {
        // If it's already wrapped, return as-is
        if ((provider as any)._isRetryable) {
            return provider;
        }

        const retryableProvider = new Proxy(provider, {
            get: (target, prop, receiver) => {
                const original = Reflect.get(target, prop, receiver);
                
                // Mark as retryable
                if (prop === '_isRetryable') {
                    return true;
                }
                
                // Wrap the main RPC send method
                if (prop === 'send' && typeof original === 'function') {
                    return async (method: string, params: any[]) => {
                        return this.executeWithRetry(
                            () => original.apply(target, [method, params]),
                            `RPC ${method}`
                        );
                    };
                }

                // For JsonRpcProvider, also wrap _send if it exists
                if (prop === '_send' && typeof original === 'function') {
                    return async (payload: any, callback?: any) => {
                        return this.executeWithRetry(
                            () => original.apply(target, [payload, callback]),
                            `RPC ${payload.method || 'unknown'}`
                        );
                    };
                }

                // Wrap other async methods that might make RPC calls
                if (typeof original === 'function' && this.isRpcMethod(prop)) {
                    return async (...args: any[]) => {
                        return this.executeWithRetry(
                            () => original.apply(target, args),
                            `Provider method ${String(prop)}`
                        );
                    };
                }

                // If it's a function, bind it to the target
                if (typeof original === 'function') {
                    return original.bind(target);
                }
                
                return original;
            }
        }) as curvance_provider;

        return retryableProvider;
    }

    private isRpcMethod(prop: string | symbol): boolean {
        if (typeof prop !== 'string') return false;
        
        // Common ethers.js methods that make RPC calls
        const rpcMethods = [
            'getBalance',
            'getCode',
            'getStorageAt',
            'getTransactionCount',
            'getBlock',
            'getBlockNumber',
            'getGasPrice',
            'getFeeData',
            'getTransaction',
            'getTransactionReceipt',
            'call',
            'estimateGas',
            'sendTransaction',
            'waitForTransaction',
            'getLogs',
            'getNetwork',
            'detectNetwork'
        ];
        
        return rpcMethods.includes(prop);
    }

    updateConfig(newConfig: Partial<RetryConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    getConfig(): RetryConfig {
        return { ...this.config };
    }
}

// Global retry provider instance
let globalRetryProvider: RetryableProvider | null = null;

/**
 * Configure global retry settings for all RPC calls
 */
export function configureRetries(config: Partial<RetryConfig> = {}): void {
    if (!globalRetryProvider) {
        globalRetryProvider = new RetryableProvider(config);
    } else {
        globalRetryProvider.updateConfig(config);
    }
}

/**
 * Create a provider with retry capabilities
 */
export function createRetryableProvider(
    provider: curvance_provider, 
    config: Partial<RetryConfig> = {}
): curvance_provider {
    const retryProvider = new RetryableProvider(config);
    return retryProvider.wrapProvider(provider);
}

/**
 * Get the global retry provider, creating one with defaults if it doesn't exist
 */
function getGlobalRetryProvider(): RetryableProvider {
    if (!globalRetryProvider) {
        globalRetryProvider = new RetryableProvider();
    }
    return globalRetryProvider;
}

/**
 * Wrap a provider with the global retry configuration
 */
export function wrapProviderWithRetries(provider: curvance_provider): curvance_provider {
    const retryProvider = getGlobalRetryProvider();
    return retryProvider.wrapProvider(provider);
}

/**
 * Utility function to check if a provider is already wrapped with retries
 */
export function isRetryableProvider(provider: curvance_provider): boolean {
    return (provider as any)._isRetryable === true;
}

/**
 * Utility function to classify error types for debugging
 */
export function classifyError(error: any): {
    type: 'contract' | 'network' | 'rpc' | 'rate_limit' | 'unknown';
    isRetryable: boolean;
    message: string;
} {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorCode = error?.code?.toString() || '';
    const errorStatus = error?.response?.status?.toString() || '';
    
    // Contract execution errors
    const contractPatterns = [
        'revert', 'execution reverted', 'transaction reverted',
        'insufficient funds', 'gas required exceeds allowance',
        'nonce too high', 'nonce too low', 'out of gas',
        'call_exception', 'unpredictable_gas_limit'
    ];
    
    if (contractPatterns.some(pattern => errorMessage.includes(pattern) || errorCode.includes(pattern))) {
        return { type: 'contract', isRetryable: false, message: error.message };
    }

    // User rejection
    const userRejectionPatterns = [
        'user rejected', 'user denied', 'user cancelled', 'action_rejected', '4001'
    ];

    if (userRejectionPatterns.some(pattern => errorMessage.includes(pattern) || errorCode.includes(pattern))) {
        return { type: 'contract', isRetryable: false, message: error.message };
    }

    // Rate limiting
    if (errorMessage.includes('rate limit') || errorMessage.includes('too many requests') || errorStatus === '429') {
        return { type: 'rate_limit', isRetryable: true, message: error.message };
    }
    
    // Network errors
    const networkPatterns = [
        'timeout', 'network error', 'connection', 'ECONNRESET', 
        'ENOTFOUND', 'ETIMEDOUT', 'socket hang up'
    ];
    
    if (networkPatterns.some(pattern => errorMessage.includes(pattern) || errorCode.includes(pattern))) {
        return { type: 'network', isRetryable: true, message: error.message };
    }
    
    // RPC errors
    const rpcPatterns = ['rpc error', 'node error', 'provider error'];
    
    if (rpcPatterns.some(pattern => errorMessage.includes(pattern))) {
        return { type: 'rpc', isRetryable: true, message: error.message };
    }
    
    return { type: 'unknown', isRetryable: false, message: error.message };
}

// Export the RetryableProvider class for advanced usage
export { RetryableProvider };