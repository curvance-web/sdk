import { config } from "dotenv";
config({ quiet: true });

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import Decimal from "decimal.js";
import { JsonRpcProvider, toBeHex, Wallet, type TransactionResponse } from "ethers";
import {
    all_markets,
    chain_config,
    configureRetries,
    getContractAddresses,
    getActiveUserMarkets,
    getActiveRetryConfig,
    refreshActiveUserMarkets,
    setup_config,
    setupChain,
    takePortfolioSnapshot,
    type address,
} from "../src";
import { NonceManagerSigner } from "./utils/helper";

const REQUIRED_ENV = ["ALCHEMY_API_KEY", "DEPLOYER_PRIVATE_KEY"] as const;
const MISSING_ENV = REQUIRED_ENV.filter((name) => !process.env[name]);
const FORK_SKIP = MISSING_ENV.length === 0
    ? undefined
    : `Dual-fork env not configured: set ${MISSING_ENV.join(", ")} in .env.`;

const TEST_API_URL = process.env.TEST_API_URL ?? "https://api.curvance.com";
const LOCAL_HOST = "127.0.0.1";
const MONAD_CHAIN_ID = 143n;
const ARB_CHAIN_ID = 421614n;
const MONAD_MARKET_NAME = "WMON | USDC";
const ARB_MARKET_NAME = "Stable Market";
const MONAD_DEPOSIT_AMOUNT = Decimal(1);
const RPC_READY_TIMEOUT_MS = 90_000;
const RPC_POLL_INTERVAL_MS = 500;
const LIVE_FORK_RPC_TIMEOUT_MS = 60_000;
const OUTPUT_LINE_LIMIT = 80;

const MONAD_TOKEN_BALANCE_SLOTS: Record<string, number> = {
    "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": 3, // WMON
    "0x754704bc059f8c67012fed69bc8a327a5aafb603": 9, // USDC
};

interface ManagedFork {
    label: string;
    port: number;
    rpcUrl: string;
    process: ChildProcess;
    output: string[];
    provider?: JsonRpcProvider;
    spawnError?: Error;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
}

if (FORK_SKIP != undefined) {
    console.warn(`[dual-fork-switch] ${FORK_SKIP}`);
}

function redactSecrets(value: string) {
    let redacted = value;
    for (const secret of [process.env.ALCHEMY_API_KEY, process.env.DEPLOYER_PRIVATE_KEY]) {
        if (secret) {
            redacted = redacted.split(secret).join("<redacted>");
        }
    }
    return redacted;
}

function appendOutput(fork: ManagedFork, chunk: Buffer) {
    const lines = redactSecrets(chunk.toString("utf8"))
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
    fork.output.push(...lines);
    if (fork.output.length > OUTPUT_LINE_LIMIT) {
        fork.output.splice(0, fork.output.length - OUTPUT_LINE_LIMIT);
    }
}

