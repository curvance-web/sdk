import assert from "node:assert/strict";
import test from "node:test";
import { getRpcDebugSnapshot, resetRpcDebugState, RetryableProvider } from "../src/retry-provider";
import { TransportHarness, fail, hang, ok } from "./support/transport-harness";

test.beforeEach(() => {
    resetRpcDebugState();
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
