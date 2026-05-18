<p style="text-align: center;width:100%">
    <img src="https://pbs.twimg.com/profile_banners/1445781144125857796/1773687595/1500x500" alt="Curvance"/>
</p>

A TypeScript SDK for interacting with the Curvance protocol. It uses ethers v6 and a setup-bound cache model: `setupChain()` loads market state up front, snapshots the chain configuration it used, and returns markets whose reads are synchronous until an explicit refresh runs.

## ❯ Install

```
$ npm install --save curvance
```

## ❯ Supported Chains

Chain identifiers use Alchemy-style prefixes:

| Chain | Identifier | Support |
|---|---|---|
| Monad Mainnet | `monad-mainnet` | Production mainnet; setup/read, rewards, Kyber-backed simple zaps/leverage where configured |
| Arbitrum Sepolia | `arb-sepolia` | Testnet read/setup surface; DEX routes fail closed through `UnsupportedDexAgg` |

## ❯ Quick Start

```ts
import { setupChain } from "curvance";
import { ethers } from "ethers";

const wallet = new ethers.Wallet(privateKey, provider);
const { chain, chainId, setupConfigSnapshot, markets, reader, dexAgg, global_milestone } =
    await setupChain("monad-mainnet", wallet);
```

`setupChain` signature:

```ts
setupChain(
    chain: ChainRpcPrefix,
    provider: curvance_provider | null = null,   // signer (wallet) OR read-only provider; null → SDK default
    api_url: string = "https://api.curvance.com",
    options: {
        feePolicy?: FeePolicy;                    // default is setup-resolved; Kyber chains require checker-compatible policy
        account?: address | null;                 // user address for user-specific reads without a signer
        readProvider?: curvance_read_provider | null;  // explicit override for read transport
    } = {}
): Promise<{
    chain: ChainRpcPrefix,
    chainId: number,
    setupConfigSnapshot: Readonly<SetupConfigSnapshot>, // includes chain asset metadata and service policies
    markets: Market[],
    reader: ProtocolReader,
    dexAgg: IDexAgg,
    global_milestone: MilestoneResponse | null
}>
```

`setupChain()` still publishes a single active setup for compatibility helpers
such as `getActiveUserMarkets()` and snapshot calls without explicit `markets`.
Multichain-safe code should pass explicit `markets`, `reader`, provider,
account, or setup context instead of relying on the latest singleton.

### Architecture contract

The current SDK architecture is result-bound. A `setupChain(...)` result owns
the chain context that produced it, and downstream objects should keep using
that context even if another chain boots later.

| Layer | Contract |
|---|---|
| Setup snapshot | `setupConfigSnapshot` contains chain id, environment, cloned/frozen asset metadata, cloned/frozen external service policy, contract addresses, read transport, signer/account, API URL, and fee policy. |
| Returned markets | `Market` and `CToken` instances keep the setup snapshot and reader they were created with. Explicit returned-result calls stay on that chain after the module singleton moves. |
| Compatibility globals | `setup_config` and `all_markets` exist for single-active-chain consumers. Treat no-argument helpers as compatibility paths, not multichain-safe state. |
| External services | Curvance API reward/native-yield slugs and Kyber API/router/chain aliases live in chain config and are cloned into the setup snapshot. Helper code should read the snapshot, not mutable exported config. |
| DEX routing | Markets receive a setup-bound `dexAgg` after boot. `CToken` route discovery and zap/leverage execution do not fall back to `chain_config.dexAgg`; unsupported or manually constructed markets fail closed unless a market-bound adapter is attached. |
| Fee/checker policy | Kyber-backed chains validate checker-compatible fee policy during setup. The current checker requires `CURVANCE_FEE_BPS` and the setup-resolved DAO receiver before routes are advertised or markets finish booting. |

### RPC routing

- **Wallet connected** (signer with a `.provider`) → the wallet's own provider is the **primary** read source; the chain's configured RPC + fallbacks absorb wallet RPC failures. This distributes read load across users' wallet RPCs and respects whichever endpoint each user chose.
- **Signerless / public view** → the chain's configured RPC is primary; chain fallbacks serve as backup.
- **Explicit `options.readProvider`** → wins over all of the above. Use when you want deterministic read transport (e.g. fork testing).
- **Writes** always route through the connected signer; they never use the chain RPC or fallbacks.

