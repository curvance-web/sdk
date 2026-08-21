import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import {
    BrowserProvider,
    JsonRpcProvider,
    JsonRpcSigner,
    type Eip1193Provider,
    type TransactionResponse,
} from "ethers";
import { CToken, type address } from "../src";

/**
 * Local end-to-end regression for post-broadcast wallet-provider failures.
 *
 * Run with:
 *   npm run test:transaction-recovery
 */

const LOCAL_HOST = "127.0.0.1";
const CHAIN_ID = 31_337n;
const RPC_READY_TIMEOUT_MS = 10_000;
const RPC_POLL_INTERVAL_MS = 100;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const ANVIL_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as address;
const STATE_TARGET = "0x1000000000000000000000000000000000000001" as address;

// Increment storage slot 0 on every call:
// PUSH1 0, SLOAD, PUSH1 1, ADD, PUSH1 0, SSTORE, STOP.
const INCREMENT_SLOT_ZERO_RUNTIME_CODE = "0x60005460010160005500";

interface ManagedAnvil {
    process: ChildProcess;
    rpcUrl: string;
    output: string[];
    spawnError?: Error;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
}

class PostBroadcastFaultProvider implements Eip1193Provider {
    readonly methods: string[] = [];
    readonly submittedHashes: string[] = [];
    corruptedTransactionReads = 0;

    constructor(private readonly rpc: JsonRpcProvider) {}

    async request({ method, params }: { method: string; params?: unknown[] | object }): Promise<any> {
        this.methods.push(method);
        const rpcParams = Array.isArray(params) ? params : [];
        const result = await this.rpc.send(method, rpcParams);

        if (method === "eth_sendTransaction") {
            assert.equal(typeof result, "string", "eth_sendTransaction must return a transaction hash");
            this.submittedHashes.push(result);
            return result;
        }

        if (
            method === "eth_getTransactionByHash" &&
            this.corruptedTransactionReads === 0 &&
            result != null &&
            this.submittedHashes.includes(rpcParams[0] as string)
        ) {
            this.corruptedTransactionReads += 1;
            return {
                ...result,
                nonce: null,
            };
        }

        return result;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStorageSlotZero(rpc: JsonRpcProvider): Promise<bigint> {
    return BigInt(await rpc.send("eth_getStorageAt", [STATE_TARGET, "0x0", "latest"]));
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, LOCAL_HOST, () => {
            const serverAddress = server.address();
            server.close(() => {
                if (serverAddress == null || typeof serverAddress === "string") {
                    reject(new Error("Could not allocate a local Anvil port."));
                    return;
                }
                resolve(serverAddress.port);
            });
        });
    });
}

function appendOutput(anvil: ManagedAnvil, chunk: Buffer): void {
    anvil.output.push(
        ...chunk.toString("utf8")
            .split(/\r?\n/)
            .filter((line) => line.length > 0),
    );
    if (anvil.output.length > 50) {
        anvil.output.splice(0, anvil.output.length - 50);
    }
}

function anvilOutput(anvil: ManagedAnvil): string {
    return anvil.output.length === 0 ? "<no Anvil output>" : anvil.output.join("\n");
}

