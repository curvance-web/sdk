import assert from "node:assert/strict";
import test from "node:test";
import { chain_rpc_config } from "../src/chains/rpc";

// ─── RPC config structural invariants ───────────────────────────────────────
//
// Cheap static checks on chain_rpc_config that would have caught classes of
// real bugs:
//  - 2026-04-16: monadinfra left as primary despite origin-blocking
//    staging.curvance.com. Diagnosed via app/scripts/rpc-probe.mjs. If a
//    future merge re-adds a known-bad RPC to the primary slot, the probe is
//    manual-only and won't catch it. These tests catch shape regressions.
//  - General: primary = fallbacks[0] (duplicate entry), http:// URLs
//    (downgrade), empty fallback lists, mismatched chain keys.
//
// Scope: structure only. Reachability / correctness is measured by
// app/scripts/rpc-probe.mjs (manual, pre-publish).

test("every chain has a non-empty primary URL", () => {
    for (const [chain, config] of Object.entries(chain_rpc_config)) {
        assert.equal(
            typeof config.primary, "string",
            `${chain}: primary must be a string`,
        );
        assert.ok(
            config.primary.length > 0,
            `${chain}: primary must be non-empty`,
        );
    }
});

test("every URL uses https:// or wss://", () => {
    for (const [chain, config] of Object.entries(chain_rpc_config)) {
        const urls = [config.primary, ...config.fallbacks];
        for (const url of urls) {
            assert.ok(
                url.startsWith("https://") || url.startsWith("wss://"),
                `${chain}: insecure URL rejected — ${url}. Use https:// or wss://.`,
            );
        }
    }
});

test("primary URL does not appear in its own fallbacks list", () => {
    for (const [chain, config] of Object.entries(chain_rpc_config)) {
        // Normalize trailing slashes so /foo and /foo/ don't sneak past.
        const norm = (u: string) => u.replace(/\/+$/, "");
        const primary = norm(config.primary);
        for (const fallback of config.fallbacks) {
            assert.notEqual(
                norm(fallback), primary,
                `${chain}: primary (${config.primary}) appears in fallbacks — ` +
                `duplicate entry means retries + fallback both hit the same endpoint.`,
            );
        }
    }
});

test("fallbacks list has no duplicates within itself", () => {
    for (const [chain, config] of Object.entries(chain_rpc_config)) {
        const norm = (u: string) => u.replace(/\/+$/, "");
        const normalized = config.fallbacks.map(norm);
        const unique = new Set(normalized);
        assert.equal(
            unique.size, normalized.length,
            `${chain}: duplicate fallback URLs — ${config.fallbacks.join(", ")}`,
        );
    }
});

test("known-bad RPCs are not in the active cascade", () => {
    // monadinfra returns 403 + missing Access-Control-Allow-Origin for
    // staging.curvance.com / app.curvance.com origins (verified 2026-04-16
    // via app/scripts/rpc-probe.mjs). Keep it out of any primary/fallback
    // slot until/unless they lift the origin restriction AND prove stable
    // under concurrent load.
    //
    // To add a new known-bad entry: measure via rpc-probe.mjs, document the
    // failure mode in a comment, then add the hostname to this list.
    const KNOWN_BAD = [
        "rpc-mainnet.monadinfra.com",
    ];

    for (const [chain, config] of Object.entries(chain_rpc_config)) {
        const urls = [config.primary, ...config.fallbacks];
        for (const url of urls) {
            for (const bad of KNOWN_BAD) {
                assert.ok(
                    !url.includes(bad),
                    `${chain}: ${bad} is a known-bad RPC but appears in the ` +
                    `cascade as ${url}. Remove or replace.`,
                );
            }
        }
    }
});

test("policy fields have sane values", () => {
    for (const [chain, config] of Object.entries(chain_rpc_config)) {
        assert.ok(
            config.retryCount >= 0 && config.retryCount <= 3,
            `${chain}: retryCount ${config.retryCount} outside sane range 0-3`,
        );
        assert.ok(
            config.timeoutMs >= 1_000 && config.timeoutMs <= 30_000,
            `${chain}: timeoutMs ${config.timeoutMs} outside sane range 1000-30000`,
        );
        // Single-provider worst case: retryCount retries × timeoutMs per
        // attempt. Lock to ~10s so the primary + one fallback stays within
        // the ~20s user tolerance window.
        const singleProviderMs = (config.retryCount + 1) * config.timeoutMs;
        assert.ok(
            singleProviderMs <= 10_000,
            `${chain}: single-provider worst case (${singleProviderMs}ms) ` +
            `exceeds 10s budget. Users will assume the site is broken before ` +
            `we even try the fallback.`,
        );
    }
});
