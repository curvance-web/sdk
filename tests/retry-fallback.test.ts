import assert from "node:assert/strict";
import test from "node:test";
import {
    configureRetries,
    DEFAULT_RETRY_CONFIG,
    getRpcDebugSnapshot,
    resetRpcDebugState,
    RetryableProvider,
    wrapProviderWithRetries,
} from "../src/retry-provider";
import { TransportHarness, fail, hang, ok } from "./support/transport-harness";

test.beforeEach(() => {
    resetRpcDebugState();
    configureRetries(DEFAULT_RETRY_CONFIG);
});

test("read methods fall through to fallback when primary exhausts retries", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: [
                    fail("timeout: primary eth_call"),
                    fail("timeout: primary eth_call"),
                ],
            },
        },
        {
            config: { maxRetries: 1 },
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback:eth_call:ok");
    assert.equal(harness.getCalls("primary", "eth_call").length, 2, "primary: initial + 1 retry");
    assert.equal(harness.getCalls("fallback", "eth_call").length, 1, "fallback: called once after primary exhausted");
});

test("read provider methods fall through to fallback", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            methods: {
                getBlockNumber: fail("timeout: primary getBlockNumber"),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback",
                    methods: {
                        getBlockNumber: ok(123),
                    },
                },
            ],
        },
    );

    const result = await wrapped.getBlockNumber();
    assert.equal(result, 123);
    assert.deepEqual(harness.callLabels(), ["primary", "fallback"]);
});

test("waitForTransaction stays on the retry/fallback path", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            methods: {
                waitForTransaction: fail("timeout: primary waitForTransaction"),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback",
                    methods: {
                        waitForTransaction: ok({ status: 1 }),
                    },
                },
            ],
        },
    );

    const result = await wrapped.waitForTransaction("0xabc");
    assert.deepEqual(result, { status: 1 });
    assert.deepEqual(harness.callLabels(), ["primary", "fallback"]);
});

test("without a fallback, read methods fail normally after retries", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: [
                    fail("timeout: primary eth_call"),
                    fail("timeout: primary eth_call"),
                ],
            },
        },
        {
            config: { maxRetries: 1 },
        },
    );

    await assert.rejects(() => wrapped.send("eth_call", []), /timeout/);
    assert.equal(harness.getCalls("primary", "eth_call").length, 2, "primary: initial + 1 retry, then throws");
});

test("primary success on read method does not touch fallback", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: ok("primary:eth_call:ok"),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "primary:eth_call:ok");
    assert.equal(harness.getCalls("fallback", "eth_call").length, 0, "fallback not called when primary succeeds");
});

test("non-retryable errors on read methods skip fallback", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: fail("execution reverted"),
            },
        },
        {
            config: { maxRetries: 2 },
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    await assert.rejects(() => wrapped.send("eth_call", []), /execution reverted/);
    assert.equal(harness.getCalls("primary", "eth_call").length, 1, "non-retryable: only 1 attempt");
    assert.equal(harness.getCalls("fallback", "eth_call").length, 0, "non-retryable: no fallback");
});

test("fallback gets its own retry cycle", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: [
                    fail("timeout: primary eth_call"),
                    fail("timeout: primary eth_call"),
                ],
            },
        },
        {
            config: { maxRetries: 1 },
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: [
                            fail("timeout: fallback transient"),
                            ok("fallback:eth_call:ok"),
                        ],
                    },
                },
            ],
        },
    );

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback:eth_call:ok");
    assert.equal(harness.getCalls("fallback", "eth_call").length, 2, "fallback: 1 failure + 1 success");
});

test("read methods cascade across multiple fallback providers", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: fail("timeout: primary eth_call"),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback-1",
                    send: {
                        eth_call: fail("timeout: fallback-1 eth_call"),
                    },
                },
                {
                    label: "fallback-2",
                    send: {
                        eth_call: ok("fallback-2:eth_call:ok"),
                    },
                },
            ],
        },
    );

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback-2:eth_call:ok");
    assert.deepEqual(
        harness.callLabels(),
        ["primary", "fallback-1", "fallback-2"],
        "primary failure should advance through the configured fallback chain",
    );
});

