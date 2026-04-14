import { JsonRpcProvider } from "ethers";
import { curvance_provider, curvance_read_provider } from "./types";
import { DEFAULT_CHAIN_RPC_POLICY } from "./chains/rpc";

/** Named ethers provider methods that make RPC calls on the read transport. */
const RPC_PROVIDER_METHODS = new Set([
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
    'getLogs',
    'getNetwork',
    'detectNetwork',
    'call',
    'estimateGas',
]);

export interface RetryConfig {
    maxRetries: number;
    baseDelay: number; // Base delay in milliseconds
    maxDelay: number; // Maximum delay in milliseconds
    backoffMultiplier: number;
    timeoutMs: number; // Per-attempt timeout for read operations
    fallbackCooldownMs: number; // How long to prefer the fallback after primary read failures
    retryableErrors: string[]; // Error messages/codes that should trigger retries
    onRetry?: (attempt: number, error: Error, delay: number) => void;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: DEFAULT_CHAIN_RPC_POLICY.retryCount,
    baseDelay: DEFAULT_CHAIN_RPC_POLICY.retryDelayMs,
    maxDelay: 1000,
    backoffMultiplier: 2,
    timeoutMs: DEFAULT_CHAIN_RPC_POLICY.timeoutMs,
    fallbackCooldownMs: DEFAULT_CHAIN_RPC_POLICY.fallbackCooldownMs,
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

interface FallbackProviderState {
    provider: JsonRpcProvider;
    index: number;
    cooldownUntil: number;
    lastFailureAt: number;
    lastSuccessAt: number;
}

class RetryableProvider {
    private config: RetryConfig;
    private fallbackProviders: JsonRpcProvider[];
    private fallbackProviderStates: FallbackProviderState[];
    private _fallbackActivated = false;
    private primaryReadCooldownUntil = 0;

