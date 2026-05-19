import assert from "node:assert/strict";
import test from "node:test";
import { Api } from "../src/classes/Api";
import { ERC20 } from "../src/classes/ERC20";
import { Market } from "../src/classes/Market";
import { NativeToken } from "../src/classes/NativeToken";
import { OracleManager } from "../src/classes/OracleManager";
import { OptimizerReader } from "../src/classes/OptimizerReader";
import { ProtocolReader } from "../src/classes/ProtocolReader";
import { LendingOptimizer } from "../src/classes/LendingOptimizer";
import * as helpers from "../src/helpers";
import * as setupModule from "../src/setup";

const TOKEN = "0x00000000000000000000000000000000000000a1";
const ORACLE_A = "0x00000000000000000000000000000000000000b1";
const ORACLE_B = "0x00000000000000000000000000000000000000b2";
const READER = "0x00000000000000000000000000000000000000c1";
const OPTIMIZER = "0x00000000000000000000000000000000000000d1";

const originalOracleManagerGetPrice = OracleManager.prototype.getPrice;
const originalSetupConfig = (setupModule as any).setup_config;
const originalContractSetup = (helpers as any).contractSetup;

function setSetupConfig(oracleManager: string, readProvider: any = {} as any) {
    (setupModule as any).setup_config = {
        chain: "monad-mainnet",
        contracts: {
            OracleManager: oracleManager,
        },
        readProvider,
        signer: null,
        account: null,
        provider: readProvider,
        api_url: "https://api.curvance.test",
        feePolicy: {
            getFeeBps: () => 0n,
            feeReceiver: undefined,
        },
    };
}

test.afterEach(() => {
    OracleManager.prototype.getPrice = originalOracleManagerGetPrice;
    (setupModule as any).setup_config = originalSetupConfig;
    (helpers as any).contractSetup = originalContractSetup;
});

test("ERC20 captures OracleManager context at construction time", async () => {
    const observedAddresses: string[] = [];
    OracleManager.prototype.getPrice = async function () {
        observedAddresses.push(this.address);
        return 111n;
    };

    setSetupConfig(ORACLE_A);
    const token = new ERC20({} as any, TOKEN as any);

    setSetupConfig(ORACLE_B);
    const price = await token.getPrice(false, true, false);

    assert.equal(price, 111n);
    assert.deepEqual(observedAddresses, [ORACLE_A]);
});

test("NativeToken captures OracleManager context at construction time", async () => {
    const observedAddresses: string[] = [];
    OracleManager.prototype.getPrice = async function () {
        observedAddresses.push(this.address);
        return 222n;
    };

    setSetupConfig(ORACLE_A);
    const token = new NativeToken("monad-mainnet", {} as any);

    setSetupConfig(ORACLE_B);
    const price = await token.getPrice(false, true, false);

    assert.equal(price, 222n);
    assert.deepEqual(observedAddresses, [ORACLE_A]);
});

test("ERC20 keeps an explicit detached read provider even when setup context exists", () => {
    const defaultReadProvider = { id: "default" } as any;
    const explicitReadProvider = { id: "explicit" } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    const token = new ERC20(explicitReadProvider, TOKEN as any);

    assert.equal(token.provider, explicitReadProvider);
});

test("NativeToken keeps an explicit detached read provider even when setup context exists", () => {
    const defaultReadProvider = { id: "default" } as any;
    const explicitReadProvider = {
        getBalance: async () => 0n,
    } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    const token = new NativeToken("monad-mainnet", explicitReadProvider);

    assert.equal(token.provider, explicitReadProvider);
});

test("supporting readers keep explicit read providers when setup context exists", () => {
    const defaultReadProvider = { id: "default" } as any;
    const explicitReadProvider = { id: "explicit" } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    const protocolReader = new ProtocolReader(READER as any, explicitReadProvider, "monad-mainnet");
    const oracleManager = new OracleManager(ORACLE_A as any, explicitReadProvider);
    const optimizerReader = new OptimizerReader(OPTIMIZER as any, explicitReadProvider);

    assert.equal(protocolReader.provider, explicitReadProvider);
    assert.equal(oracleManager.provider, explicitReadProvider);
    assert.equal(optimizerReader.provider, explicitReadProvider);
    assert.notEqual(protocolReader.provider, defaultReadProvider);
    assert.ok(protocolReader.batchKey != null);
});

test("supporting readers capture the default read provider at construction time", () => {
    const oldReadProvider = { id: "old-setup" } as any;
    const newReadProvider = { id: "new-setup" } as any;

    setSetupConfig(ORACLE_A, oldReadProvider);
    const protocolReader = new ProtocolReader(READER as any, undefined, "monad-mainnet");
    const oracleManager = new OracleManager(ORACLE_A as any);
    const optimizerReader = new OptimizerReader(OPTIMIZER as any);

    setSetupConfig(ORACLE_B, newReadProvider);
    const currentProtocolReader = new ProtocolReader(READER as any, undefined, "arb-sepolia");

    assert.equal(protocolReader.provider, oldReadProvider);
    assert.equal(oracleManager.provider, oldReadProvider);
    assert.equal(optimizerReader.provider, oldReadProvider);
    assert.equal(currentProtocolReader.provider, newReadProvider);
    assert.notEqual(protocolReader.provider, currentProtocolReader.provider);
    assert.notEqual(protocolReader.batchKey, currentProtocolReader.batchKey);
});