test("failed fallback providers are deprioritized during cooldown", async (t) => {
    const harness = new TransportHarness(t);
    harness.enableMockTime();

    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: [
                    fail("timeout: primary eth_call"),
                    ok("primary:eth_call:ok"),
                ],
            },
        },
        {
            config: { fallbackCooldownMs: 50 },
            fallbacks: [
                {
                    label: "fallback-1",
                    send: {
                        eth_call: fail("timeout: fallback-1 eth_call"),
                    },
                },
                {
                    label: "fallback-2",
                    send: {
                        eth_call: [
                            ok("fallback-2:eth_call:first"),
                            ok("fallback-2:eth_call:sticky"),
                        ],
                    },
                },
            ],
        },
    );

    const first = await wrapped.send("eth_call", []);
    assert.equal(first, "fallback-2:eth_call:first");

    const second = await wrapped.send("eth_call", []);
    assert.equal(second, "fallback-2:eth_call:sticky");

    assert.deepEqual(
        harness.callLabels(),
        ["primary", "fallback-1", "fallback-2", "fallback-2"],
        "during cooldown the healthy fallback should be preferred over the failed one and the primary",
    );
});

test("read timeouts fall through to fallback", async (t) => {
    const harness = new TransportHarness(t);
    harness.enableMockTime();

    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: hang(),
            },
        },
        {
            config: { timeoutMs: 5 },
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    const resultPromise = wrapped.send("eth_call", []);
    await harness.flush();
    await harness.tick(5);

    const result = await resultPromise;
    assert.equal(result, "fallback:eth_call:ok");
    assert.equal(harness.getCalls("primary", "eth_call").length, 1, "timed out primary is attempted once");
    assert.equal(harness.getCalls("fallback", "eth_call").length, 1, "fallback handles the timed out read");
});

test("read timeouts reject without a fallback instead of hanging", async (t) => {
    const harness = new TransportHarness(t);
    harness.enableMockTime();

    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: hang(),
            },
        },
        {
            config: { timeoutMs: 5 },
        },
    );

    const resultPromise = wrapped.send("eth_call", []);
    const rejection = assert.rejects(resultPromise, /timeout after 5ms/);
    await harness.flush();
    await harness.tick(5);

    await rejection;
    assert.equal(harness.getCalls("primary", "eth_call").length, 1, "timed out primary is attempted once");
});

test("provider method timeouts reject without a fallback instead of hanging", async (t) => {
    const harness = new TransportHarness(t);
    harness.enableMockTime();

    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            methods: {
                getBlockNumber: hang(),
            },
        },
        {
            config: { timeoutMs: 5 },
        },
    );

    const resultPromise = wrapped.getBlockNumber();
    const rejection = assert.rejects(resultPromise, /timeout after 5ms/);
    await harness.flush();
    await harness.tick(5);

    await rejection;
    assert.equal(harness.getCalls("primary", "getBlockNumber").length, 1, "timed out primary is attempted once");
});

test("fallback remains sticky during cooldown, then returns to primary", async (t) => {
    const harness = new TransportHarness(t);
    harness.enableMockTime();

    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: [
                    fail("timeout: primary eth_call"),
                    ok("primary:eth_call:ok"),
                ],
            },
        },
        {
            config: { fallbackCooldownMs: 50 },
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: [
                            ok("fallback:eth_call:first"),
                            ok("fallback:eth_call:sticky"),
                        ],
                    },
                },
            ],
        },
    );

    const first = await wrapped.send("eth_call", []);
    assert.equal(first, "fallback:eth_call:first");

    const second = await wrapped.send("eth_call", []);
    assert.equal(second, "fallback:eth_call:sticky");

    await harness.tick(60);
    const third = await wrapped.send("eth_call", []);
    assert.equal(third, "primary:eth_call:ok");

    assert.equal(harness.getCalls("primary", "eth_call").length, 2, "primary is bypassed during cooldown, then retried after it expires");
    assert.equal(harness.getCalls("fallback", "eth_call").length, 2, "fallback serves the initial failure and the sticky cooldown window");
});