    constructor(
        config: Partial<RetryConfig> = {},
        fallbackProviders: JsonRpcProvider | JsonRpcProvider[] | null = null,
    ) {
        this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
        this.fallbackProviders = Array.isArray(fallbackProviders)
            ? fallbackProviders
            : fallbackProviders
                ? [fallbackProviders]
                : [];
        this.fallbackProviderStates = this.fallbackProviders.map((provider, index) => ({
            provider,
            index,
            cooldownUntil: 0,
            lastFailureAt: 0,
            lastSuccessAt: 0,
        }));
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

    private isReadFallbackActive(): boolean {
        if (this.primaryReadCooldownUntil === 0) {
            return false;
        }

        if (Date.now() >= this.primaryReadCooldownUntil) {
            this.primaryReadCooldownUntil = 0;
            this._fallbackActivated = false;
            return false;
        }

        return true;
    }

    private getFallbackProviderLabel(state: FallbackProviderState): string {
        return `fallback-${state.index + 1}`;
    }

    private isProviderCoolingDown(cooldownUntil: number): boolean {
        return cooldownUntil > Date.now();
    }

    private compareFallbackProviders(a: FallbackProviderState, b: FallbackProviderState): number {
        const aCooling = this.isProviderCoolingDown(a.cooldownUntil);
        const bCooling = this.isProviderCoolingDown(b.cooldownUntil);

        if (aCooling !== bCooling) {
            return aCooling ? 1 : -1;
        }

        if (aCooling && bCooling) {
            return a.cooldownUntil - b.cooldownUntil || a.index - b.index;
        }

        if (a.lastSuccessAt !== b.lastSuccessAt) {
            return b.lastSuccessAt - a.lastSuccessAt;
        }

        if (a.lastFailureAt !== b.lastFailureAt) {
            return a.lastFailureAt - b.lastFailureAt;
        }

        return a.index - b.index;
    }

    private getOrderedFallbackProviders(): FallbackProviderState[] {
        return [...this.fallbackProviderStates].sort((a, b) => this.compareFallbackProviders(a, b));
    }

    private markFallbackFailure(state: FallbackProviderState): void {
        state.lastFailureAt = Date.now();
        state.cooldownUntil = state.lastFailureAt + this.config.fallbackCooldownMs;
    }

    private markFallbackSuccess(state: FallbackProviderState): void {
        state.lastSuccessAt = Date.now();
        state.lastFailureAt = 0;
        state.cooldownUntil = 0;
    }

    private getOrderedFallbackOps<T>(
        fallbackOps: Array<{ state: FallbackProviderState; operation: () => Promise<T> }>,
    ): Array<{ state: FallbackProviderState; operation: () => Promise<T> }> {
        const fallbackOpMap = new Map(
            fallbackOps.map((entry) => [entry.state, entry.operation] as const),
        );

        return this.getOrderedFallbackProviders()
            .map((state) => {
                const operation = fallbackOpMap.get(state);
                if (!operation) {
                    return null;
                }

                return { state, operation };
            })
            .filter((entry): entry is { state: FallbackProviderState; operation: () => Promise<T> } => entry != null);
    }

    private async executeWithTimeout<T>(
        operation: () => Promise<T>,
        timeoutMs: number,
        context: string,
    ): Promise<T> {
        if (timeoutMs <= 0) {
            return operation();
        }

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        try {
            return await Promise.race([
                operation(),
                new Promise<T>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        const error: any = new Error(`[rpc] ${context}: timeout after ${timeoutMs}ms`);
                        error.code = "timeout";
                        reject(error);
                    }, timeoutMs);
                }),
            ]);
        } finally {
            if (timeoutHandle != null) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private withReadTimeout<T>(operation: () => Promise<T>, context: string): () => Promise<T> {
        return () => this.executeWithTimeout(operation, this.config.timeoutMs, context);
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
                        console.debug(`[rpc] ${context}: non-retryable`, error.message);
                    }
                    throw error;
                }
                
                const delay = this.calculateDelay(attempt);
                
                // Call retry callback if provided
                if (this.config.onRetry) {
                    this.config.onRetry(attempt + 1, error, delay);
                }
                
                console.debug(`[rpc] ${context}: attempt ${attempt + 1}/${this.config.maxRetries + 1} failed, retry in ${delay}ms`, error.message);
                
                await this.sleep(delay);
            }
        }
        
        throw lastError!;
    }

    /**
     * Execute a read operation against the primary provider, falling back to
     * the dedicated RPC providers if the primary exhausts all retries.
     *
     * Write operations (signing, sending transactions) never use the fallback
     * because the fallback providers cannot sign.
     */
    private async executeFallbackChain<T>(
        fallbackOps: Array<{ state: FallbackProviderState; operation: () => Promise<T> }>,
        context: string,
        originalError?: Error,
    ): Promise<T> {
        let lastError = originalError;

        for (const { state, operation } of fallbackOps) {
            const fallbackContext = `${context} [${this.getFallbackProviderLabel(state)}]`;

            try {
                const result = await this.executeWithRetry(
                    this.withReadTimeout(operation, fallbackContext),
                    fallbackContext,
                );
                this.markFallbackSuccess(state);
                return result;
            } catch (fallbackError: any) {
                if (!this.isRetryableError(fallbackError)) {
                    throw fallbackError;
                }

                this.markFallbackFailure(state);
                lastError = fallbackError;
                console.warn(
                    `[rpc] ${fallbackContext} failed after ${this.config.maxRetries + 1} attempts. ` +
                    `Trying the next configured read RPC.`
                );
            }
        }

        throw lastError!;
    }

    private async executeWithReadFallback<T>(
        primaryOp: () => Promise<T>,
        fallbackOps: Array<{ state: FallbackProviderState; operation: () => Promise<T> }>,
        context: string,
    ): Promise<T> {
        const timedPrimaryOp = this.withReadTimeout(primaryOp, context);
        const orderedFallbackOps = this.getOrderedFallbackOps(fallbackOps);

        if (this.isReadFallbackActive()) {
            return this.executeFallbackChain(orderedFallbackOps, context);
        }

        try {
            return await this.executeWithRetry(timedPrimaryOp, context);
        } catch (primaryError: any) {
            if (!this.isRetryableError(primaryError)) {
                throw primaryError;
            }

            this.primaryReadCooldownUntil = Date.now() + this.config.fallbackCooldownMs;

            if (!this._fallbackActivated) {
                this._fallbackActivated = true;
                console.warn(
                    `[rpc] Primary provider failed for ${context} after ${this.config.maxRetries + 1} attempts. ` +
                    `Falling back to dedicated RPCs for read operations for ${this.config.fallbackCooldownMs}ms.`
                );
            }

            return this.executeFallbackChain(orderedFallbackOps, context, primaryError);
        }
    }

    wrapProvider(provider: curvance_read_provider): curvance_read_provider {
        // If it's already wrapped, return as-is
        if ((provider as any)._isRetryable) {
            return provider;
        }

        const hasFallback = this.fallbackProviders.length > 0;

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
                        const primaryOp = () => original.apply(target, [method, params]);

                        if (hasFallback) {
                            const fallbackOps = this.fallbackProviderStates.map((state) => ({
                                state,
                                operation: () => state.provider.send(method, params),
                            }));
                            return this.executeWithReadFallback(primaryOp, fallbackOps, `RPC ${method}`);
                        }

                        return this.executeWithRetry(primaryOp, `RPC ${method}`);
                    };
                }

                // For JsonRpcProvider, also wrap _send if it exists
                if (prop === '_send' && typeof original === 'function') {
                    return async (payload: any, callback?: any) => {
                        const method = payload.method || 'unknown';
                        const primaryOp = () => original.apply(target, [payload, callback]);

                        if (hasFallback) {
                            const fallbackOps = this.fallbackProviderStates.map((state) => ({
                                state,
                                operation: () => (state.provider as any)._send(payload, callback),
                            }));
                            return this.executeWithReadFallback(primaryOp, fallbackOps, `RPC ${method}`);
                        }

                        return this.executeWithRetry(primaryOp, `RPC ${method}`);
                    };
                }

                // Wrap other async methods that might make RPC calls
                if (typeof original === 'function' && this.isRpcMethod(prop)) {
                    return async (...args: any[]) => {
                        const primaryOp = () => original.apply(target, args);

                        if (hasFallback) {
                            const fallbackOps = this.fallbackProviderStates
                                .map((state) => {
                                    const fbMethod = (state.provider as any)[prop as string];
                                    if (typeof fbMethod !== 'function') {
                                        return null;
                                    }

                                    return {
                                        state,
                                        operation: () => fbMethod.apply(state.provider, args),
                                    };
                                })
                                .filter((entry): entry is { state: FallbackProviderState; operation: () => Promise<any> } => entry != null);

                            if (fallbackOps.length > 0) {
                                return this.executeWithReadFallback(primaryOp, fallbackOps, `Provider method ${String(prop)}`);
                            }
                        }

                        return this.executeWithRetry(primaryOp, `Provider method ${String(prop)}`);
                    };
                }

                // If it's a function, bind it to the target
                if (typeof original === 'function') {
                    return original.bind(target);
                }
                
                return original;
            }
        }) as curvance_read_provider;

        return retryableProvider;
    }

    private isRpcMethod(prop: string | symbol): boolean {
        if (typeof prop !== 'string') return false;
        
        // Common ethers.js methods that make RPC calls
        return RPC_PROVIDER_METHODS.has(prop);
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
    provider: curvance_read_provider, 
    config: Partial<RetryConfig> = {},
    readFallback: JsonRpcProvider | JsonRpcProvider[] | null = null,
): curvance_read_provider {
    const retryProvider = new RetryableProvider(config, readFallback);
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
 * Wrap a provider with the global retry configuration.
 *
 * When `readFallback` is supplied, read-only RPC methods (eth_call,
 * eth_getBalance, etc.) will fall through to the fallback providers after
 * exhausting retries on the primary.  Write/signing methods never use
 * the fallback because only the primary (wallet) provider can sign.
 */
export function wrapProviderWithRetries(
    provider: curvance_read_provider,
    readFallback: JsonRpcProvider | JsonRpcProvider[] | null = null,
): curvance_read_provider {
    const hasFallback = Array.isArray(readFallback) ? readFallback.length > 0 : readFallback != null;
    if (hasFallback) {
        // Fallback is per-invocation — create a dedicated instance so the
        // fallback providers aren't shared across setupChain calls.
        const retryProvider = new RetryableProvider(
            getGlobalRetryProvider().getConfig(),
            readFallback,
        );
        return retryProvider.wrapProvider(provider);
    }
    return getGlobalRetryProvider().wrapProvider(provider);
}

/**
 * Utility function to check if a provider is already wrapped with retries
 */
export function isRetryableProvider(provider: curvance_provider): boolean {
    return (provider as any)._isRetryable === true;
}

export function isRetryableReadProvider(provider: curvance_read_provider): boolean {
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
