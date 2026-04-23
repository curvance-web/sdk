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

    function createExecutionToken() {
        const token = createCToken() as CToken & {
            __state: {
                oracleRouteCalled: boolean;
                assetChecked: boolean;
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
        (token as any).__state = {
            oracleRouteCalled: false,
            assetChecked: false,
        };
        (token as any).ensureUnderlyingAmount = async (amount: Decimal) => amount;
        (token as any).requireSigner = () => ({ address: OWNER } as any);
        (token as any).getAccountOrThrow = () => OWNER;
        (token as any).getCallData = () => '0xdeadbeef';
        (token as any).zap = async (
            _assets: bigint,
            _zap: unknown,
            _collateralize: boolean,
            defaultCalldata: string,
        ) => ({ calldata: defaultCalldata, calldata_overrides: {} });
        (token as any).oracleRoute = async () => {
            token.__state.oracleRouteCalled = true;
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

    test('deposit blocks submission when zapper delegate approval is missing', async () => {
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
            () => token.deposit(Decimal(1), 'simple' as any),
            /Please approve the simple Zapper to be able to move cWMON on your behalf\./i,
        );
        assert.equal(token.__state.assetChecked, false);
        assert.equal(token.__state.oracleRouteCalled, false);
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
        (token as any).isPluginApproved = async () => true;
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
});

describe('Preservation — sibling getters must keep returning shares / raw units', () => {
    // These getters feed share-denominated contract operations. Collapsing any
    // of them to assets would break redeem-all, collateral-cap-sized flows,
    // and the maxRedemption path. The Issue 3 fix MUST NOT touch them.

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
