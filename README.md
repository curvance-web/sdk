<p style="text-align: center;width:100%">
    <img src="https://pbs.twimg.com/profile_banners/1445781144125857796/1773687595/1500x500" alt="Curvance"/>
</p>

A TypeScript SDK for interacting with the Curvance protocol. Built on ethers v6 with a bulk-loaded cache model — `setupChain()` preloads all market data in 1–3 RPC calls, and all subsequent reads are synchronous from cache.

## ❯ Install

```
$ npm install --save curvance
```

## ❯ Supported Chains

Chain identifiers use Alchemy-style prefixes:

| Chain | Identifier |
|---|---|
| Monad Mainnet | `monad-mainnet` |
| Arbitrum Sepolia | `arb-sepolia` |

## ❯ Quick Start

```ts
import { setupChain } from "curvance";
import { ethers } from "ethers";

const wallet = new ethers.Wallet(privateKey, provider);
const { markets, reader, dexAgg, global_milestone } = await setupChain("monad-mainnet", wallet);
```

`setupChain` signature:

```ts
setupChain(
    chain: ChainRpcPrefix,
    provider: curvance_provider | null = null,   // signer (wallet) OR read-only provider; null → SDK default
    approval_protection: boolean = false,         // revoke-before-approve pattern
    api_url: string = "https://api.curvance.com",
    options: {
        feePolicy?: FeePolicy;                    // zap/leverage fee routing (default: NO_FEE_POLICY)
        account?: address | null;                 // user address for user-specific reads without a signer
        readProvider?: curvance_read_provider | null;  // explicit override for read transport
    } = {}
): Promise<{
    markets: Market[],
    reader: ProtocolReader,
    dexAgg: IDexAgg,
    global_milestone: MilestoneResponse | null
}>
```

### RPC routing

- **Wallet connected** (signer with a `.provider`) → the wallet's own provider is the **primary** read source; the chain's configured RPC + fallbacks absorb wallet RPC failures. This distributes read load across users' wallet RPCs and respects whichever endpoint each user chose.
- **Signerless / public view** → the chain's configured RPC is primary; chain fallbacks serve as backup.
- **Explicit `options.readProvider`** → wins over all of the above. Use when you want deterministic read transport (e.g. fork testing).
- **Writes** always route through the connected signer; they never use the chain RPC or fallbacks.

### Explore markets

```ts
for (const market of markets) {
    console.log(`${market.name} | deposits: ${market.totalDeposits} | debt: ${market.totalDebt}`);
    for (const token of market.tokens) {
        console.log(`  ${token.symbol} | price: ${token.getPrice()} | apy: ${token.getApy(true)}%`);
    }
}
```

## ❯ Providers

`curvance_provider` accepts any ethers v6 provider or signer. All providers are automatically wrapped with retry logic (exponential backoff for rate limits and 5xx errors).

| Type | Use case |
|---|---|
| `ethers.Wallet` | CLI / server-side with private key |
| `ethers.JsonRpcSigner` | Browser wallet (MetaMask, etc.) |
| `ethers.JsonRpcProvider` | Read-only or custom RPC |
| `null` | SDK constructs a provider from chain config |

`curvance_signer` = `JsonRpcSigner | Wallet` — required for write operations (deposit, borrow, etc.)

## ❯ Markets

`Market` is the top-level container. Each market groups related collateral and borrow tokens and tracks the user's aggregate position.

### Market properties

```ts
market.name                 // market name
market.address              // market contract address
market.totalDeposits        // total market deposits (USD, Decimal)
market.totalDebt            // total outstanding debt (USD, Decimal)
market.totalCollateral      // total posted collateral (USD, Decimal)
market.cooldownLength       // hold period between actions (20 min)
market.hasBorrowing()       // whether this market supports borrowing
market.highestApy()         // best supply APY across all tokens
market.ltv                  // LTV range {min, max} or single value
```

### User position (all in USD as `Decimal`)

```ts
market.userDeposits         // total deposits
market.userDebt             // total outstanding debt
market.userMaxDebt          // maximum allowable debt
market.userRemainingCredit  // available borrow capacity (with 0.1% buffer)
market.userCollateral       // posted collateral (in shares)
market.positionHealth       // health factor — null means infinite (no debt)
market.userNet              // deposits - debt
```

### Rate tracking