async function waitForAnvil(anvil: ManagedAnvil): Promise<void> {
    const deadline = Date.now() + RPC_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (anvil.spawnError != null) {
            throw new Error(
                `Could not start Anvil. Install Foundry or set ANVIL_BIN. ${anvil.spawnError.message}`,
            );
        }
        if (anvil.exit != null) {
            throw new Error(
                `Anvil exited before becoming ready ` +
                `(code=${anvil.exit.code ?? "null"} signal=${anvil.exit.signal ?? "null"}).\n` +
                anvilOutput(anvil),
            );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 500);
        try {
            const response = await fetch(anvil.rpcUrl, {
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
            if (body.result != null) {
                assert.equal(BigInt(body.result), CHAIN_ID, "Anvil must use the expected local chain ID");
                return;
            }
        } catch (error) {
            if (error instanceof assert.AssertionError) {
                throw error;
            }
        } finally {
            clearTimeout(timeout);
        }

        await delay(RPC_POLL_INTERVAL_MS);
    }

    throw new Error(
        `Anvil did not become ready within ${RPC_READY_TIMEOUT_MS}ms.\n${anvilOutput(anvil)}`,
    );
}

async function startAnvil(): Promise<ManagedAnvil> {
    const port = await getFreePort();
    const child = spawn(process.env.ANVIL_BIN ?? "anvil", [
        "--host",
        LOCAL_HOST,
        "--port",
        String(port),
        "--chain-id",
        CHAIN_ID.toString(),
        "--silent",
    ], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const anvil: ManagedAnvil = {
        process: child,
        rpcUrl: `http://${LOCAL_HOST}:${port}`,
        output: [],
    };
    child.stdout?.on("data", (chunk: Buffer) => appendOutput(anvil, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(anvil, chunk));
    child.once("error", (error) => {
        anvil.spawnError = error;
    });
    child.once("exit", (code, signal) => {
        anvil.exit = { code, signal };
    });

    try {
        await waitForAnvil(anvil);
        return anvil;
    } catch (error) {
        await stopAnvil(anvil);
        throw error;
    }
}

async function stopAnvil(anvil: ManagedAnvil): Promise<void> {
    if (anvil.exit != null || anvil.process.exitCode != null) {
        return;
    }

    let forceKillTimer: NodeJS.Timeout | undefined;
    const exited = once(anvil.process, "exit");
    anvil.process.kill("SIGTERM");
    const forcedExit = new Promise<void>((resolve) => {
        forceKillTimer = setTimeout(() => {
            if (anvil.process.exitCode == null) {
                anvil.process.kill("SIGKILL");
            }
            resolve();
        }, PROCESS_EXIT_TIMEOUT_MS);
    });
    try {
        await Promise.race([exited, forcedExit]);
    } finally {
        if (forceKillTimer != null) {
            clearTimeout(forceKillTimer);
        }
    }
}

test("recovers a real mined transaction after a malformed wallet-side lookup", { timeout: 30_000 }, async (t) => {
    const anvil = await startAnvil();
    const rpc = new JsonRpcProvider(anvil.rpcUrl);
    const faultProvider = new PostBroadcastFaultProvider(rpc);
    const browserProvider = new BrowserProvider(faultProvider, "any");
    const signer = new JsonRpcSigner(browserProvider, ANVIL_ACCOUNT);

    t.after(async () => {
        browserProvider.destroy();
        rpc.destroy();
        await stopAnvil(anvil);
    });

    await rpc.send("anvil_setCode", [STATE_TARGET, INCREMENT_SLOT_ZERO_RUNTIME_CODE]);
    assert.equal(
        await rpc.send("eth_getCode", [STATE_TARGET, "latest"]),
        INCREMENT_SLOT_ZERO_RUNTIME_CODE,
        "the local state target must contain the incrementing runtime code",
    );
    const startingNonce = BigInt(await rpc.send("eth_getTransactionCount", [ANVIL_ACCOUNT, "latest"]));
    const startingValue = await readStorageSlotZero(rpc);
    assert.equal(startingValue, 0n);

    const lifecycle: string[] = [];
    const recoveryHashes: string[] = [];
    let refreshedValue: bigint | null = null;
    const recoveryProvider = {
        getTransaction: async (hash: string): Promise<TransactionResponse | null> => {
            recoveryHashes.push(hash);
            const transaction = await rpc.getTransaction(hash);
            if (transaction == null) {
                return null;
            }

            return new Proxy(transaction, {
                get(target, property) {
                    if (property === "wait") {
                        return async (...args: Parameters<TransactionResponse["wait"]>) => {
                            lifecycle.push("wait");
                            return target.wait(...args);
                        };
                    }

                    const value = Reflect.get(target, property, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
        },
    };

    const token = Object.create(CToken.prototype) as CToken;
    (token as any).address = STATE_TARGET;
    (token as any).provider = recoveryProvider;
    (token as any).market = {
        signer,
        reloadUserData: async (account: address) => {
            lifecycle.push("reload");
            assert.equal(account.toLowerCase(), ANVIL_ACCOUNT.toLowerCase());
            refreshedValue = await readStorageSlotZero(rpc);
        },
    };

    const transaction = await token.oracleRoute("0x" as any, { gasLimit: 100_000n });
    const submittedHash = faultProvider.submittedHashes[0];
    assert.ok(submittedHash, "the wallet provider must report the broadcast hash");
    assert.equal(transaction.hash, submittedHash);

    const receipt = await rpc.getTransactionReceipt(submittedHash);
    assert.ok(receipt, "the broadcast transaction must be mined");
    assert.equal(receipt.status, 1);
    assert.equal(
        BigInt(await rpc.send("eth_getTransactionCount", [ANVIL_ACCOUNT, "latest"])),
        startingNonce + 1n,
    );
    assert.equal(
        await readStorageSlotZero(rpc),
        1n,
        "the state change must execute exactly once",
    );
    assert.equal(refreshedValue, 1n, "the SDK refresh must observe the settled state");

    assert.equal(
        faultProvider.methods.filter((method) => method === "eth_sendTransaction").length,
        1,
        "recovery must never resubmit the transaction",
    );
    assert.equal(faultProvider.corruptedTransactionReads, 1);
    assert.deepEqual(recoveryHashes, [submittedHash]);
    assert.deepEqual(lifecycle, ["wait", "reload"]);
});
