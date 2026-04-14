import assert from "node:assert/strict";
import test from "node:test";
import { RetryableProvider } from "../src/retry-provider";

/**
 * Minimal stub that records calls and can be configured to succeed or fail.
 * Only implements the `send(method, params)` surface used by the Proxy.
 */
function createStubProvider(opts: {
    label: string;
    failMethods?: Set<string>;
    calls?: Array<{ label: string; method: string }>;
}) {
    const calls = opts.calls ?? [];
    return {
        _label: opts.label,
        send: async (method: string, _params: any[]) => {
            calls.push({ label: opts.label, method });
            if (opts.failMethods?.has(method)) {
                throw new Error(`timeout: ${opts.label} ${method}`);
            }
            return `${opts.label}:${method}:ok`;
        },
    } as any;
}

test("read methods fall through to fallback when primary exhausts retries", async () => {
    const calls: Array<{ label: string; method: string }> = [];

    const primary = createStubProvider({
        label: "primary",
        failMethods: new Set(["eth_call"]),
        calls,
    });
    const fallback = createStubProvider({
        label: "fallback",
        calls,
    });

    const rp = new RetryableProvider(
        { maxRetries: 1, baseDelay: 1, maxDelay: 1, backoffMultiplier: 1, retryableErrors: ["timeout"] },
        fallback,
    );
    const wrapped = rp.wrapProvider(primary) as any;

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback:eth_call:ok");

    // Primary should have been called 2 times (initial + 1 retry), then fallback once
    const primaryCalls = calls.filter((c) => c.label === "primary" && c.method === "eth_call");
    const fallbackCalls = calls.filter((c) => c.label === "fallback" && c.method === "eth_call");
    assert.equal(primaryCalls.length, 2, "primary: initial + 1 retry");
    assert.equal(fallbackCalls.length, 1, "fallback: called once after primary exhausted");
});

test("write methods do NOT fall through to fallback", async () => {
    const calls: Array<{ label: string; method: string }> = [];

    const primary = createStubProvider({
        label: "primary",
        failMethods: new Set(["eth_sendTransaction"]),
        calls,
    });
    const fallback = createStubProvider({
        label: "fallback",
        calls,
    });

    const rp = new RetryableProvider(
        { maxRetries: 0, baseDelay: 1, maxDelay: 1, backoffMultiplier: 1, retryableErrors: ["timeout"] },
        fallback,
    );
    const wrapped = rp.wrapProvider(primary) as any;

    await assert.rejects(() => wrapped.send("eth_sendTransaction", []), /timeout/);

    const fallbackCalls = calls.filter((c) => c.label === "fallback");
    assert.equal(fallbackCalls.length, 0, "fallback must never be called for write methods");
});

test("without a fallback, read methods fail normally after retries", async () => {
    const calls: Array<{ label: string; method: string }> = [];

    const primary = createStubProvider({
        label: "primary",
        failMethods: new Set(["eth_call"]),
        calls,
    });

    const rp = new RetryableProvider(
        { maxRetries: 1, baseDelay: 1, maxDelay: 1, backoffMultiplier: 1, retryableErrors: ["timeout"] },
        null, // no fallback
    );
    const wrapped = rp.wrapProvider(primary) as any;

    await assert.rejects(() => wrapped.send("eth_call", []), /timeout/);

    const primaryCalls = calls.filter((c) => c.label === "primary");
    assert.equal(primaryCalls.length, 2, "primary: initial + 1 retry, then throws");
});

test("primary success on read method does not touch fallback", async () => {
    const calls: Array<{ label: string; method: string }> = [];

    const primary = createStubProvider({
        label: "primary",
        calls,
    });
    const fallback = createStubProvider({
        label: "fallback",
        calls,
    });

    const rp = new RetryableProvider(
        { maxRetries: 1, baseDelay: 1, maxDelay: 1, backoffMultiplier: 1, retryableErrors: ["timeout"] },
        fallback,
    );
    const wrapped = rp.wrapProvider(primary) as any;

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "primary:eth_call:ok");

    const fallbackCalls = calls.filter((c) => c.label === "fallback");
    assert.equal(fallbackCalls.length, 0, "fallback not called when primary succeeds");
});