```ts
// rateType: 'day' | 'week' | 'month' | 'year'
market.getUserDepositsChange('week')   // projected earnings
market.getUserDebtChange('week')       // projected interest cost
market.getUserNetChange('week')        // net projected change
```

### Data refresh

```ts
await market.reloadMarketData()       // refresh rates, prices, utilization
await market.reloadUserData(account)  // refresh user balances and position
```

## ❯ Tokens (CToken / BorrowableCToken)

Tokens within a market are either `CToken` (collateral/supply side) or `BorrowableCToken` (extends `CToken` with borrow/repay). Access them via `market.tokens` or `market.getBorrowableCTokens()`.

### Token metadata

```ts
token.symbol
token.name
token.decimals
token.asset              // underlying ERC20 address
token.isBorrowable       // whether this token can be borrowed
token.isVault            // whether underlying is an ERC4626 vault
token.isNativeVault      // native token vault (e.g. shMON)
token.canZap             // supports zap deposits
token.canLeverage        // supports leverage
token.maxLeverage        // max allowed leverage (Decimal)
```

### Market state

```ts
token.exchangeRate       // current share-to-asset rate
token.totalAssets        // total assets held (bigint)
token.totalSupply        // total shares outstanding (bigint)
token.borrowPaused
token.collateralizationPaused
token.mintPaused
```

### Prices & conversions

```ts
token.getPrice()                         // asset price (USD, Decimal)
token.getPrice(true)                     // share price
token.convertTokensToUsd(amount)         // TokenInput → USD
token.convertUsdToTokens(usd)            // USD → TokenInput
token.convertTokenInputToShares(amount)  // user input → shares
token.virtualConvertToAssets(shares)     // shares → assets (cached, no RPC)
token.virtualConvertToShares(assets)     // assets → shares (cached, no RPC)
```

### User balances

```ts
token.getUserShareBalance(inUSD)      // cToken balance
token.getUserAssetBalance(inUSD)      // underlying asset balance
token.getUserUnderlyingBalance(inUSD) // underlying token balance
token.getUserCollateral(inUSD)        // posted collateral
token.getUserDebt(inUSD)              // outstanding debt (borrow tokens)
```

### Market totals & caps

```ts
token.getDeposits(inUSD)               // underlying assets held (USD or bigint)
token.getTotalCollateral(inUSD)
token.getCollateralCap(inUSD)          // remaining collateral capacity
token.getDebtCap(inUSD)               // remaining debt capacity
token.getRemainingCollateral(formatted)
token.getRemainingDebt(formatted)
```

### Collateral parameters

```ts
token.getCollRatio(inBPS)            // collateralization ratio
token.getCollReqSoft(inBPS)          // soft liquidation threshold
token.getCollReqHard(inBPS)          // hard liquidation threshold
token.getLiqIncBase(inBPS)           // liquidation incentive base
token.getLiqIncMin(inBPS)            // liquidation incentive min
token.getLiqIncMax(inBPS)            // liquidation incentive max
token.liquidationPrice               // oracle liquidation price (null = infinite)
```

### APY & rates

```ts
token.getApy(asPercentage)           // supply APY
token.getTotalSupplyRate()           // supply APY + incentives + native yield
token.getBorrowRate(inPercentage)    // borrow APY
token.getTotalBorrowRate()           // borrow APY minus incentive rewards

// BorrowableCToken only
token.getLiquidity(inUSD)            // available liquidity to borrow
token.getUtilizationRate(inPercentage)
token.getPredictedBorrowRate(inPercentage)
token.getMaxBorrowable()             // max amount given credit
```

### Position snapshot & preview

```ts
token.getSnapshot(account)                // position snapshot for an account
token.maxRedemption(inShares, bufferTime) // max redeemable amount
token.simulateDeposit(amount)             // preview deposit without executing
token.simulateDepositAsCollateral(amount)
```

## ❯ Core Operations

All amounts are `Decimal` (human-readable token units) unless noted.

### Approvals

```ts
await token.approveUnderlying(amount, target)  // approve underlying asset spend
await token.approve(amount, spender)            // approve cToken itself
await token.getAllowance(contract, underlying)  // check allowance
```

### Deposit & Withdraw

```ts
// Deposit as supplier (earns yield, cannot be used as collateral)
await token.deposit(amount, zap?, receiver?)

// Deposit as collateral (enables borrowing against it)
await token.depositAsCollateral(amount, zapInstructions?, receiver?)

// Withdraw
await token.redeem(amount)           // by asset amount
await token.redeemShares(amount)     // by share amount
await token.redeemCollateral(amount, receiver?, owner?)

// Manage posted collateral
await token.postCollateral(amount)   // post unposted balance as collateral
await token.removeCollateral(amount, removeAll?)
```

