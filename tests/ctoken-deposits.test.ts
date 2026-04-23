import { afterEach, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { CToken, BorrowableCToken, ERC20, FormatConverter, NATIVE_ADDRESS } from '../src';

/**
 * Unit tests pinning the USD-valuation semantics of CToken getters after the
 * Issue 3 fix:
 *
 *   - `getDeposits` (renamed from `getTvl`) must value deposits via
 *     `cache.totalAssets × assetPrice`, NOT `cache.totalSupply × assetPrice`.
 *     When exchangeRate == WAD the two agree by coincidence; they diverge as
 *     the cToken accrues interest. Pre-fix, passing `cache.totalSupply` to
 *     `convertTokensToUsd(_, asset=true)` understated USD deposits by the
 *     exchange-rate drift factor and broke the `Liquidity ≤ Deposits`
 *     invariant on live markets (observed $29.97K liquidity vs $29.21K deposits
 *     on loAZND/AUSD).
 *
 *   - Sibling getters (`getCollateral`, `getCollateralCap`,
 *     `getRemainingCollateral`, `getUserCollateral`, `getUserShareBalance`)
 *     MUST keep returning share-denominated bigints when called with
 *     `inUSD=false` / `formatted=false`. Their raw values are load-bearing for
 *     share-denominated contract operations (redeem-all, share-sized cap
 *     checks) — collapsing them to assets would break those paths.
 *
 * Construction follows the `Object.create(...prototype)` + manual field
 * assignment pattern used in `protocol-reader.test.ts` and
 * `market-refresh.test.ts`; full instantiation requires a live provider and
 * is unnecessary for getter math.
 */

const ADDR = '0x0000000000000000000000000000000000000001';

interface MockCache {
    totalSupply: bigint;
    totalAssets: bigint;
    exchangeRate: bigint;
    collateral: bigint;
    debt: bigint;
    sharePrice: bigint;
    assetPrice: bigint;
    sharePriceLower: bigint;
    assetPriceLower: bigint;
    liquidity: bigint;
    collateralCap: bigint;
    debtCap: bigint;
    userCollateral: bigint;
    userShareBalance: bigint;
    userAssetBalance: bigint;
    userUnderlyingBalance: bigint;
    userDebt: bigint;
    decimals: bigint;
    asset: { address: string; decimals: bigint };
}

const WAD = 10n ** 18n;
const originalErc20Allowance = ERC20.prototype.allowance;
const originalErc20Approve = ERC20.prototype.approve;
const originalErc20FetchSymbol = ERC20.prototype.fetchSymbol;
const originalErc20DecimalsDescriptor = Object.getOwnPropertyDescriptor(ERC20.prototype, 'decimals');

afterEach(() => {
    ERC20.prototype.allowance = originalErc20Allowance;
    ERC20.prototype.approve = originalErc20Approve;
    ERC20.prototype.fetchSymbol = originalErc20FetchSymbol;
    if (originalErc20DecimalsDescriptor) {
        Object.defineProperty(ERC20.prototype, 'decimals', originalErc20DecimalsDescriptor);
    }
});

function makeDefaultCache(): MockCache {
    return {
        totalSupply: 100n * WAD,        // 100 shares
        totalAssets: 100n * WAD,        // 100 assets (exchangeRate = 1)
        exchangeRate: WAD,
        collateral: 50n * WAD,          // 50 shares collateralized (share units)
        debt: 20n * WAD,                // 20 assets borrowed (asset units)
        sharePrice: 2n * WAD,           // $2 per share (when exchangeRate == WAD, matches assetPrice)
        assetPrice: 2n * WAD,           // $2 per asset
        sharePriceLower: 2n * WAD,
        assetPriceLower: 2n * WAD,
        liquidity: 60n * WAD,           // 60 assets available to borrow
        collateralCap: 200n * WAD,      // 200 shares cap
        debtCap: 150n * WAD,            // 150 assets cap
        userCollateral: 10n * WAD,      // 10 shares
        userShareBalance: 10n * WAD,
        userAssetBalance: 10n * WAD,
        userUnderlyingBalance: 10n * WAD,
        userDebt: 5n * WAD,             // 5 assets
        decimals: 18n,
        asset: { address: ADDR, decimals: 18n },
    };
}

function createCToken(cacheOverrides: Partial<MockCache> = {}): CToken {
    const ctoken = Object.create(CToken.prototype) as CToken;
    (ctoken as any).cache = { ...makeDefaultCache(), ...cacheOverrides };
    return ctoken;
}

function createBorrowableCToken(cacheOverrides: Partial<MockCache> = {}): BorrowableCToken {
    const token = Object.create(BorrowableCToken.prototype) as BorrowableCToken;
    const borrowableDefaults: Partial<MockCache> = {
        collateral: 0n,
        debt: 40n * WAD,                // 40 assets borrowed
        liquidity: 60n * WAD,           // 60 assets available (totalAssets - debt)
        collateralCap: 0n,
        userCollateral: 0n,
        userShareBalance: 0n,
        userAssetBalance: 0n,
        userUnderlyingBalance: 0n,
        userDebt: 0n,
    };
    (token as any).cache = { ...makeDefaultCache(), ...borrowableDefaults, ...cacheOverrides };
    return token;
}

describe('getDeposits — Issue 3 fix (renamed from getTvl, valued from totalAssets)', () => {
    test('exchangeRate == WAD: getDeposits(true) equals totalAssets × assetPrice', () => {
        // Baseline sanity: when exchangeRate is exactly 1, totalSupply ==
        // totalAssets, so pre-fix (totalSupply) and post-fix (totalAssets)
        // paths agree numerically. The fix must preserve this by-coincidence
        // agreement — any arithmetic regression shows up here too.
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 100n * WAD,
            exchangeRate: WAD,
            assetPrice: 2n * WAD,
        });
        const expectedUsd = FormatConverter.bigIntTokensToUsd(100n * WAD, 2n * WAD, 18n);
        assert.equal(ctoken.getDeposits(true).toString(), expectedUsd.toString());
    });

    test('exchangeRate > WAD: getDeposits(true) uses totalAssets, not totalSupply', () => {
        // The core bug scenario. After interest accrual, totalAssets grows
        // while totalSupply stays fixed, so exchangeRate exceeds WAD. Pre-fix
        // `getTvl(true)` returned `totalSupply × assetPrice`, understating
        // deposits by the exchange-rate drift factor. Post-fix must return
        // `totalAssets × assetPrice`.
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 103n * WAD,         // 3% of accrued interest baked into exchange rate
            exchangeRate: (WAD * 103n) / 100n,
            assetPrice: 1n * WAD,            // $1 per asset for easy math
        });
        const expectedUsd = FormatConverter.bigIntTokensToUsd(103n * WAD, 1n * WAD, 18n);
        const buggyUsd = FormatConverter.bigIntTokensToUsd(100n * WAD, 1n * WAD, 18n);
        const actual = ctoken.getDeposits(true);
        assert.equal(actual.toString(), expectedUsd.toString(),
            'post-fix must value deposits from totalAssets');
        assert.notEqual(actual.toString(), buggyUsd.toString(),
            'the buggy totalSupply-based USD would be strictly less after accrual');
    });

    test('getDeposits(false) returns cache.totalAssets as a bigint', () => {
        // The raw bigint form must match the asset-denominated balance
        // directly. Pre-fix `getTvl(false)` returned cache.totalSupply —
        // callers that do their own USD conversion downstream silently got
        // the wrong unit. Pin the post-fix contract.
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 105n * WAD,
        });
        assert.equal(ctoken.getDeposits(false), 105n * WAD);
    });

    test('getLiquidity(true) ≤ getDeposits(true) — core invariant', () => {
        // Any borrowable market must satisfy `liquidity ≤ deposits` (liquidity
        // is assetsHeld - outstandingDebt). Pre-fix broke this for markets
        // with interest accrual; post-fix restores the invariant.
        const token = createBorrowableCToken({
            totalSupply: 100n * WAD,
            totalAssets: 103n * WAD,         // accrued interest
            debt: 40n * WAD,
            liquidity: 63n * WAD,            // totalAssets - debt
            assetPrice: 1n * WAD,
        });
        const deposits = token.getDeposits(true);
        const liquidity = token.getLiquidity(true);
        assert.ok(liquidity.lte(deposits),
            `expected liquidity (${liquidity}) ≤ deposits (${deposits})`);
    });

    test('getDeposits ≈ getLiquidity + debt×assetPrice (identity)', () => {
        // Stronger invariant: deposits should equal available liquidity plus
        // outstanding debt (both at asset price). Within decimal rounding.
        const token = createBorrowableCToken({
            totalSupply: 100n * WAD,
            totalAssets: 103n * WAD,
            debt: 40n * WAD,
            liquidity: 63n * WAD,
            assetPrice: 1n * WAD,
        });
        const deposits = token.getDeposits(true);
        const liquidity = token.getLiquidity(true);
        const debtUsd = FormatConverter.bigIntTokensToUsd(40n * WAD, 1n * WAD, 18n);
        const sum = liquidity.plus(debtUsd);
        assert.ok(deposits.sub(sum).abs().lt(new Decimal('0.000001')),
            `expected deposits (${deposits}) ≈ liquidity (${liquidity}) + debt USD (${debtUsd}) = ${sum}`);
    });
});