test("ERC20 explicit detached read providers do not inherit the global setup signer", async () => {
    const defaultReadProvider = { id: "default" } as any;
    const explicitReadProvider = { id: "explicit" } as any;
    const globalSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: defaultReadProvider,
    } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    (setupModule as any).setup_config.signer = globalSigner;

    const token = new ERC20(explicitReadProvider, TOKEN as any);

    assert.equal(token.provider, explicitReadProvider);
    assert.equal(token.signer, null);
    await assert.rejects(
        () => token.approve(ORACLE_B as any, null),
        /Provider is not a signer/i,
    );
});

test("LendingOptimizer explicit detached read providers do not inherit the global setup signer", async () => {
    const defaultReadProvider = { id: "default" } as any;
    const explicitReadProvider = { id: "explicit" } as any;
    const globalSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: defaultReadProvider,
        sendTransaction: async () => {
            throw new Error("global setup signer should not be used");
        },
    } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    (setupModule as any).setup_config.signer = globalSigner;

    const asset = new ERC20(
        explicitReadProvider,
        TOKEN as any,
        {
            decimals: 18n,
            symbol: "TOK",
        } as any,
        ORACLE_A as any,
    );
    const optimizer = new LendingOptimizer(OPTIMIZER as any, asset, explicitReadProvider);

    assert.equal(optimizer.provider, explicitReadProvider);
    assert.equal(optimizer.signer, null);
    await assert.rejects(
        () => optimizer.deposit(1 as any),
        /Provider is not a signer/i,
    );
});

test("LendingOptimizer default context still captures the current setup signer", () => {
    const defaultReadProvider = { id: "default" } as any;
    const globalSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: defaultReadProvider,
    } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    (setupModule as any).setup_config.signer = globalSigner;

    const asset = new ERC20(
        defaultReadProvider,
        TOKEN as any,
        {
            decimals: 18n,
            symbol: "TOK",
        } as any,
        ORACLE_A as any,
    );
    const optimizer = new LendingOptimizer(OPTIMIZER as any, asset);

    assert.equal(optimizer.provider, defaultReadProvider);
    assert.equal(optimizer.signer, globalSigner);
});

test("LendingOptimizer defaults to an asset-bound provider after setup context moves", () => {
    const oldReadProvider = { id: "old-chain" } as any;
    const newReadProvider = { id: "new-chain" } as any;
    const newGlobalSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: newReadProvider,
    } as any;

    const asset = new ERC20(
        oldReadProvider,
        TOKEN as any,
        {
            decimals: 18n,
            symbol: "TOK",
        } as any,
        ORACLE_A as any,
    );

    setSetupConfig(ORACLE_B, newReadProvider);
    (setupModule as any).setup_config.signer = newGlobalSigner;

    const optimizer = new LendingOptimizer(OPTIMIZER as any, asset);

    assert.equal(optimizer.provider, oldReadProvider);
    assert.equal(optimizer.signer, null);
});

test("LendingOptimizer defaults to an asset-bound signer after setup context moves", async () => {
    const oldReadProvider = { id: "old-chain" } as any;
    const newReadProvider = { id: "new-chain" } as any;
    const sent: Array<{ to: string; data: string }> = [];
    const oldSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: oldReadProvider,
        sendTransaction: async (tx: { to: string; data: string }) => {
            sent.push(tx);
            return { hash: "0xold" };
        },
    } as any;
    const newGlobalSigner = {
        address: "0x0000000000000000000000000000000000000def",
        provider: newReadProvider,
        sendTransaction: async () => {
            throw new Error("moved global setup signer should not be used");
        },
    } as any;
    const asset = {
        provider: oldReadProvider,
        signer: oldSigner,
        decimals: 0n,
        symbol: "TOK",
        allowance: async (owner: string, spender: string) => {
            assert.equal(owner, oldSigner.address);
            assert.equal(spender, OPTIMIZER);
            return 10n;
        },
    };

    setSetupConfig(ORACLE_B, newReadProvider);
    (setupModule as any).setup_config.signer = newGlobalSigner;

    const optimizer = new LendingOptimizer(OPTIMIZER as any, asset as any);
    const tx = await optimizer.deposit(1 as any);

    assert.equal(optimizer.provider, oldReadProvider);
    assert.equal(optimizer.signer, oldSigner);
    assert.deepEqual(tx, { hash: "0xold" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, OPTIMIZER);
});