### Borrow & Repay (`BorrowableCToken` only)

```ts
await borrowToken.borrow(amount, receiver?)
await borrowToken.repay(amount)

// Previews
const impact = await borrowToken.hypotheticalBorrowOf(amount) // on-chain health preview
await borrowToken.fetchDebt(inUSD)
await borrowToken.debtBalance(account)
```

### Interest rate model

```ts
await borrowToken.fetchBorrowRate()
await borrowToken.fetchSupplyRate()
await borrowToken.fetchUtilizationRate()
await borrowToken.fetchPredictedBorrowRate()
await borrowToken.fetchUtilizationRateChange(assets, direction)
borrowToken.borrowChange(amount, rateType)  // interest accrual over time period
```

## ❯ Plugins (Zappers & Position Managers)

Zapper and PositionManager contracts must be approved before first use.

```ts
// Check and approve a plugin
const approved = await token.isPluginApproved('simple', 'zapper')
if (!approved) await token.approvePlugin('simple', 'zapper')

// Plugin types
// ZapperTypes:          'none' | 'native-vault' | 'vault' | 'simple' | 'native-simple'
// PositionManagerTypes: 'native-vault' | 'simple' | 'vault'

const zapper = token.getZapper('simple')
const positionManager = token.getPositionManager('simple')
```

## ❯ Zapping (Swap + Deposit)

Zap deposits allow depositing any token by swapping to the required underlying via the DEX aggregator.

```ts
// Native token (MON) → deposit
await token.approvePlugin('native-simple', 'zapper')
await zapper.nativeZap(ctoken, amount, collateralize)

// Any ERC20 → swap → deposit
await token.approvePlugin('simple', 'zapper')
await token.approveUnderlying(amount)
await token.depositAsCollateral(amount, {
    type: 'simple',
    inputToken: inputTokenAddress,
    slippage: new Decimal(0.01)   // 1%
})
```

Check approval status for a zap before executing:

```ts
const approved = await token.isZapAssetApproved(instructions, amount)
if (!approved) await token.approveZapAsset(instructions, amount)
```

## ❯ Leverage & Deleverage

Leverage uses the PositionManager plugin to atomically borrow and swap into the collateral token.

```ts
// One-step: deposit collateral + leverage
await collateralToken.approveUnderlying(amount)
await collateralToken.approvePlugin('simple', 'positionManager')
await collateralToken.depositAndLeverage(amount, borrowToken, targetLeverage, 'simple', slippage)

// Separate: deposit first, then leverage
await collateralToken.depositAsCollateral(amount)
await collateralToken.leverageUp(borrowToken, new Decimal(3), 'simple', new Decimal(0.005))

// Reduce leverage
await collateralToken.leverageDown(borrowToken, currentLeverage, targetLeverage, 'simple', slippage)

// Check current leverage
collateralToken.getLeverage()   // Decimal | null (null if no debt)
```

### Leverage previews (via ProtocolReader)

```ts
const preview = await reader.hypotheticalLeverageOf(account, depositCToken, borrowCToken, depositAmount)
// Returns: { currentLeverage, adjustMaxLeverage, maxLeverage, maxDebtBorrowable }
```

## ❯ Health & Position Previews

Preview position health before executing any action. Returns a `Decimal` percentage (0–1) or `null` (infinite / no debt).

```ts
// Individual action previews
await market.previewPositionHealthDeposit(ctoken, amount)
await market.previewPositionHealthRedeem(ctoken, amount)
await market.previewPositionHealthBorrow(borrowToken, amount)
await market.previewPositionHealthRepay(borrowToken, amount)
await market.previewPositionHealthLeverageUp(depositCToken, depositAmount, borrowCToken, borrowAmount)
await market.previewPositionHealthLeverageDown(depositCToken, borrowCToken, newLeverage, currentLeverage)

// Generic preview
await market.previewPositionHealth(depositCToken, borrowCToken, isDeposit, collateralAmt, isRepay, debtAmt, bufferTime)

// Projected earnings/cost impact
await market.previewAssetImpact(user, collateralCToken, debtCToken, depositAmount, borrowAmount, rateType)
```

