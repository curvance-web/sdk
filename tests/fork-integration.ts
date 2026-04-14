import { config } from "dotenv";
config({ quiet: true });

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import Decimal from "decimal.js";
import { Wallet } from "ethers";
import { type Market } from "../src/classes/Market";
import { refreshActiveUserMarkets, setup_config, setupChain } from "../src/setup";
import type { ChainRpcPrefix, address } from "../src";
import { TestFramework } from "./utils/TestFramework";

const TEST_CHAIN = (process.env.TEST_CHAIN ?? "monad-mainnet") as ChainRpcPrefix;
const TEST_API_URL = process.env.TEST_API_URL ?? "https://api.curvance.com";
const TARGET_MARKET = "earnAUSD | AUSD";
const DEPOSIT_AMOUNT = Decimal(250);
const HAS_FORK_ENV = Boolean(process.env.TEST_RPC);
const describeFork = HAS_FORK_ENV ? describe : describe.skip;
const FORK_TEST_PRIVATE_KEY = Wallet.createRandom().privateKey;

if (!HAS_FORK_ENV) {
    console.warn(
        "[test:fork] Skipping fork integration because TEST_RPC is not set. " +
        "Point TEST_RPC at an Anvil-compatible fork RPC. Optional: TEST_CHAIN, TEST_API_URL."
    );
}

function findMarket(markets: Market[], marketAddress: address): Market {
    const market = markets.find((candidate) => candidate.address === marketAddress);
    assert.ok(market, `Expected market ${marketAddress} to be present`);
    return market;
}

function findToken(market: Market, tokenAddress: address) {
    const token = market.tokens.find((candidate) => candidate.address === tokenAddress);
    assert.ok(token, `Expected token ${tokenAddress} in market ${market.address}`);
    return token;
}

if (!HAS_FORK_ENV) {
    test("fork integration requires TEST_RPC", { skip: true }, () => {
        assert.fail("Set TEST_RPC to an Anvil-compatible fork before running test:fork.");
    });
}

describeFork("Fork integration", () => {
    let framework: TestFramework;

    before(async () => {
        framework = await TestFramework.init(FORK_TEST_PRIVATE_KEY, TEST_CHAIN, {
            seedNativeBalance: true,
            seedUnderlying: true,
            snapshot: true,
            log: false,
            apiUrl: TEST_API_URL,
        });
    });

    after(async () => {
        await framework.destroy();
    });

    afterEach(async () => {
        await framework.reset();
    });

    test("public account-only setup rehydrates signer-created state on the fork", async () => {
        const publicBefore = await setupChain(TEST_CHAIN, null, true, TEST_API_URL, {
            account: framework.account,
            readProvider: framework.provider,
        });
        const [signerMarket, signerToken] = await framework.getMarket(TARGET_MARKET);
        const beforeMarket = findMarket(publicBefore.markets, signerMarket.address);
        const beforeToken = findToken(beforeMarket, signerToken.address);

        assert.equal(beforeToken.cache.userAssetBalance, 0n);
        assert.equal(beforeMarket.cache.user.collateral, 0n);

        await signerToken.approveUnderlying();
        await signerToken.depositAsCollateral(DEPOSIT_AMOUNT);
        await signerMarket.reloadUserData(framework.account);

        const signerAssetBalance = signerToken.cache.userAssetBalance;
        assert.ok(signerAssetBalance > 0n, "Expected signer-side cache to reflect the new deposit");

        const publicAfter = await setupChain(TEST_CHAIN, null, true, TEST_API_URL, {
            account: framework.account,
            readProvider: framework.provider,
        });
        const afterMarket = findMarket(publicAfter.markets, signerMarket.address);
        const afterToken = findToken(afterMarket, signerToken.address);

        assert.equal(setup_config.signer, null);
        assert.equal(setup_config.account, framework.account);
        assert.equal(afterMarket.signer, null);
        assert.equal(afterMarket.account, framework.account);
        assert.equal(afterToken.cache.userAssetBalance, signerAssetBalance);
        assert.equal(afterMarket.cache.user.collateral, signerMarket.cache.user.collateral);
    });

    test("getMarketStates targeted refresh matches live market cache after a write", async () => {
        const [market, token] = await framework.getMarket(TARGET_MARKET);

        await token.approveUnderlying();
        await token.depositAsCollateral(DEPOSIT_AMOUNT);
        await market.reloadUserData(framework.account);

        const { dynamicMarkets, userMarkets } = await framework.curvance.reader.getMarketStates([market.address], framework.account);

        assert.equal(dynamicMarkets.length, 1);
        assert.equal(userMarkets.length, 1);

        const dynamicMarket = dynamicMarkets[0]!;
        const userMarket = userMarkets[0]!;
        const dynamicToken = dynamicMarket.tokens.find((candidate) => candidate.address === token.address);
        const userToken = userMarket.tokens.find((candidate) => candidate.address === token.address);

        assert.ok(dynamicToken, "Expected targeted refresh to include the deposited token in dynamic state");
        assert.ok(userToken, "Expected targeted refresh to include the deposited token in user state");
        assert.equal(dynamicMarket.address, market.address);
        assert.equal(dynamicToken.exchangeRate, token.cache.exchangeRate);
        assert.equal(dynamicToken.totalAssets, token.cache.totalAssets);
        assert.equal(userMarket.collateral, market.cache.user.collateral);
        assert.equal(userToken.userAssetBalance, token.cache.userAssetBalance);
        assert.equal(userToken.userCollateral, token.cache.userCollateral);
    });

    test("refreshActiveUserMarkets returns only the markets that became active on-chain", async () => {
        const [targetMarket, targetToken] = await framework.getMarket(TARGET_MARKET);

        await targetToken.approveUnderlying();
        await targetToken.depositAsCollateral(DEPOSIT_AMOUNT);
        await targetMarket.reloadUserData(framework.account);

        const refreshed = await refreshActiveUserMarkets(framework.account, framework.curvance.markets);

        assert.deepEqual(
            refreshed.map((market) => market.address),
            [targetMarket.address],
        );
        assert.equal(refreshed[0], targetMarket);
        assert.ok(targetMarket.hasUserActivity(), "Expected the deposited market to be active after refresh");
    });
});