test("configureRetries updates active fallback-backed wrapped providers", async (t) => {
    const harness = new TransportHarness(t);

    configureRetries({
        ...DEFAULT_RETRY_CONFIG,
        maxRetries: 0,
        baseDelay: 1,
        maxDelay: 1,
        backoffMultiplier: 1,
        retryableErrors: ["timeout"],
    });

    const primary = harness.createProvider({
        label: "primary",
        methods: {
            getBlockNumber: [
                fail("timeout: primary getBlockNumber"),
                ok(123),
            ],
        },
    });
    const fallback = harness.createProvider({
        label: "fallback",
        methods: {
            getBlockNumber: ok(456),
        },
    });

    const wrapped = wrapProviderWithRetries(primary as any, fallback as any);

    configureRetries({
        maxRetries: 1,
        baseDelay: 1,
        maxDelay: 1,
        backoffMultiplier: 1,
        retryableErrors: ["timeout"],
    });

    const result = await wrapped.getBlockNumber();
    assert.equal(result, 123);
    assert.equal(harness.getCalls("primary", "getBlockNumber").length, 2);
    assert.equal(harness.getCalls("fallback", "getBlockNumber").length, 0);
});

test("rpc debug snapshot records endpoint health without request params", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: fail("timeout: primary eth_call"),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    await wrapped.send("eth_call", [{ secret: "do-not-log" }]);

    const snapshot = getRpcDebugSnapshot();
    const primaryState = snapshot.endpoints.find((endpoint) => endpoint.role === "primary");
    const fallbackState = snapshot.endpoints.find((endpoint) => endpoint.role === "fallback");

    assert.ok(primaryState, "primary endpoint should be tracked");
    assert.ok(fallbackState, "fallback endpoint should be tracked");
    assert.equal(primaryState?.attempts, 1);
    assert.equal(primaryState?.retryableFailures, 1);
    assert.equal(fallbackState?.attempts, 1);
    assert.equal(fallbackState?.successes, 1);
    assert.equal(fallbackState?.fallbackSelections, 1);
    assert.equal(
        snapshot.endpoints.some((endpoint) => endpoint.lastError?.includes("do-not-log") ?? false),
        false,
        "debug state must not include RPC params",
    );
});

// ---------------------------------------------------------------------------
// Regression: unknown errors on primary should still try the fallback.
// Contract errors (revert, nonce, user rejection) are deterministic chain
// state and must skip the fallback. But errors that are neither contract
// nor known-retryable (e.g. BAD_DATA from ethers, malformed JSON, 401/403,
// unrecognized RPC error shapes) indicate a transport-level issue that a
// different provider may handle correctly. Without this, a primary with a
// broken response shape causes every read to fail while a healthy fallback
// sits idle.
// ---------------------------------------------------------------------------

test("unknown errors on primary fall through to fallback", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: fail("BAD_DATA: could not decode result", { code: "BAD_DATA" }),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback:eth_call:ok");
    assert.equal(
        harness.getCalls("primary", "eth_call").length,
        1,
        "primary: single attempt (unknown errors are not retried on same provider)",
    );
    assert.equal(
        harness.getCalls("fallback", "eth_call").length,
        1,
        "fallback: called after primary's unknown error",
    );
});

test("unknown errors on a fallback advance to the next fallback", async (t) => {
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: fail("timeout: primary eth_call"),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback-1",
                    send: {
                        eth_call: fail("Unexpected end of JSON input"),
                    },
                },
                {
                    label: "fallback-2",
                    send: {
                        eth_call: ok("fallback-2:eth_call:ok"),
                    },
                },
            ],
        },
    );

    const result = await wrapped.send("eth_call", []);
    assert.equal(result, "fallback-2:eth_call:ok");
    assert.deepEqual(
        harness.callLabels(),
        ["primary", "fallback-1", "fallback-2"],
        "unknown error on fallback-1 should still advance to fallback-2",
    );
});

