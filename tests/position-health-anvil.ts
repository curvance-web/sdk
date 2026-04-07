/**
 * Test: Single leverage operation on anvil fork
 *
 * Usage:
 *   npx tsx tests/position-health-anvil.ts
 */

import { JsonRpcProvider, Wallet, ethers } from 'ethers';
import Decimal from 'decimal.js';
import { setupChain, all_markets } from '../src/setup';
import type { CToken } from '../src/classes/CToken';
import type { BorrowableCToken } from '../src/classes/BorrowableCToken';
import type { address } from '../src/types';
import { spawn, type ChildProcess } from 'child_process';

// ── Config ──────────────────────────────────────────────────────────
const PRIVATE_KEY = '';
const USER_ADDRESS = '' as address;
const COLLATERAL_SYMBOL = 'shMON';
const BORROW_SYMBOL = 'WMON';
const FORK_RPC = '';
const ANVIL_PORT = 8546;
const MARKET_MANAGER = '0xE1C24B2E93230FBe33d32Ba38ECA3218284143e2' as address;

const DIRECTION: 'up' | 'down' = 'down';
const TARGET_LEVERAGE = 5;
const SLIPPAGE = 0.05;

// ── Anvil ───────────────────────────────────────────────────────────
let anvilProcess: ChildProcess | null = null;

async function startAnvil(): Promise<void> {
  return new Promise((resolve) => {
    anvilProcess = spawn('anvil', [
      '--fork-url', FORK_RPC,
      '--port', String(ANVIL_PORT),
      '--auto-impersonate',
      '--retries', '20',
      '--compute-units-per-second', '50',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    anvilProcess.on('error', (e) => console.error('Anvil error:', e));
    const timeout = setTimeout(resolve, 8000);
    anvilProcess.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('Listening on')) {
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      }
    });
  });
}

function stopAnvil() { anvilProcess?.kill(); anvilProcess = null; }

const PROTOCOL_READER = '0x4Fa99687a90948A930BE2c1Cc540C12fD525bE73' as address;
const WAD = 10n ** 18n;

async function getOnChainHealth(provider: JsonRpcProvider, user: address): Promise<number> {
  const iface = new ethers.Interface([
    'function getPositionHealth(address mm, address account, address cToken, address borrowableCToken, bool isDeposit, uint256 collateralAssets, bool isRepayment, uint256 debtAssets, uint256 bufferTime) view returns (uint256 positionHealth, bool errorCodeHit)'
  ]);
  const result = await provider.send('eth_call', [{
    to: PROTOCOL_READER,
    data: iface.encodeFunctionData('getPositionHealth', [
      MARKET_MANAGER, user,
      ethers.ZeroAddress, ethers.ZeroAddress,
      false, 0n, false, 0n, 0n
    ]),
  }, 'latest']);
  const [positionHealth] = iface.decodeFunctionResult('getPositionHealth', result);
  if (positionHealth === ethers.MaxUint256) return Infinity;
  // positionHealth = soft * WAD / debt. Convert to percentage: (health / WAD - 1) * 100
  return (Number(positionHealth) / 1e18 - 1) * 100;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('Starting anvil fork...');
  await startAnvil();

  try {
    const anvilRpc = new JsonRpcProvider(`http://127.0.0.1:${ANVIL_PORT}`);
    const signer = new Wallet(PRIVATE_KEY, anvilRpc);
    console.log(`Signer: ${signer.address}`);
    console.log('Loading SDK...');
    await setupChain('monad-mainnet', signer);

    let coll: CToken | null = null;
    let borr: BorrowableCToken | null = null;
    for (const m of all_markets) {
      for (const t of m.tokens) {
        if (t.asset.symbol === COLLATERAL_SYMBOL && !coll) coll = t as CToken;
        if (t.asset.symbol === BORROW_SYMBOL && t.market?.address === coll?.market?.address) borr = t as BorrowableCToken;
      }
    }
    if (!coll || !borr) { console.error('Token not found'); return; }

    const market = coll.market;
    await market.reloadUserData(USER_ADDRESS);

    const currentLev = coll.getLeverage() ?? Decimal(1);
    const sdkHealth = market.positionHealth;

    // Raw statusOf
    const onChainHealth = await getOnChainHealth(anvilRpc, USER_ADDRESS);

    console.log(`\nCurrent leverage: ${currentLev.toFixed(4)}x`);
    console.log(`SDK health:       ${sdkHealth ? sdkHealth.mul(100).toFixed(2) + '%' : '∞'}`);
    console.log(`On-chain health:  ${onChainHealth.toFixed(2)}%`);

    // SDK preview health
    let previewHealth: number | null;
    if (DIRECTION === 'up') {
      const { borrowAmount, rawBorrowAmount } = coll.previewLeverageUp(Decimal(TARGET_LEVERAGE), borr);
      console.log(`\nPreview inputs:`);
      console.log(`  borrowAmount (reduced): ${borrowAmount.toFixed(4)}`);
      console.log(`  rawBorrowAmount:        ${rawBorrowAmount.toFixed(4)}`);
      const h = await market.previewPositionHealthLeverageUp(coll, borr, Decimal(TARGET_LEVERAGE));
      previewHealth = h ? h.mul(100).toNumber() : null;
    } else if (TARGET_LEVERAGE === 1) {
      previewHealth = null;
    } else {
      const h = await market.previewPositionHealthLeverageDown(coll, borr, Decimal(TARGET_LEVERAGE), currentLev);
      previewHealth = h ? h.mul(100).toNumber() : null;
    }
    console.log(`Preview health: ${previewHealth?.toFixed(2) ?? '∞'}%`);

    // Execute
    console.log(`\nExecuting ${DIRECTION} to ${TARGET_LEVERAGE}x...`);
    try {
      if (DIRECTION === 'up') {
        const levType = (coll.isVault || coll.isNativeVault) ? 'native-vault' : 'simple';
        await coll.leverageUp(borr, Decimal(TARGET_LEVERAGE), levType as any, Decimal(SLIPPAGE));
      } else {
        await coll.leverageDown(borr, currentLev, Decimal(TARGET_LEVERAGE), 'simple' as any, Decimal(SLIPPAGE));
      }

      // Read after
      const healthAfter = await getOnChainHealth(anvilRpc, USER_ADDRESS);
      console.log(`On-chain health after: ${healthAfter.toFixed(2)}%`);

      const diff = previewHealth != null ? previewHealth - healthAfter : 0;
      console.log(`\n${'='.repeat(50)}`);
      console.log(`Preview:  ${previewHealth?.toFixed(2) ?? '∞'}%`);
      console.log(`Actual:   ${healthAfter === Infinity ? '∞' : healthAfter.toFixed(2) + '%'}`);
      console.log(`Diff:     ${diff > 0 ? '+' : ''}${diff.toFixed(2)}%`);
      console.log(`Status:   ${Math.abs(diff) <= 2 ? '✓ PASS' : '✗ FAIL (>2% off)'}`);
      console.log(`${'='.repeat(50)}`);
    } catch (err: any) {
      const msg = err.message?.includes('Call failed') ? 'OracleRoute/swap call failed'
        : err.message?.slice(0, 80);
      console.log(`TX FAILED: ${msg}`);
    }
  } finally {
    stopAnvil();
  }
}

main().catch((err) => { console.error(err); stopAnvil(); });
