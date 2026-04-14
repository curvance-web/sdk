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
    rankSampleCount: number; // Number of recent attempts to use when scoring fallback health
    rankWeights: {
        latency: number;
        stability: number;
    };
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
    rankSampleCount: DEFAULT_CHAIN_RPC_POLICY.rankSampleCount,
    rankWeights: DEFAULT_CHAIN_RPC_POLICY.rankWeights,
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

export interface RpcEndpointDebugState {
    endpointId: string;
    label: string;
    role: 'primary' | 'fallback';
    url: string | null;
    attempts: number;
    successes: number;
    retryableFailures: number;
    nonRetryableFailures: number;
    timeoutFailures: number;
    fallbackSelections: number;
    recentSampleCount: number;
    recentSuccessRate: number | null;
    averageLatencyMs: number | null;
    lastLatencyMs: number | null;
    rankScore: number | null;
    lastError: string | null;
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    cooldownUntil: number | null;
}

export interface RpcDebugSnapshot {
    updatedAt: number;
    endpoints: RpcEndpointDebugState[];
}

type RpcDebugListener = (snapshot: RpcDebugSnapshot) => void;

interface ProviderAttemptSample {
    success: boolean;
    latencyMs: number | null;
}

interface ProviderState {
    provider: JsonRpcProvider;
    label: string;
    role: 'primary' | 'fallback';
    endpointId: string;
    url: string | null;
    index: number;
    cooldownUntil: number;
    lastFailureAt: number;
    lastSuccessAt: number;
    attempts: number;
    successes: number;
    retryableFailures: number;
    nonRetryableFailures: number;
    timeoutFailures: number;
    fallbackSelections: number;
    lastLatencyMs: number | null;
    lastError: string | null;
    lastAttemptAt: number;
    recentSamples: ProviderAttemptSample[];
}

const rpcDebugListeners = new Set<RpcDebugListener>();
const rpcDebugStates = new Map<string, RpcEndpointDebugState>();

function normalizeRpcUrl(url: string | null | undefined): string | null {
    if (!url) {
        return null;
    }

    return url.replace(/\/+$/, '');
}

function getProviderUrl(provider: JsonRpcProvider): string | null {
    const connection = (provider as any)._getConnection?.() ?? (provider as any).connection ?? null;
    return normalizeRpcUrl(connection?.url);
}

function getEndpointId(url: string | null, label: string): string {
    return url ?? label;
}

function cloneRpcDebugState(state: RpcEndpointDebugState): RpcEndpointDebugState {
    return { ...state };
}

function emitRpcDebugSnapshot(): void {
    if (rpcDebugListeners.size === 0) {
        return;
    }

    const snapshot = getRpcDebugSnapshot();
    for (const listener of rpcDebugListeners) {
        listener(snapshot);
    }
}

export function getRpcDebugSnapshot(): RpcDebugSnapshot {
    return {
        updatedAt: Date.now(),
        endpoints: [...rpcDebugStates.values()]
            .map(cloneRpcDebugState)
            .sort((a, b) => {
                if (a.role !== b.role) {
                    return a.role === 'primary' ? -1 : 1;
                }

                return a.label.localeCompare(b.label);
            }),
    };
}

export function subscribeToRpcDebug(listener: RpcDebugListener): () => void {
    rpcDebugListeners.add(listener);
    listener(getRpcDebugSnapshot());
    return () => {
        rpcDebugListeners.delete(listener);
    };
}

export function resetRpcDebugState(): void {
    rpcDebugStates.clear();
    emitRpcDebugSnapshot();
}

class RetryableProvider {
    private config: RetryConfig;
    private fallbackProviders: JsonRpcProvider[];
    private fallbackProviderStates: ProviderState[];
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
        this.fallbackProviderStates = this.fallbackProviders.map((provider, index) =>
            this.createProviderState(provider, 'fallback', `fallback-${index + 1}`, index),
        );
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

    private createProviderState(
        provider: JsonRpcProvider,
        role: 'primary' | 'fallback',
        label: string,
        index: number,
    ): ProviderState {
        const url = getProviderUrl(provider);
        const state: ProviderState = {
            provider,
            label,
            role,
            endpointId: getEndpointId(url, label),
            url,
            index,
            cooldownUntil: 0,
            lastFailureAt: 0,
            lastSuccessAt: 0,
            attempts: 0,
            successes: 0,
            retryableFailures: 0,
            nonRetryableFailures: 0,
            timeoutFailures: 0,
            fallbackSelections: 0,
            lastLatencyMs: null,
            lastError: null,
            lastAttemptAt: 0,
            recentSamples: [],
        };

        this.publishDebugState(state);
        return state;
    }

    private getRecentSamples(state: ProviderState): ProviderAttemptSample[] {
        return state.recentSamples.slice(-this.config.rankSampleCount);
    }

    private getProviderSuccessRate(state: ProviderState): number {
        const samples = this.getRecentSamples(state);
        if (samples.length === 0) {
            return 0.5;
        }

        const successes = samples.filter((sample) => sample.success).length;
        return successes / samples.length;
    }

