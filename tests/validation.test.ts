import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeout, validateApiUrl } from "../src/validation";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
});

test("validateApiUrl rejects non-HTTPS URLs before fetch callers can use them", () => {
    assert.equal(validateApiUrl("https://api.curvance.test"), "https://api.curvance.test");
    assert.throws(
        () => validateApiUrl("http://api.curvance.test"),
        /api_url must use HTTPS/i,
    );
    assert.throws(
        () => validateApiUrl("javascript:alert(1)"),
        /api_url must use HTTPS/i,
    );
    assert.throws(
        () => validateApiUrl("not a url"),
        /Invalid api_url/i,
    );
});

test("fetchWithTimeout forwards an AbortSignal and clears its timeout after success", async () => {
    const liveTimeouts = new Set<object>();
    let capturedSignal: any = null;

    globalThis.setTimeout = ((callback: any, timeout?: number) => {
        const handle = { callback, timeout };
        liveTimeouts.add(handle);
        return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
        liveTimeouts.delete(handle as object);
    }) as typeof clearTimeout;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
        capturedSignal = init?.signal ?? null;
        return { ok: true } as Response;
    }) as typeof fetch;

    const response = await fetchWithTimeout("https://api.curvance.test", {}, 1_000);

    assert.equal(response.ok, true);
    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
    assert.equal(liveTimeouts.size, 0);
});

test("fetchWithTimeout composes an already-aborted caller signal", async () => {
    const callerAbort = new AbortController();
    let capturedSignal: any = null;
    callerAbort.abort();

    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
        capturedSignal = init?.signal ?? null;
        return { ok: true } as Response;
    }) as typeof fetch;

    await fetchWithTimeout(
        "https://api.curvance.test",
        { signal: callerAbort.signal },
        1_000,
    );

    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, true);
});

test("fetchWithTimeout aborts the request when its timeout fires", async () => {
    let timeoutCallback: (() => void) | null = null;
    const timeoutHandle = {};
    let timeoutCleared = false;

    globalThis.setTimeout = ((callback: any) => {
        timeoutCallback = callback as () => void;
        return timeoutHandle as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
        if (handle === timeoutHandle) {
            timeoutCleared = true;
        }
    }) as typeof clearTimeout;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
            assert.ok(timeoutCallback);
            timeoutCallback();
        });
    }) as typeof fetch;

    await assert.rejects(
        () => fetchWithTimeout("https://api.curvance.test", {}, 1_000),
        /request aborted/,
    );
    assert.equal(timeoutCleared, true);
});