function forkOutput(fork: ManagedFork) {
    return fork.output.length === 0 ? "<no anvil output>" : fork.output.join("\n");
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, LOCAL_HOST, () => {
            const address = server.address();
            server.close(() => {
                if (address == null || typeof address === "string") {
                    reject(new Error("Could not allocate a local Anvil port."));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

function alchemyForkUrl(chain: "monad-mainnet" | "arb-sepolia") {
    return `https://${chain}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
}

async function waitForRpcChainId(fork: ManagedFork, expectedChainId: bigint) {
    const deadline = Date.now() + RPC_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (fork.spawnError != null) {
            throw fork.spawnError;
        }
        if (fork.exit != null) {
            throw new Error(
                `${fork.label} Anvil exited before becoming ready ` +
                `(code=${fork.exit.code ?? "null"} signal=${fork.exit.signal ?? "null"}).\n${forkOutput(fork)}`,
            );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_000);
        try {
            const response = await fetch(fork.rpcUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_chainId",
                    params: [],
                }),
                signal: controller.signal,
            });
            const body = await response.json() as { result?: string };
            if (typeof body.result === "string") {
                const actualChainId = BigInt(body.result);
                if (actualChainId !== expectedChainId) {
                    throw new Error(
                        `${fork.label} Anvil reported chainId ${actualChainId}, expected ${expectedChainId}.`,
                    );
                }
                return;
            }
        } catch (error) {
            if (error instanceof Error && /reported chainId/.test(error.message)) {
                throw error;
            }
        } finally {
            clearTimeout(timeout);
        }

        await delay(RPC_POLL_INTERVAL_MS);
    }

    throw new Error(
        `${fork.label} Anvil did not become ready within ${RPC_READY_TIMEOUT_MS}ms.\n${forkOutput(fork)}`,
    );
}

async function startAnvilFork(
    label: string,
    forkUrl: string,
    expectedChainId: bigint,
): Promise<ManagedFork> {
    const port = await getFreePort();
    const rpcUrl = `http://${LOCAL_HOST}:${port}`;
    const child = spawn("anvil", [
        "--fork-url",
        forkUrl,
        "--host",
        LOCAL_HOST,
        "--port",
        String(port),
        "--auto-impersonate",
    ], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const fork: ManagedFork = {
        label,
        port,
        rpcUrl,
        output: [],
        process: child,
    };
    child.stdout?.on("data", (chunk: Buffer) => appendOutput(fork, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(fork, chunk));
    child.once("error", (error) => {
        fork.spawnError = error;
    });
    child.once("exit", (code, signal) => {
        fork.exit = { code, signal };
    });

    try {
        await waitForRpcChainId(fork, expectedChainId);
    } catch (error) {
        await stopAnvilFork(fork);
        throw error;
    }
    fork.provider = new JsonRpcProvider(rpcUrl);
    return fork;
}

async function stopAnvilFork(fork: ManagedFork) {
    fork.provider?.destroy();
    if (fork.exit != null || fork.process.exitCode != null || fork.process.killed) {
        return;
    }

    fork.process.kill("SIGTERM");
    const exited = once(fork.process, "exit");
    const killed = delay(2_000).then(() => {
        if (fork.process.exitCode == null && !fork.process.killed) {
            fork.process.kill("SIGKILL");
        }
    });
    await Promise.race([exited, killed]);
}

async function mineBlock(provider: JsonRpcProvider) {
    await provider.send("evm_mine", []);
}

async function setNativeBalance(provider: JsonRpcProvider, account: address, amount: bigint) {
    await provider.send("anvil_setBalance", [account, toBeHex(amount)]);
    await mineBlock(provider);
}

async function setERC20Balance(
    provider: JsonRpcProvider,
    tokenAddress: address,
    account: address,
    balance: bigint,
    balanceSlot: number,
) {
    const { AbiCoder, keccak256 } = await import("ethers");
    const slot = keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["address", "uint256"],
            [account, balanceSlot],
        ),
    );
    const value = `0x${balance.toString(16).padStart(64, "0")}`;
    await provider.send("anvil_setStorageAt", [tokenAddress, slot, value]);
    await mineBlock(provider);
}

async function waitForTx(txLike: TransactionResponse | unknown) {
    if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === "function") {
        await (txLike as { wait: () => Promise<unknown> }).wait();
    }
}

function findMarket(markets: Awaited<ReturnType<typeof setupChain>>["markets"], name: string) {
    const market = markets.find((candidate) => candidate.name === name);
    assert.ok(market, `Expected ${name} to be present`);
    return market;
}

function findSeedableMonadToken(market: ReturnType<typeof findMarket>) {
    const token = market.tokens.find(
        (candidate) => MONAD_TOKEN_BALANCE_SLOTS[candidate.asset.address.toLowerCase()] != null,
    );
    assert.ok(token, `Expected ${MONAD_MARKET_NAME} to contain a seedable WMON or USDC token`);
    return token;
}

describe("Dual-fork chain switch E2E", { skip: FORK_SKIP }, () => {
    test("switches between live Monad and Arbitrum forks without losing provenance", { timeout: 420_000 }, async (t) => {
        const previousRetryConfig = getActiveRetryConfig();
        configureRetries({
            ...previousRetryConfig,
            maxRetries: 0,
            timeoutMs: LIVE_FORK_RPC_TIMEOUT_MS,
        });
        t.after(() => {
            configureRetries(previousRetryConfig);
        });

        const startedForks: ManagedFork[] = [];
        const forkStarts: [Promise<ManagedFork>, Promise<ManagedFork>] = [
            startAnvilFork("Monad", alchemyForkUrl("monad-mainnet"), MONAD_CHAIN_ID).then((fork) => {
                startedForks.push(fork);
                return fork;
            }),
            startAnvilFork("Arbitrum Sepolia", alchemyForkUrl("arb-sepolia"), ARB_CHAIN_ID).then((fork) => {
                startedForks.push(fork);
                return fork;
            }),
        ];

        t.after(async () => {
            await Promise.allSettled(forkStarts);
            await Promise.allSettled(startedForks.map(stopAnvilFork));
        });

        const [monadFork, arbFork] = await Promise.all(forkStarts);
        const monadProvider = monadFork.provider!;
        const arbProvider = arbFork.provider!;
        const originalMonadProvider = chain_config["monad-mainnet"].provider;
        const originalMonadFallbacks = [...chain_config["monad-mainnet"].fallbackProviders];
        const originalArbProvider = chain_config["arb-sepolia"].provider;
        const originalArbFallbacks = [...chain_config["arb-sepolia"].fallbackProviders];
        (chain_config["monad-mainnet"] as any).provider = monadProvider;
        (chain_config["monad-mainnet"] as any).fallbackProviders = [];
        (chain_config["arb-sepolia"] as any).provider = arbProvider;
        (chain_config["arb-sepolia"] as any).fallbackProviders = [];
        t.after(() => {
            (chain_config["monad-mainnet"] as any).provider = originalMonadProvider;
            (chain_config["monad-mainnet"] as any).fallbackProviders = originalMonadFallbacks;
            (chain_config["arb-sepolia"] as any).provider = originalArbProvider;
            (chain_config["arb-sepolia"] as any).fallbackProviders = originalArbFallbacks;
        });

        const privateKey = process.env.DEPLOYER_PRIVATE_KEY!;
        const monadWallet = new Wallet(privateKey, monadProvider);
        const arbWallet = new Wallet(privateKey, arbProvider);
        const monadSigner = new NonceManagerSigner(monadWallet, await monadWallet.getNonce("latest"));
        const arbSigner = new NonceManagerSigner(arbWallet, await arbWallet.getNonce("latest"));
        const account = monadSigner.address as address;

        assert.equal(arbSigner.address.toLowerCase(), account.toLowerCase());
        await assert.rejects(
            () => setupChain("arb-sepolia", arbSigner, TEST_API_URL, {
                readProvider: monadProvider,
            }),
            /Read provider is connected to chainId 143 but setupChain\('arb-sepolia'\) expects 421614\./i,
        );
        await setNativeBalance(monadProvider, account, 100_000_000_000_000_000_000n);

        const monadResult = await setupChain("monad-mainnet", monadSigner, TEST_API_URL, {
            readProvider: monadProvider,
        });
        const monadMarket = findMarket(monadResult.markets, MONAD_MARKET_NAME);
        const monadToken = findSeedableMonadToken(monadMarket);
        const balanceSlot = MONAD_TOKEN_BALANCE_SLOTS[monadToken.asset.address.toLowerCase()];
        assert.notEqual(balanceSlot, undefined, `Missing seed slot for ${monadToken.asset.symbol}`);

        const seededBalance = 100_000n * (10n ** monadToken.asset.decimals);
        await setERC20Balance(
            monadProvider,
            monadToken.asset.address,
            account,
            seededBalance,
            balanceSlot!,
        );
        await monadMarket.reloadUserData(account);
        const collateralBefore = monadToken.getUserCollateralAssets();

        await waitForTx(await monadToken.approveUnderlying());
        await waitForTx(await monadToken.depositAsCollateral(MONAD_DEPOSIT_AMOUNT));
        await monadMarket.reloadUserData(account);
        const collateralAfter = monadToken.getUserCollateralAssets();
        assert(
            collateralAfter.gt(collateralBefore),
            `Expected Monad collateral to increase after deposit; before=${collateralBefore} after=${collateralAfter}`,
        );

        const arbResult = await setupChain("arb-sepolia", arbSigner, TEST_API_URL, {
            readProvider: arbProvider,
        });
        const arbContracts = getContractAddresses("arb-sepolia");
        const stableMarketAddress = (arbContracts.markets as Record<string, { address: address }>)[ARB_MARKET_NAME]?.address;
        assert.ok(stableMarketAddress, `Expected ${ARB_MARKET_NAME} deployment metadata`);
        const arbStableMarket = arbResult.markets.find(
            (market) => market.address.toLowerCase() === stableMarketAddress.toLowerCase(),
        );
        assert.ok(arbStableMarket, `Expected deployed ${ARB_MARKET_NAME} to boot on Arbitrum Sepolia`);
        assert.equal(arbResult.chain, "arb-sepolia");
        assert.equal(arbResult.chainId, Number(ARB_CHAIN_ID));
        assert.equal(setup_config.chain, "arb-sepolia");
        assert.equal(all_markets, arbResult.markets);
        assert.equal(monadResult.setupConfigSnapshot.chain, "monad-mainnet");
        assert.equal(monadMarket.setup.chain, "monad-mainnet");
        assert.equal(monadMarket.account?.toLowerCase(), account.toLowerCase());

        await monadMarket.reloadUserData(account);
        assert(
            monadToken.getUserCollateralAssets().gte(collateralAfter),
            "Expected the old Monad market object to keep reading from the Monad fork after switching to Arb",
        );
        assert.equal(setup_config.chain, "arb-sepolia");
        assert.equal(all_markets, arbResult.markets);

        const explicitMonadActiveMarkets = await refreshActiveUserMarkets(account, monadResult.markets);
        assert.equal(
            explicitMonadActiveMarkets.some((market) => market.address.toLowerCase() === monadMarket.address.toLowerCase()),
            true,
            "Expected explicit Monad active refresh to include the deposited Monad market",
        );
        assert.equal(
            explicitMonadActiveMarkets.every((market) => market.setup.chain === "monad-mainnet"),
            true,
            "Expected explicit Monad active refresh to stay on Monad markets",
        );
        assert.equal(
            getActiveUserMarkets().every((market) => market.setup.chain === "arb-sepolia"),
            true,
            "Expected default active-market helper to read from the latest Arb globals",
        );
        assert.equal(setup_config.chain, "arb-sepolia");
        assert.equal(all_markets, arbResult.markets);

        const monadSnapshot = await takePortfolioSnapshot(account, {
            markets: monadResult.markets,
            refresh: true,
        });
        assert.equal(monadSnapshot.chain, "monad-mainnet");
        assert.equal(
            monadSnapshot.markets.some(
                (market) =>
                    market.marketAddress.toLowerCase() === monadMarket.address.toLowerCase() &&
                    market.chain === "monad-mainnet" &&
                    market.chainId === Number(MONAD_CHAIN_ID),
            ),
            true,
        );
        const arbSnapshot = await takePortfolioSnapshot(account, {
            markets: arbResult.markets,
        });
        assert.equal(arbSnapshot.chain, "arb-sepolia");
        assert.equal(
            arbSnapshot.markets.every((market) => market.chain === "arb-sepolia" && market.chainId === Number(ARB_CHAIN_ID)),
            true,
        );
        assert.equal(setup_config.chain, "arb-sepolia");
        assert.equal(all_markets, arbResult.markets);

        const monadAgain = await setupChain("monad-mainnet", monadSigner, TEST_API_URL, {
            readProvider: monadProvider,
        });
        const monadMarketAgain = findMarket(monadAgain.markets, MONAD_MARKET_NAME);
        const monadTokenAgain = monadMarketAgain.tokens.find(
            (token) => token.address.toLowerCase() === monadToken.address.toLowerCase(),
        );
        assert.ok(monadTokenAgain, `Expected ${monadToken.symbol} to exist after switching back`);
        await monadMarketAgain.reloadUserData(account);
        assert(
            monadTokenAgain.getUserCollateralAssets().gte(collateralAfter),
            "Expected the Monad fork deposit to remain visible after switching away and back",
        );
        assert.equal(setup_config.chain, "monad-mainnet");
        assert.equal(all_markets, monadAgain.markets);

        const arbToken = arbStableMarket.tokens[0];
        assert.ok(arbToken, `Expected ${ARB_MARKET_NAME} to include at least one token`);
        await assert.rejects(
            () => monadMarketAgain.previewPositionHealth(arbToken as any, null, true, Decimal(1)),
            /Deposit token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
        );
    });
});
