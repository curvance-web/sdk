/**
 * Test: Position Health Preview Accuracy
 *
 * Compares SDK preview position health for leverage-up and leverage-down.
 * Uses the actual SDK methods (same as the app).
 *
 * Usage:
 *   npx tsx tests/position-health-preview.ts
 */

import { JsonRpcProvider, Wallet } from 'ethers';
import Decimal from 'decimal.js';
import { setupChain, all_markets } from '../src/setup';
import type { CToken } from '../src/classes/CToken';
import type { BorrowableCToken } from '../src/classes/BorrowableCToken';
import type { address } from '../src/types';

// ── Config ──────────────────────────────────────────────────────────
const PRIVATE_KEY = '';
const USER_ADDRESS = '' as address;
const COLLATERAL_SYMBOL = 'shMON';
const BORROW_SYMBOL = 'WMON';

const LEVERAGE_UP_TARGETS = [5, 7, 9];
const LEVERAGE_DOWN_TARGETS = [3, 2, 1];

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('Setting up chain...');
  const rpc = new JsonRpcProvider('');
  const signer = new Wallet(PRIVATE_KEY, rpc);
  console.log(`Signer address: ${signer.address}`);
  await setupChain('monad-mainnet', signer);
  console.log(`Found ${all_markets.length} markets\n`);

  let collateralToken: CToken | null = null;
  let borrowToken: BorrowableCToken | null = null;

  for (const m of all_markets) {
    for (const token of m.tokens) {
      if (token.asset.symbol === COLLATERAL_SYMBOL && !collateralToken) {
        collateralToken = token as CToken;
      }
      if (token.asset.symbol === BORROW_SYMBOL && token.market?.address === collateralToken?.market?.address) {
        borrowToken = token as BorrowableCToken;
      }
    }
  }

  if (!collateralToken || !borrowToken) {
    console.error('Token not found');
    process.exit(1);
  }

  const market = collateralToken.market;
  await market.reloadUserData(USER_ADDRESS);

  const currentLev = collateralToken.getLeverage() ?? Decimal(1);
  const currentHealth = market.positionHealth;

  console.log(`Market: ${market.name}`);
  console.log(`Vault: ${collateralToken.isVault}, NativeVault: ${collateralToken.isNativeVault}`);
  console.log(`Max Leverage: ${collateralToken.maxLeverage.toFixed(2)}x`);
  console.log(`Current Leverage: ${currentLev.toFixed(4)}x`);
  console.log(`Current Health:   ${currentHealth ? (currentHealth.mul(100).toFixed(2) + '%') : '∞'}`);
  console.log(`Collateral USD:   $${collateralToken.getUserCollateral(true).toFixed(4)}`);
  console.log(`Debt USD:         $${market.userDebt.toFixed(4)}`);

  const hasPosition = currentLev.gt(1);

  // ── Leverage Up ────────────────────────────────────────────────
  if (hasPosition) {
    console.log('\n' + '='.repeat(60));
    console.log('LEVERAGE UP (previewPositionHealthLeverageUp)');
    console.log('='.repeat(60));

    for (const target of LEVERAGE_UP_TARGETS) {
      if (Decimal(target).lte(currentLev) || Decimal(target).gt(collateralToken.maxLeverage)) {
        console.log(`\n  ${target}x — SKIPPED`);
        continue;
      }

      try {
        const health = await market.previewPositionHealthLeverageUp(
          collateralToken,
          borrowToken,
          Decimal(target),
        );
        const healthPct = health ? health.mul(100).toFixed(2) : '∞';

        const { borrowAmount, rawBorrowAmount } = collateralToken.previewLeverageUp(Decimal(target), borrowToken);

        console.log(`\n  UP to ${target}x:`);
        console.log(`    Preview Health:     ${healthPct}%`);
        console.log(`    Borrow (reduced):   ${borrowAmount.toFixed(4)}`);
        console.log(`    Borrow (raw/debt):  ${rawBorrowAmount.toFixed(4)}`);
      } catch (err: any) {
        console.log(`\n  UP to ${target}x — ERROR: ${err.message}`);
      }
    }
  }

  // ── Leverage Down ──────────────────────────────────────────────
  if (hasPosition) {
    console.log('\n' + '='.repeat(60));
    console.log('LEVERAGE DOWN (previewPositionHealthLeverageDown)');
    console.log('='.repeat(60));

    for (const target of LEVERAGE_DOWN_TARGETS) {
      if (Decimal(target).gte(currentLev)) {
        console.log(`\n  ${target}x — SKIPPED`);
        continue;
      }

      try {
        const health = await market.previewPositionHealthLeverageDown(
          collateralToken,
          borrowToken,
          Decimal(target),
          currentLev,
        );
        const healthPct = health ? health.mul(100).toFixed(2) : '∞';

        console.log(`\n  DOWN to ${target}x:`);
        console.log(`    Preview Health:     ${healthPct}%`);
      } catch (err: any) {
        console.log(`\n  DOWN to ${target}x — ERROR: ${err.message}`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('DONE');
}

main().catch(console.error);
