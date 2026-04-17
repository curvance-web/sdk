import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-audit regression for Issue 2: the vault + native-vault leverage paths
 * currently lack the same buffering that the simple path has, causing
 * `BasePositionManager__InvalidSlippage` reverts at non-trivial leverage even
 * when the vault deposit itself is lossless by construction.
 *
 * Two buffers must be present in the post-fix source:
 *
 *   (1) `amplifyContractSlippage(slippage, <delta>, LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS)`
 *       in both vault branches of `leverageUp` (delta = `newLeverage.sub(1)`)
 *       and `depositAndLeverage` (delta = `multiplier.sub(1)`). Mirrors the
 *       simple-branch pattern so the `checkSlippage` modifier has (L-1) ×
 *       K bps of headroom for vault-token collateral drift (fundamental
 *       mint rate vs stored oracle rate).
 *
 *   (2) A buffered `previewDeposit` step inside
 *       `PositionManager.getVaultExpectedShares` — the outer
 *       `convertToShares(...)` already defaults to a 2-bps buffer, but the
 *       inner vault previewDeposit had none, letting vault-exchange-rate
 *       drift between RPC-read and tx-inclusion trip the
 *       `shares < expectedShares` check at
 *       `BasePositionManager.sol:389-391`.
 *
 * The constant must exist in the `LEVERAGE` block with a name that documents
 * the mechanism (fundamental-vs-oracle drift on vault-token collateral), NOT
 * as "feed divergence" which is the directionally-wrong framing the engineer
 * used (shMON oracle is derived from MON × exchange rate in the Redstone
 * off-chain computation — the gap is between publish-time rate and tx-time
 * rate, not between two independent feeds).
 *
 * These tests read the SDK source and regex-match the required shapes. A
 * follow-up fork test (`leverage.test.ts:SDK-005/006`) exercises the actual
 * on-chain pass/fail at 1% user slippage — this file only pins the static
 * structure. Together they prevent (a) silent removal of the buffers during
 * refactors and (b) silent reintroduction of the bug in a new PM type that
 * copies from the current vault branch.
 */

const CTOKEN_PATH = path.resolve(__dirname, '..', 'src', 'classes', 'CToken.ts');
const POSITION_MANAGER_PATH = path.resolve(
    __dirname,
    '..',
    'src',
    'classes',
    'PositionManager.ts',
);

const ctokenSrc = readFileSync(CTOKEN_PATH, 'utf8');
const pmSrc = readFileSync(POSITION_MANAGER_PATH, 'utf8');

describe('Issue 2 — LEVERAGE_UP_VAULT_DRIFT_BPS constant', () => {
    test('constant is declared in the LEVERAGE block with mechanism-accurate naming', () => {
        // The constant must live alongside `LEVERAGE_UP_BUFFER_BPS` and
        // `DELEVERAGE_OVERHEAD_BPS` so compound buffer effects are auditable
        // in one place, per the Skill_CurvanceSDK WGW entry on buffer
        // centralization. Name must NOT contain "FEED" (engineer's original
        // `LEVERAGE_UP_VAULT_FEED_BPS` framing was overturned by source trace;
        // shMON/WMON feeds are not independently drifting on-chain).
        assert.match(
            ctokenSrc,
            /LEVERAGE_UP_VAULT_DRIFT_BPS:\s*\d+n/,
            'LEVERAGE_UP_VAULT_DRIFT_BPS must be declared in LEVERAGE block',
        );
        // Anti-pattern guard: the old engineer-proposed name should not land.
        assert.doesNotMatch(
            ctokenSrc,
            /LEVERAGE_UP_VAULT_FEED_BPS/,
            'the misleading "FEED" naming must not be present',
        );
    });

    test('constant has a comment explaining the fundamental-vs-oracle-drift mechanism', () => {
        // Future engineers will see this constant and wonder if it can be
        // removed "now that oracles are better." Anchor the rationale in the
        // source so the answer is visible without cross-referencing lane
        // memory or release notes. Key phrases: "drift", "vault", and "oracle".
        const constantIdx = ctokenSrc.indexOf('LEVERAGE_UP_VAULT_DRIFT_BPS');
        assert.ok(constantIdx > -1, 'constant must exist for its comment to be testable');
        // Look at the block of preceding JSDoc — capture up to ~1500 chars
        // above the declaration (comfortable for a multi-line comment).
        const windowStart = Math.max(0, constantIdx - 1500);
        const contextBlock = ctokenSrc.slice(windowStart, constantIdx);
        assert.match(contextBlock, /drift/i, 'comment must mention drift');
        assert.match(contextBlock, /vault/i, 'comment must mention vault');
        assert.match(
            contextBlock,
            /oracle|mint rate|fundamental/i,
            'comment must reference the mechanism (oracle, mint rate, or fundamental)',
        );
    });
});

