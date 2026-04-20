import assert from "node:assert/strict";
import test from "node:test";
import { Api } from "../src/classes/Api";
import { ERC20 } from "../src/classes/ERC20";
import { Market } from "../src/classes/Market";
import { NativeToken } from "../src/classes/NativeToken";
import { OracleManager } from "../src/classes/OracleManager";
import { OptimizerReader } from "../src/classes/OptimizerReader";
import { ProtocolReader } from "../src/classes/ProtocolReader";
import * as setupModule from "../src/setup";

const TOKEN = "0x00000000000000000000000000000000000000a1";
const ORACLE_A = "0x00000000000000000000000000000000000000b1";
const ORACLE_B = "0x00000000000000000000000000000000000000b2";
const READER = "0x00000000000000000000000000000000000000c1";

const originalOracleManagerGetPrice = OracleManager.prototype.getPrice;
const originalSetupConfig = (setupModule as any).setup_config;

function setSetupConfig(oracleManager: string) {
    (setupModule as any).setup_config = {
        chain: "monad-mainnet",
        contracts: {
            OracleManager: oracleManager,
        },
        readProvider: {} as any,
        signer: null,
        account: null,
        provider: {} as any,
        approval_protection: false,
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
