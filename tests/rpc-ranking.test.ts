import assert from "node:assert/strict";
import test from "node:test";
import { resetRpcDebugState, RetryableProvider } from "../src/retry-provider";
import { TransportHarness, fail, ok } from "./support/transport-harness";

test.beforeEach(() => {
    resetRpcDebugState();
});

test("ranking prefers the healthier fallback when stability weight dominates", async (t) => {
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
            config: {
                fallbackCooldownMs: 0,
                rankWeights: { latency: 0, stability: 1 },
            },
            fallbacks: [
                {
                    label: "fallback-1",
                    send: {
                        eth_call: [
                            fail("timeout: fallback-1 eth_call"),
                            ok("fallback-1:eth_call:recovered"),
                        ],
                    },
                },
                {
                    label: "fallback-2",
                    send: {
                        eth_call: [
                            ok("fallback-2:eth_call:healthy"),
                            ok("fallback-2:eth_call:preferred"),
                        ],
                    },
                },
            ],
        },
    );

    const first = await wrapped.send("eth_call", []);
    assert.equal(first, "fallback-2:eth_call:healthy");

    const second = await wrapped.send("eth_call", []);
    assert.equal(second, "fallback-2:eth_call:preferred");

    assert.deepEqual(
        harness.callLabels(),
        ["primary", "fallback-1", "fallback-2", "primary", "fallback-2"],
        "once fallback-1 has a worse success rate, fallback-2 should be tried first",
    );
});

test("ranking prefers the faster fallback when latency weight dominates", async (t) => {
    const harness = new TransportHarness(t);
    harness.enableMockTime();

    const wrapped = harness.wrapReadProvider(
        RetryableProvider,
        {
            label: "primary",
            send: {
                eth_call: [
                    fail("timeout: primary eth_call"),
                    fail("timeout: primary eth_call"),
                    fail("timeout: primary eth_call"),
                ],
            },
        },
        {
            config: {
                fallbackCooldownMs: 0,
                rankWeights: { latency: 1, stability: 0 },
                timeoutMs: 50,
            },
            fallbacks: [
                {
                    label: "fallback-1",
                    send: {
                        eth_call: [
                            ok("fallback-1:eth_call:slow", 20),
                            fail("timeout: fallback-1 eth_call"),
                        ],
                    },
                },
                {
                    label: "fallback-2",
                    send: {
                        eth_call: [
                            ok("fallback-2:eth_call:fast", 1),
                            ok("fallback-2:eth_call:preferred", 1),
                        ],
                    },
                },
            ],
        },
    );

    const firstPromise = wrapped.send("eth_call", []);
    await harness.flush();
    await harness.tick(20);
    const first = await firstPromise;
    assert.equal(first, "fallback-1:eth_call:slow");

    const secondPromise = wrapped.send("eth_call", []);
    await harness.flush();
    await harness.tick(1);
    const second = await secondPromise;
    assert.equal(second, "fallback-2:eth_call:fast");

    const thirdPromise = wrapped.send("eth_call", []);
    await harness.flush();
    await harness.tick(1);
    const third = await thirdPromise;
    assert.equal(third, "fallback-2:eth_call:preferred");

    assert.deepEqual(
        harness.callLabels(),
        ["primary", "fallback-1", "primary", "fallback-1", "fallback-2", "primary", "fallback-2"],
        "after both endpoints are sampled, the lower-latency fallback should lead the order",
    );
});