```ts
const health = await market.previewPositionHealthBorrow(borrowToken, new Decimal(1000))
if (health === null) {
    // remains solvent with infinite health
} else if (health.lt(0.1)) {
    console.warn("Would drop to 10% health — too risky")
}
```

## ❯ Cooldowns

Curvance enforces a 20-minute hold period between certain actions.

```ts
market.cooldown                          // Date | null (current cooldown expiry)
await market.expiresAt(account)          // fetch cooldown expiry from chain
await market.multiHoldExpiresAt(markets) // cooldown across multiple markets
```

## ❯ Format Utilities

Pure calculation helpers for building UI or simulating outcomes. All accept and return `Decimal`.

### Leverage math

```ts
import { leverage } from "curvance"

leverage.calculateBorrowAmount(depositUsd, leverageMultiplier)
leverage.calculateLeverageRatio(totalValue, debtAmount)
leverage.calculateDeleverageAmount(currentLeverage, targetLeverage, totalValue)
leverage.calculatePositionSize(tokenAmount, leverageMultiplier)
leverage.validateLeverageInput(input)           // checks balance, min deposit, max leverage, liquidity
leverage.checkLeverageAmountBelowMinimum(input) // $10.10 minimum borrow
leverage.checkBorrowExceedsLiquidity(borrowAmount, availableLiquidity)
```

### Contract-level slippage amplification

```ts
import { amplifyContractSlippage, toContractSwapSlippage } from "curvance"

// Used internally by CToken.leverageUp / leverageDown / depositAndLeverage to
// expand the contract-level slippage budget for the equity-fraction amplification
// that on-chain `checkSlippage` applies. Each deterministic per-swap loss
// (CURVANCE_FEE_BPS, full-deleverage overshoot) gets amplified by (L-1) in
// (L-1)-terms, so contractSlippage must absorb it without dipping into the
// user's raw `slippage` budget (reserved for variable DEX impact + drift).
amplifyContractSlippage(baseSlippageBps, leverageDelta, bpsToAmplify)

// Used by DEX aggregator adapters (KyberSwap etc.) in `quoteAction` to
// compute the WAD-BPS slippage tolerance for the `Swap.slippage` struct
// field consumed by on-chain `_swapSafe`. When the aggregator pre-deducts
// a currency_in fee, the expansion absorbs that fee so `_swapSafe` doesn't
// double-count it as swap slippage. Adapters whose fee model does NOT
// pre-deduct (e.g., out-of-band referrer paid from output) should call
// with `feeBps` omitted / 0n so no expansion applies.
toContractSwapSlippage(userSlippageBps, feeBps?)
```

### Borrow math

```ts
import { borrow } from "curvance"

borrow.calculateMaxBorrow(remainingCredit, remainingDebt, availableLiquidity)
borrow.calculateMaxRepay(userBalance, userDebt)
borrow.validateRepayRemainder(currentDebtUsd, repayAmountUsd)  // enforces $10 minimum remainder
borrow.calculateDebtPreview(currentDebt, amount, isRepaying)
borrow.convertAmountByCurrencyView(amount, price, currencyView) // USD ↔ token view
```

### Collateral math

```ts
import { collateral } from "curvance"

collateral.calculateExchangeRate(assetBalance, shareBalance)
collateral.calculateCollateralBreakdown(assetBalance, shares, exchangeRate)
collateral.calculateNewCollateral(currentCollateral, amount, action)
```

### Health display

```ts
import { health } from "curvance"

health.getHealthStatus(percentageValue)       // 'Danger' | 'Caution' | 'Healthy'
health.healthFactorToPercentage(rawFactor)
health.formatHealthFactorPercentage(value)
health.formatHealthFactor(value)              // handles infinity
health.getLiquidityStatus(ratio)              // 'green' | 'yellow' | 'red'
```

### Amount formatting

```ts
import { amounts } from "curvance"

amounts.clampUsdDustAmount(value)             // zero out sub-$0.01 amounts
amounts.normalizeAmountString(value, maxFractionDigits, roundingMode)
amounts.normalizeCurrencyAmounts({ amount, currencyView, tokenDecimals, price })
```

## ❯ Helpers & Utilities

```ts
import {
    getContractAddresses,
    contractSetup,
    handleTransactionWithOracles,
    toDecimal, toBigInt,
    getDepositApy, getBorrowCost,
    getInterestYield, getNativeYield,
    getMerklDepositIncentives, getMerklBorrowIncentives,
    getRateSeconds,
    WAD, WAD_DECIMAL, BPS, RAY,
    UINT256_MAX, EMPTY_ADDRESS, NATIVE_ADDRESS,
    DEFAULT_SLIPPAGE_BPS,
} from "curvance"
```

