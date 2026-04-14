import assert from "node:assert/strict";
import test from "node:test";
import { Api } from "../src/classes/Api";
import { Market } from "../src/classes/Market";
import { all_markets, setup_config, setupChain } from "../src/setup";

function defer<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });

    return { promise, resolve };
}

test("setupChain only publishes the latest invocation", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;

    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url, approvalProtection: activeSetup.approval_protection }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, false, "https://api.older.example");
    const newerSetup = setupChain("monad-mainnet", null, true, "https://api.newer.example");

    rewardsB.resolve({ milestones: {}, incentives: {} });
    const newerResult = await newerSetup;

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const olderResult = await olderSetup;

    assert.equal(setup_config.api_url, "https://api.newer.example");
    assert.equal(setup_config.approval_protection, true);
    assert.equal(setup_config.signer, null);
    assert.equal(setup_config.account, null);
    assert.equal(setup_config.provider, setup_config.readProvider);
    assert.deepEqual(all_markets, newerResult.markets);
    assert.notDeepEqual(all_markets, olderResult.markets);
    assert.equal((newerResult.markets[0] as any).marker, "https://api.newer.example");
    assert.equal((olderResult.markets[0] as any).marker, "https://api.older.example");
});

test("setupChain keeps signer writes separate from dedicated read transport", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
    } as any;

    let captured: {
        provider: any;
        signer: any;
        account: any;
        setup: typeof setup_config | null;
    } = {
        provider: null,
        signer: null,
        account: null,
        setup: null,
    };

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, provider, signer, account, _milestones, _incentives, setup) => {
        captured = {
            provider,
            signer,
            account,
            setup: setup ?? null,
        };
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await setupChain("monad-mainnet", fakeSigner, false, "https://api.example");

    assert.equal(setup_config.signer, fakeSigner);
    assert.equal(setup_config.account, fakeSigner.address);
    assert.equal(setup_config.provider, fakeSigner);
    assert.notEqual(setup_config.readProvider, fakeSigner);
    assert.equal(captured.signer, fakeSigner);
    assert.equal(captured.account, fakeSigner.address);
    assert.equal(captured.setup, setup_config);
    assert.equal(captured.provider, setup_config.readProvider);
    assert.notEqual(captured.provider, fakeSigner);
});