describe('Issue 2 — vault leverageUp branch applies amplifyContractSlippage', () => {
    test('vault branch of leverageUp passes newLeverage.sub(1) and the drift constant', () => {
        // The leverageUp vault branch lives at ~line 1315; it currently passes
        // raw `slippage` through `FormatConverter.bpsToBpsWad(slippage)` with
        // no (L-1) amplification. Post-fix must apply
        // `amplifyContractSlippage(slippage, newLeverage.sub(1), LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS)`
        // and pass the result through bpsToBpsWad. We anchor on the vault
        // case block specifically to avoid accidentally matching the simple
        // branch.
        const vaultCaseLeverageUpIdx = ctokenSrc.indexOf(
            "case 'vault': {",
            ctokenSrc.indexOf('leverageUp('),
        );
        assert.ok(
            vaultCaseLeverageUpIdx > -1,
            'leverageUp vault case block must be locatable',
        );
        const blockEnd = ctokenSrc.indexOf('break;', vaultCaseLeverageUpIdx);
        const vaultBlock = ctokenSrc.slice(vaultCaseLeverageUpIdx, blockEnd);
        assert.match(
            vaultBlock,
            /amplifyContractSlippage\s*\([^)]*newLeverage\.sub\(1\)[^)]*LEVERAGE\.LEVERAGE_UP_VAULT_DRIFT_BPS/s,
            'vault leverageUp must call amplifyContractSlippage with newLeverage.sub(1) and the drift constant',
        );
    });

    test('native-vault branch of leverageUp shares the amplified contractSlippage with vault', () => {
        // native-vault falls through to the same block as `vault` (they share
        // the switch case). This test confirms the fall-through is preserved,
        // so both types get the same buffering.
        const leverageUpIdx = ctokenSrc.indexOf('leverageUp(');
        assert.ok(leverageUpIdx > -1);
        const caseNativeVault = ctokenSrc.indexOf(
            "case 'native-vault':",
            leverageUpIdx,
        );
        const caseVault = ctokenSrc.indexOf("case 'vault':", caseNativeVault);
        assert.ok(
            caseNativeVault > -1 && caseVault > -1 && caseVault - caseNativeVault < 100,
            'native-vault and vault cases must remain adjacent (fall-through) in leverageUp',
        );
    });
});

describe('Issue 2 — vault depositAndLeverage branch applies amplifyContractSlippage', () => {
    test('vault branch of depositAndLeverage passes multiplier.sub(1) and the drift constant', () => {
        // The depositAndLeverage vault branch lives at ~line 1573; local
        // variable is `multiplier` (not `newLeverage`) per the per-call-site
        // asymmetry documented in helpers.ts:87-100. Surface-parity with
        // simple's `amplifyContractSlippage(slippage, multiplier.sub(1), feeBps)`
        // at the same surface.
        const depositAndLeverageIdx = ctokenSrc.indexOf('depositAndLeverage(');
        assert.ok(depositAndLeverageIdx > -1);
        const vaultCaseIdx = ctokenSrc.indexOf("case 'vault': {", depositAndLeverageIdx);
        assert.ok(
            vaultCaseIdx > -1,
            'depositAndLeverage vault case block must be locatable',
        );
        const blockEnd = ctokenSrc.indexOf('break;', vaultCaseIdx);
        const vaultBlock = ctokenSrc.slice(vaultCaseIdx, blockEnd);
        assert.match(
            vaultBlock,
            /amplifyContractSlippage\s*\([^)]*multiplier\.sub\(1\)[^)]*LEVERAGE\.LEVERAGE_UP_VAULT_DRIFT_BPS/s,
            'vault depositAndLeverage must call amplifyContractSlippage with multiplier.sub(1) and the drift constant',
        );
    });
});

describe('Issue 2 — getVaultExpectedShares applies inner previewDeposit buffer', () => {
    test('getVaultExpectedShares downward-buffers the inner previewDeposit result', () => {
        // Without the inner buffer, vault exchange-rate accrual between the
        // SDK RPC read and tx inclusion makes actual shares < expectedShares,
        // tripping `shares < action.expectedShares` in
        // BasePositionManager.onBorrow (same InvalidSlippage selector as the
        // modifier). Post-fix must shrink the previewDeposit result by
        // `LEVERAGE.SHARES_BUFFER_BPS` before passing to convertToShares so
        // the outer buffer covers cToken drift and the inner buffer covers
        // vault drift. Anchor on the two previewDeposit + buffer shape, not a
        // specific variable name, so future readability refactors don't
        // break this test.
        const getVaultExpectedIdx = pmSrc.indexOf('getVaultExpectedShares');
        assert.ok(getVaultExpectedIdx > -1, 'getVaultExpectedShares must be defined');
        const fnEnd = pmSrc.indexOf('\n    }\n', getVaultExpectedIdx);
        const fnBody = pmSrc.slice(getVaultExpectedIdx, fnEnd);
        assert.match(
            fnBody,
            /previewDeposit\(/,
            'function must still call previewDeposit on the underlying vault',
        );
        assert.match(
            fnBody,
            /SHARES_BUFFER_BPS/,
            'function must apply SHARES_BUFFER_BPS to the inner previewDeposit result',
        );
    });
});