### Write approvals

- High-level write methods always preflight the approvals they need before submit.
- Missing ERC20 allowance throws a descriptive error instead of sending a revert-prone transaction.
- Missing zapper or position-manager delegate approval also throws before submit.
- There is no setup-time approval mode switch. Use `approveUnderlying`, `approveZapAsset`, and `approvePlugin` explicitly when the caller needs to satisfy approvals.

### Explore markets

```ts
for (const market of markets) {
    console.log(`${market.name} | deposits: ${market.totalDeposits} | debt: ${market.totalDebt}`);
    for (const token of market.tokens) {
        console.log(`  ${token.symbol} | price: ${token.getPrice(true)} | apy: ${token.getApy(true)}%`);
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

`curvance_signer` = `JsonRpcSigner | Wallet`, required for write operations (deposit, borrow, etc.)

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
market.positionHealth       // health factor; null means infinite (no debt)
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
token.getPrice()                         // share price (USD, Decimal)
token.getPrice(true)                     // asset price
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
token.maxRemovableCollateral(inShares, bufferTime) // max posted collateral removable without violating health
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
await token.removeCollateralExact(amount) // exact collateral removal, capped to the safe removable max
await token.removeMaxCollateral()         // remove the maximum valid posted collateral
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
// `leverageDown(...)` currently executes through the 'simple' position manager only.

const zapper = token.getZapper('simple')
const positionManager = token.getPositionManager('simple')
```

Prefer `token.getZapper(...)` so the zapper carries the token's setup-bound DEX aggregator. Direct construction must use the same setup result as the CToken it will operate on:

```ts
import { Zapper } from "curvance"

const setup = await setupChain("monad-mainnet", wallet)
const token = setup.markets[0].tokens[0]
const zapperAddress = token.getPluginAddress("simple", "zapper")
if (zapperAddress == null) throw new Error("Simple zapper is not configured")

const zapper = new Zapper(
    zapperAddress,
    wallet,
    "simple",
    setup.setupConfigSnapshot,
    setup.dexAgg,
)
```

A direct `Zapper` built without the setup-bound adapter throws. A `Zapper`
from one setup result also refuses to build calldata for a CToken from another
setup result.

## ❯ Zapping (Swap + Deposit)

Zap deposits allow depositing another token by swapping to the required underlying through the setup-bound DEX aggregator.

`token.getDepositTokens(search?)` is the route-discovery entrypoint. It always
includes the direct deposit asset and then adds native, vault, and simple-swap
routes only when the token and chain can execute them. DEX-sourced simple
routes require a market-bound executable adapter; unsupported DEX chains expose
readable markets but no simple zap or simple leverage routes.

```ts
// Native token (MON) → deposit
await token.approvePlugin('native-simple', 'zapper')
await token.depositAsCollateral(amount, 'native-simple')

// Any ERC20 → swap → deposit
await token.approvePlugin('simple', 'zapper')
const simpleZap = {
    type: 'simple',
    inputToken: inputTokenAddress,
    slippage: new Decimal(0.01)   // 1%
} as const
await token.approveZapAsset(simpleZap, amount)
await token.depositAsCollateral(amount, simpleZap)
```

Check approval status for a zap before executing:

```ts
const rawZapAmount = toBigInt(amount, inputTokenDecimals)
const approved = await token.isZapAssetApproved(instructions, rawZapAmount)
if (!approved) await token.approveZapAsset(instructions, amount)
```

## ❯ Leverage & Deleverage

Leverage uses the PositionManager plugin to atomically borrow and swap into the collateral token.