describe('Approval preflights â€” single-path execution', () => {
    const OWNER = '0x00000000000000000000000000000000000000aa';
    const CTOKEN = '0x00000000000000000000000000000000000000c1';
    const SIMPLE_ZAPPER = '0x00000000000000000000000000000000000000b1';
    const VAULT_ZAPPER = '0x00000000000000000000000000000000000000b2';
    const INPUT_TOKEN = '0x00000000000000000000000000000000000000d1';
    const VAULT_ASSET = '0x00000000000000000000000000000000000000d2';
    const RECEIVER = '0x00000000000000000000000000000000000000f2';

    function createExecutionToken() {
        const token = createCToken() as CToken & {
            __state: {
                oracleRouteCalled: boolean;
                assetChecked: boolean;
                zapAssets: bigint | null;
                zapCollateralize: boolean | null;
                zapReceiver: string | null;
                callDataCalls: Array<{ method: string; args: unknown[] }>;
                oracleRouteCalls: Array<{ calldata: string; overrides: Record<string, unknown>; reloadAccount?: string | null | undefined }>;
            };
        };

        (token as any).cache = {
            ...(token as any).cache,
            symbol: 'cWMON',
        };
        (token as any).address = CTOKEN;
        (token as any).provider = {} as any;
        (token as any).market = {
            signer: { address: OWNER },
            account: OWNER,
            setup: {
                chain: 'monad-mainnet',
                contracts: {
                    OracleManager: ADDR,
                    zappers: {
                        simpleZapper: SIMPLE_ZAPPER,
                        vaultZapper: VAULT_ZAPPER,
                        nativeVaultZapper: VAULT_ZAPPER,
                    },
                },
            },
            plugins: {},
        };
        (token as any).contract = {
            isDelegate: async () => true,
        };
        (token as any).__state = {
            oracleRouteCalled: false,
            assetChecked: false,
            zapAssets: null,
            zapCollateralize: null,
            zapReceiver: null,
            callDataCalls: [],
            oracleRouteCalls: [],
        };
        (token as any).ensureUnderlyingAmount = async (amount: Decimal) => amount;
        (token as any).requireSigner = () => ({ address: OWNER } as any);
        (token as any).getAccountOrThrow = () => OWNER;
        (token as any).getCallData = (method: string, args: unknown[]) => {
            token.__state.callDataCalls.push({ method, args });
            return '0xdeadbeef';
        };
        (token as any).zap = async (
            assets: bigint,
            _zap: unknown,
            collateralize: boolean,
            defaultCalldata: string,
            receiver: string,
        ) => {
            token.__state.zapAssets = assets;
            token.__state.zapCollateralize = collateralize;
            token.__state.zapReceiver = receiver;
            return { calldata: defaultCalldata, calldata_overrides: {} };
        };
        (token as any).oracleRoute = async (
            calldata: string,
            overrides: Record<string, unknown> = {},
            reloadAccount?: string | null,
        ) => {
            token.__state.oracleRouteCalled = true;
            token.__state.oracleRouteCalls.push({ calldata, overrides, reloadAccount });
            return {} as any;
        };

        return token;
    }

    test('zapper helper approvals target the real simple-zap input token and zapper', async () => {
        const token = createExecutionToken();
        const allowanceChecks: Array<{ owner: string; spender: string; token: string }> = [];
        const approveCalls: Array<{ spender: string; token: string; amount: string | null }> = [];
        const instructions = {
            type: 'simple',
            inputToken: INPUT_TOKEN,
            slippage: new Decimal('0.005'),
        } as const;

        ERC20.prototype.allowance = async function (owner, spender) {
            allowanceChecks.push({ owner, spender, token: this.address });
            return 0n;
        };
        ERC20.prototype.approve = async function (spender, amount) {
            approveCalls.push({
                spender,
                token: this.address,
                amount: amount == null ? null : amount.toString(),
            });
            return {} as any;
        };

        const isApproved = await token.isZapAssetApproved(instructions, 10n);
        await token.approveZapAsset(instructions, Decimal('1.25'));

        assert.equal(isApproved, false);
        assert.deepEqual(allowanceChecks, [
            {
                owner: OWNER,
                spender: SIMPLE_ZAPPER,
                token: INPUT_TOKEN,
            },
        ]);
        assert.deepEqual(approveCalls, [
            {
                spender: SIMPLE_ZAPPER,
                token: INPUT_TOKEN,
                amount: '1.25',
            },
        ]);
    });

    test('deposit blocks submission when underlying allowance is missing', async () => {
        const token = createExecutionToken();
        (token as any).getAsset = () => ({
            allowance: async () => {
                token.__state.assetChecked = true;
                return 0n;
            },
            symbol: 'WMON',
        });

        await assert.rejects(
            () => token.deposit(Decimal(1)),
            /Please approve the WMON token for cWMON/i,
        );
        assert.equal(token.__state.assetChecked, true);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('ensureUnderlyingAmount fails exact instead of shrinking requested deposits to wallet balance', async () => {
        const token = createCToken();
        (token as any).getZapBalance = async () => 50n * WAD;

        await assert.rejects(
            () => token.ensureUnderlyingAmount(Decimal(51), 'none'),
            /Insufficient balance: requested 51, available 50/i,
        );
        assert.equal(
            (await token.ensureUnderlyingAmount(Decimal(50), 'none')).toString(),
            '50',
        );
    });

    const simpleZap = {
        type: 'simple',
        inputToken: INPUT_TOKEN,
        slippage: new Decimal('0.005'),
    } as const;

    const nativeSimpleZap = {
        type: 'simple',
        inputToken: NATIVE_ADDRESS,
        slippage: new Decimal('0.005'),
    } as const;

    const writeSurfaceMatrix = [
        {
            name: 'direct deposit to self',
            method: 'deposit',
            zap: 'none',
            receiver: null,
            expectedCall: { method: 'deposit', args: [WAD, OWNER] },
            expectedAssetAllowance: [{ owner: OWNER, spender: CTOKEN }],
            expectedZapAllowance: [],
            expectedPluginChecks: [],
            expectedDelegateChecks: [],
            expectedZap: { assets: WAD, collateralize: false, receiver: OWNER },
        },
        {
            name: 'simple zap deposit to third-party receiver',
            method: 'deposit',
            zap: simpleZap,
            receiver: RECEIVER,
            expectedCall: { method: 'deposit', args: [WAD, RECEIVER] },
            expectedAssetAllowance: [],
            expectedZapAllowance: [{ owner: OWNER, spender: SIMPLE_ZAPPER, token: INPUT_TOKEN }],
            expectedPluginChecks: [],
            expectedDelegateChecks: [],
            expectedZap: { assets: 1_000_000n, collateralize: false, receiver: RECEIVER },
        },
        {
            name: 'native simple zap deposit to third-party receiver',
            method: 'deposit',
            zap: nativeSimpleZap,
            receiver: RECEIVER,
            expectedCall: { method: 'deposit', args: [WAD, RECEIVER] },
            expectedAssetAllowance: [],
            expectedZapAllowance: [],
            expectedPluginChecks: [],
            expectedDelegateChecks: [],
            expectedZap: { assets: 1_000_000n, collateralize: false, receiver: RECEIVER },
        },
        {
            name: 'direct collateral deposit to self',
            method: 'depositAsCollateral',
            zap: 'none',
            receiver: null,
            expectedCall: { method: 'depositAsCollateral', args: [WAD, OWNER] },
            expectedAssetAllowance: [{ owner: OWNER, spender: CTOKEN }],
            expectedZapAllowance: [],
            expectedPluginChecks: [],
            expectedDelegateChecks: [],
            expectedZap: { assets: WAD, collateralize: true, receiver: OWNER },
        },
        {
            name: 'direct collateral deposit to third-party receiver',
            method: 'depositAsCollateral',
            zap: 'none',
            receiver: RECEIVER,
            expectedCall: { method: 'depositAsCollateralFor', args: [WAD, RECEIVER] },
            expectedAssetAllowance: [{ owner: OWNER, spender: CTOKEN }],
            expectedZapAllowance: [],
            expectedPluginChecks: [],
            expectedDelegateChecks: [{ owner: RECEIVER, delegate: OWNER }],
            expectedZap: { assets: WAD, collateralize: true, receiver: RECEIVER },
        },
        {
            name: 'simple collateral zap to self',
            method: 'depositAsCollateral',
            zap: simpleZap,
            receiver: null,
            expectedCall: { method: 'depositAsCollateral', args: [WAD, OWNER] },
            expectedAssetAllowance: [],
            expectedZapAllowance: [{ owner: OWNER, spender: SIMPLE_ZAPPER, token: INPUT_TOKEN }],
            expectedPluginChecks: [{ type: 'simple', pluginType: 'zapper' }],
            expectedDelegateChecks: [],
            expectedZap: { assets: 1_000_000n, collateralize: true, receiver: OWNER },
        },
        {
            name: 'simple collateral zap to third-party receiver',
            method: 'depositAsCollateral',
            zap: simpleZap,
            receiver: RECEIVER,
            expectedCall: { method: 'depositAsCollateralFor', args: [WAD, RECEIVER] },
            expectedAssetAllowance: [],
            expectedZapAllowance: [{ owner: OWNER, spender: SIMPLE_ZAPPER, token: INPUT_TOKEN }],
            expectedPluginChecks: [],
            expectedDelegateChecks: [
                { owner: RECEIVER, delegate: OWNER },
                { owner: RECEIVER, delegate: SIMPLE_ZAPPER },
            ],
            expectedZap: { assets: 1_000_000n, collateralize: true, receiver: RECEIVER },
        },
    ] as const;

    for (const scenario of writeSurfaceMatrix) {
        test(`write-surface matrix: ${scenario.name}`, async () => {
            const token = createExecutionToken();
            const assetAllowanceChecks: Array<{ owner: string; spender: string }> = [];
            const zapAllowanceChecks: Array<{ owner: string; spender: string; token: string }> = [];
            const pluginChecks: Array<{ type: string; pluginType: string }> = [];
            const delegateChecks: Array<{ owner: string; delegate: string }> = [];

            (token as any).getAsset = () => ({
                address: ADDR,
                symbol: 'WMON',
                decimals: 18n,
                allowance: async (owner: string, spender: string) => {
                    assetAllowanceChecks.push({ owner, spender });
                    return 10n ** 30n;
                },
            });
            (token as any).getZapAssetAmount = async (_amount: Decimal, zap: unknown) =>
                zap === 'none' ? WAD : 1_000_000n;
            (token as any).getZapper = (type: string) => ({
                type,
                address: type === 'vault' || type === 'native-vault' ? VAULT_ZAPPER : SIMPLE_ZAPPER,
            });
            (token as any).isPluginApproved = async (type: string, pluginType: string) => {
                pluginChecks.push({ type, pluginType });
                return true;
            };
            (token as any).contract = {
                isDelegate: async (owner: string, delegate: string) => {
                    delegateChecks.push({ owner, delegate });
                    return true;
                },
            };
            (token as any).zap = async (
                assets: bigint,
                zap: unknown,
                collateralize: boolean,
                defaultCalldata: string,
                receiver: string,
            ) => {
                const zapType = typeof zap === 'object' && zap != null
                    ? (zap as { type: string }).type
                    : zap;
                token.__state.zapAssets = assets;
                token.__state.zapCollateralize = collateralize;
                token.__state.zapReceiver = receiver;
                return {
                    calldata: defaultCalldata,
                    calldata_overrides: zapType === 'none' ? {} : { to: SIMPLE_ZAPPER },
                };
            };
            ERC20.prototype.allowance = async function (owner, spender) {
                zapAllowanceChecks.push({ owner, spender, token: this.address });
                return 10n ** 30n;
            };

            if (scenario.method === 'deposit') {
                await token.deposit(Decimal(1), scenario.zap as any, scenario.receiver as any);
            } else {
                await token.depositAsCollateral(Decimal(1), scenario.zap as any, scenario.receiver as any);
            }

            assert.deepEqual(token.__state.callDataCalls.at(-1), scenario.expectedCall);
            assert.deepEqual(assetAllowanceChecks, scenario.expectedAssetAllowance);
            assert.deepEqual(zapAllowanceChecks, scenario.expectedZapAllowance);
            assert.deepEqual(pluginChecks, scenario.expectedPluginChecks);
            assert.deepEqual(delegateChecks, scenario.expectedDelegateChecks);
            assert.equal(token.__state.zapAssets, scenario.expectedZap.assets);
            assert.equal(token.__state.zapCollateralize, scenario.expectedZap.collateralize);
            assert.equal(token.__state.zapReceiver, scenario.expectedZap.receiver);
            assert.equal(token.__state.oracleRouteCalled, true);
            assert.equal(token.__state.oracleRouteCalls.at(-1)?.reloadAccount, scenario.expectedZap.receiver);
        });
    }

    test('depositAsCollateral blocks submission when self-collateral zapper delegate approval is missing', async () => {
        const token = createExecutionToken();
        (token as any).getZapper = () => ({ type: 'simple' });
        (token as any).isPluginApproved = async () => false;
        (token as any).getAsset = () => ({
            allowance: async () => {
                token.__state.assetChecked = true;
                return 10n ** 30n;
            },
            symbol: 'WMON',
        });

        await assert.rejects(
            () => token.depositAsCollateral(Decimal(1), {
                type: 'simple',
                inputToken: NATIVE_ADDRESS,
                slippage: new Decimal('0.005'),
            }),
            /Please approve the simple Zapper to be able to move cWMON on your behalf\./i,
        );
        assert.equal(token.__state.assetChecked, false);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('deposit zaps do not require cToken delegate approval when not collateralizing', async () => {
        const token = createExecutionToken();
        (token as any).getZapper = () => ({
            type: 'simple',
            address: SIMPLE_ZAPPER,
        });
        (token as any).isPluginApproved = async () => {
            throw new Error('non-collateral zaps should not check delegate approval');
        };
        (token as any).getAsset = () => ({
            allowance: async () => {
                token.__state.assetChecked = true;
                return 10n ** 30n;
            },
            symbol: 'WMON',
        });
        Object.defineProperty(ERC20.prototype, 'decimals', {
            configurable: true,
            get() {
                return 6n;
            },
        });
        ERC20.prototype.allowance = async () => 10n ** 30n;

        await token.deposit(Decimal(1), {
            type: 'simple',
            inputToken: INPUT_TOKEN,
            slippage: new Decimal('0.005'),
        });

        assert.equal(token.__state.assetChecked, false);
        assert.equal(token.__state.oracleRouteCalled, true);
    });

    test('deposit blocks simple ERC20 zaps on the zap input allowance target, not the deposit asset', async () => {
        const token = createExecutionToken();
        const allowanceChecks: Array<{ owner: string; spender: string; token: string }> = [];
        (token as any).isPluginApproved = async () => true;
        (token as any).getAsset = () => ({
            allowance: async () => {
                token.__state.assetChecked = true;
                return 10n ** 30n;
            },
            symbol: 'WMON',
        });
        ERC20.prototype.allowance = async function (owner, spender) {
            allowanceChecks.push({ owner, spender, token: this.address });
            return 0n;
        };
        ERC20.prototype.fetchSymbol = async function () {
            return this.address === INPUT_TOKEN ? 'USDC' : 'UNKNOWN';
        };
        Object.defineProperty(ERC20.prototype, 'decimals', {
            configurable: true,
            get() {
                return 6n;
            },
        });

        await assert.rejects(
            () =>
                token.deposit(Decimal(1), {
                    type: 'simple',
                    inputToken: INPUT_TOKEN,
                    slippage: new Decimal('0.005'),
                }),
            /Please approve the USDC token for simple Zapper/i,
        );
        assert.deepEqual(allowanceChecks, [
            {
                owner: OWNER,
                spender: SIMPLE_ZAPPER,
                token: INPUT_TOKEN,
            },
        ]);
        assert.equal(token.__state.assetChecked, false);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('deposit skips ERC20 allowance checks for native simple zaps', async () => {
        const token = createExecutionToken();
        (token as any).getZapper = () => ({
            type: 'simple',
            address: SIMPLE_ZAPPER,
        });
        (token as any).isPluginApproved = async () => {
            throw new Error('non-collateral native zaps should not check delegate approval');
        };
        (token as any).getAsset = () => ({
            allowance: async () => {
                throw new Error('deposit asset allowance should not be checked for native zaps');
            },
            symbol: 'WMON',
        });
        ERC20.prototype.allowance = async function () {
            throw new Error(`unexpected ERC20 allowance check for ${this.address}`);
        };

        await token.deposit(Decimal(1), {
            type: 'simple',
            inputToken: NATIVE_ADDRESS,
            slippage: new Decimal('0.005'),
        });

        assert.equal(token.__state.oracleRouteCalled, true);
        assert.equal(token.__state.assetChecked, false);
    });

    test('deposit passes a third-party receiver through simple zap calldata', async () => {
        const token = createExecutionToken();
        const zapCalls: Array<{ receiver: string; collateralize: boolean }> = [];
        (token as any).zap = (CToken.prototype as any).zap;
        (token as any).isPluginApproved = async () => true;
        (token as any).getZapper = () => ({
            address: SIMPLE_ZAPPER,
            getSimpleZapCalldata: async (
                _ctoken: unknown,
                _inputToken: string,
                _outputToken: string,
                _amount: bigint,
                collateralize: boolean,
                _slippage: bigint,
                receiver: string,
            ) => {
                zapCalls.push({ receiver, collateralize });
                return '0xzapped';
            },
        });

        await token.deposit(
            Decimal(1),
            {
                type: 'simple',
                inputToken: NATIVE_ADDRESS,
                slippage: new Decimal('0.005'),
            },
            RECEIVER as any,
        );

        assert.deepEqual(zapCalls, [{
            receiver: RECEIVER,
            collateralize: false,
        }]);
        assert.equal(token.__state.oracleRouteCalled, true);
    });

    test('depositAsCollateral uses depositAsCollateralFor for delegated third-party deposits', async () => {
        const token = createExecutionToken();
        (token as any).getAsset = () => ({
            allowance: async () => 10n ** 30n,
            symbol: 'WMON',
        });

        await token.depositAsCollateral(Decimal(1), 'none', RECEIVER as any);

        assert.equal(token.__state.callDataCalls[0]?.method, 'depositAsCollateralFor');
        assert.deepEqual(token.__state.callDataCalls[0]?.args, [1n * WAD, RECEIVER]);
        assert.equal(token.__state.zapReceiver, RECEIVER);
        assert.equal(token.__state.oracleRouteCalled, true);
    });

    test('depositAsCollateral fails before submit when third-party receiver has not delegated signer', async () => {
        const token = createExecutionToken();
        const delegateChecks: Array<{ owner: string; delegate: string }> = [];
        (token as any).contract = {
            isDelegate: async (owner: string, delegate: string) => {
                delegateChecks.push({ owner, delegate });
                return false;
            },
        };
        (token as any).getAsset = () => ({
            allowance: async () => {
                throw new Error('asset allowance should not be checked before receiver delegation');
            },
            symbol: 'WMON',
        });

        await assert.rejects(
            () => token.depositAsCollateral(Decimal(1), 'none', RECEIVER as any),
            /Please approve the connected signer as a delegate for cWMON/i,
        );
        assert.deepEqual(delegateChecks, [{ owner: RECEIVER, delegate: OWNER }]);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('depositAsCollateral fails before zap submit when third-party receiver has not delegated signer', async () => {
        const token = createExecutionToken();
        const delegateChecks: Array<{ owner: string; delegate: string }> = [];
        (token as any).isPluginApproved = async () => {
            throw new Error('third-party collateral zaps should not check signer-to-zapper approval');
        };
        (token as any).getZapper = () => ({
            type: 'simple',
            address: SIMPLE_ZAPPER,
        });
        (token as any).contract = {
            isDelegate: async (owner: string, delegate: string) => {
                delegateChecks.push({ owner, delegate });
                return false;
            },
        };
        ERC20.prototype.allowance = async function () {
            throw new Error(`unexpected ERC20 allowance check for ${this.address}`);
        };

        await assert.rejects(
            () => token.depositAsCollateral(
                Decimal(1),
                {
                    type: 'simple',
                    inputToken: NATIVE_ADDRESS,
                    slippage: new Decimal('0.005'),
                },
                RECEIVER as any,
            ),
            /Please approve the connected signer as a delegate for cWMON/i,
        );
        assert.deepEqual(delegateChecks, [{ owner: RECEIVER, delegate: OWNER }]);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('depositAsCollateral fails before zap submit when third-party receiver has not delegated zapper', async () => {
        const token = createExecutionToken();
        const delegateChecks: Array<{ owner: string; delegate: string }> = [];
        (token as any).isPluginApproved = async () => {
            throw new Error('third-party collateral zaps should not check signer-to-zapper approval');
        };
        (token as any).getZapper = () => ({
            type: 'simple',
            address: SIMPLE_ZAPPER,
        });
        (token as any).contract = {
            isDelegate: async (owner: string, delegate: string) => {
                delegateChecks.push({ owner, delegate });
                return delegate === OWNER;
            },
        };
        ERC20.prototype.allowance = async function () {
            throw new Error(`unexpected ERC20 allowance check for ${this.address}`);
        };

        await assert.rejects(
            () => token.depositAsCollateral(
                Decimal(1),
                {
                    type: 'simple',
                    inputToken: NATIVE_ADDRESS,
                    slippage: new Decimal('0.005'),
                },
                RECEIVER as any,
            ),
            /Please approve simple Zapper as a delegate for cWMON/i,
        );
        assert.deepEqual(delegateChecks, [
            { owner: RECEIVER, delegate: OWNER },
            { owner: RECEIVER, delegate: SIMPLE_ZAPPER },
        ]);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('postCollateral fails before submit when no unposted shares are available', async () => {
        const token = createExecutionToken();
        (token as any).balanceOf = async () => 5n * WAD;
        (token as any).fetchUserCollateral = async () => 5n * WAD;

        await assert.rejects(
            () => token.postCollateral(Decimal(1)),
            /No cToken shares available to post as collateral/i,
        );
        assert.deepEqual(token.__state.callDataCalls, []);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('depositAsCollateral rejects negative remaining collateral capacity before approvals', async () => {
        const token = createExecutionToken();
        (token as any).getRemainingCollateral = () => -1n;
        (token as any).getAsset = () => ({
            allowance: async () => {
                throw new Error('approval should not be checked');
            },
            symbol: 'WMON',
        });

        await assert.rejects(
            () => token.depositAsCollateral(Decimal(1), 'none'),
            /not enough collateral left/i,
        );
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('depositAsCollateral cap preflight uses unbuffered minted shares', async () => {
        const token = createExecutionToken();
        (token as any).getRemainingCollateral = () => WAD - 1n;
        (token as any).getAsset = () => ({
            allowance: async () => {
                throw new Error('approval should not be checked after cap failure');
            },
            symbol: 'WMON',
        });

        await assert.rejects(
            () => token.depositAsCollateral(Decimal(1), 'none'),
            /not enough collateral left/i,
        );
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('depositAsCollateral checks vault zaps against the underlying vault asset allowance', async () => {
        const token = createExecutionToken();
        let vaultAllowanceCheck: { owner: string; spender: string } | null = null;
        (token as any).isPluginApproved = async () => true;
        (token as any).getAsset = () => ({
            allowance: async () => {
                token.__state.assetChecked = true;
                return 10n ** 30n;
            },
            symbol: 'WMON',
        });
        (token as any).getVaultAsset = async () => ({
            address: VAULT_ASSET,
            symbol: 'MON',
            decimals: 18n,
            allowance: async (owner: string, spender: string) => {
                vaultAllowanceCheck = { owner, spender };
                return 0n;
            },
        });

        await assert.rejects(
            () => token.depositAsCollateral(Decimal(1), 'vault' as any),
            /Please approve the MON token for vault Zapper/i,
        );
        assert.deepEqual(vaultAllowanceCheck, {
            owner: OWNER,
            spender: VAULT_ZAPPER,
        });
        assert.equal(token.__state.assetChecked, false);
        assert.equal(token.__state.oracleRouteCalled, false);
    });

    test('depositAsCollateral treats bare vault zaps as zap paths for units and cap checks', async () => {
        const token = createExecutionToken();
        let capChecked = false;
        (token as any).isPluginApproved = async () => true;
        (token as any).getRemainingCollateral = () => {
            capChecked = true;
            throw new Error('non-zap collateral cap check should not run for vault zaps');
        };
        (token as any).getVaultAsset = async () => ({
            address: VAULT_ASSET,
            symbol: 'MON',
            decimals: 6n,
            allowance: async () => 10n ** 30n,
        });

        await token.depositAsCollateral(Decimal('1.23'), 'vault' as any);

        assert.equal(capChecked, false);
        assert.equal(token.__state.zapAssets, 1_230_000n);
        assert.equal(token.__state.zapCollateralize, true);
        assert.equal(token.__state.oracleRouteCalled, true);
    });

    test('simulateDepositAsCollateral sizes bare native-vault zaps as native value', async () => {
        const token = createExecutionToken();
        (token as any).simulateOracleRoute = async () => ({ success: true });

        const result = await token.simulateDepositAsCollateral(Decimal('1.25'), 'native-vault' as any);

        assert.deepEqual(result, { success: true });
        assert.equal(token.__state.zapAssets, 1_250_000_000_000_000_000n);
        assert.equal(token.__state.zapCollateralize, true);
    });
});

describe('Preservation — sibling getters must keep returning shares / raw units', () => {
    // These getters feed share-denominated contract operations. Collapsing any
    // of them to assets would break redeem-all, collateral-cap-sized flows,
    // and the maxRedemption path. The Issue 3 fix MUST NOT touch them.

    test('share-denominated collateral USD getters use share price, not asset price', () => {
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 200n * WAD,
            collateral: 5n * WAD,
            collateralCap: 20n * WAD,
            sharePrice: 4n * WAD,
            assetPrice: 2n * WAD,
        });

        assert.equal(
            ctoken.getCollateralCap(true).toString(),
            FormatConverter.bigIntTokensToUsd(20n * WAD, 4n * WAD, 18n).toString(),
        );
        assert.equal(
            ctoken.getCollateral(true).toString(),
            FormatConverter.bigIntTokensToUsd(5n * WAD, 4n * WAD, 18n).toString(),
        );
        assert.equal(
            ctoken.getRemainingCollateral(true).toString(),
            FormatConverter.bigIntTokensToUsd(15n * WAD, 4n * WAD, 18n).toString(),
        );
        assert.equal(
            ctoken.getTotalCollateral(true).toString(),
            FormatConverter.bigIntTokensToUsd(5n * WAD, 4n * WAD, 18n).toString(),
        );
    });

    test('convertSharesToUsd prices the provided share amount exactly once', async () => {
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 200n * WAD,
            sharePrice: 4n * WAD,
            assetPrice: 2n * WAD,
        });

        const actual = await ctoken.convertSharesToUsd(10n * WAD);
        const expected = FormatConverter.bigIntTokensToUsd(10n * WAD, 4n * WAD, 18n);
        const doubleConverted = FormatConverter.bigIntTokensToUsd(5n * WAD, 4n * WAD, 18n);

        assert.equal(actual.toString(), expected.toString());
        assert.notEqual(actual.toString(), doubleConverted.toString());
    });

    test('fetchTotalCollateral(true) refreshes share price and prices returned collateral shares', async () => {
        const ctoken = createCToken({
            sharePrice: 3n * WAD,
            assetPrice: 1n * WAD,
        });
        let fetchedAssetPriceArg: boolean | null = null;
        (ctoken as any).contract = {
            marketCollateralPosted: async () => 7n * WAD,
        };
        (ctoken as any).fetchPrice = async (asset: boolean) => {
            fetchedAssetPriceArg = asset;
        };
        (ctoken as any).fetchDecimals = async () => 18n;

        const actual = await ctoken.fetchTotalCollateral(true);

        assert.equal(fetchedAssetPriceArg, false);
        assert.equal(
            actual.toString(),
            FormatConverter.bigIntTokensToUsd(7n * WAD, 3n * WAD, 18n).toString(),
        );
    });

    test('getCollateral(false) returns cache.collateral unchanged (shares)', () => {
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 110n * WAD,     // accrued; confirms no accidental re-scaling
            collateral: 50n * WAD,       // share-denominated per ProtocolReader ABI
        });
        assert.equal(ctoken.getCollateral(false), 50n * WAD);
    });

    test('getCollateralCap(false) returns cache.collateralCap unchanged (shares)', () => {
        const ctoken = createCToken({
            collateralCap: 200n * WAD,
        });
        assert.equal(ctoken.getCollateralCap(false), 200n * WAD);
    });

    test('getRemainingCollateral(false) returns share-denominated diff', () => {
        const ctoken = createCToken({
            collateralCap: 200n * WAD,
            collateral: 50n * WAD,
        });
        assert.equal(ctoken.getRemainingCollateral(false), 150n * WAD);
    });

    test('getUserCollateral(false) returns raw user shares (not asset-scaled)', () => {
        // userCollateral is recorded in cToken share units; share-denominated
        // writes (postCollateral, removeCollateral) take the raw value. Pin
        // the shape — a regression that formats it against asset decimals
        // would break redeem-all.
        const ctoken = createCToken({
            userCollateral: 7n * WAD,
        });
        const result = ctoken.getUserCollateral(false);
        assert.equal(result.toString(), FormatConverter.bigIntToDecimal(7n * WAD, 18n).toString());
    });

    test('getUserCollateralAssets converts raw collateral shares to underlying assets for display', () => {
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 150n * WAD,
            userCollateral: 6n * WAD,
        });

        assert.equal(ctoken.getUserCollateral(false).toString(), '6');
        assert.equal(ctoken.getUserCollateralAssets().toString(), '9');
    });

    test('getUserShareBalance(false) returns share-denominated Decimal, not asset-scaled', () => {
        // API returns `FormatConverter.bigIntToDecimal(userShareBalance, this.decimals)`,
        // i.e. share-formatted. Pin the share semantic — a regression that
        // re-scaled via asset decimals would make share-counting consumers
        // (balance displays, redeem flows) silently wrong.
        const ctoken = createCToken({
            userShareBalance: 3n * WAD,
        });
        const result = ctoken.getUserShareBalance(false);
        assert.equal(result.toString(), FormatConverter.bigIntToDecimal(3n * WAD, 18n).toString());
    });

    test('formatSharesAsAssets exposes an explicit display bridge from share units to asset units', () => {
        const ctoken = createCToken({
            totalSupply: 100n * WAD,
            totalAssets: 125n * WAD,
        });

        assert.equal(ctoken.formatShares(8n * WAD).toString(), '8');
        assert.equal(ctoken.formatAssets(10n * WAD).toString(), '10');
        assert.equal(ctoken.formatSharesAsAssets(8n * WAD).toString(), '10');
    });

    test('getDebt(false) returns cache.debt (assets, unchanged)', () => {
        // debt is asset-denominated per ProtocolReader ABI. Included here as
        // a control — the Issue 3 fix is about collateral/deposits; the debt
        // side must also remain untouched.
        const ctoken = createCToken({
            debt: 40n * WAD,
        });
        assert.equal(ctoken.getDebt(false), 40n * WAD);
    });
});