test("contract errors on primary correctly skip fallback (regression)", async (t) => {
    // Sibling of `non-retryable errors on read methods skip fallback` above.
    // Kept as a regression guard so fixing the unknown-error behavior above
    // doesn't accidentally start cascading contract reverts across providers.
    const harness = new TransportHarness(t);
    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: fail("user rejected transaction", { code: "ACTION_REJECTED" }),
            },
        },
        {
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    await assert.rejects(() => wrapped.send("eth_call", []), /user rejected/);
    assert.equal(harness.getCalls("primary", "eth_call").length, 1);
    assert.equal(
        harness.getCalls("fallback", "eth_call").length,
        0,
        "contract/user errors must never cascade to fallbacks",
    );
});

// ---------------------------------------------------------------------------
// Worst-case latency budget — with defaults, a dying primary + healthy fallback
// must not leave the user staring at a loading spinner longer than the user
// will tolerate. At ~10s users start to assume the site is broken. Previous
// defaults (maxRetries: 3, timeoutMs: 10s) produced a ~82s ceiling on a two-
// provider cascade; the current policy targets ~17s worst case.
//
// These tests lock in the budget by simulation. Future config changes that
// restore excessive latency will visibly fail here rather than silently ship.
// ---------------------------------------------------------------------------

test("DEFAULT_RETRY_CONFIG keeps single-provider worst-case under 10 seconds", () => {
    // Math guardrail — independent of mock-timer plumbing. A two-provider
    // cascade is bounded by 2 × this value + fallback handshake overhead,
    // so keeping a single provider under 10s targets ~20s total worst case.
    const attempts = DEFAULT_RETRY_CONFIG.maxRetries + 1;
    const timeoutBudget = attempts * DEFAULT_RETRY_CONFIG.timeoutMs;
    const worstBackoff = DEFAULT_RETRY_CONFIG.maxRetries * DEFAULT_RETRY_CONFIG.maxDelay;
    const worstCase = timeoutBudget + worstBackoff;

    assert.ok(
        worstCase <= 10_000,
        `Single-provider worst case is ${worstCase}ms; cascade = ~${worstCase * 2}ms. ` +
        `Target <= 10_000ms per provider (~20s total) to keep users from bouncing.`,
    );
});

test("read with hanging primary and healthy fallback resolves within latency budget", async (t) => {
    // Behavioral guardrail — uses the ACTUAL default config, not harness overrides.
    // Budget is set to the Option C target (~17s). Failure here signals that the
    // default retry policy has drifted into "user-hostile" territory.
    const LATENCY_BUDGET_MS = 17_000;

    const harness = new TransportHarness(t);
    harness.enableMockTime();

    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                // Enough hangs to cover any retry count the defaults could specify.
                eth_call: [hang(), hang(), hang(), hang(), hang(), hang()],
            },
        },
        {
            // Intentionally use the production defaults, not harness overrides —
            // this test validates the shipped policy, not a test fixture.
            config: {
                maxRetries: DEFAULT_RETRY_CONFIG.maxRetries,
                timeoutMs: DEFAULT_RETRY_CONFIG.timeoutMs,
                baseDelay: DEFAULT_RETRY_CONFIG.baseDelay,
                maxDelay: DEFAULT_RETRY_CONFIG.maxDelay,
                backoffMultiplier: DEFAULT_RETRY_CONFIG.backoffMultiplier,
                retryableErrors: DEFAULT_RETRY_CONFIG.retryableErrors,
            },
            fallbacks: [
                {
                    label: "fallback",
                    send: {
                        eth_call: ok("fallback:eth_call:ok"),
                    },
                },
            ],
        },
    );

    let resolved = false;
    const promise = wrapped.send("eth_call", []).then((v: any) => {
        resolved = true;
        return v;
    });

    // Advance time in 500ms increments up to the budget ceiling so any
    // setTimeout-driven step (per-attempt timeout, backoff sleep) fires.
    for (let elapsed = 0; elapsed < LATENCY_BUDGET_MS && !resolved; elapsed += 500) {
        await harness.tick(500);
    }

    assert.ok(
        resolved,
        `Read did not resolve within ${LATENCY_BUDGET_MS}ms budget — ` +
        `dying primary + healthy fallback should not leave the user hanging.`,
    );
    assert.equal(await promise, "fallback:eth_call:ok");
});
