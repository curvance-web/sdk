import assert from "node:assert/strict";
import test from "node:test";
import { fetchMerklOpportunities } from "../src/integrations/merkl";

test("fetchMerklOpportunities forwards action and chainId in the request URL", async (t) => {
    const originalFetch = globalThis.fetch;
    let requestedUrl: string | null = null;

    globalThis.fetch = (async (input: string | URL | Request) => {
        requestedUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;

        return {
            ok: true,
            json: async () => [],
        } as Response;
    }) as typeof fetch;

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await fetchMerklOpportunities({ action: "LEND", chainId: 421614 });

    assert.notEqual(requestedUrl, null);
    const url = new URL(requestedUrl!);
    assert.equal(url.searchParams.get("mainProtocolId"), "curvance");
    assert.equal(url.searchParams.get("action"), "LEND");
    assert.equal(url.searchParams.get("chainId"), "421614");
});