    private getProviderAverageLatency(state: ProviderState): number | null {
        const latencies = this.getRecentSamples(state)
            .filter((sample) => sample.success && sample.latencyMs != null)
            .map((sample) => sample.latencyMs as number);

        if (latencies.length === 0) {
            return null;
        }

        return latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length;
    }

    private getProviderRankScore(state: ProviderState): number {
        const averageLatencyMs = this.getProviderAverageLatency(state);
        const latencyScore = averageLatencyMs == null
            ? 0.5
            : Math.max(0, 1 - Math.min(averageLatencyMs, this.config.timeoutMs) / this.config.timeoutMs);
        const stabilityScore = this.getProviderSuccessRate(state);

        return (
            (latencyScore * this.config.rankWeights.latency) +
            (stabilityScore * this.config.rankWeights.stability)
        );
    }

    private publishDebugState(state: ProviderState): void {
        const current: RpcEndpointDebugState = rpcDebugStates.get(state.endpointId) ?? {
            endpointId: state.endpointId,
            label: state.label,
            role: state.role,
            url: state.url,
            attempts: 0,
            successes: 0,
            retryableFailures: 0,
            nonRetryableFailures: 0,
            timeoutFailures: 0,
            fallbackSelections: 0,
            recentSampleCount: 0,
            recentSuccessRate: null,
            averageLatencyMs: null,
            lastLatencyMs: null,
            rankScore: null,
            lastError: null,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            cooldownUntil: null,
        };

        current.label = state.label;
        current.role = state.role;
        current.url = state.url;
        current.recentSampleCount = this.getRecentSamples(state).length;
        current.recentSuccessRate = current.recentSampleCount > 0 ? this.getProviderSuccessRate(state) : null;
        current.averageLatencyMs = this.getProviderAverageLatency(state);
        current.lastLatencyMs = state.lastLatencyMs;
        current.rankScore = this.getProviderRankScore(state);
        current.lastError = state.lastError;
        current.lastAttemptAt = state.lastAttemptAt || current.lastAttemptAt;
        current.lastSuccessAt = state.lastSuccessAt || current.lastSuccessAt;
        current.lastFailureAt = state.lastFailureAt || current.lastFailureAt;
        current.cooldownUntil = state.cooldownUntil || null;

        rpcDebugStates.set(state.endpointId, current);
        emitRpcDebugSnapshot();
    }

    private recordProviderSelection(state: ProviderState): void {
        state.fallbackSelections += 1;
        const current = rpcDebugStates.get(state.endpointId);
        if (current) {
            current.fallbackSelections += 1;
        }
        this.publishDebugState(state);
    }