| Helper | Description |
|---|---|
| `getContractAddresses(chain)` | All contract addresses for a chain |
| `contractSetup(provider, address, abi)` | Create a typed contract instance |
| `handleTransactionWithOracles(...)` | Wraps a tx in a Redstone multicall when a pull oracle price write is required |
| `toDecimal(value, decimals)` | `bigint` → `Decimal` |
| `toBigInt(value, decimals)` | `Decimal` → `bigint` |
| `getDepositApy(token, opportunities, apyOverrides)` | Total deposit yield (interest + Merkl + native) |
| `getBorrowCost(token, opportunities)` | Net borrow cost — may be negative when rewards exceed rate |
| `getInterestYield(token)` | Lending APY only |
| `getNativeYield(token, apyOverrides)` | Native yield component |
| `getMerklDepositIncentives(tokenAddress, opportunities)` | Merkl reward APR for deposits |
| `getMerklBorrowIncentives(tokenAddress, opportunities)` | Merkl reward APR for borrows |
| `getRateSeconds(rateType)` | Convert `'year' \| 'month' \| 'week' \| 'day'` → seconds |

## ❯ Fee Policy

The SDK supports configurable fees applied at the DEX aggregator layer for swaps. Fees are denominated in BPS of the swap input and charged on leverage, deleverage, deposit+leverage, and zap operations.

```ts
import { flatFeePolicy, NO_FEE_POLICY } from "curvance"

const feePolicy = flatFeePolicy({
    bps: 10n,                          // 0.1% default fee
    feeReceiver: "0xYourAddress",
    chain: "monad-mainnet",
    stableToStableBps: 2n,             // optional lower fee for stable↔stable swaps
})

const { markets } = await setupChain("monad-mainnet", wallet, false, undefined, { feePolicy })
```

The SDK automatically returns 0 bps for native ↔ wrapped-native swaps and same-token no-op zaps.

```ts
// FeePolicy interface — implement your own
interface FeePolicy {
    feeReceiver: address;
    getFeeBps(ctx: FeePolicyContext): bigint;
}

// Context passed to getFeeBps
interface FeePolicyContext {
    operation: 'leverage-up' | 'leverage-down' | 'deposit-and-leverage' | 'zap';
    inputToken: address;
    outputToken: address;
    inputAmount: bigint;
    currentLeverage: Decimal | null;
    targetLeverage: Decimal | null;
}
```

## ❯ Integrations

### Merkl rewards

```ts
import { fetchMerklOpportunities, fetchMerklUserRewards, fetchMerklCampaignsBySymbol } from "curvance"

// All active opportunities (APR, token, type)
const opportunities = await fetchMerklOpportunities()

// Pending rewards for a user
const rewards = await fetchMerklUserRewards({ wallet: address, chainId: 143 })

// Campaigns for a specific token
const campaigns = await fetchMerklCampaignsBySymbol({ tokenSymbol: "USDC" })
```

### Portfolio snapshots

```ts
import { takePortfolioSnapshot, snapshotMarket } from "curvance"

// Full portfolio across all markets
const snapshot = await takePortfolioSnapshot(account)
// Returns: { account, chain, timestamp, totalDepositsUSD, totalDebtUSD, netUSD, dailyEarnings, dailyCost, markets[] }

// Single market
const marketSnapshot = snapshotMarket(market)
```

## ❯ Optimizer

The `OptimizerReader` reads yield-rebalancing vaults that allocate across markets.

```ts
import { OptimizerReader } from "curvance"

const optimizer = new OptimizerReader(provider)

await optimizer.getOptimizerMarketData(optimizerAddresses)
// Returns: { totalAssets, sharePrice, performanceFee, markets[] }

await optimizer.getOptimizerUserData(optimizerAddresses, account)
// Returns: user balance and redeemable amounts

await optimizer.optimalDeposit(optimizer, assets)    // best market to deposit into
await optimizer.optimalWithdrawal(optimizer, assets) // best market to withdraw from
await optimizer.optimalRebalance(optimizer)          // suggested reallocations: { cToken, assets }[]
```

## ❯ TypeScript Types

