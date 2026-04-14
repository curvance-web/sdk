import type { TestContext } from "node:test";

type MaybeFactory<T> = T | ((args: any[], callIndex: number) => T);

interface ResolveOutcome<T = any> {
    type: "resolve";
    value: MaybeFactory<T>;
    delayMs?: number;
}

interface RejectOutcome {
    type: "reject";
    error: Error | string | { message: string; code?: string | number };
    delayMs?: number;
}

interface HangOutcome {
    type: "hang";
}

type ScriptedOutcome<T = any> = ResolveOutcome<T> | RejectOutcome | HangOutcome;
type OutcomeSequence<T = any> = ScriptedOutcome<T> | ScriptedOutcome<T>[];

export interface ScriptedProviderDefinition {
    label: string;
    send?: Record<string, OutcomeSequence>;
    methods?: Record<string, OutcomeSequence>;
}

export interface TransportCall {
    label: string;
    channel: "send" | "method";
    name: string;
    args: any[];
    callIndex: number;
}

interface RetryableProviderLike {
    wrapProvider(provider: any): any;
}

interface RetryableProviderCtor {
    new(config?: Record<string, any>, fallbackProviders?: any): RetryableProviderLike;
}

function normalizeSequence(sequence?: OutcomeSequence): ScriptedOutcome[] {
    if (sequence == null) {
        return [];
    }

    return Array.isArray(sequence) ? [...sequence] : [sequence];
}

async function wait(delayMs = 0): Promise<void> {
    if (delayMs <= 0) {
        return;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeError(error: RejectOutcome["error"]): Error & { code?: string | number } {
    if (error instanceof Error) {
        return error as Error & { code?: string | number };
    }

    if (typeof error === "string") {
        return new Error(error) as Error & { code?: string | number };
    }

    const nextError = new Error(error.message) as Error & { code?: string | number };
    if (error.code != null) {
        nextError.code = error.code;
    }
    return nextError;
}

function materializeValue<T>(value: MaybeFactory<T>, args: any[], callIndex: number): T {
    return typeof value === "function"
        ? (value as (args: any[], callIndex: number) => T)(args, callIndex)
        : value;
}

class ScriptedProvider {
    private readonly sendScripts = new Map<string, ScriptedOutcome[]>();
    private readonly methodScripts = new Map<string, ScriptedOutcome[]>();
    private callIndex = 0;
    private readonly definition: ScriptedProviderDefinition;
    private readonly calls: TransportCall[];
    readonly provider: any;

    constructor(definition: ScriptedProviderDefinition, calls: TransportCall[]) {
        this.definition = definition;
        this.calls = calls;

        for (const [method, sequence] of Object.entries(definition.send ?? {})) {
            this.sendScripts.set(method, normalizeSequence(sequence));
        }
        for (const [method, sequence] of Object.entries(definition.methods ?? {})) {
            this.methodScripts.set(method, normalizeSequence(sequence));
        }

        this.provider = {
            _label: definition.label,
            send: async (method: string, params: any[]) => this.run("send", method, [method, params]),
        };

        for (const method of this.methodScripts.keys()) {
            this.provider[method] = async (...args: any[]) => this.run("method", method, args);
        }
    }

    private nextOutcome(channel: "send" | "method", key: string): ScriptedOutcome {
        const scripts = channel === "send" ? this.sendScripts : this.methodScripts;
        const direct = scripts.get(key);
        if (direct && direct.length > 0) {
            return direct.shift()!;
        }

        const wildcard = scripts.get("*");
        if (wildcard && wildcard.length > 0) {
            return wildcard.shift()!;
        }

        throw new Error(`No scripted ${channel} outcome configured for ${this.definition.label}:${key}`);
    }

    private async run(channel: "send" | "method", name: string, args: any[]): Promise<any> {
        const currentCallIndex = this.callIndex++;
        this.calls.push({
            label: this.definition.label,
            channel,
            name,
            args,
            callIndex: currentCallIndex,
        });

        const outcome = this.nextOutcome(channel, name);
        switch (outcome.type) {
            case "resolve":
                await wait(outcome.delayMs);
                return materializeValue(outcome.value, args, currentCallIndex);
            case "reject":
                await wait(outcome.delayMs);
                throw normalizeError(outcome.error);
            case "hang":
                return await new Promise(() => undefined);
            default:
                throw new Error(`Unhandled scripted outcome ${(outcome as ScriptedOutcome).type}`);
        }
    }
}

export function ok<T>(value: MaybeFactory<T>, delayMs = 0): ResolveOutcome<T> {
    return { type: "resolve", value, delayMs };
}

export function fail(
    message: string,
    options: { delayMs?: number; code?: string | number } = {},
): RejectOutcome {
    const error = new Error(message) as Error & { code?: string | number };
    if (options.code != null) {
        error.code = options.code;
    }

    const outcome: RejectOutcome = {
        type: "reject",
        error,
    };
    if (options.delayMs != null) {
        outcome.delayMs = options.delayMs;
    }
    return outcome;
}

export function hang(): HangOutcome {
    return { type: "hang" };
}

export class TransportHarness {
    readonly calls: TransportCall[] = [];
    private readonly t: TestContext;

    constructor(t: TestContext) {
        this.t = t;
    }

    enableMockTime(now = 0, apis: Array<"setTimeout" | "Date"> = ["setTimeout", "Date"]): void {
        this.t.mock.timers.enable({ apis, now });
    }

    async tick(milliseconds: number): Promise<void> {
        this.t.mock.timers.tick(milliseconds);
        await this.flush();
    }

    async flush(): Promise<void> {
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await Promise.resolve();
    }

    createProvider(definition: ScriptedProviderDefinition): any {
        return new ScriptedProvider(definition, this.calls).provider;
    }

    wrapReadProvider(
        RetryableProviderClass: RetryableProviderCtor,
        primary: ScriptedProviderDefinition,
        options: {
            config?: Record<string, any>;
            fallbacks?: ScriptedProviderDefinition[];
        } = {},
    ): any {
        const primaryProvider = this.createProvider(primary);
        const fallbackProviders = (options.fallbacks ?? []).map((definition) => this.createProvider(definition));
        const retryProvider = new RetryableProviderClass(
            {
                maxRetries: 0,
                baseDelay: 1,
                maxDelay: 1,
                backoffMultiplier: 1,
                retryableErrors: ["timeout"],
                ...options.config,
            },
            fallbackProviders.length === 0
                ? null
                : fallbackProviders.length === 1
                    ? fallbackProviders[0]
                    : fallbackProviders,
        );

        return retryProvider.wrapProvider(primaryProvider as any) as any;
    }

    callLabels(): string[] {
        return this.calls.map((call) => call.label);
    }

    getCalls(label: string, name?: string): TransportCall[] {
        return this.calls.filter((call) => call.label === label && (name == null || call.name === name));
    }
}