    private recordProviderAttempt(state: ProviderState, latencyMs: number, error?: any): void {
        const recordedAt = Date.now();
        state.attempts += 1;
        state.lastAttemptAt = recordedAt;
        state.lastLatencyMs = latencyMs;
        state.recentSamples.push({
            success: error == null,
            latencyMs,
        });
        if (state.recentSamples.length > this.config.rankSampleCount) {
            state.recentSamples.shift();
        }

        const current = rpcDebugStates.get(state.endpointId);
        if (current) {
            current.attempts += 1;
            current.lastAttemptAt = recordedAt;
            current.lastLatencyMs = latencyMs;
        }

        if (error == null) {
            state.successes += 1;
            state.lastSuccessAt = recordedAt;
            state.lastError = null;
            if (current) {
                current.successes += 1;
                current.lastSuccessAt = recordedAt;
                current.lastError = null;
            }
            this.publishDebugState(state);
            return;
        }

        const isTimeout = error?.code === 'timeout' || String(error?.message ?? '').toLowerCase().includes('timeout');
        const isRetryable = this.isRetryableError(error);

        state.lastFailureAt = recordedAt;
        state.lastError = error?.message ?? String(error);

        if (isRetryable) {
            state.retryableFailures += 1;
        } else {
            state.nonRetryableFailures += 1;
        }

        if (isTimeout) {
            state.timeoutFailures += 1;
        }

        if (current) {
            current.lastFailureAt = recordedAt;
            current.lastError = state.lastError;
            if (isRetryable) {
                current.retryableFailures += 1;
            } else {
                current.nonRetryableFailures += 1;
            }
            if (isTimeout) {
                current.timeoutFailures += 1;
            }
        }

        this.publishDebugState(state);
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

    private isReadFallbackActive(primaryState?: ProviderState): boolean {
        if (this.primaryReadCooldownUntil === 0) {
            return false;
        }

        if (Date.now() >= this.primaryReadCooldownUntil) {
            this.primaryReadCooldownUntil = 0;
            this._fallbackActivated = false;
            if (primaryState) {
                primaryState.cooldownUntil = 0;
                this.publishDebugState(primaryState);
            }
            return false;
        }

        return true;
    }

    private getFallbackProviderLabel(state: ProviderState): string {
        return state.label;
    }

    private isProviderCoolingDown(cooldownUntil: number): boolean {
        return cooldownUntil > Date.now();
    }

    private compareFallbackProviders(a: ProviderState, b: ProviderState): number {
        const aCooling = this.isProviderCoolingDown(a.cooldownUntil);
        const bCooling = this.isProviderCoolingDown(b.cooldownUntil);

        if (aCooling !== bCooling) {
            return aCooling ? 1 : -1;
        }

        if (aCooling && bCooling) {
            return a.cooldownUntil - b.cooldownUntil || a.index - b.index;
        }

        const aRankScore = this.getProviderRankScore(a);
        const bRankScore = this.getProviderRankScore(b);
        if (aRankScore !== bRankScore) {
            return bRankScore - aRankScore;
        }

        const aSuccessRate = this.getProviderSuccessRate(a);
        const bSuccessRate = this.getProviderSuccessRate(b);
        if (aSuccessRate !== bSuccessRate) {
            return bSuccessRate - aSuccessRate;
        }

        const aLatency = this.getProviderAverageLatency(a);
        const bLatency = this.getProviderAverageLatency(b);
        if (aLatency != null || bLatency != null) {
            if (aLatency == null) {
                return 1;
            }
            if (bLatency == null) {
                return -1;
            }
            if (aLatency !== bLatency) {
                return aLatency - bLatency;
            }
        }

        if (a.lastSuccessAt !== b.lastSuccessAt) {
            return b.lastSuccessAt - a.lastSuccessAt;
        }

        if (a.lastFailureAt !== b.lastFailureAt) {
            return a.lastFailureAt - b.lastFailureAt;
        }

        return a.index - b.index;
    }

    private getOrderedFallbackProviders(): ProviderState[] {
        return [...this.fallbackProviderStates].sort((a, b) => this.compareFallbackProviders(a, b));
    }

    private markFallbackFailure(state: ProviderState): void {
        state.lastFailureAt = Date.now();
        state.cooldownUntil = state.lastFailureAt + this.config.fallbackCooldownMs;
        this.publishDebugState(state);
    }

    private markFallbackSuccess(state: ProviderState): void {
        state.lastSuccessAt = Date.now();
        state.lastFailureAt = 0;
        state.cooldownUntil = 0;
        this.publishDebugState(state);
    }

    private getOrderedFallbackOps<T>(
        fallbackOps: Array<{ state: ProviderState; operation: () => Promise<T> }>,
    ): Array<{ state: ProviderState; operation: () => Promise<T> }> {
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
            .filter((entry): entry is { state: ProviderState; operation: () => Promise<T> } => entry != null);
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
        context: string = 'RPC call',
        providerState: ProviderState | null = null,
    ): Promise<T> {
        let lastError: Error;
        
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            const startedAt = Date.now();
            try {
                const result = await operation();
                if (providerState) {
                    this.recordProviderAttempt(providerState, Date.now() - startedAt);
                }
                return result;
            } catch (error: any) {
                if (providerState) {
                    this.recordProviderAttempt(providerState, Date.now() - startedAt, error);
                }
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
        fallbackOps: Array<{ state: ProviderState; operation: () => Promise<T> }>,
        context: string,
        originalError?: Error,
    ): Promise<T> {
        let lastError = originalError;

        for (const { state, operation } of fallbackOps) {
            const fallbackContext = `${context} [${this.getFallbackProviderLabel(state)}]`;

            try {
                this.recordProviderSelection(state);
                const result = await this.executeWithRetry(
                    this.withReadTimeout(operation, fallbackContext),
                    fallbackContext,
                    state,
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
        fallbackOps: Array<{ state: ProviderState; operation: () => Promise<T> }>,
        context: string,
        primaryState: ProviderState,
    ): Promise<T> {
        const timedPrimaryOp = this.withReadTimeout(primaryOp, context);
        const orderedFallbackOps = this.getOrderedFallbackOps(fallbackOps);

        if (this.isReadFallbackActive(primaryState)) {
            return this.executeFallbackChain(orderedFallbackOps, context);
        }

        try {
            return await this.executeWithRetry(timedPrimaryOp, context, primaryState);
        } catch (primaryError: any) {
            if (!this.isRetryableError(primaryError)) {
                throw primaryError;
            }

            this.primaryReadCooldownUntil = Date.now() + this.config.fallbackCooldownMs;
            primaryState.cooldownUntil = this.primaryReadCooldownUntil;
            this.publishDebugState(primaryState);

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
        const primaryState = this.createProviderState(provider, 'primary', 'primary', -1);

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
                            return this.executeWithReadFallback(primaryOp, fallbackOps, `RPC ${method}`, primaryState);
                        }

                        return this.executeWithRetry(primaryOp, `RPC ${method}`, primaryState);
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
                            return this.executeWithReadFallback(primaryOp, fallbackOps, `RPC ${method}`, primaryState);
                        }

                        return this.executeWithRetry(primaryOp, `RPC ${method}`, primaryState);
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
                                .filter((entry): entry is { state: ProviderState; operation: () => Promise<any> } => entry != null);

                            if (fallbackOps.length > 0) {
                                return this.executeWithReadFallback(primaryOp, fallbackOps, `Provider method ${String(prop)}`, primaryState);
                            }
                        }

                        return this.executeWithRetry(primaryOp, `Provider method ${String(prop)}`, primaryState);
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