test("non-retryable errors on read methods skip fallback", async () => {
    const calls: Array<{ label: string; method: string }> = [];

    const primary = createStubProvider({ label: "primary", calls });
    // Override send to throw a non-retryable error
    primary.send = async (method: string) => {
        calls.push({ label: "primary", method });
        throw new Error("execution reverted");
    };

    const fallback = createStubProvider({ label: "fallback", calls });

    const rp = new RetryableProvider(
        { maxRetries: 2, baseDelay: 1, maxDelay: 1, backoffMultiplier: 1, retryableErrors: ["timeout"] },
        fallback,
    );
    const wrapped = rp.wrapProvider(primary) as any;

    await assert.rejects(() => wrapped.send("eth_call", []), /execution reverted/);

    // Non-retryable errors throw immediately — no retries, no fallback
    const primaryCalls = calls.filter((c) => c.label === "primary");
    const fallbackCalls = calls.filter((c) => c.label === "fallback");
    assert.equal(primaryCalls.length, 1, "non-retryable: only 1 attempt");
    assert.equal(fallbackCalls.length, 0, "non-retryable: no fallback");
});

test("fallback gets its own retry cycle", async () => {
    const calls: Array<{ label: string; method: string }> = [];
    let fallbackCallCount = 0;

    const primary = createStubProvider({
        label: "primary",
        failMethods: new Set(["eth_call"]),
        calls,
    });

    const fallback = createStubProvider({ label: "fallback", calls });
    // Make fallback fail once then succeed
    const originalSend = fallback.send;
    fallback.send = async (method: string, params: any[]) => {
        fallbackCallCount++;
        if (fallbackCallCount === 1) {
            calls.push({ label: "fallback", method });
            throw new Error("timeout: fallback transient");
        }
        return originalSend(method, params);
    };

    const rp = new RetryableProvider(
        { maxRetries: 1, baseDelay: 1, maxDelay: 1, backoffMultiplier: 1, retryableErrors: ["timeout"] },
        fallback,
    );
    const wrapped = rp.wrapProvider(primary) as any;

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback:eth_call:ok");

    // Fallback had its own retry: fail once, succeed on retry
    assert.equal(fallbackCallCount, 2, "fallback: 1 failure + 1 success");
});

test("read timeouts fall through to fallback", async () => {
    const calls: Array<{ label: string; method: string }> = [];

    const primary = {
        send: async (method: string) => {
            calls.push({ label: "primary", method });
            return await new Promise(() => undefined);
        },
    } as any;

    const fallback = createStubProvider({
        label: "fallback",
        calls,
    });

    const rp = new RetryableProvider(
        { maxRetries: 0, baseDelay: 1, maxDelay: 1, backoffMultiplier: 1, timeoutMs: 5, retryableErrors: ["timeout"] },
        fallback,
    );
    const wrapped = rp.wrapProvider(primary) as any;

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback:eth_call:ok");

    const primaryCalls = calls.filter((c) => c.label === "primary");
    const fallbackCalls = calls.filter((c) => c.label === "fallback");
    assert.equal(primaryCalls.length, 1, "timed out primary is attempted once");
    assert.equal(fallbackCalls.length, 1, "fallback handles the timed out read");
});

test("fallback remains sticky during cooldown, then returns to primary", async () => {
    const calls: Array<{ label: string; method: string }> = [];
    let shouldPrimaryFail = true;

    const primary = {
        send: async (method: string) => {
            calls.push({ label: "primary", method });
            if (shouldPrimaryFail) {
                throw new Error(`timeout: primary ${method}`);
            }
            return `primary:${method}:ok`;
        },
    } as any;

    const fallback = createStubProvider({
        label: "fallback",
        calls,
    });

    const rp = new RetryableProvider(
        {
            maxRetries: 0,
            baseDelay: 1,
            maxDelay: 1,
            backoffMultiplier: 1,
            fallbackCooldownMs: 50,
            retryableErrors: ["timeout"],
        },
        fallback,
    );
    const wrapped = rp.wrapProvider(primary) as any;

    const first = await wrapped.send("eth_call", []);
    assert.equal(first, "fallback:eth_call:ok");

    shouldPrimaryFail = false;
    const second = await wrapped.send("eth_call", []);
    assert.equal(second, "fallback:eth_call:ok");

    await new Promise((resolve) => setTimeout(resolve, 60));
    const third = await wrapped.send("eth_call", []);
    assert.equal(third, "primary:eth_call:ok");

    const primaryCalls = calls.filter((c) => c.label === "primary");
    const fallbackCalls = calls.filter((c) => c.label === "fallback");
    assert.equal(primaryCalls.length, 2, "primary is bypassed during cooldown, then retried after it expires");
    assert.equal(fallbackCalls.length, 2, "fallback serves the initial failure and the sticky cooldown window");
});