```ts
// One-step: deposit collateral + leverage
const positionManager = collateralToken.getPluginAddress('simple', 'positionManager')
if (positionManager == null) throw new Error("Simple position manager is not configured")

await collateralToken.approveUnderlying(amount, positionManager)
await collateralToken.depositAndLeverage(amount, borrowToken, targetLeverage, 'simple', slippage)

// Separate: deposit first, then leverage
await collateralToken.approveUnderlying(amount)
await collateralToken.depositAsCollateral(amount)
await collateralToken.leverageUp(borrowToken, new Decimal(3), 'simple', new Decimal(0.005))

// Reduce leverage
// Deleverage currently executes through the simple position manager path.
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
await market.previewPositionHealthLeverageUp(depositCToken, borrowCToken, newLeverage, depositAmount)
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
    console.warn("Would drop to 10% health - too risky")
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

Pure calculation helpers for building UI or simulating outcomes. Amount and
leverage helpers primarily use `Decimal`; validation, health-status, slippage,
and normalization helpers also expose `number`, `bigint`, string, and structured
result types where those are the safer UI boundary.

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

// Used by DEX aggregator adapters in `quoteAction` to
// compute the WAD-BPS slippage tolerance for the `Swap.slippage` struct
// field consumed by on-chain `_swapSafe`. When an adapter's fee model is
// represented as value loss in the swap calldata (for example Kyber's
// currency_in fee), pass `feeBps` so `_swapSafe`
// does not treat deterministic fee loss as user slippage. Adapters whose
// fees are not observable as swap value loss should omit `feeBps` / pass 0n.
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
| `toDecimal(value, decimals)` | `bigint` → `Decimal` |
| `toBigInt(value, decimals)` | `Decimal` → `bigint` |
| `getDepositApy(token, opportunities, apyOverrides)` | Total deposit yield (interest + Merkl + native) |
| `getBorrowCost(token, opportunities)` | Net borrow cost; may be negative when rewards exceed rate |
| `getInterestYield(token)` | Lending APY only |
| `getNativeYield(token, apyOverrides)` | Native yield component |
| `getMerklDepositIncentives(tokenAddress, opportunities)` | Merkl reward APR for deposits |
| `getMerklBorrowIncentives(tokenAddress, opportunities)` | Merkl reward APR for borrows |
| `getRateSeconds(rateType)` | Convert `'year' \| 'month' \| 'week' \| 'day'` → seconds |

## ❯ Fee Policy

The SDK supports configurable fees applied at the DEX aggregator layer for swaps. Fees are denominated in BPS of the swap input and charged on leverage, deleverage, deposit+leverage, and zap operations.

For standard Curvance app/front-end usage, omit `options.feePolicy` and let
`setupChain()` build the default Curvance fee policy:

```ts
const { markets } = await setupChain("monad-mainnet", wallet)
```

The default policy charges `CURVANCE_FEE_BPS` and resolves the fee receiver from
`CentralRegistry.daoAddress()` once during setup. App consumers should not
hardcode or pin a DAO fee receiver locally. Pass `options.feePolicy` only for an
intentional custom integration override.

```ts
import {
    CURVANCE_FEE_BPS,
    flatFeePolicy,
    setupChain,
} from "curvance"

const defaultSetup = await setupChain("monad-mainnet", wallet)

const feePolicy = flatFeePolicy({
    // Kyber-backed chains require one exact checker-compatible DEX fee.
    bps: CURVANCE_FEE_BPS,
    feeReceiver: defaultSetup.setupConfigSnapshot.feePolicy.feeReceiver,
    chain: "monad-mainnet",
})