test("LendingOptimizer explicit read providers still use explicit signers", async () => {
    const defaultReadProvider = { id: "default" } as any;
    const explicitReadProvider = { id: "explicit" } as any;
    const globalSigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: defaultReadProvider,
        sendTransaction: async () => {
            throw new Error("global setup signer should not be used");
        },
    } as any;
    const sent: Array<{ to: string; data: string }> = [];
    const explicitSigner = {
        address: "0x0000000000000000000000000000000000000def",
        sendTransaction: async (tx: { to: string; data: string }) => {
            sent.push(tx);
            return { hash: "0xexplicit" };
        },
    } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    (setupModule as any).setup_config.signer = globalSigner;

    const asset = {
        decimals: 0n,
        symbol: "TOK",
        allowance: async (owner: string, spender: string) => {
            assert.equal(owner, explicitSigner.address);
            assert.equal(spender, OPTIMIZER);
            return 10n;
        },
    };
    const optimizer = new LendingOptimizer(
        OPTIMIZER as any,
        asset as any,
        explicitReadProvider,
        explicitSigner,
    );

    const tx = await optimizer.deposit(1 as any);

    assert.equal(optimizer.provider, explicitReadProvider);
    assert.equal(optimizer.signer, explicitSigner);
    assert.deepEqual(tx, { hash: "0xexplicit" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, OPTIMIZER);
});

test("NativeToken explicit detached read providers do not inherit the global setup account", async () => {
    const defaultReadProvider = {
        getBalance: async () => {
            throw new Error("should not use default provider");
        },
    } as any;
    const explicitReadProvider = {
        getBalance: async (account: string) => {
            assert.equal(account, "0x0000000000000000000000000000000000000def");
            return 123n;
        },
    } as any;

    setSetupConfig(ORACLE_A, defaultReadProvider);
    (setupModule as any).setup_config.account = "0x0000000000000000000000000000000000000abc";

    const token = new NativeToken("monad-mainnet", explicitReadProvider);

    assert.equal(token.provider, explicitReadProvider);
    assert.equal(token.account, null);
    await assert.rejects(
        () => token.balanceOf(null, false),
        /Provider is not a signer/i,
    );

    const balance = await token.balanceOf("0x0000000000000000000000000000000000000def" as any, false);
    assert.equal(balance, 123n);
});

test("ERC20 preserves legacy detached signer-in-provider writes", async () => {
    (setupModule as any).setup_config = undefined;

    const legacySigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: {} as any,
    } as any;
    const runners: any[] = [];

    (helpers as any).contractSetup = (runner: any) => {
        runners.push(runner);
        return {
            approve: async () => ({ hash: "0xapprove" }),
        };
    };

    const token = new ERC20(
        legacySigner,
        TOKEN as any,
        {
            decimals: 18n,
            symbol: "TOK",
        } as any,
    );
    const tx = await token.approve(ORACLE_A as any, null);

    assert.deepEqual(tx, { hash: "0xapprove" });
    assert.equal(runners.at(-1), legacySigner);
});

test("NativeToken preserves legacy detached signer account inference", async () => {
    (setupModule as any).setup_config = undefined;

    let capturedAccount: string | null = null;
    const legacySigner = {
        address: "0x0000000000000000000000000000000000000abc",
        provider: {
            getBalance: async (account: string) => {
                capturedAccount = account;
                return 123n;
            },
        },
    } as any;

    const token = new NativeToken("monad-mainnet", legacySigner);
    const balance = await token.balanceOf(null, false);

    assert.equal(balance, 123n);
    assert.equal(capturedAccount, legacySigner.address);
});

test("detached tokens fail clearly when OracleManager context was never configured", async () => {
    (setupModule as any).setup_config = undefined;

    const erc20 = new ERC20({} as any, TOKEN as any, undefined, undefined, null);
    const native = new NativeToken("monad-mainnet", {} as any, undefined, null, null);

    await assert.rejects(
        () => erc20.getPrice(false, true, false),
        /OracleManager address is not configured for ERC20/i,
    );
    await assert.rejects(
        () => native.getPrice(false, true, false),
        /OracleManager address is not configured for native token/i,
    );
});

test("reader constructors fail clearly when read provider context was never configured", () => {
    (setupModule as any).setup_config = undefined;

    assert.throws(
        () => new ProtocolReader(READER as any),
        /Read provider is not configured for ProtocolReader/i,
    );
    assert.throws(
        () => new OptimizerReader(READER as any),
        /Read provider is not configured for OptimizerReader/i,
    );
});

test("Api defaults fail clearly when setup context was never configured", async () => {
    (setupModule as any).setup_config = undefined;

    assert.throws(
        () => new Api(),
        /Setup config is not configured for Api/i,
    );
    await assert.rejects(
        () => Api.fetchNativeYields(),
        /Setup config is not configured for Api\.fetchNativeYields/i,
    );
    await assert.rejects(
        () => Api.getRewards(),
        /Setup config is not configured for Api\.getRewards/i,
    );
});

test("Market.getAll fails clearly when setup context was never configured", async () => {
    (setupModule as any).setup_config = undefined;

    let called = false;
    const reader = {
        getAllMarketData: async () => {
            called = true;
            throw new Error("should not reach reader call");
        },
    } as any;

    await assert.rejects(
        () => Market.getAll(reader, {} as any),
        /Setup config is not configured for Market\.getAll/i,
    );
    assert.equal(called, false);
});