```ts
// Primitives
type address = `0x${string}`          // checksummed Ethereum address
type bytes = `0x${string}`            // hex-encoded calldata
type Percentage = Decimal             // 0–1, e.g. 0.7 = 70%
type USD = Decimal                    // human-readable USD (1.0 = $1)
type USD_WAD = bigint                 // USD in 1e18 WAD format
type TokenInput = Decimal             // human-readable token amount
type TypeBPS = bigint                 // basis points (10000 = 100%)
type ChainRpcPrefix = "monad-mainnet" | "arb-sepolia"
type curvance_provider = JsonRpcSigner | Wallet | JsonRpcProvider
type curvance_signer = JsonRpcSigner | Wallet

// Market categorization
type MarketCategory = "stablecoin" | "staking" | "restaking" | "yield-stablecoin" | "blue-chip" | "native"
type CollateralSource = "Renzo" | "Upshift" | "Yuzu" | "Native" | "Circle" | "Fastlane" | "Apriori" | "Mu Digital" | "Kintsu" | "Reservoir"

// Operations
type ZapperTypes = 'none' | 'native-vault' | 'vault' | 'simple' | 'native-simple'
type PositionManagerTypes = 'native-vault' | 'simple' | 'vault'
type ChangeRate = 'year' | 'month' | 'week' | 'day'

// DEX
interface Quote {
    to: address
    calldata: bytes
    min_out: bigint
    out: bigint
}
```

All numeric return values are `bigint` or `Decimal` — never plain JS `number`.

## ❯ Constants

```ts
WAD              // 1_000_000_000_000_000_000n  (1e18)
BPS              // 10_000n
RAY              // 1_000_000_000_000_000_000_000_000_000n  (1e27)
WAD_SQUARED      // 1e36n
WAD_DECIMAL      // Decimal('1e18')
UINT256_MAX
EMPTY_ADDRESS    // '0x0000000000000000000000000000000000000000'
NATIVE_ADDRESS   // canonical native token address
DEFAULT_SLIPPAGE_BPS  // 100n  (1%)
```

## ❯ Dependencies

| Package | Purpose |
|---|---|
| [ethers v6](https://www.npmjs.com/package/ethers) | Typed contract interactions, providers, and signer handling |
| [decimal.js](https://www.npmjs.com/package/decimal.js) | Arbitrary-precision math for all token amounts, prices, and rates |
| [@redstone-finance/sdk](https://www.npmjs.com/package/@redstone-finance/sdk) | Price feed writes bundled into multicalls for pull-oracle adaptors |

## ❯ Pre-Publish Checklist

Run before every `npm publish` that touches `src/chains/`, `src/setup.ts`,
`src/retry-provider.ts`, or any RPC-adjacent code:

1. **Unit tests green.** `npm test` — must show all `test:transport` tests
   passing. `tests/rpc-config-shape.test.ts` locks the structural invariants
   of `chain_rpc_config` (no known-bad RPCs, no duplicate fallbacks, policy
   fields within sane ranges).

2. **Live RPC probe against both app origins.** In the app repo:

   ```bash
   cd path/to/curvance-app
   RPC_PROBE_YES=1 node scripts/rpc-probe.mjs
   ```

   The probe hits `staging.curvance.com` and `app.curvance.com` origins
   against every URL in `chain_rpc_config`. Required thresholds for the
   **primary** and **first fallback** on each chain:

   - CORS preflight returns `204` or `200` with a matching `Access-Control-Allow-Origin` header
   - Correctness call returns a valid `chainId` matching the chain
   - Latency `p95 ≤ 500ms`
   - 50-concurrent-burst: `≥ 45/50` successful (allow 10% for transient blips)

   Any primary or first-fallback failing these thresholds **blocks the
   publish**. Demote to a later fallback position or replace.

   Deeper-cascade fallbacks (`fallbacks[1]+`) MAY have looser limits if
   documented inline with a comment in `chain_rpc_config`.

3. **Do not add the probe to CI.** The probe fires ~500 requests per run
   across 5-10 public RPCs from a single IP. Running it on every PR would
   trip per-IP rate limits and eventually provoke origin bans from the
   free RPCs we depend on — recreating the exact failure mode
   (monadinfra 403'ing `staging.curvance.com`) that motivated building
   this probe.

4. **Republish workflow.** Version bump → `npm publish` → in app repo,
   bump `curvance` in `package.json` to the new version → `yarn install`
   → commit `yarn.lock` → deploy.