const { markets } = await setupChain("monad-mainnet", wallet, undefined, { feePolicy })
```

On Kyber-backed chains, setup validates explicit policies before rewards or
markets boot. A zero-fee policy, wrong BPS value, or wrong receiver rejects
with a checker-policy error. Context-dependent lower tiers such as
`stableToStableBps` are not valid for checker-bound Kyber routes because the
on-chain checker enforces one exact BPS value and DAO receiver. On
unsupported-Dex chains such as `arb-sepolia`, `NO_FEE_POLICY` remains valid and
setup skips the DAO lookup because no DEX route can execute there.

The SDK automatically returns 0 bps for native ↔ wrapped-native swaps and same-token no-op zaps.

```ts
// FeePolicy interface: implement your own
interface FeePolicy {
    // "any" marks chain-agnostic no-op policies; chain-bound policies must match setupChain.
    chain?: "monad-mainnet" | "arb-sepolia" | "any";
    feeReceiver: address;
    // Required on checker-bound routes when the policy is custom.
    checkerCompatibility?: {
        exactFeeBpsForDexSwaps: bigint;
        feeReceiver: address;
    };
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

// Active opportunities for a production display path (APR, token, type)
const opportunities = await fetchMerklOpportunities({ chainId: 143 })

// Pending rewards for a user
const rewards = await fetchMerklUserRewards({ wallet: address, chainId: 143 })

// Campaigns for a specific token on one chain
const campaigns = await fetchMerklCampaignsBySymbol({ tokenSymbol: "USDC", chainId: 143 })

// Chainless Merkl calls are all-chain utilities. Filter explicitly before
// using them in production multichain display paths.
const allChainOpportunities = await fetchMerklOpportunities({})
```

### Portfolio snapshots

```ts
import { takePortfolioSnapshot, snapshotMarket } from "curvance"

// Full portfolio across the current active-chain markets
const snapshot = await takePortfolioSnapshot(account)
// Returns: { account, chain, timestamp, totalDepositsUSD, totalDebtUSD, netUSD, dailyEarnings, dailyCost, markets[] }
// Each market row includes { chain, chainId }. Mixed-chain snapshots require:
// takePortfolioSnapshot(account, { markets, allowMixedChains: true })

// Single market
const marketSnapshot = snapshotMarket(market)
```

`snapshotMarket(...)` requires full user token data. `takePortfolioSnapshot(...)` will automatically promote summary-scoped markets back to full user data before reading token balances. If you previously called `refreshActiveUserMarketSummaries(...)` and need a direct single-market snapshot, run `market.reloadUserData(account)` or `Market.reloadUserMarkets(...)` first.

## ❯ Optimizer

The `OptimizerReader` reads yield-rebalancing vaults that allocate across markets.

```ts
import { ERC20, LendingOptimizer, OptimizerReader } from "curvance"

const optimizerReader = new OptimizerReader(optimizerReaderAddress, provider)

await optimizerReader.getOptimizerAPY(optimizerAddress)
// Returns: weighted-average optimizer APY in WAD

await optimizerReader.getOptimizerMarketData(optimizerAddresses)
// Returns: { totalAssets, sharePrice, performanceFee, apy, markets[] }

await optimizerReader.getOptimizerUserData(optimizerAddresses, account)
// Returns: user balance and redeemable amounts

await optimizerReader.optimalRebalance(optimizerAddress, 100n)
// Returns: { actions: { cToken, assetsOrBps }[], bounds: { cToken, minBps, maxBps }[] }

const asset = new ERC20(provider, assetAddress, undefined, undefined, signer)
const vault = new LendingOptimizer(optimizerAddress, asset, provider, signer)

await vault.deposit(amount, account)
await vault.withdraw(amount, account, account)
await vault.redeem(shares, account, account)
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
type ChainEnvironment = "production-mainnet" | "testnet" | "local"
type curvance_read_provider = JsonRpcProvider
type curvance_provider = JsonRpcSigner | Wallet | JsonRpcProvider
type curvance_signer = JsonRpcSigner | Wallet

interface SetupConfigSnapshot {
    chain: ChainRpcPrefix
    chainId: number
    environment: ChainEnvironment
    assets: Readonly<ChainAssetConfig>
    services: Readonly<ChainServiceConfig>
    contracts: Readonly<Record<string, unknown>>
    readProvider: curvance_read_provider
    signer: curvance_signer | null
    account: address | null
    api_url: string
    feePolicy: FeePolicy
}

// Market categorization
type MarketCategory = "stablecoin" | "staking" | "restaking" | "yield-stablecoin" | "blue-chip" | "native"
type CollateralSource = "Renzo" | "Upshift" | "Yuzu" | "Native" | "Circle" | "Fastlane" | "Apriori" | "Mu Digital" | "Kintsu" | "Reservoir"

// Operations
type ZapperTypes = 'none' | 'native-vault' | 'vault' | 'simple' | 'native-simple'
type PositionManagerTypes = 'native-vault' | 'simple' | 'vault'
// `leverageDown(...)` accepts 'simple' only.
type ChangeRate = 'year' | 'month' | 'week' | 'day'

// DEX
interface Quote {
    to: address
    calldata: bytes
    min_out: bigint
    out: bigint
}
```

Core monetary, token, share, health, APY, and fixed-point values use `bigint`
or `Decimal`. Backend API DTOs may expose raw `number` fields before SDK
normalization; do not use those DTO fields as contract-scale values.

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

### Leverage tuning (`LEVERAGE`)

Exposed tuning block used by leverage preview / mutation paths. Values are considered tunable across releases. SDK consumers pinning against specific values opt into the coupling.

```ts
import { LEVERAGE } from 'curvance';

LEVERAGE.MAX_LEVERAGE_FACTOR          // Decimal(0.98)
// Cap applied to the theoretical max leverage span. Reserves ~2% of the
// equity-fraction slippage budget for deterministic loss channels
// (CURVANCE_FEE_BPS, pool-fee variance, oracle drift, share rounding)
// that would otherwise push post-op LTV above collRatio at the boundary.

LEVERAGE.LEVERAGE_UP_BUFFER_BPS       // 10n
// Flat BPS buffer added to leverage-up slippage for share-rounding + fresh
// Oracle price drift between snapshot RPC and tx broadcast. NOT amplified
// by (L-1); the contract's equity-fraction denominator handles amplification.

LEVERAGE.DELEVERAGE_OVERHEAD_BPS      // 60n
// BPS overhead added to full-deleverage swap sizing to absorb DEX impact
// and oracle drift without leaving dust debt. The contract returns any
// excess debt token to the user, so economic loss is zero, but
// `checkSlippage` treats the intentional overshoot as equity loss and
// amplifies it by (L-1), which the contract-slippage expansion compensates.

LEVERAGE.SHARES_BUFFER_BPS            // 2n
// Downward BPS buffer on `virtualConvertToShares` and the inner
// `previewDeposit` step of `getVaultExpectedShares`. Covers exchange-rate
// drift from interest accrual since cache load so actual mint satisfies
// `shares >= expectedShares` at tx inclusion.

LEVERAGE.LEVERAGE_UP_VAULT_DRIFT_BPS  // 30n
// Per-leverage-unit BPS buffer for `checkSlippage` on vault + native-vault
// leverage-up paths. Absorbs drift between the collateral vault's
// fundamental mint rate at tx time and the stored oracle price that
// `marketManager.statusOf` uses inside `checkSlippage`. Mirrors the
// `(L-1) × feeBps` amplification the simple branch uses for DEX-fee
// absorption, with a different K since vault paths have no DEX leg.
```

## ❯ Dependencies

| Package | Purpose |
|---|---|
| [ethers v6](https://www.npmjs.com/package/ethers) | Typed contract interactions, providers, and signer handling |
| [decimal.js](https://www.npmjs.com/package/decimal.js) | Arbitrary-precision math for all token amounts, prices, and rates |

## ❯ Pre-Publish Checklist

Run before every `npm publish`:

1. **Typecheck and deterministic transport gate green.**

   ```bash
   node node_modules/typescript/bin/tsc --noEmit
   npm run test:transport
   ```

   `npm test` is an alias for `test:transport`. `tests/rpc-config-shape.test.ts`
   locks the structural invariants of `chain_rpc_config` (no known-bad RPCs,
   no duplicate fallbacks, policy fields within sane ranges).

2. **Fork gate green or explicitly skipped with reason.** `npm run test:fork`
   must pass when fork env is available. If it skips, record which env/artifact
   blocker caused the skip before treating the release as covered.

3. **Package artifact smoke green.**

   ```bash
   npm run test:dist-smoke
   npm pack --dry-run --json
   ```

   `prepack` and `prepublishOnly` rebuild `dist`, and `test:dist-smoke`
   imports the packed package root. Package consumers load the artifact, so
   source-green or build-green alone is not package-boundary proof.

4. **Workspace hygiene clean.**

   ```bash
   git diff --check
   git status --short
   ```

   Confirm new imported production files are tracked. This matters because
   dirty-tree tests can pass while a clean package checkout cannot import an
   untracked source file.

5. **Live RPC probe against both app origins for RPC-adjacent changes.** In the
   app repo:

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

6. **Do not add the probe to CI.** The probe fires ~500 requests per run
   across 5-10 public RPCs from a single IP. Running it on every PR would
   trip per-IP rate limits and eventually provoke origin bans from the
   free RPCs we depend on. That recreates the exact failure mode
   (monadinfra 403'ing `staging.curvance.com`) that motivated this probe.

7. **Republish workflow.** Version bump -> `npm publish` -> in app repo,
   bump `curvance` in `package.json` to the new version -> `yarn install`
   -> commit `yarn.lock` -> deploy.
