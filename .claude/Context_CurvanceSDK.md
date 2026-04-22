---
Context file for Curvance SDK (contract-sdk). Load specific sections via grep on `## [LABEL]` headers, routed from Skill_CurvanceSDK.md.
---

# Curvance SDK Context

## [SETUP_FLOW]

### `setupChain(chain, provider?, approval_protection?, api_url?, options?)`

Bootstrap entry point. Must run before any SDK usage.

```ts
type SetupChainOptions = {
  feePolicy?: FeePolicy;
  account?: address | null;
  readProvider?: curvance_read_provider | null;
};

async function setupChain(
  chain: ChainRpcPrefix,
  provider: curvance_provider | null = null,
  approval_protection: boolean = false,
  api_url: string = "https://api.curvance.com",
  options: SetupChainOptions = {},
): Promise<{
  markets: Market[],
  reader: ProtocolReader,
  dexAgg: IDexAgg,
  global_milestone: MilestoneResponse | null
}>
```

**Side effects:**
- Sets module-level `setup_config`
- Sets module-level `all_markets`
- Wraps the read transport with retry/fallback policy from `chains/rpc.ts`

**Data model:** `setupChain` bulk-loads all market, token, and user data via `Market.getAll()` -> ProtocolReader in a single batch of RPC calls. This populates `.cache` on every CToken and Market instance. The app reads from this bulk-loaded data everywhere; selective refreshes happen on mutations.

**`Market.getAll` data-loading sequence:**
1. `reader.getAllMarketData(user)` -> 3 parallel RPC calls (static, dynamic, user)
2. In parallel: rewards/native-yield fetches
3. Construct `Market` / `CToken` instances from RPC data
4. Enrich token APY fields from Merkl/native-yield responses

### `setup_config` (module global)

```ts
{
  chain: ChainRpcPrefix,
  contracts: ReturnType<typeof getContractAddresses>,
  readProvider: curvance_read_provider,
  signer: curvance_signer | null,
  account: address | null,
  provider: curvance_provider,   // deprecated alias: signer ?? readProvider
  approval_protection: boolean,
  api_url: string,
  feePolicy: FeePolicy
}
```

### Provider routing contract

- If `provider` is a signer and `options.readProvider` is not set, the signer's own provider becomes the primary read source.
- The chain-configured provider plus chain fallbacks remain the fallback chain for connected-wallet reads.
- If no signer is connected, `chain_config[chain].provider` stays the primary read provider.
- Writes still route through `signer` only; the wallet-primary rule is read-path behavior, not a write-path change.

### Chain Configuration

Each chain entry in `chain_config` carries:
- `chainId`
- `dexAgg`
- `provider`
- `fallbackProviders`
- native token metadata
- vault metadata

**Supported chains:** `monad-mainnet`, `arb-sepolia`

### Contract Addresses (from `chains/*.json`)

Each chain JSON has:
- `CentralRegistry`, `OracleManager`, `ProtocolReader`
- oracle adaptors
- calldata checkers
- zappers
- market definitions and plugin addresses

---

## [DATA_SHAPES]

Full type definitions: `src/classes/ProtocolReader.ts`. Key semantic notes for fields that aren't self-explanatory:

| Field | In type | Semantics |
|---|---|---|
| `cooldownLength` | StaticMarketData | Seconds before withdraw after deposit |
| `collRatio` | StaticMarketToken | LTV ratio (raw TypeBPS bigint) |
| `irmBaseRate` | StaticMarketToken | Annualized (`baseRate × SECONDS_PER_YEAR`) |
| `irmVertexStart` | StaticMarketToken | Utilization where vertex kicks in (raw BPS) |
| `sharePrice`, `assetPrice` | DynamicMarketToken | WAD-scaled (1e18) |
| `borrowRate`, `supplyRate` | DynamicMarketToken | Per-second, WAD-scaled |
| `utilizationRate` | DynamicMarketToken | WAD-scaled (0 to 1e18) |
| `liquidity` | DynamicMarketToken | Available to borrow (BorrowableCToken only) |
| `positionHealth` | UserMarket | WAD-scaled, UINT256_MAX = infinite (no debt) |
| `cooldown` | UserMarket | Timestamp, not duration |
| `priceStale` | UserMarket | True if oracle price is stale — check before operations |
| `liquidationPrice` | UserMarketToken | UINT256_MAX = no liquidation price |

**UserData (top-level from `getUserData`):**
- `markets: UserMarket[]` — per-market position data
- `locks: UserLock[]` — vesting/lock entries (`{ lockIndex: bigint, amount: bigint, unlockTime: bigint }`)

**Key enums:**
- `AdaptorTypes` (in `ProtocolReader.ts`): `CHAINLINK` = keccak hash (large bigint), `REDSTONE_CLASSIC` = large bigint, `REDSTONE_CORE = 2n`, `MOCK = 1337n`. Compare with `===`, not numeric equality.
- `ZapperInstructions`: `'none' | 'native-vault' | 'vault' | 'native-simple' | { type, inputToken, slippage }`

**On-chain structs (Solidity):**
- `HypotheticalResult`: collateral/maxDebt/debt (WAD), collateralSurplus/liquidityDeficit (WAD), loanSizeError (true if < MIN_ACTIVE_LOAN_SIZE 10e18), oracleError
- `OptimizerMarketData`: optimizer address/asset/totalAssets/markets/totalLiquidity, sharePrice (WAD), performanceFee (BPS)

---

## [MARKET_API]

**Constructor:** `new Market(provider, staticData, dynamicData, userData, deployData, oracleManager, reader)`

**Properties:**
| Property | Type | Source |
|---|---|---|
| `address` | `address` | `staticData.address` |
| `tokens` | `(CToken \| BorrowableCToken)[]` | Built in constructor |
| `oracle_manager` | `OracleManager` | Injected |
| `reader` | `ProtocolReader` | Injected |
| `cache` | `{ static, dynamic, user, deploy }` | Merged data |
| `milestone` | `MilestoneResponse \| null` | From API |
| `incentives` | `IncentiveResponse[]` | From API |

**Getters (synchronous, from bulk-loaded data):**
| Getter | Return | Notes |
|---|---|---|
| `name` | `string` | Deploy name |
| `plugins` | `Plugins` | `{ simplePositionManager?, vaultPositionManager?, nativeVaultPositionManager? }` |
| `cooldownLength` | `bigint` | Seconds |
| `adapters` | `bigint[]` | Oracle adaptor IDs |
| `cooldown` | `Date \| null` | null if not in cooldown |
| `userCollateral` | `Decimal` | Total collateral in shares (18 decimals) |
| `userDebt` | `USD` | In USD |
| `userMaxDebt` | `USD` | Max borrowable in USD |
| `userRemainingCredit` | `USD` | maxDebt - debt, with 0.1% buffer |
| `positionHealth` | `Percentage \| null` | null = infinite (no debt) |
| `userDeposits` | `USD` | Sum of all token deposits |
| `userNet` | `USD` | deposits - debt |
| `ltv` | `string` | `"75%"` or `"70% - 85%"` range |
| `tvl` | `USD` | Total market TVL |
| `totalDebt` | `USD` | Sum of borrowable token debt |
| `totalCollateral` | `USD` | Sum of all collateral |

**Methods:**
| Method | Params | Return | Notes |
|---|---|---|---|
| `getBorrowableCTokens()` | — | `{ eligible: BorrowableCToken[], ineligible: BorrowableCToken[] }` | Ineligible if user has collateral in that token or no market collateral |
| `getUserDepositsChange(rate)` | `ChangeRate` | `USD` | Earn per rate period |
| `getUserDebtChange(rate)` | `ChangeRate` | `USD` | Debt cost per rate period |
| `getUserNetChange(rate)` | `ChangeRate` | `USD` | Net earn per rate period |
| `highestApy()` | — | `Percentage` | Max APY across all tokens |
| `hasBorrowing()` | — | `boolean` | Any borrowable token exists |
| `getSnapshots(account)` | `address` | `AccountSnapshot[]` | Per-token snapshots |
| `reloadMarketData()` | — | `void` | Re-fetches dynamic data from ProtocolReader, updates `.cache` fields on all tokens |
| `reloadUserData(account)` | `address` | `void` | Re-fetches user-specific data, updates `.cache` fields on all tokens. Called automatically by `oracleRoute` after every write |
| `previewAssetImpact(user, collCToken, debtCToken, depositAmt, borrowAmt, rate)` | `address, CToken, BorrowableCToken, TokenInput, TokenInput, ChangeRate` | `{ supply: {percent, change}, borrow: {percent, change}, earn: {percent, change} }` | Preview rates after action |
| `previewPositionHealth(deposit?, borrow?, isDeposit, collAmt, isRepay, debtAmt, buffer)` | mixed | `Percentage \| null` | Generic health preview |
| `previewPositionHealthDeposit(ctoken, amount)` | `CToken, TokenInput` | `Percentage \| null` | |
| `previewPositionHealthRedeem(ctoken, amount)` | `CToken, TokenInput` | `Percentage \| null` | |
| `previewPositionHealthBorrow(token, amount)` | `BorrowableCToken, TokenInput` | `Percentage \| null` | |
| `previewPositionHealthRepay(token, amount)` | `BorrowableCToken, TokenInput` | `Percentage \| null` | |
| `previewPositionHealthLeverageDeposit(depCToken, depAmt, borCToken, borAmt)` | `CToken, TokenInput, BorrowableCToken, TokenInput` | `Percentage \| null` | |
| `previewPositionHealthLeverageUp(depCToken, borCToken, newLev)` | `CToken, BorrowableCToken, Decimal` | `Percentage \| null` | |
| `previewPositionHealthLeverageDown(depCToken, borCToken, newLev, curLev)` | `CToken, BorrowableCToken, Decimal, Decimal` | `Percentage \| null` | |
| `hypotheticalLiquidityOf(account, cTokenModified?, redemptionShares?, borrowAssets?)` | `address, address?, bigint?, bigint?` | `HypotheticalLiquidityOf` | Raw contract call |
| `expiresAt(account, fetch?)` | `address, boolean?` | `Date \| null` | Cooldown expiration |
| `multiHoldExpiresAt(markets)` | `Market[]` | `{ [address]: Date \| null }` | Batch cooldown check |
| `formatPositionHealth(bigint)` | `bigint` | `Percentage \| null` | `Decimal(val).div(WAD).sub(1)` |

**Static methods:**
| Method | Return | Notes |
|---|---|---|
| `Market.getAll(reader, oracle, provider?, milestones?, incentives?)` | `Market[]` | Main factory — called by `setupChain()` |

**`ChangeRate` type:** `'year' | 'month' | 'week' | 'day'`

**`DeployData` interface** (passed to Market constructor via `Market.getAll`):
```ts
interface DeployData {
    name: string,           // Market deploy key (e.g., "gMON | WMON")
    plugins: { [key: string]: address }  // Plugin contract addresses
}
```
`Market.getAll` looks up deploy data from `setup_config.contracts.markets` by matching market address. Markets without deploy data are skipped with a console warning.

---

## [CTOKEN_API]

**Extends:** `Calldata<ICToken>`. Full source: `src/CToken.ts`.

**Key properties:**
- `cache` — merged `StaticMarketToken & DynamicMarketToken & UserMarketToken` (bulk-loaded at setup, synchronous access, refreshed selectively on mutations)
- `zapTypes: ZapperTypes[]` — populated in constructor based on vault type and chain config (`'native-vault'`, `'native-simple'`, `'vault'`, `'simple'`)
- `leverageTypes: string[]` — populated based on market plugins (position managers) and vault type
- `isVault`, `isNativeVault`, `isWrappedNative` — boolean instance properties, set in constructor from chain config
- `nativeApy: Decimal` — native vault yield (set during `Market.getAll` from API). Default `Decimal(0)`
- `incentiveSupplyApy: Decimal` — Merkl LEND APR for this token (set during `Market.getAll`). Default `Decimal(0)`
- `incentiveBorrowApy: Decimal` — Merkl BORROW APR for this token (set during `Market.getAll`). Default `Decimal(0)`

**Constructor skip list:** Tokens with symbols `['csAUSD', 'cwsrUSD', 'cezETH', 'csyzUSD', 'cearnAUSD', 'cYZM']` skip ALL zapTypes and leverageTypes population. These are complex tokens that require custom zap/leverage logic not yet built. They will have empty `zapTypes` and `leverageTypes` arrays regardless of chain config.

**Overload pattern (used throughout CToken and BorrowableCToken):**
Many getters take a boolean: `(true)` → USD formatted, `(false)` → raw bigint or TokenInput. Examples:
- `getUserAssetBalance(true)` → `USD`, `getUserAssetBalance(false)` → `TokenInput`
- `getPrice(true)` → asset price, `getPrice(false)` → share price
- `getPrice()` defaults: `(asset=false, lower=false, formatted=true)` → share price, formatted

Risk parameter getters (`getCollRatio`, `getCollReqSoft/Hard`, `getLiqInc*`, `getCloseFactor*`) all follow: `(true)` → Percentage, `(false)` → raw bigint BPS.

**Conversion methods with caveats:**
| Method | Notes |
|---|---|
| `virtualConvertToAssets/Shares` | Local calculation, no on-chain call |
| `convertToAssets/Shares` | On-chain call (async) |
| `convertTokensToUsd(amount, asset?)` | `asset=true` uses asset price, `false` uses share price |
| `convertTokenToToken(from, to, amount, formatted, shares?)` | Cross-token via prices |

**Write methods (all return `Promise<TransactionResponse>`, all use oracleRoute):**
| Method | Key caveats |
|---|---|
| `deposit(amount, zap?, receiver?)` | Checks approvals, ensureUnderlyingAmount |
| `depositAsCollateral(amount, zap?, receiver?)` | Also checks collateral cap |
| `redeem(amount)` | Converts to shares, respects maxRedemption |
| `redeemCollateral(amount, receiver?, owner?)` | |
| `postCollateral(amount)` | Capped at available balance |
| `removeCollateralExact(amount)` | Preferred exact-removal path. Capped at safe removable collateral and dust-sweeps only to the safe cap |
| `removeMaxCollateral()` | Preferred MAX-removal path. Uses the reader's collateral-only cap with execution buffer |
| `approvePlugin(plugin, type)` | setDelegateApproval for Zapper/PositionManager |
| `approveUnderlying(amount?)` | null = UINT256_MAX |

**Leverage methods:**
| Method | Return shape |
|---|---|
| `previewLeverageUp(newLev, borrow, depositAmt?)` | `{ borrowAmount, newDebt, newDebtInAssets, newCollateral, newCollateralInAssets }` |
| `previewLeverageDown(newLev, currentLev, borrow?)` | `{ collateralAssetReduction, collateralAssetReductionUsd, leverageDiff, newDebt, newDebtInAssets?, newCollateral, newCollateralInAssets }` |
| `leverageUp(borrow, newLev, type, slippage?)` | TransactionResponse |
| `depositAndLeverage(depositAmt, borrow, multiplier, type, slippage?)` | TransactionResponse |

**Query methods with behavioral notes:**
| Method | Notes |
|---|---|
| `maxRedemption(in_shares?, bufferTime?, breakdown?)` | `breakdown=true` → `{ max_collateral, max_uncollateralized }` |
| `getDepositTokens(search?)` | Returns `ZapToken[]` for zap UI |
| `ensureUnderlyingAmount(amount, zap)` | Caps to balance — silent truncation |
| `fetchUserCollateral(formatted?)` | On-chain `collateralPosted()`. Updates cache. `(true)` → Decimal, `(false/default)` → bigint |

**Write pattern internals:**
| Method | Notes |
|---|---|
| `oracleRoute(calldata, override?)` | Gets price updates → wraps in multicall → executeCallData → reloadUserData |
| `getPriceUpdates()` | Returns Redstone multicall actions if oracle needs update |
| `zap(assets, zap, collateralize, default_calldata)` | Routes to appropriate zapper, returns `{ calldata, overrides, zapper }` |

**Key interfaces:**
```ts
interface AccountSnapshot { asset: address; decimals: bigint; isCollateral: boolean; collateralPosted: bigint; debtBalance: bigint; }
interface MulticallAction { target: address; isPriceUpdate: boolean; data: bytes; }
interface ZapToken { interface: NativeToken | ERC20; type: ZapperTypes; quote?: Function; }
```

---

## [BORROWABLE_CTOKEN_API]

**Extends:** `CToken`

Overrides `contract` type to `IBorrowableCToken` (adds borrow/repay/IRM methods).

**Additional getters (overloaded true/false):**
| Method | `(true)` | `(false)` |
|---|---|---|
| `getLiquidity(inUSD)` | `USD` | `USD_WAD (bigint)` |
| `getBorrowRate(inPercentage)` | `Percentage` | `bigint` |
| `getPredictedBorrowRate(inPercentage)` | `Percentage` | `bigint` |
| `getUtilizationRate(inPercentage)` | `Percentage` | `bigint` (note: no `* SECONDS_PER_YEAR` — already a ratio) |
| `getSupplyRate(inPercentage)` | `Percentage` | `bigint` |

**Additional methods:**
| Method | Params | Return | Notes |
|---|---|---|---|
| `borrowChange(amount, rateType)` | `USD, ChangeRate` | `USD` | Projected debt cost |
| `getMaxBorrowable(inUSD?)` | `bool?` | `TokenInput \| USD` | Uses `market.userRemainingCredit` |
| `hypotheticalBorrowOf(amount)` | `TokenInput` | via reader |
| `borrow(amount, receiver?)` | `TokenInput, address?` | `Promise<TransactionResponse>` | Via oracleRoute |
| `repay(amount)` | `TokenInput` | `Promise<TransactionResponse>` | Via oracleRoute |
| `dynamicIRM()` | — | `Promise<IDynamicIRM>` | Gets IRM contract instance |
| `fetchUtilizationRateChange(assets, direction, inPercentage?)` | `TokenInput, 'add'\|'remove', bool?` | `Percentage \| bigint` | Simulates utilization after liquidity change |
| `fetchDebtBalanceAtTimestamp(timestamp?, asUSD?)` | `bigint?, bool?` | `USD \| bigint` | User debt at future timestamp |
| `fetchBorrowRate()` | — | `bigint` | Updates cache |
| `fetchPredictedBorrowRate()` | — | `bigint` | Updates cache |
| `fetchUtilizationRate()` | — | `bigint` | Updates cache |
| `fetchSupplyRate()` | — | `bigint` | Updates cache |
| `fetchLiquidity()` | — | `bigint` | `totalAssets - outstandingDebt` |
| `fetchDebt(inUSD)` | `bool` | `USD \| bigint` | Total market debt |
| `fetchInterestFee()` | — | `Promise<bigint>` | |
| `marketOutstandingDebt()` | — | `Promise<bigint>` | |
| `debtBalance(account)` | `address` | `Promise<bigint>` | |

**Overrides:**
- `depositAsCollateral()` — throws if user has outstanding debt
- `postCollateral()` — throws if user has outstanding debt

**IDynamicIRM interface:**
```ts
interface IDynamicIRM {
  ADJUSTMENT_RATE(): Promise<bigint>;
  linkedToken(): Promise<address>;
  borrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
  predictedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
  supplyRate(assetsHeld: bigint, debt: bigint, interestFee: bigint): Promise<bigint>;
  adjustedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
  utilizationRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
}
```

---

## [PROTOCOL_READER_API]

**Constructor:** `new ProtocolReader(address: address)` — wraps the on-chain `ProtocolReader.sol` contract (1931 lines).

**Key constants (on-chain):**
- `MIN_ACTIVE_LOAN_SIZE`: 10e18 (10 USD minimum loan)
- `MARKET_COOLDOWN_LENGTH`: 20 minutes
- `MARKET_ASSET_RESERVE`: 77777

**SDK methods:**
| Method | Params | Return |
|---|---|---|
| `getAllMarketData(user, use_api?)` | `address, boolean=true` | `{ staticMarket, dynamicMarket, userData }` — 3 parallel calls |
| `getStaticMarketData(use_api?)` | `boolean=true` | `StaticMarketData[]` |
| `getDynamicMarketData(use_api?)` | `boolean=true` | `DynamicMarketData[]` |
| `getUserData(account)` | `address` | `UserData` |
| `maxRedemptionOf(account, ctoken, bufferTime)` | `address, CToken, bigint` | `{ maxCollateralizedShares, maxUncollateralizedShares, errorCodeHit }` |
| `maxCollateralRemovalOf(account, ctoken, bufferTime)` | `address, CToken, bigint` | `{ maxRemovableCollateralShares, errorCodeHit }` - explicit reader seam for posted-collateral removal |
| `hypotheticalRedemptionOf(account, ctoken, shares)` | `address, CToken, bigint` | `(collateralSurplus, liquidityDeficit, isPossible, oracleError)` |
| `hypotheticalBorrowOf(account, ctoken, assets)` | `address, BorrowableCToken, bigint` | `(collateralSurplus, liquidityDeficit, isPossible, loanSizeError, oracleError)` |
| `getPositionHealth(market, user, cToken, borrowableCToken, isDeposit, collateralAssets, isRepayment, debtAssets, bufferTime)` | 9 params | `{ positionHealth: bigint, errorCodeHit: boolean }` |
| `previewAssetImpact(user, collCToken, debtCToken, amountIn, amountOut)` | 5 params | `{ supply: bigint, borrow: bigint }` — per-second rates in WAD |
| `hypotheticalLeverageOf(account, ctoken, borrowCToken, amount)` | `address, address, address, bigint` | `{ currentLeverage, adjustedMaxLeverage, maxLeverage, maxDebtBorrowable, loanSizeError, oracleError }` — all WAD-scaled |
| `marketMultiCooldown(marketAddresses, account)` | `address[], address` | `bigint[]` |
| `debtBalanceAtTimestamp(account, ctoken, timestamp)` | `address, address, bigint` | `bigint` — projects debt using vesting rate model |
| `getLiquidationPrice(account, cToken, long)` | `address, address, bool` | `(price, errorHit)` — long=true for collateral tokens |
| `liquidationValuesOf(mm, account, isAuction)` | — | `(cSoft, cHard, debt, lFactor, errorCodeHit)` |
| `getAllDynamicState(account)` | `address` | `(DynamicMarketData[], UserData)` — combined call |
| `getOptimizerMarketData(optimizers)` | `address[]` | `OptimizerMarketData[]` |
| `getOptimizerUserData(optimizers, account)` | `address[], address` | `OptimizerUserData[]` |
| `optimalDeposit(optimizer, assets)` | `address, uint256` | `address` — best cToken market |
| `optimalWithdrawal(optimizer, assets)` | `address, uint256` | `address` — best cToken market |
| `optimalRebalance(optimizer)` | `address` | `ReallocationAction[]` — 20-chunk greedy allocation |

#### On-Chain Calculation Details

**Position Health** (`getPositionHealth`):
```
positionHealth = (softCollateral × WAD) / debt
```
- Uses `isAuction=true` internally for pessimistic values (applies AUCTION_BUFFER discount)
- Returns `UINT256_MAX` when debt = 0 (infinite health)
- Collateral valued with lower prices (pessimistic), debt with standard prices
- SDK formats: `Decimal(positionHealth).div(WAD).sub(1)` → 0 = at liquidation, null = ∞

**Max Leverage** (computed in `_getStaticTokenConfig`):
```
maxLeverage = BPS × BPS / (BPS - collRatio)
```
Example: 80% LTV (collRatio=8000) → 10000×10000/2000 = 50000 → 5x leverage
SDK converts: `Decimal(cache.maxLeverage).div(BPS)`

**hypotheticalLeverageOf** flow:
1. Get current liquidity via `hypotheticalLiquidityOf`
2. Add new collateral value and maxDebt from deposit
3. Terminal leverage = `1 / (1 - LTV)` extrapolated for account state
4. `maxDebtBorrowable = (maxDebt - debt) × collateral / (collateral - maxDebt)`
5. Convert to asset denomination using debt token price
6. `_adjustForLimitations()` caps by: collateral cap, debt cap, available liquidity

**maxRedemptionOf** flow:
1. Get current hypothetical liquidity (no changes)
2. Uncollateralized shares = balance - collateralPosted (always redeemable)
3. For collateralized shares: calculate redemption debt impact
4. If `debt + redemptionDebt > maxDebt`: partial redemption = `shares × (maxDebt-debt)/redemptionDebt`

**debtBalanceAtTimestamp** (vesting model):
1. Get current debt, rate, vestingEnd, lastVestingClaim
2. If timestamp within current vesting: `newDebt = rate × (timestamp - lastVestingClaim) × debt / WAD`
3. If past vestingEnd: recalculates with `predictedBorrowRate` for new period
4. Returns `debtBalance + newDebt`

**LendingOptimizer system** (new in this version):
- `optimalDeposit(optimizer, assets)`: finds cToken with highest projected supply rate after deposit
- `optimalWithdrawal(optimizer, assets)`: finds cToken with lowest projected supply rate after withdrawal
- `optimalRebalance(optimizer)`: 20-chunk greedy allocation across approved markets, respecting allocation caps and pause states

**Liquidation values** (`liquidationValuesOf`):
- `cSoft` = sum of (collateral × BPS / collReqSoft) — soft liquidation threshold
- `cHard` = sum of (collateral × BPS / collReqHard) — hard liquidation threshold
- `lFactor`: 0 = healthy, WAD = hard liquidation, between = soft liquidation
- If `isAuction=true`: applies AUCTION_BUFFER discount to cSoft/cHard

**Price asymmetry rule (critical):**
- Collateral: `getPrice(underlying, true, getLower=true)` × exchangeRate — pessimistic
- Debt: `getPrice(underlying, true, getLower=false)` — standard

---

## [FORMAT_CONVERTER_API]

All methods are **static**. No instance needed.

| Method | Params | Return | Notes |
|---|---|---|---|
| `bigIntToUsd(value)` | `bigint` | `USD` | Hardcodes 18 decimals. Alias for `bigIntToDecimal(value, 18)` |
| `bigIntToDecimal(value, decimals)` | `bigint, number\|bigint` | `Decimal` | `Decimal(value) / 10^decimals`, ROUND_DOWN |
| `decimalToBigInt(value, decimals)` | `Decimal, number\|bigint` | `bigint` | `value * 10^decimals` truncated (floor) |
| `bigIntTokensToUsd(tokens, price, decimals)` | `bigint, bigint, number\|bigint` | `USD` | `(tokens / 10^decimals) * (price / 1e18)`. Price is WAD-scaled bigint |
| `tokensToTokens(from, to, formatted)` | `{price, decimals, amount}, {price, decimals}, bool` | `TokenInput \| bigint` | Cross-token conversion via USD intermediate |
| `decimalTokensToUsd(tokens, price)` | `Decimal, Decimal` | `USD` | `tokens * price`, 18dp ROUND_DOWN |
| `usdToDecimalTokens(usd, price, decimals)` | `USD, USD\|bigint, number\|bigint` | `Decimal` | `usd / price`, rounded to token decimals. Price accepts Decimal or bigint |
| `usdToBigIntTokens(usd, price, decimals)` | `USD, USD\|bigint, number\|bigint` | `bigint` | `usdToDecimalTokens` → `decimalToBigInt` |
| `bpsToBpsWad(bps)` | `bigint` | `bigint` | `(bps * 1e18) / 10000` |
| `percentageToBps(pct)` | `Percentage` | `bigint` | `pct * 10000` |
| `percentageToBpsWad(pct)` | `Percentage` | `bigint` | `percentageToBps` → `bpsToBpsWad` |
| `percentageToText(pct)` | `Percentage` | `string` | `"75.00%"` |

---

## [ERC20_API]

**Constructor:** `new ERC20(provider, address, cache?)`. Source: `src/ERC20.ts`.

The optional `StaticMarketAsset` data is populated by ProtocolReader during bulk load. When present, property getters (`name`, `symbol`, `decimals`, `totalSupply`, `image`, `balance`, `price`) return values synchronously from loaded data. When absent (standalone ERC20 instances), they return `undefined`.

**Behavioral notes:**
- `balanceOf(account, true)` → `TokenInput`, `balanceOf(account, false)` → raw `bigint` (same overload pattern as CToken)
- `approve(spender, null)` → approves UINT256_MAX
- `rawTransfer(to, amount)` — takes raw bigint, no Decimal conversion (use for pre-converted amounts)

---

## [ERC4626_API]

**Extends:** `ERC20`. Source: `src/ERC4626.ts`. Standard vault methods: `fetchAsset`, `convertToShares/Assets`, `previewDeposit`.

---

## [ORACLE_MANAGER_API]

**Constructor:** `new OracleManager(address, provider?)`

| Method | Params | Return | Notes |
|---|---|---|---|
| `getPrice(asset, inUSD, getLower)` | `address, bool, bool` | `bigint` | Throws on error code 1 (caution) or 2 (failure) |

---

## [NATIVE_TOKEN_API]

Represents chain native token (MON/ETH). No on-chain contract.

| Property | Value |
|---|---|
| `address` | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` |
| `decimals` | `18n` |
| `name` | From chain config |
| `symbol` | From chain config |

| Method | Return |
|---|---|
| `balanceOf(account?, in_token_input?)` | `bigint \| TokenInput` |
| `getPrice(inTokenInput, inUSD, getLower)` | `USD \| bigint` |

---

## [POSITION_MANAGER_API]

**Constructor:** `new PositionManager(address, signer, type)`

Types: `'native-vault' | 'simple' | 'vault'`

| Method | Params | Return |
|---|---|---|
| `getLeverageCalldata(action, slippage)` | `LeverageAction, bigint` | `bytes` |
| `getDeleverageCalldata(action, slippage)` | `DeleverageAction, bigint` | `bytes` |
| `getDepositAndLeverageCalldata(assets, action, slippage)` | `bigint, LeverageAction, bigint` | `bytes` |
| `static emptySwapAction()` | — | `Swap` (all zeros) |
| `static getExpectedShares(ctoken, amount)` | `CToken, bigint` | `bigint` |
| `static getVaultExpectedShares(depositCToken, borrowCToken, borrowAmount)` | — | `bigint` |

```ts
interface LeverageAction {
  borrowableCToken: address; borrowAssets: bigint; cToken: address;
  expectedShares: bigint; swapAction?: Swap; auxData?: bytes;
}
interface DeleverageAction {
  cToken: address; collateralAssets: bigint; borrowableCToken: address;
  repayAssets: bigint; swapActions?: Swap[]; auxData?: bytes;
}
```

---

## [ZAPPER_API]

**Constructor:** `new Zapper(address, signer, type)`

Types: `'none' | 'native-vault' | 'vault' | 'simple' | 'native-simple'`

Mapping: `zapperTypeToName: Map<ZapperTypes, keyof Zappers>` — maps type to setup_config contract key.

| Method | Params | Return |
|---|---|---|
| `nativeZap(ctoken, amount, collateralize)` | `CToken, bigint, bool` | `TransactionResponse` |
| `simpleZap(ctoken, inputToken, outputToken, amount, collateralize, slippage)` | — | `TransactionResponse` |
| `getSimpleZapCalldata(...)` | same | `bytes` — quotes via dexAgg, builds Swap struct |
| `getVaultZapCalldata(ctoken, amount, collateralize, wrapped?)` | — | `bytes` |
| `getNativeZapCalldata(ctoken, amount, collateralize, wrapped?)` | — | `bytes` |

```ts
interface Swap {
  inputToken: address; inputAmount: bigint; outputToken: address;
  target: address; slippage: bigint; call: bytes;
}
```

---

## [CALLDATA_API]

Abstract base for contract interaction.

| Method | Notes |
|---|---|
| `getCallData(functionName, params)` | `contract.interface.encodeFunctionData(...)` |
| `executeCallData(calldata, overrides?)` | `signer.sendTransaction({ to: this.address, data, ...overrides })` |

---

## [REDSTONE_API]

Oracle price update helper.

| Static Method | Params | Return |
|---|---|---|
| `getPayload(symbol, log?)` | `string, bool?` | `{ payload: bytes, timestamp }` |
| `buildMultiCallAction(ctoken)` | `MarketToken` | `MulticallAction` — encodes `writePrice` + payload |

Uses 3-of-4 authorized signers from Redstone primary prod.

---

## [DEX_AGGREGATORS_API]

**IDexAgg interface:**
```ts
interface IDexAgg {
  dao: address;
  router: address;
  getAvailableTokens(provider, query): Promise<ZapToken[]>;
  quoteAction(...args: QuoteArgs): Promise<{ action: Swap, quote: Quote }>;
  quoteMin(...args: QuoteArgs): Promise<bigint>;
  quote(...args: QuoteArgs): Promise<Quote>;
}
```

**KyberSwap** (monad-mainnet):
- 2-step quote flow: GET `/api/v1/routes` -> POST `/api/v1/route/build`
- `quoteAction` converts slippage to WAD for the on-chain `Swap` struct
- when `feeBps > 0`, KyberSwap fee params are encoded in the adapter request itself
- every swap is checked again on-chain by `KyberSwapChecker`

**Kuru** (monad-mainnet):
- JWT-authenticated quote flow
- `quoteAction` converts slippage to WAD
- current source should be treated as its own adapter contract; do not assume KyberSwap fee semantics automatically apply here

**MultiDexAgg**:
- wraps one or more aggregators
- single aggregator -> passthrough
- multiple aggregators -> parallel fan-out with best-quote selection

Adapter fee semantics are intentionally adapter-owned. KyberSwap's pre-swap fee handling lives in the adapter path; do not generalize that behavior across aggregators unless the current source for that adapter proves the same semantics.

---

## [HELPERS]

### Constants

| Name | Value | Use |
|---|---|---|
| `BPS` | `10000n` | Basis points denominator |
| `WAD` | `10n ** 18n` | WAD denominator |
| `WAD_DECIMAL` | `Decimal(10).pow(18)` | WAD as Decimal |
| `RAY` | `10n ** 27n` | Ray denominator |
| `SECONDS_PER_YEAR` | `31536000n` | Rate annualization |
| `UINT256_MAX` | `2n ** 256n - 1n` | Max approval / infinite health |
| `EMPTY_ADDRESS` | `"0x0000...0000"` | Zero address |
| `NATIVE_ADDRESS` | `"0xEeee...eeEE"` | Native token sentinel |
| `EMPTY_BYTES` | `"0x"` | Empty calldata |

### Utility Functions

| Function | Params | Return | Notes |
|---|---|---|---|
| `toDecimal(value, decimals)` | `bigint, bigint` | `Decimal` | `Decimal(value) / 10^decimals` |
| `toBigInt(value, decimals)` | `Decimal, bigint` | `bigint` | `value * 10^decimals` truncated |
| `toBps(value)` | `Decimal` | `bigint` | `value * 10000` |
| `fromBpsToWad(value)` | `bigint` | `bigint` | `value * 1e14` |
| `getRateSeconds(rate)` | `ChangeRate` | `bigint` | Maps rate name to seconds |
| `getChainConfig()` | — | chain config entry | `chain_config[setup_config.chain]` |
| `validateProviderAsSigner(provider)` | `curvance_provider` | `JsonRpcSigner \| Wallet` | Throws if read-only |
| `contractSetup<I>(provider, address, abi)` | — | `Contract & I` | Returns gas-buffered proxy |
| `getContractAddresses(chain)` | `ChainRpcPrefix` | contract addresses | From `chains/*.json` |

### `contractWithGasBuffer(contract)`

Returns a `Proxy` that intercepts all contract method calls. For each call:
1. Estimates gas via `contract.method.estimateGas(...args)`
2. Adds 10% buffer: `gas + gas / 10n`
3. Calls with `{ gasLimit: bufferedGas }`

This is transparent — all `contractSetup()` results are already wrapped.

---

## [RETRY_PROVIDER]

`wrapProviderWithRetries(provider, config?)` wraps the read transport with retry and fallback logic.

Default config comes from `DEFAULT_CHAIN_RPC_POLICY` in `src/chains/rpc.ts`:
- `maxRetries = 1`
- `baseDelay = 150ms`
- `timeoutMs = 4_000`
- `fallbackCooldownMs = 30_000`
- `rankSampleCount = 5`
- `rankWeights = { latency: 0.3, stability: 0.7 }`

Retryable errors include rate limits, network/connectivity failures, server failures, and RPC endpoint errors.

Retry and fallback are separate decisions in current source:
- `isContractError(...)` identifies deterministic contract/user failures that should skip both retry and fallback
- `isRetryableError(...)` controls same-provider retry for transient endpoint failures
- unknown non-contract failures can skip same-provider retry and still advance to a fallback provider

Non-retryable errors are re-thrown wrapped in new `Error` objects, so the original ethers `.code` property does not survive. App-side error filtering must check `.message` content, not `.code`.

---

## [V1_CONSUMPTION_LAYER]

All hooks live in `modules/market/v2/queries/index.ts`. Pattern: most hooks use `useSetupChainQuery` with a `select` function for synchronous data derivation.

### `useSetupChainQuery<TResult>(options?)`

Core hook. Calls `setupChain()` with signer from wagmi. Query key: `['setupchain', signerAddress, networkSlug]`. Enabled logic: if connected, waits for signer; if disconnected, runs immediately (read-only).

Post-processing: `sanitizeMarketNames()` (replaces `&` with `|`, uses token symbols) → `prioritizeDefaultMarket()` (bumps priority markets to front).

### Derived Hooks (select-based, no extra RPC)

| Hook | Select function | Return type |
|---|---|---|
| `useMarketsQuery()` | `data.markets` | `Market[]` |
| `useBorrowableTokensQuery()` | `getBorrowableCTokens()` per market, filtered by debt cap | `{ eligible, ineligible }` |
| `useMarketStatsQuery()` | Sum TVL and debt | `{ totalDeposits: number, activeLoans: number }` |
| `useGlobalTvlQuery()` | Sum TVL | `string` |

### Async Hooks (separate useQuery, extra RPC/compute)

| Hook | Query key | Enabled | Notes |
|---|---|---|---|
| `useZapTokensQuery(token, search?)` | `['zap-tokens', token.address, account, search]` | `!!token && !!account` | Calls `token.getDepositTokens()` |
| `useBalancePriceTokenQuery(depositToken)` | `['zap-tokens', 'balance', account, token.address]` | `!!account && !!token` | `balanceOf()` + `getPrice()` in parallel |
| `useZapTokenQuoteQuery(depositToken, zapToken, amount, slippage)` | `['zap-tokens', 'quote', ...]` | `!!token && !!zapToken.quote && amount > 0` | Calls `zapToken.quote()` |
| `useMaxRedemptionQuery()` | `['maxRedemption', symbol, address]` | `!!token` | `token.maxRedemption()` — reads from deposit store |
| `useMaxLeverageQuery(token, amount)` | `['maxLeverage', amount, address, account]` | `canLeverage && amount > 0` | `reader.hypotheticalLeverageOf()` |
| `useMerklBorrowOpportunitiesQuery()` | `['merkl', ...]` | env flag | External Merkl API |

---

## [V1_ACTION_PATTERNS]

All writes live in `modules/market/v2/mutations/index.ts` and `modules/market/queries/mutations.ts`.

### Architecture

Every mutation follows:
```
useMutation({
  mutationKey: ['transaction', actionType],
  onMutate: ({ amount }) → addTransaction({id, status:'pending', txMethod, ...metadata}),
  mutationFn: async ({ amount }) → SDK call → tx.wait(),
  onSuccess: (receipt) → updateTransaction({status:'success', txHash}) → invalidateUserStateQueries(),
  onError: () → updateTransaction({status:'failed'}),
})
```

**Query invalidation helper:**
```ts
invalidateUserStateQueries(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['setupchain'] });
  queryClient.invalidateQueries({ queryKey: ['positionHealth'] });
  queryClient.invalidateQueries({ queryKey: ['balance'] });
  queryClient.invalidateQueries({ queryKey: ['zap-tokens', 'balance'] });
  queryClient.invalidateQueries({ queryKey: ['user-debt'] });
  queryClient.invalidateQueries({ queryKey: ['maxLeverage'] });
  queryClient.invalidateQueries({ queryKey: ['previewPositionHealthLeverage'] });
  queryClient.invalidateQueries({ queryKey: ['previewPositionHealthEditLeverage'] });
  queryClient.invalidateQueries({ queryKey: ['previewPositionHealthDeposit'] });
  queryClient.invalidateQueries({ queryKey: ['previewPositionHealthRedeem'] });
  queryClient.invalidateQueries({ queryKey: ['previewPositionHealthBorrow'] });
  queryClient.invalidateQueries({ queryKey: ['previewPositionHealthRepay'] });
  queryClient.invalidateQueries({ queryKey: ['previewAssetImpact'] });
}
```

**Fresh token resolution:** Every mutation calls `resolveFreshToken(token)` (`modules/market/v2/utils/resolve-fresh-token.ts`) before any SDK write. Store-held CToken references become stale when `setupChain` re-runs with a signer — the old CToken carries a read-only provider. `resolveFreshToken` looks up the token by address in the module-level `all_markets` array (always current after latest `setupChain`).

**Safe transaction waiting:** Every mutation wraps SDK calls in `safeWaitForTx(txPromise, providerSource)` (`shared/functions/safe-tx-wait.ts`) instead of direct `tx.wait()`. Handles a Monad RPC issue where pending tx responses contain `nonce: null` — ethers v6 throws BAD_DATA but the tx IS broadcast. The wrapper extracts the tx hash from the error object and falls back to `provider.waitForTransaction(hash)`. On error, `txStatusForError(error)` detects this specific failure and marks the transaction as `'success'` in the store (not `'failed'`).

**Note:** All mutation code blocks below show the actual current patterns including `resolveFreshToken` and `safeWaitForTx`.

### `useBorrowTokenMutation()`

Source: `modules/market/v2/mutations/index.ts`
Store: `useBorrowStore` → `token: BorrowableCToken`

```ts
mutationFn: async ({ amount }) => {
  const freshToken = resolveFreshToken(token);
  const receipt = await safeWaitForTx(
    freshToken.borrow(Decimal(amount), walletAddress),
    freshToken,
  );
  return receipt;
}
```

Task integration: Filters tasks by `TaskSlug.BORROW` + chain + tokenTaskGroupMap match.

### `useRepayTokenMutation()`

Store: `useBorrowStore` → `token: BorrowableCToken`
Approval setting: `useApprovalSettingStore` → `'unlimited' | 'exact'`

```ts
mutationFn: async ({ amount, onApprovalStart, onApprovalComplete, onTransactionStart }) => {
  const freshToken = resolveFreshToken(token);

  // 1. Fetch current debt
  const usdUserDebt = await freshToken.fetchDebtBalanceAtTimestamp();
  const userDebt = freshToken.convertUsdToTokens(usdUserDebt);

  // 2. Full repay detection: ≥99.9% of debt → send 0
  const threshold = userDebt.mul(0.999);
  const isPayingAll = Decimal(amount).gte(threshold);

  // 3. Allowance (add 1% buffer for full repay)
  const allowanceAmount = isPayingAll ? Decimal(amount).mul(0.01).add(amount) : Decimal(amount);
  const asset = freshToken.getAsset(true);
  const allowance = await asset.allowance(account.address, freshToken.address);
  if (toDecimal(allowance, freshToken.asset.decimals).lt(allowanceAmount)) {
    onApprovalStart?.();
    await safeWaitForTx(
      asset.approve(freshToken.address, approvalSetting === 'unlimited' ? null : allowanceAmount),
      asset,
    );
  }

  onApprovalComplete?.(); onTransactionStart?.();

  // 4. Repay — 0 = full repay, else partial
  return await safeWaitForTx(
    freshToken.repay(isPayingAll ? Decimal(0) : Decimal(amount)),
    freshToken,
  );
}
```

### `useWithdrawTokenMutation(token)`

Token passed as parameter (not from store).

```ts
mutationFn: async ({ amount }) => {
  const freshToken = resolveFreshToken(token);
  const maxRedemption = await freshToken.maxRedemption();
  const wasCapped = Decimal(maxRedemption).lessThan(amount);
  const effectiveAmount = wasCapped ? Decimal(maxRedemption) : Decimal(amount);
  const receipt = await safeWaitForTx(freshToken.redeem(effectiveAmount), freshToken);
  return { receipt, wasCapped, effectiveAmount };
}
```

On success: if `wasCapped`, updates the transaction record with the effective (capped) amount.

### `useAddCollateralMutation()` / `useRemoveCollateralMutation()`

Store: `useSelectedManageCollateral` → `token: CToken | BorrowableCToken`

```ts
// Add — isMax from useSelectedManageCollateral store
mutationFn: async ({ amount }) => {
  const freshToken = resolveFreshToken(token);
  // For MAX add: pass full asset balance so SDK's share clamping
  // (balance - collateral) avoids dust from asset↔share conversion
  const effectiveAmount = isMax
    ? Decimal(freshToken.getUserAssetBalance(false) || 0)
    : Decimal(amount);
  return await safeWaitForTx(freshToken.postCollateral(effectiveAmount), freshToken);
}

// Remove — exact calldata capped to fresh max removable collateral shares
mutationFn: async ({ amount }) => {
  const freshToken = resolveFreshToken(token);
  const requestedShares = freshToken.convertTokenInputToShares(Decimal(amount));
  const breakdown = await freshToken.maxRedemption(true, 0n, true);
  const sharesToRemove =
    requestedShares < breakdown.max_collateral
      ? requestedShares
      : breakdown.max_collateral;
  const calldata = freshToken.getCallData('removeCollateral', [sharesToRemove]);
  return await safeWaitForTx(freshToken.oracleRoute(calldata), freshToken);
}
```

### `useDepositLeverageMutation(token)`

Store: `useDepositStore` → `borrowToken`, `slippage`
Approval setting from `useApprovalSettingStore`

```ts
mutationFn: async ({ amount, leverage, onTransactionStart, slippage }) => {
  const freshToken = resolveFreshToken(token);

  // 1. Find debt token (first with existing debt, or fallback to borrowToken)
  let debtToken = freshToken.market?.tokens.find(t => t.getUserDebt(true).gt(0));
  if (!debtToken) debtToken = resolveFreshToken(borrowToken);

  // 2. Get position manager — fallback to 'simple' if no leverageTypes
  const leverageTypes = freshToken.leverageTypes?.length
    ? getHighestPriority(freshToken.leverageTypes)
    : 'simple';
  const positionManager = freshToken.getPositionManager(leverageTypes);

  // 3. Asset approval to position manager
  const asset = freshToken.getAsset(true);
  const allowance = await asset.allowance(account.address, positionManager.address);
  const requiredAmount = FormatConverter.decimalToBigInt(Decimal(amount), freshToken.asset.decimals);
  if (allowance < requiredAmount) {
    await safeWaitForTx(
      asset.approve(positionManager.address, approvalSetting === 'unlimited' ? null : amount),
      asset,
    );
  }

  // 4. Plugin approval
  if (!(await freshToken.isPluginApproved(leverageTypes, 'positionManager'))) {
    await safeWaitForTx(freshToken.approvePlugin(leverageTypes, 'positionManager'), freshToken);
  }

  onTransactionStart?.();

  // 5. Execute
  return await safeWaitForTx(
    freshToken.depositAndLeverage(
      Decimal(amount), debtToken as BorrowableCToken,
      Decimal(leverage), leverageTypes, slippage
    ),
    freshToken,
  );
}
```

---

## [STORE_ARCHITECTURE]

### `useDepositStore` (Zustand, persisted: currencyView only)

State:
```ts
{
  market: Market | null,
  depositToken: CToken | BorrowableCToken | null,
  borrowToken: CToken | BorrowableCToken | null,
  amount: string,                     // display amount
  usdAmount: string,                  // always in USD
  tokenAmount: string,                // always in tokens
  zapToken: ZapToken | null,
  zapperType: ZapperTypes,
  isCollateralized: boolean,          // default: true
  leverage: number,                   // 0 = no leverage, >1 = leverage multiplier
  editLeverage: boolean,              // true when editing existing position leverage
  slippage: Decimal,                  // stored as decimal (0.005 = 0.5%)
  currencyView: 'dollar' | 'token',
  depositStatus: DepositStatus,       // enum: Initial → AdvancedDetails → TransactionSummary → Processing → Completed/Failure, AssetSelection
}
```

Key behavior: `onSelectMarket(market)` resets everything (token defaults to `market.tokens[0]`, borrowToken to `market.tokens[1]`, leverage to 0). `onSlippageChange(slippage)` divides by 100 (input is percentage, stored as decimal).

### `useBorrowStore` (Zustand, persisted: currencyView only)

State: `{ market, token: BorrowableCToken, amount, usdAmount, tokenAmount, borrowStatus, isIneligible, currencyView, leverage }`

### `useSelectedManageCollateral` (Zustand, persisted: currencyView only)

State: `{ market, token, amount, usdAmount, tokenAmount, action: 'add'|'remove', currencyView, isCollateralized }`

---

## [VALIDATION_HOOKS]

### Borrow validation
| Hook | Returns | Logic |
|---|---|---|
| `useMaxBorrowAmount()` | `string` | `min(userRemainingCredit, remainingDebt, liquidity)` converted to tokens |
| `useBorrowError()` | `{type}` | Types: no_token, no_amount, zero_amount, debt_cap_zero, ineligible, exceeds_max, none |
| `useDisableBorrow()` | `boolean` | No amount OR amount=0 OR exceeds max OR no market |
| `useDebtBalanceQuery(token)` | `Decimal` | `token.fetchDebtBalanceAtTimestamp()` — staleTime: 2min |

### Repay validation
| Hook | Returns | Logic |
|---|---|---|
| `useMaxRepayAmount()` | `Decimal` | `min(userBalance, userDebt)` |
| `useRepayError()` | `{type}` | Types: exceeds_balance, no_token, no_amount, zero_amount, exceeds_debt, min_loan, none |

`min_loan` check: validates remainder after repay > $10 or = 0 (can't leave dust debt).

### Deposit validation
| Hook | Returns | Logic |
|---|---|---|
| `useDepositError(tokenDebtSize?)` | `{type}` | Types: no_token, no_amount, zero_amount, no_balance, min_loan, none |
| `useWithdrawError()` | `{type}` | Types: no_amount, no_token, zero_amount, no_balance, excess_liquidity, none |
| `useDisableDeposit()` | `boolean` | No token OR no amount OR amount=0 OR no balance |

### Collateral validation
| Hook | Returns | Logic |
|---|---|---|
| `useManageCollateralError()` | `{type}` | Types: exceeds_max, exceeds_max_redemption, none |
| `useDisableManageCollateral()` | `boolean` | Error exists OR no amount OR (add + no uncollateralized balance) |

---

## [LEVERAGE_UTILITIES]

From `modules/market/v2/utils/leverage.ts`:

| Function | Params | Return | Notes |
|---|---|---|---|
| `calculateBorrowAmount(depositUsd, leverage)` | `Decimal, number` | `Decimal` | `depositUsd × (leverage - 1)` |
| `calculatePositionSize(tokenAmount, leverage)` | `Decimal, number` | `Decimal` | `tokenAmount × leverage` |
| `checkLeverageAmountBelowMinimum(input)` | `CheckLeverageAmountBelowMinimumInput` | `boolean` | Terminal debt must be 0 (fully closed) or ≥ MIN_BORROW_USD. Checks both edit-leverage and new-leverage paths |
| `checkBorrowExceedsLiquidity(borrowAmount, liquidity)` | `Decimal?, Decimal?` | `boolean` | Returns false if either input is undefined |

**Constants:**
```ts
MIN_BORROW_USD = 10.1
```

---

## [POSITION_PREVIEW_HOOKS]

### `useDepositPositionSize(debouncedAmount?, debouncedLeverage?)`

Defined in `market/v2/stores/market.ts`. Returns `{ current: {usd, token}, new?: {usd, token} }`.

Three modes:
1. **editLeverage + increasing**: Uses `token.previewLeverageUp(newLev, debtToken)` → `{ newCollateral }` (USD), `{ newCollateralInAssets }` (token terms)
2. **editLeverage + decreasing**: Proportional: `current × newLev / currentLev`
3. **New deposit**: `calculatePositionSize(tokenAmount, leverage)` → add to current

### `useDepositDebt(debouncedAmount?, debouncedLeverage?)`

Defined in `market/v2/stores/market.ts`. Returns `{ current: {usd, token}, new?: {usd, token} }`.

Three modes:
1. **editLeverage + increasing**: `previewLeverageUp(leverage, debtToken)` → `newDebt` used directly as `new.usd` (it's already a total, NOT added to current)
2. **editLeverage + decreasing**: `current × (newLev-1) / (currentLev-1)`
3. **New leverage deposit**: `calculateBorrowAmount(depositUsd, leverage)` → `current + borrowUsd`

### `useBorrowYourDebt(params?)`

Returns current/new debt for borrow or repay actions. Uses `calculateDebtPreview()` (simple add/subtract).

---

## [BORROW_UTILITIES]

From `modules/market/v2/utils/borrow.ts`:

| Function | Params | Return |
|---|---|---|
| `calculateMaxBorrow(credit, debt, liquidity)` | `Decimal ×3` | `Decimal` — `min(credit, debt, liquidity)` |
| `calculateMaxRepay(balance, debt)` | `Decimal ×2` | `Decimal` — `min(balance, debt)` |
| `validateRepayRemainder(debtUsd, repayUsd, minLoan?)` | — | `{isValid, error?}` — remainder must be 0 or ≥ $10 |
| `calculateDebtPreview(currentDebt, amount, isRepaying)` | — | `Decimal` — add or subtract |
| `convertAmountByCurrencyView(amount, price, view)` | — | `{usdAmount, tokenAmount}` |

---

## [COLLATERAL_UTILITIES]

From `modules/market/v2/utils/collateral.ts`:

| Function | Params | Return |
|---|---|---|
| `calculateExchangeRate(assetBalance, shareBalance)` | `Decimal ×2` | `Decimal` — `assets / shares` |
| `calculateCollateralBreakdown(assetBal, collShares, exRate)` | — | `{exchangeRate, collateralAssets, uncollateralizedAssets}` |
| `calculateNewCollateral(current, amount, action)` | — | `Decimal` — add or subtract (clamped to 0) |

---

## [ZAP_FLOW]

```
User wants to deposit TokenX into a CToken whose underlying is TokenY

1. token.getDepositTokens(search)     → list of ZapToken[] with quote functions
2. User picks a ZapToken
3. zapToken.quote(tokenIn, tokenOut, amount, slippage) → { minOut, output }
4. token.deposit(amount, { type, inputToken, slippage })
   └── ensureUnderlyingAmount()        → cap to balance
   └── zap(assets, instructions, ...)  → routes to correct zapper
       ├── 'simple':  zapper.getSimpleZapCalldata()  → dexAgg.quote → Swap struct
       ├── 'vault':   zapper.getVaultZapCalldata()   → vault preview
       ├── 'native-vault': zapper.getNativeZapCalldata() → { value: assets }
       └── 'native-simple': same but wrapped=true
   └── _checkDepositApprovals()
   └── oracleRoute(calldata, overrides)
```

---

## [LEVERAGE_FLOW]

All three leverage entry points call `_getLeverageSnapshot(borrowToken)` as the first async step. This single ProtocolReader RPC call refreshes oracle prices + projected debt into the cache so preview computations use fresh state. Tunable buffers are centralized in the `LEVERAGE` constants block at the top of CToken.ts.

### Leverage Up
```
token.leverageUp(borrowToken, newLeverage, positionManagerType, slippage?, simulate?)
  ├── _getLeverageSnapshot(borrowToken)  → refreshes cache (prices + debt with 2min interest)
  ├── previewLeverageUp(newLev, borrowToken)
  │     └── calculates: borrowAmount, newCollateral (subtracts feeUsd), fee preview fields
  ├── getPositionManager(type)
  ├── switch(type):
  │     ├── 'simple':
  │     │     ├── feePolicy.getFeeBps() → feeBps, feeReceiver
  │     │     ├── dexAgg.quoteAction(borrowAssets, slippage, feeBps, feeReceiver)
  │     │     ├── contractSlippage = slippage + (L−1) × feeBps  ← fee amplification
  │     │     └── manager.getLeverageCalldata(action, bpsToBpsWad(contractSlippage))
  │     └── 'vault'/'native-vault': PositionManager.getVaultExpectedShares() → getLeverageCalldata()
  ├── _checkPositionManagerApproval()
  └── oracleRoute(calldata, { to: manager.address })
```

### Leverage Down
```
token.leverageDown(borrowToken, currentLev, newLev, type, slippage?, simulate?)
  ├── _getLeverageSnapshot(borrowToken)  → refreshes cache (prices + debt with 2min interest)
  ├── previewLeverageDown(newLev, currentLev)
  │     └── calculates collateralAssetReduction + fee preview fields
  ├── feePolicy.getFeeBps() → feeBps, feeReceiver
  ├── if newLev == 1 (full deleverage):
  │     └── swapCollateral = snapshot debt × (1 + DELEVERAGE_OVERHEAD_BPS + feeBps), capped at maxCollateral
  │   else if feeBps > 0 (partial deleverage):
  │     └── swapCollateral = collateralAssetReduction × 10000 / (10000 − feeBps)  ← fee compensation
  ├── switch(type):
  │     └── 'simple': dexAgg.quoteAction(swapCollateral, slippage, feeBps, feeReceiver)
  │           contractSlippage: full = slippage + (L−1) × (overhead + feeBps); partial = slippage
  │     └── default: throws (only 'simple' supported for deleverage)
  ├── _checkPositionManagerApproval()
  └── oracleRoute(calldata, { to: manager.address })
```
Full deleverage (newLev == 1): `minRepay = 1n` (contract handles exact repayment via `min(assetsHeld, totalDebt)`, returns excess to user). Partial deleverage: `minRepay = quote.min_out` (DEX's slippage-adjusted guarantee). **Contract slippage:** partial deleverage uses user's slippage as-is. Full deleverage uses `slippage + (L−1) × (DELEVERAGE_OVERHEAD_BPS + feeBps)` because the intentional swap oversize becomes `(L−1)×overhead` in equity-fraction terms after `checkSlippage` amplification — see #SLIPPAGE_HANDLING for derivation.

### Deposit and Leverage
```
token.depositAndLeverage(depositAmount, borrowToken, multiplier, type, slippage)
  ├── ensureUnderlyingAmount()
  ├── _getLeverageSnapshot(borrowToken)  → refreshes cache
  ├── previewLeverageUp(multiplier, borrowToken, depositAssets)
  ├── switch(type): same as leverageUp (fee resolution + contractSlippage)
  ├── _checkErc20Approval(asset, depositAmount, manager.address)
  ├── _checkPositionManagerApproval()
  └── oracleRoute(calldata, { to: manager.address })
```

---

## [WRITE_PATTERN]

Every state-changing operation follows this path:

```
1. Encode calldata:   this.getCallData("methodName", [args])
2. Check oracle:      this.getPriceUpdates()
                      └── if REDSTONE_CORE adaptor: Redstone.buildMultiCallAction(this)
3. If price updates:  wrap in multicall
                      const token_action = this.buildMultiCallAction(calldata);
                      calldata = this.getCallData("multicall", [[...price_updates, token_action]]);
4. Execute:           this.executeCallData(calldata, overrides)
                      └── signer.sendTransaction({ to: this.address, data, ...overrides })
5. Reload:            this.market.reloadUserData(signer.address)
```

**Override patterns:**
- Zap operations: `{ to: zapper.address }` — redirects tx to zapper
- Native zap: `{ value: assets, to: zapper.address }` — sends native token
- Leverage: `{ to: manager.address }` — redirects tx to position manager

---

## [REWARDS_INCENTIVES]

### MilestoneResponse
```ts
{ market: address; tvl: number; multiplier: number; fail_multiplier: number;
  chain_network: string; start_date: string; end_date: string; duration_in_days: number; }
```

### IncentiveResponse
```ts
{ market: address; type: string; rate: number; description: string; image: string; }
```

Fetched from `{api_url}/v1/rewards/active/{chain}` during `setupChain()`. Attached to Market instances.

### Native Yields

Fetched from `{api_url}/v1/{chain}/native_apy`. Matched by symbol. Stored in `token.nativeApy` (0-1 scale). Currently only available for `monad`/`monad-mainnet`.

## [MARKET_COMPUTED_PROPERTIES]

All synchronous getters read from `Market.cache` (bulk-loaded by `setupChain()` → `Market.getAll()`, refreshed selectively on mutations). All USD values are `Decimal`.

### Aggregate Properties

| Property | Type | Source | Notes |
|---|---|---|---|
| `market.name` | `string` | `cache.deploy.name` | Sanitized by v1 app (& → \|) |
| `market.address` | `address` | `cache.deploy.address` | Market manager contract |
| `market.tokens` | `(CToken \| BorrowableCToken)[]` | Constructed per-market | Heterogeneous array |
| `market.plugins` | `Plugins` | `cache.deploy.plugins` | Plugin addresses |
| `market.tvl` | `USD (Decimal)` | Sum of `token.getTvl(true)` across all tokens | |
| `market.totalDebt` | `USD (Decimal)` | Sum of `token.getDebt(true)` for borrowable tokens only | |
| `market.totalCollateral` | `USD (Decimal)` | Sum of `token.getTotalCollateral(true)` | |
| `market.ltv` | `string` | Min-max range across tokens | Returns `"75%"` or `"65% - 80%"` |
| `market.highestApy()` | `Percentage (Decimal)` | Max of `token.getApy()` | 0-1 scale |

### User Properties

| Property | Type | Source | Notes |
|---|---|---|---|
| `market.userCollateral` | `USD (Decimal)` | `toDecimal(cache.user.collateral, 18n)` | Total collateral value in market |
| `market.userDebt` | `USD (Decimal)` | `toDecimal(cache.user.debt, 18n)` | Total debt value in market |
| `market.userMaxDebt` | `USD (Decimal)` | `toDecimal(cache.user.maxDebt, 18n)` | Max debt allowed by collateral |
| `market.userRemainingCredit` | `USD (Decimal)` | `(maxDebt - debt) × 0.999` | 0.1% buffer prevents edge-case liquidation |
| `market.userDeposits` | `USD (Decimal)` | Sum of `token.getUserAssetBalance(true)` | Derived on access, not a direct `.cache` field |
| `market.userNet` | `USD (Decimal)` | `userDeposits - userDebt` | Net position value |
| `market.positionHealth` | `Percentage \| null` | `(raw / WAD) - 1` or null if infinity | Formatted: 0 = at liquidation, null = no debt |

### User Change Rate Methods

Used for dashboard earnings display. `ChangeRate` = `'year' | 'month' | 'week' | 'day'`.

```ts
market.getUserDepositsChange(rate: ChangeRate): USD    // sum of token.earnChange(balance, rate)
market.getUserDebtChange(rate: ChangeRate): USD        // sum of borrowToken.borrowChange(debt, rate)
market.getUserNetChange(rate: ChangeRate): USD         // depositsChange - debtChange
```

### Borrow Eligibility

```ts
market.getBorrowableCTokens(): { eligible: BorrowableCToken[], ineligible: BorrowableCToken[] }
```

Logic: A borrowable token with debtCap > 0 is **ineligible** if the user has collateral posted to it (can't borrow from a token you're also using as collateral) or if the user has no market collateral at all. Otherwise **eligible**.

### Position Health Formatting

```ts
market.formatPositionHealth(rawBigint: bigint): Percentage | null
// Returns Decimal((rawBigint / 1e18) - 1)
// 0 = at liquidation threshold, null = infinity
```

---

## [CTOKEN_SYNC_GETTERS]

All read from `this.cache` (bulk-loaded data). Use for display. No RPC calls.

### Balance Getters (overloaded: inUSD:true → USD, inUSD:false → Decimal/bigint)

| Method | `(true)` Returns | `(false)` Returns | Source field |
|---|---|---|---|
| `getUserAssetBalance(inUSD)` | `USD` | `TokenInput (Decimal)` | `cache.userAssetBalance` |
| `getUserShareBalance(inUSD)` | `USD` | `TokenInput (Decimal)` | `cache.userShareBalance` |
| `getUserCollateral(inUSD)` | `USD` | `TokenInput (Decimal)` | `cache.userCollateral` |
| `getUserDebt(inUSD)` | `USD` | `TokenInput (Decimal)` | `cache.userDebt` |
| `getCollateralCap(inUSD)` | `USD` | `bigint` | `cache.collateralCap` |
| `getDebtCap(inUSD)` | `USD` | `bigint` | `cache.debtCap` |
| `getTotalCollateral(inUSD)` | `USD` | `bigint` | `cache.collateral` |
| `getDebt(inUSD)` | `USD` | `bigint` | `cache.debt` |
| `getTvl(inUSD)` | `USD` | `bigint` | `cache.totalSupply` (shares, converted via share price for USD) |
| `getRemainingDebt(formatted)` | `USD` | `bigint` | `debtCap - debt` |

**Conversion details:**
- `(true)` path: calls `this.convertTokensToUsd(rawBigint)` — uses `cache.assetPrice / 1e18 * rawBigint / 10^decimals`
- `(false)` path: calls `FormatConverter.bigIntToDecimal(rawBigint, decimals)`
- `getUserCollateral(false)` and `getUserShareBalance(false)` use `this.decimals` (cToken decimals), NOT `asset.decimals`

### Price Getters

```ts
getPrice(): USD                                    // share price, upper, formatted
getPrice(asset: boolean): USD                      // asset=true for underlying price
getPrice(asset: boolean, lower: boolean): USD      // lower=true for lower bound
getPrice(asset: boolean, lower: boolean, formatted: false): USD_WAD  // raw bigint
```

**v2 usage patterns:**
- `token.getPrice(true)` — most common: underlying asset price in USD (Decimal)
- `depositToken.getPrice(true, true, false)` — lower bound price for balance display (used in `useBalancePriceTokenQuery`)
- Default `getPrice()` — cToken share price (NOT the underlying asset price)

### Risk Parameters

```ts
getCollRatio(inBPS: true): Percentage    // Decimal(cache.collRatio) / 10000
getCollRatio(inBPS: false): bigint       // raw BPS
maxLeverage: Percentage                  // getter: Decimal(cache.maxLeverage) / 10000
canLeverage: boolean                     // getter: leverageTypes.length > 0
canZap: boolean                          // getter: zapTypes.length > 0
```

### Leverage State

```ts
getLeverage(): Decimal | null
// Returns null if no collateral
// Formula: userCollateral(true) / (userCollateral(true) - market.userDebt)
// Returns current effective leverage multiplier (1 = unleveraged)
```

### APY

```ts
getApy(): Percentage                     // supply rate as APY (Decimal, 0-1 scale)
getApy(asPercentage: false): bigint      // raw rate

getTotalSupplyRate(): Percentage         // getSupplyRate(true) + incentiveSupplyApy + nativeApy
getTotalBorrowRate(): Percentage         // getBorrowRate(true) - incentiveBorrowApy
```

Internal `getApy`: `rate / WAD * SECONDS_PER_YEAR`. `getTotalSupplyRate` uses on-chain incentive fields; app uses `getDepositApy()` from SDK helpers (Merkl API data) instead — see Yield Calculation Helpers section.

### Token Conversion (synchronous)

```ts
convertTokensToUsd(tokenAmount: bigint, asset = true): USD
// asset=true: uses asset price + asset decimals
// asset=false: uses share price + cToken decimals

convertUsdToTokens(usdAmount: USD, asset = true, lower = false): Decimal
// Inverse of above. lower=true uses lower-bound price

convertTokenToToken(from: CToken, to: CToken, amount: TokenInput, formatted: true): TokenInput
convertTokenToToken(from: CToken, to: CToken, amount: TokenInput, formatted: false): bigint
// Cross-token conversion via USD intermediate
```

### Other Getters

```ts
liquidationPrice: USD | null             // cache.liquidationPrice, null if UINT256_MAX (no liquidation price)
nativeApy: Decimal                       // 0-1 scale, set during setupChain from native yields API
incentiveSupplyApy: Decimal              // Merkl LEND APR (0-1 scale), set during setupChain
incentiveBorrowApy: Decimal              // Merkl BORROW APR (0-1 scale), set during setupChain
isBorrowable: boolean                    // from .cache (bulk-loaded)
isVault: boolean                         // true if asset is in chain_config.vaults
isNativeVault: boolean                   // true if asset is in chain_config.native_vaults
isWrappedNative: boolean                 // true if asset == chain_config.wrapped_native
borrowPaused: boolean                    // from .cache
collateralizationPaused: boolean         // from .cache
mintPaused: boolean                      // from .cache
exchangeRate: bigint                     // cToken → asset exchange rate
totalAssets: bigint                      // total underlying assets
totalSupply: bigint                      // total cToken shares
decimals: bigint                         // cToken decimals
symbol: string
name: string
asset: { address, name, symbol, decimals }  // underlying token info

// Rate methods defined on CToken (not just BorrowableCToken):
getBorrowRate(inPercentage?): Percentage | bigint    // cache.borrowRate / WAD * SECONDS_PER_YEAR
getSupplyRate(asPercentage?): Percentage | bigint    // cache.supplyRate / WAD * SECONDS_PER_YEAR
earnChange(amount: USD, rateType: ChangeRate): USD   // projected earnings for period
```

### CToken Async Fetch Methods (not in cache — make RPC calls)

```ts
redeemShares(amount: bigint)              // Redeems by raw share count (no Decimal conversion). Bypasses maxRedemption clamping — caller must ensure amount is valid
getExchangeRate(): Promise<bigint>        // Reads on-chain exchangeRate(), updates cache.exchangeRate, returns raw bigint
fetchTvl(inUSD?): Promise<USD | bigint>   // Refreshes totalSupply cache, then returns via getTvl(). Overloaded: true → USD, false → bigint
fetchTotalCollateral(inUSD?): Promise<USD | bigint>  // Reads marketCollateralPosted() on-chain. Overloaded: true → USD, false → bigint
convertSharesToUsd(tokenAmount: bigint): Promise<USD>  // Converts shares → virtual assets via virtualConvertToShares, then multiplies by lower-bound price
```

---

## [BORROWABLE_EXTENDED_API]

Extends CToken. Inherits all getters above. Adds:

### Synchronous Rate Getters

| Method | `(true)` | `(false)` | Formula |
|---|---|---|---|
| `getBorrowRate(inPercentage)` | `Percentage` | `bigint` | `rate / WAD × SECONDS_PER_YEAR` |
| `getPredictedBorrowRate(inPercentage)` | `Percentage` | `bigint` | Same formula, predicted rate |
| `getUtilizationRate(inPercentage)` | `Percentage` | `bigint` | `rate / WAD` (no annualization) |
| `getSupplyRate(inPercentage)` | `Percentage` | `bigint` | `rate / WAD × SECONDS_PER_YEAR` |

### Liquidity

```ts
getLiquidity(inUSD: true): USD           // convertTokensToUsd(cache.liquidity)
getLiquidity(inUSD: false): USD_WAD      // raw bigint (NOT Decimal — returns bigint)
```

**Gotcha:** `getLiquidity(false)` returns `bigint`, not `Decimal`. To display: `toDecimal(token.getLiquidity(false), token.asset.decimals)` or `FormatConverter.bigIntToDecimal(...)`.

### Borrow Change Rate

```ts
borrowChange(amount: USD, rateType: ChangeRate): USD
// Returns: amount × (borrowRate × rateSeconds / WAD)
// Used by market.getUserDebtChange() for dashboard earnings
```

### Overrides with Safety Checks

```ts
depositAsCollateral(amount, zap?, receiver?)
// THROWS if cache.userDebt > 0 — "Cannot deposit as collateral when there is outstanding debt"
// Then delegates to super.depositAsCollateral()

postCollateral(amount)
// THROWS if cache.userDebt > 0 — "Cannot post collateral when there is outstanding debt"
// Then delegates to super.postCollateral()
```

### Async Borrow Methods

```ts
borrow(amount: TokenInput, receiver?: address)
// Converts to bigint, encodes calldata, routes through oracleRoute

repay(amount: TokenInput)
// Converts to bigint, encodes calldata, routes through oracleRoute
// amount=0 signals FULL REPAY (protocol convention)

fetchDebtBalanceAtTimestamp(timestamp?: bigint, asUSD?: boolean)
// Calls reader.debtBalanceAtTimestamp() — time-accurate debt including interest
// Default: timestamp=0 (current), asUSD=true
// Used for full-repay detection (≥99.9% threshold)

getMaxBorrowable(inUSD?: boolean)
// Returns market.userRemainingCredit converted to tokens (or USD if inUSD=true)

hypotheticalBorrowOf(amount: TokenInput)
// Position preview: what would position look like after this borrow

fetchDebt(inUSD?: boolean)
// Calls contract.marketOutstandingDebt() — total market debt (not user-specific)
```

### IRM Access

```ts
dynamicIRM(): Promise<IDynamicIRM>
// Returns contract interface for the Interest Rate Model

fetchBorrowRate(): Promise<bigint>       // updates cache.borrowRate
fetchPredictedBorrowRate(): Promise<bigint>
fetchUtilizationRate(): Promise<bigint>
fetchSupplyRate(): Promise<bigint>
fetchLiquidity(): Promise<bigint>        // totalAssets - outstandingDebt

fetchUtilizationRateChange(assets: TokenInput, direction: 'add'|'remove'): Promise<Percentage>
// Preview: what would utilization be if assets were added/removed
```

---

## [DEPOSIT_MUTATION]

Source: `modules/dashboard/v2/queries/index.ts`. The primary deposit flow.

```ts
export function useDepositV2Mutation(token: CToken | BorrowableCToken | null | undefined)
```

### Flow

```ts
mutationFn: async ({ amount, isCollateralized, slippage, zap, onTransactionStart }) => {
  const freshToken = resolveFreshToken(token);
  const asset = freshToken.getAsset(true);
  const isNativeZap = zap === 'native-simple' || zap === 'native-vault';
  const isZapping = zap !== 'none' && zapToken;

  // 1. Plugin approval (zap only)
  if (zap !== 'none') {
    if (!(await freshToken.isPluginApproved(zap, 'zapper'))) {
      await safeWaitForTx(freshToken.approvePlugin(zap, 'zapper'), freshToken);
    }
  }

  // 2. Build zapper instructions — inputToken differs for zap vs direct
  const zapperInstructions = {
    type: zap,
    inputToken: isZapping ? zapToken.interface.address : asset.address,
    slippage,
  };

  // 3. Approval — three branches
  if (isNativeZap) {
    // Native: MON attached as msg.value, no ERC20 approval
  } else if (isZapping) {
    // Zap: approve zap input token to zapper plugin
    const zapDecimals = zapToken.interface.decimals ?? freshToken.asset.decimals;
    if (!(await freshToken.isZapAssetApproved(zapperInstructions,
        FormatConverter.decimalToBigInt(Decimal(amount), zapDecimals)))) {
      await safeWaitForTx(
        freshToken.approveZapAsset(zapperInstructions,
          approvalSetting === 'unlimited' ? null : Decimal(amount)),
        freshToken,
      );
    }
  } else {
    // Direct: approve underlying to cToken
    const allowance = await asset.allowance(account.address, freshToken.address);
    if (toDecimal(allowance, freshToken.asset.decimals).lt(amount)) {
      await safeWaitForTx(
        asset.approve(freshToken.address, approvalSetting === 'unlimited' ? null : Decimal(amount)),
        asset,
      );
    }
  }

  onTransactionStart?.();

  // 4. Execute
  const txRes = isCollateralized
    ? await freshToken.depositAsCollateral(Decimal(amount), zapperInstructions, account.address)
    : await freshToken.deposit(Decimal(amount), zapperInstructions, account.address);
  return await safeWaitForTx(Promise.resolve(txRes), freshToken);
}
```

**Task integration:** On success, starts both deposit + collateralize tasks (filtered by `TaskSlug`, `chainId`, `tokenTaskGroupMap`).

**Key difference from leverage deposit:** No position manager. Approval target is `token.address` (the cToken), not the position manager.

---

## [STANDALONE_LEVERAGE_MUTATIONS]

Source: `modules/dashboard/v2/queries/index.ts`. Used when editing leverage on an existing position (no new deposit).

### `useLeverageUpMutation({ depositToken, borrowToken })`

```ts
mutationFn: async ({ newLeverage, onTransactionStart, slippage }) => {
  const freshDepositToken = resolveFreshToken(depositToken);
  const freshBorrowToken = resolveFreshToken(borrowToken);

  let debtToken = freshDepositToken.market.tokens.find(t => t.getUserDebt(true).gt(0));
  if (!debtToken) debtToken = freshBorrowToken;

  const leverageTypes = freshDepositToken.leverageTypes?.length
    ? getHighestPriority(freshDepositToken.leverageTypes) : 'simple';
  if (!(await freshDepositToken.isPluginApproved(leverageTypes, 'positionManager'))) {
    await safeWaitForTx(freshDepositToken.approvePlugin(leverageTypes, 'positionManager'), freshDepositToken);
  }

  onTransactionStart?.();
  return await safeWaitForTx(
    freshDepositToken.leverageUp(debtToken, newLeverage, leverageTypes, slippage), freshDepositToken
  );
}
```

### `useLeverageDownMutation(token)`

```ts
mutationFn: async ({ newLeverage, currentLeverage, slippage, onTransactionStart }) => {
  const freshToken = resolveFreshToken(token);

  let debtToken = freshToken.market.tokens.find(t => t.getUserDebt(true).gt(0));
  if (!debtToken) debtToken = resolveFreshToken(borrowToken);

  // Use token's leverage type, but vault/native-vault fall back to 'simple'
  // (only simple position manager implements deleverage swap routing)
  const leverageTypes = freshToken.leverageTypes?.length
    ? getHighestPriority(freshToken.leverageTypes) : 'simple';
  const deleverageType =
    leverageTypes === 'vault' || leverageTypes === 'native-vault' ? 'simple' : leverageTypes;

  if (!(await freshToken.isPluginApproved(deleverageType, 'positionManager'))) {
    await safeWaitForTx(freshToken.approvePlugin(deleverageType, 'positionManager'), freshToken);
  }

  onTransactionStart?.();
  return await safeWaitForTx(
    freshToken.leverageDown(debtToken, currentLeverage, newLeverage, deleverageType, slippage), freshToken
  );
}
```

**Pattern:** Leverage-down resolves leverage type via `getHighestPriority` then falls back to `'simple'` if vault/native-vault. Leverage-up uses `getHighestPriority` directly.

**Why leverage-down falls back to 'simple':** Only the simple position manager implements deleverage swap routing (collateral asset → borrow asset via dex aggregator for repayment). Vault and native-vault position managers don't expose `deleverage` calldata for the reverse path. The SDK's `leverageDown` switch statement only handles `case 'simple'` and throws on all other types. The app resolves leverage type first (to match the position's original type for plugin approval) then substitutes `'simple'` for the actual deleverage call if needed.

### Full deleverage special path (newLeverage = 1)

When fully closing a leveraged position, `leverageDown` uses a different path:

```ts
// Inside CToken.leverageDown():
const isFullDeleverage = newLeverage.equals(1);
const repay_balance = isFullDeleverage
  ? await borrowToken.fetchDebtBalanceAtTimestamp(100n, false)  // projected debt 100s in future (bigint)
  : null;

// 1. Initial quote to check if swap output covers debt
const initialQuote = await dexAgg.quote(manager, collateralAsset, borrowAsset, collateralAssetReduction, slippage);

// 2. If quote output < debt, scale up collateral proportionally
let swapCollateral = collateralAssetReduction;
if (isFullDeleverage && initialQuote.out < repay_balance) {
  swapCollateral = collateralAssetReduction * repay_balance * 1005n / (initialQuote.out * 1000n);
}

// 3. Final quote with adjusted collateral
const { action, quote } = await dexAgg.quoteAction(manager, collateralAsset, borrowAsset, swapCollateral, slippage);

// 4. Min repay and contract slippage
const minRepay = isFullDeleverage ? 1n : quote.out - BigInt(Decimal(quote.out).mul(.05).toFixed(0));
const contractSlippage = isFullDeleverage ? slippage + 50n : slippage;  // +50 BPS for oracle variance
```

Full deleverage sets `minRepay = 1n` (contract handles exact repayment). The collateral scaling ensures enough is swapped to cover accrued interest. Contract slippage gets +50 BPS buffer for oracle price variance in the multicall.

### LeverageAction vs DeleverageAction API shapes

```ts
// LEVERAGE (singular swapAction):
interface LeverageAction {
  borrowableCToken: address;
  borrowAssets: bigint;
  cToken: address;
  expectedShares: bigint;
  swapAction?: Swap;       // ← SINGULAR
  auxData?: bytes;
}

// DELEVERAGE (plural swapActions array):
interface DeleverageAction {
  cToken: address;
  collateralAssets: bigint;
  borrowableCToken: address;
  repayAssets: bigint;
  swapActions?: Swap[];    // ← ARRAY
  auxData?: bytes;
}
```

Gotcha: using `swapAction` (singular) in deleverage calldata or `swapActions` (array) in leverage calldata will cause encoding errors.

### Contract-side execution flow (from BasePositionManager.sol)

**depositAndLeverage(assets, action, slippage)** — execution order:
1. `preDeposit` modifier: `safeTransferFrom(collateralAsset, user, manager, assets)` → `cToken.depositAsCollateral(assets, user)` → initial deposit
2. `_leverage(action, user)` → `borrowableCToken.borrowForPositionManager(borrowAssets, user, action)` → triggers `onBorrow` callback
3. `onBorrow`: validates inputs → applies protocol fee (reduces effective borrowAssets) → `_swapDebtAssetToCollateralAsset` → deposits ALL received collateral via `cToken.depositAsCollateral(balance, user)` → checks `shares >= action.expectedShares` → returns remaining debt asset to user
4. `checkSlippage` modifier: compares pre/post position value, reverts if loss exceeds slippage

**leverage(action, slippage)** — same as above but without step 1 (no preDeposit). Only `_leverage` + `checkSlippage`.

**deleverage(action, slippage)** — execution order:
1. `_deleverage(action, user)` → validates `action.repayAssets != 0` → `cToken.withdrawByPositionManager(collateralAssets, user, action)` → triggers `onRedeem` callback
2. `onRedeem`: validates inputs → applies protocol fee → `_swapCollateralAssetToDebtAsset` → checks `assetsHeld >= action.repayAssets` (minimum floor) → gets `totalDebt = borrowableCToken.debtBalanceUpdated(user)` → repays `min(assetsHeld, totalDebt)` → returns remaining debt asset + collateral asset + swap output dust to user
3. `checkSlippage` modifier: same value comparison

**Key contract behaviors not visible from SDK:**
- Protocol fee: `centralRegistry.protocolLeverageFee()` in BPS, deducted from effective amount, sent to DAO
- Auto-max repay: deleverage always repays as much as possible (capped at total debt), `repayAssets` is just a minimum floor
- Remaining tokens: any leftover debt asset, collateral asset, or swap dust is returned to user — no tokens stay in the position manager
- `depositAsCollateral` vs `depositAsCollateralFor`: the position manager calls `depositAsCollateral(assets, msg.sender)` — the cToken recognizes position managers at the market manager level

### leverageDown partial — 5% minRepay is intentional defense-in-depth

```ts
const minRepay = ... quote.out - (BigInt(Decimal(quote.out).mul(.05).toFixed(0)));
//                                                              ^^^^ hardcoded 5%
```

This is NOT a bug. The 5% floor on `repayAssets` is a sanity check against oracle/dex price divergence, separate from user slippage. User slippage is already enforced by: (1) dex quote minimum, (2) `_swapSafe` oracle-price comparison in SwapperLib, (3) `checkSlippage` portfolio modifier. The `minRepay` floor sits below all three as defense-in-depth — it catches edge cases where oracle checks pass but absolute token output is insufficient for repay.

### V2 Dashboard Display Bugs

**BUG: Deposit vs Collateral values differ when fully collateralized**

File: `dashboard/v2/tables/deposit.tsx`. Two different conversion paths:
```
Deposits:  cache.userAssetBalance (on-chain convertToAssets) × assetPrice
Collateral: cache.userCollateral (collateralPosted shares) × sharePrice
```
When all deposits are collateralized these should produce identical USD values (`shares × sharePrice ≡ convertToAssets(shares) × assetPrice`), but on-chain `convertToAssets()` rounding differs from client-side price ratio, producing small visible discrepancies. Mitigated: dust clamping now hides sub-cent differences, but the dual conversion path remains.

### ICToken additional function variants

The contract has delegate variants (`depositAsCollateralFor`, `redeemFor`, `redeemCollateralFor`) that require receiver to have approved caller as delegate. These are not used by the SDK or position manager — the position manager uses `withdrawByPositionManager` for deleverage and `depositAsCollateral` (non-delegate) for leverage deposits.

---

## [DASHBOARD_QUERIES]

Source: `modules/dashboard/v2/queries/index.ts`. All derive from `useSetupChainQuery` via select.

### `useDashboardOverview()`

```ts
// Returns { deposits, depositsChange, debts, debtsChange, portfolio, portfolioChange }
// All Decimal, summed across all markets
// Uses: market.userDeposits, market.userDebt, market.userNet
//       market.getUserDepositsChange('day'), market.getUserDebtChange('day'), market.getUserNetChange('day')
// If not connected: all zeros
```

### `useDepositDashboardQuery()`

```ts
// Returns tokens with positive asset balance
select: (data) => data.markets.flatMap(m => m.tokens).filter(t => t.getUserAssetBalance(true).gt(0))
```

### `useLoanDashboardQuery()`

```ts
// Returns borrowable tokens with positive debt
select: (data) => data.markets.flatMap(m => m.tokens)
  .filter(t => isBorrowableTokenWithDebtCap(t) && Decimal(t.getUserDebt(false)).gt(0))
```

### `useBalanceQuery(token)`

```ts
queryKey: ['balance', account.address, token.asset.symbol, token.market.address]
queryFn: async () => {
  const asset = token.getAsset(true);
  const balance = await asset.balanceOf(account.address);
  return FormatConverter.bigIntToDecimal(balance, token.asset.decimals);
}
```

### `usePositionHealthQuery(token, market)`

```ts
queryKey: ['positionHealth', account.address, token.asset.symbol]
// Calls market.previewPositionHealth(...) or reads market.positionHealth
// Returns { textClassName, bgClassName, positionHealthPercentage, status }
```

### `useRewardsDashboardQuery()`

Fetches from Merkl API, aggregates rewards by token+chain, enriches with campaign metadata.

```ts
queryKey: ['merkl', 'rewards', account.address, chainId]
// 1. fetchMerklUserRewards(wallet, chainId) → rewards per chain
// 2. Aggregate: totalAmount - claimedAmount per token
// 3. fetchMerklCampaignsBySymbol(symbol) → name, icon, price enrichment
// Returns: RewardsTableRow[] { symbol, address, amount, usdValue, price, chainId, ... }
```

---

## [COOLDOWN_SYSTEM]

The protocol enforces a hold period after collateral posting or borrowing.

```ts
market.cooldownLength: bigint            // cache.static.cooldownLength (seconds, currently ~1200 = 20min)
market.cooldown: Date | null             // null = not in cooldown, Date = unlock time
// Getter: if cache.user.cooldown == cooldownLength → null (never activated)
//         else: new Date(cache.user.cooldown * 1000)

market.expiresAt(account, fetch?): Promise<Date | null>
// Async: reads from contract accountAssets(account), adds cooldownLength
// fetch=true: reads MIN_HOLD_PERIOD() from contract (if cooldownLength not yet loaded)

market.multiHoldExpiresAt(markets: Market[]): Promise<{[address]: Date | null}>
// Batch: reads multiple market cooldowns via reader.marketMultiCooldown()
```

**v1 usage:** After deposit/borrow, a cooldown timer prevents immediate withdraw/repay. UI shows countdown with disabled buttons. `market.cooldown` provides the unlock Date.

---

## [POSITION_PREVIEW_METHODS]

All on `Market` class. Return `Percentage | null` (formatted position health after hypothetical action).

```ts
// Generic preview
market.previewPositionHealth(
  account, collateral_ctoken, debt_ctoken, depositAmount, borrowAmount
): Promise<Percentage | null>

// Action-specific previews
market.previewPositionHealthDeposit(ctoken, amount): Promise<Percentage | null>
market.previewPositionHealthRedeem(ctoken, amount): Promise<Percentage | null>
market.previewPositionHealthBorrow(token, amount): Promise<Percentage | null>
market.previewPositionHealthRepay(token, amount): Promise<Percentage | null>

// Leverage previews
market.previewPositionHealthLeverageDeposit(
  depositToken, borrowToken, depositAmount, leverageMultiplier
): Promise<Percentage | null>

market.previewPositionHealthLeverageUp(
  depositToken, borrowToken, newLeverage
): Promise<Percentage | null>

market.previewPositionHealthLeverageDown(
  depositToken, borrowToken, newLeverage, currentLeverage
): Promise<Percentage | null>

// Asset impact preview (comprehensive)
market.previewAssetImpact(
  user, collateral_ctoken, debt_ctoken, deposit_amount, borrow_amount, rate_change
): Promise<{positionHealth, liquidationPrice, ...}>
```

All leverage previews use `CToken.previewLeverageUp()` or `previewLeverageDown()` internally.

### `CToken.previewLeverageUp(newLeverage, borrowToken, depositAmount?)`

```ts
// Returns: { newDebt: USD, newCollateral: USD, borrowAmount: USD,
//            newDebtInAssets, newCollateralInAssets }
// newDebt = total debt at target leverage (notional × newLev - notional)
// borrowAmount = delta (newDebt - currentDebt)
// Used by useDepositPositionSize and useDepositDebt for live preview
```

### `CToken.previewLeverageDown(newLeverage, currentLeverage, borrowToken?)`

```ts
// Returns: { collateralAssetReduction: bigint, collateralAssetReductionUsd: USD,
//            leverageDiff: Decimal, newDebt: USD, newDebtInAssets?: TokenInput,
//            newCollateral: USD, newCollateralInAssets: TokenInput }
// Used by leverageDown for swap sizing and deleverage calldata
```

---

## [TOKEN_TASK_GROUP_MAP]

Maps onboarding task groups to market LST tokens. Used by all mutations to start gamification tasks on tx success.

```ts
const tokenTaskGroupMap: Record<string, string> = {
  'Kintsu Tasks': 'smon',
  'Magma Tasks': 'gmon',
  'Fastlane Tasks': 'shmon',
  'aPriori Tasks': 'aprmon',
};
```

Pattern: `token.market.name.toLowerCase().split(' ')[0]` extracts the LST prefix for matching.

---

## [FORMAT_CONVERTER_COMPLETE]

**File:** `src/classes/FormatConverter.ts`. All methods are static. Global precision: `Decimal.set({ precision: 50 })`. All rounding uses `Decimal.ROUND_DOWN` (truncation, never rounding up).

### Core Conversion Methods

```ts
// bigint → Decimal: divide by 10^decimals, truncate
bigIntToDecimal(value: bigint, decimals: number | bigint): Decimal
// Example: bigIntToDecimal(1500000000n, 8) → Decimal(15.0)  (WBTC with 8 decimals)

// Decimal → bigint: multiply by 10^decimals, floor, no scientific notation
decimalToBigInt(value: TokenInput, decimals: number | bigint): bigint
// Example: decimalToBigInt(Decimal(1.5), 8) → 150000000n
// THROWS if value is not a Decimal instance

// Shorthand: bigint → USD (always 18 decimals)
bigIntToUsd(value: bigint): USD
// Equivalent to: bigIntToDecimal(value, 18)
```

**Critical:** `decimalToBigInt` uses `.floor().toFixed(0)` internally. This means:
- `Decimal(1.999999999)` with 8 decimals → `199999999n` (NOT 200000000n)
- Fractional sub-wei amounts are silently truncated

### USD Conversion Methods

```ts
// bigint tokens → USD: tokens_decimal × price_decimal, rounded to `decimals` places
bigIntTokensToUsd(tokens: bigint, price: bigint, decimals: number | bigint): USD
// price is WAD-scaled (1e18). Internally: bigIntToDecimal(tokens) × bigIntToUsd(price)

// Decimal tokens → USD
decimalTokensToUsd(tokens: Decimal, price: Decimal): USD
// tokens × price, rounded to 18 decimal places

// USD → Decimal tokens
usdToDecimalTokens(value: USD, price: USD | bigint, decimals: number | bigint): Decimal
// value ÷ price, rounded to `decimals` places. If price is bigint, auto-converts via bigIntToUsd

// USD → bigint tokens
usdToBigIntTokens(value: USD, price: USD | bigint, decimals: number | bigint): bigint
// Chains: usdToDecimalTokens → decimalToBigInt
```

### Token-to-Token Conversion

```ts
// Cross-token conversion via USD intermediate
tokensToTokens(
  from: { price: Decimal, decimals: bigint, amount: TokenInput },
  to:   { price: Decimal, decimals: bigint },
  formatted: boolean
): Decimal | bigint
// formatted=true → Decimal (human-readable)
// formatted=false → bigint (on-chain ready)
// Flow: from_amount × from_price → USD → USD ÷ to_price → to_amount
```

### BPS/WAD Utilities

```ts
// BPS → WAD-BPS: (value × 1e18) / 10,000
bpsToBpsWad(value: bigint): bigint
// Example: 100n (1%) → 1e16n (0.01 in WAD)
// Example: 10000n (100%) → 1e18n (1.0 in WAD)

// Percentage → BPS: value × 10,000
percentageToBps(value: Percentage): bigint
// Example: Decimal(0.05) (5%) → 500n

// Percentage → WAD-BPS: chains percentageToBps → bpsToBpsWad
percentageToBpsWad(value: Percentage): bigint
// Example: Decimal(0.05) → 500n → 5e16n

// Percentage → display string
percentageToText(value: Percentage): string
// Example: Decimal(0.005) → "0.50%"
```

---

## [TYPE_SYSTEM_CONSTANTS]

**File:** `src/types.ts` and `src/helpers.ts`

### Semantic Types (all are aliases — no runtime enforcement)

```ts
type TokenInput  = Decimal;   // Human-readable amount: 1.5 WBTC. Must convert via decimalToBigInt before on-chain use
type USD         = Decimal;   // Human-readable USD: value/1e18 of on-chain WAD representation
type USD_WAD     = bigint;    // Raw on-chain USD in WAD format (1e18 = $1)
type Percentage  = Decimal;   // Fractional: 0.7 = 70%. NOT basis points
type TypeBPS     = bigint;    // Basis points: 10000 = 100%
type address     = `0x${string}`;
type bytes       = `0x${string}`;
type curvance_provider = JsonRpcSigner | Wallet | JsonRpcProvider;  // Any ethers v6 provider
type curvance_signer   = JsonRpcSigner | Wallet;  // Provider that can sign transactions
```

### Constants

```ts
BPS              = 10_000n                // 1 BPS = 0.01%
BPS_SQUARED      = 100_000_000n           // 1e8
WAD              = 1_000_000_000_000_000_000n  // 1e18
WAD_BPS          = 10_000_000_000_000_000_000_000n  // 1e22
RAY              = 1_000_000_000_000_000_000_000_000_000n  // 1e27
WAD_SQUARED      = 1e36n
WAD_CUBED_BPS_OFFSET = 1e50n
WAD_DECIMAL      = new Decimal(WAD)

SECONDS_PER_YEAR  = 31_536_000n   // 365 days
SECONDS_PER_MONTH = 2_592_000n    // 30 days
SECONDS_PER_WEEK  = 604_800n
SECONDS_PER_DAY   = 86_400n

DEFAULT_SLIPPAGE_BPS = 100n       // 1%
UINT256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n
UINT256_MAX_DECIMAL = Decimal(UINT256_MAX)
EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
NATIVE_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
EMPTY_BYTES = "0x"
```

### Helper Functions

```ts
getRateSeconds(rate: ChangeRate): bigint  // 'year'|'month'|'week'|'day' → seconds
toDecimal(value: bigint, decimals: bigint): Decimal  // alias for FormatConverter.bigIntToDecimal
toBps(value: Percentage): bigint  // alias for FormatConverter.percentageToBps
fromBpsToWad(value: bigint): bigint  // alias for FormatConverter.bpsToBpsWad
toBigInt(value: number | Decimal, decimals: bigint): bigint  // wraps in Decimal then decimalToBigInt
```

---

## [DECIMAL_SYSTEM]

CToken exposes TWO decimal accessors that are **always equal by contract design**:

```ts
token.decimals       // cToken share decimals (from cache.decimals)
token.asset.decimals // underlying asset decimals (from cache.asset.decimals)
```

**ICToken.sol confirms:** `decimals()` "pull[s] directly from underlying... matching the underlying token." The cToken's `decimals()` function returns the underlying's decimals. These values are identical — the SDK separates them for semantic clarity, not because they differ.

**On-chain proof (ProtocolReader.sol):** The Solidity ProtocolReader relies on this invariant in multiple functions. `_adjustForLimitations` (L1715-1717) scales `debtAssets` (underlying-denominated) using `_decimals(debtCToken)` (cToken decimals) — only correct if they're equal. `hypotheticalLeverageOf` (L801-805) converts WAD to "assets denomination" using `_decimals(borrowableCToken)` — same invariant. Meanwhile, functions that genuinely deal with different denominations use separate decimal lookups: `_debtValue` uses `_decimals(underlyingAsset)` for asset amounts, `_collateralValue` uses `_decimals(cToken)` for share amounts. This confirms the protocol enforces `cToken.decimals == asset.decimals` as a design invariant, not an accidental assumption.

**SDK usage convention** (semantic, not functional — both produce the same result):

| Context | SDK uses | Semantic reason |
|---|---|---|
| User input amounts (deposit, borrow, repay) | `asset.decimals` | Conceptually in underlying tokens |
| `convertTokenInputToShares(amount)` | `asset.decimals` | Converting user amount → bigint before share conversion |
| `getUserShareBalance(false)` | `token.decimals` | Formatting share count |
| `getUserAssetBalance(false)` | `asset.decimals` | Formatting asset amount |
| `getUserCollateral(false)` | `token.decimals` | Collateral posted is in shares |
| `getUserDebt(false)` | `asset.decimals` | Debt is in underlying |
| `convertTokensToUsd(amount)` | `this.decimals` | Always uses cToken decimals (= asset decimals) |

**For v1 code:** Since these are always equal, using either produces correct results. The SDK's convention is organizational. If you're directly calling `FormatConverter.bigIntToDecimal` or `decimalToBigInt`, use `token.asset.decimals` for asset amounts and `token.decimals` for share amounts — it won't matter numerically, but keeps intent clear.

---

## [SHARES_ASSETS_PIPELINE]

Three conversion layers, each building on the previous:

### Layer 1: Virtual (synchronous, from bulk-loaded data)

```ts
virtualConvertToAssets(shares: bigint): bigint {
  return (shares * this.totalAssets) / this.totalSupply;
}

virtualConvertToShares(assets: bigint): bigint {
  return (assets * this.totalSupply) / this.totalAssets;
}
```

Uses bulk-loaded `totalAssets` and `totalSupply` from `.cache`. Fast, no RPC call. Suitable for UI display and pre-flight checks. Data is current as of the last bulk load or mutation-triggered refresh (e.g., `reloadUserData` after deposit).

### Layer 2: On-chain (async, exact)

```ts
async convertToAssets(shares: bigint): Promise<bigint>  // calls contract.convertToAssets
async convertToShares(assets: bigint): Promise<bigint>  // calls contract.convertToShares
```

Reads current exchange rate from contract. Used for expected-shares calculations in zap and leverage flows.

### Layer 3: User Input (Decimal → shares bigint)

```ts
convertTokenInputToShares(amount: TokenInput): bigint {
  return this.virtualConvertToShares(
    FormatConverter.decimalToBigInt(amount, this.asset.decimals)
  );
}
```

Takes a human-readable Decimal, scales to bigint using **asset.decimals** (NOT token.decimals), then converts to shares. Used by: `transfer`, `redeemCollateral`, `postCollateral`, `removeCollateral`, `redeem`, `hypotheticalRedemptionOf`.

### Which methods take assets vs shares

| Method | Input type | What SDK does internally |
|---|---|---|
| `deposit(amount)` | `TokenInput` (assets) | `decimalToBigInt(amount, asset.decimals)` → pass as-is to contract |
| `depositAsCollateral(amount)` | `TokenInput` (assets) | Same as deposit, also checks collateral cap in shares |
| `borrow(amount)` | `TokenInput` (assets) | `decimalToBigInt(amount, asset.decimals)` → pass to contract |
| `repay(amount)` | `TokenInput` (assets) | `decimalToBigInt(amount, asset.decimals)`. Amount=0 signals full repay |
| `redeem(amount)` | `TokenInput` (assets) | `convertTokenInputToShares(amount)` → sends shares to contract |
| `redeemCollateral(amount)` | `Decimal` (assets) | `convertTokenInputToShares(amount)` → shares to contract |
| `postCollateral(amount)` | `TokenInput` (assets) | `convertTokenInputToShares(amount)` → capped to available shares |
| 
emoveCollateralExact(amount) | TokenInput (assets) | convertTokenInputToShares(amount) ? capped to safe removable collateral, then dust-swept only to the safe cap |
| 
emoveMaxCollateral() | none | Reads safe removable collateral shares and sends the full valid amount |
| `transfer(receiver, amount)` | `TokenInput` (assets) | `convertTokenInputToShares(amount)` → transfers shares |

**Key insight:** The user always thinks in assets (underlying token amounts). The cToken contract IS an ERC4626 vault — its interface accepts **assets** for `deposit`/`borrow` but **shares** for `redeem`/`postCollateral`/`removeCollateral`. The SDK bridges this gap: all user-facing methods accept asset-denominated `TokenInput`, and the SDK internally converts to shares via `convertTokenInputToShares` where the contract requires it.

---

## [TRANSACTION_EXECUTION]

Every state-changing CToken operation follows this pipeline:

```
User calls SDK method (e.g., token.deposit(amount))
  │
  ├─ 1. Validate & convert input
  │     decimalToBigInt(amount, asset.decimals) → bigint assets
  │
  ├─ 2. Build calldata
  │     this.getCallData("deposit", [assets, receiver]) → bytes
  │     (Calldata.getCallData uses contract.interface.encodeFunctionData)
  │
  ├─ 3. Handle zap routing (if applicable)
  │     this.zap(assets, zapInstructions, ...) → { calldata, calldata_overrides, zapper }
  │     Overrides include { to: zapper.address } and { value: amount } for native
  │
  ├─ 4. Check approvals (if approval_protection enabled)
  │     _checkAssetApproval, _checkZapperApproval, _checkDepositApprovals
  │     THROWS if insufficient — does NOT auto-approve
  │
  └─ 5. oracleRoute(calldata, overrides)
        │
        ├─ 5a. getPriceUpdates()
        │      If token uses REDSTONE_CORE adaptor:
        │        → fetch signed price payload (3/4 signers)
        │        → encode as multicall action targeting RedstoneCoreAdaptor
        │
        ├─ 5b. Wrap in multicall (if price updates exist)
        │      [priceUpdate_action, real_action] → multicall calldata
        │
        ├─ 5c. executeCallData(calldata, overrides)
        │      signer.sendTransaction({ to: this.address, data: calldata, ...overrides })
        │      (Target is cToken address unless overridden by zap/leverage → zapper/manager address)
        │
        └─ 5d. Reload user data
               market.reloadUserData(signer.address)
```

### Calldata Base Class

```ts
// src/classes/Calldata.ts
abstract class Calldata<T> {
  abstract address: address;
  abstract contract: Contract & T;
  abstract provider: curvance_provider;

  getCallData(functionName: string, exec_params: any[]): bytes {
    return this.contract.interface.encodeFunctionData(functionName, exec_params);
  }

  async executeCallData(calldata: bytes, overrides = {}): Promise<TransactionResponse> {
    const signer = validateProviderAsSigner(this.provider);
    return signer.sendTransaction({ to: this.address, data: calldata, ...overrides });
  }

  async simulateCallData(calldata: bytes, overrides = {}): Promise<{ success: boolean; error?: string }> {
    // Dry-run via signer.call() — does not send tx. Used by simulate=true on leverage methods.
    const signer = validateProviderAsSigner(this.provider);
    try {
      await signer.call({ to: this.address, data: calldata, from: signer.address, ...overrides });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.reason || error?.message || String(error) };
    }
  }
}
```

CToken, PositionManager, and Zapper all extend `Calldata`. This means all three can encode their own calldata and send transactions.

### Gas Buffer Proxy

Every contract instance is wrapped via `contractWithGasBuffer(contract, bufferPercent=10)`:

```ts
// Proxy intercepts ALL function calls on the contract
// For each call:
//   1. Try estimateGas(...args)
//   2. Calculate: gasLimit = estimatedGas × (100 + 10) / 100
//   3. Push { gasLimit } as final arg override
//   4. Call original method with buffered gas
//   5. If estimateGas fails, call without buffer (silent fallback)
//
// Effect: all tx automatically get 10% gas buffer. No consumer code changes needed.
```

### Transaction target routing

| Operation | `to` address in sendTransaction |
|---|---|
| deposit, depositAsCollateral (no zap) | `token.address` (cToken) |
| deposit with zap | `zapper.address` (override) |
| borrow, repay | `token.address` (BorrowableCToken) |
| redeem, redeemCollateral | `token.address` |
| postCollateral, removeCollateral | `token.address` |
| leverageUp, leverageDown | `manager.address` (PositionManager override) |
| depositAndLeverage | `manager.address` (PositionManager override) |

---

## [APPROVAL_ARCHITECTURE]

Three distinct approval types, each checking different on-chain state:

### Type 1: ERC20 Asset Allowance

Standard ERC20 `approve(spender, amount)`. Checked via `allowance(owner, spender)`.

```ts
// SDK methods:
token.approveUnderlying(amount?, target?)  // approves underlying asset to target (default: cToken address)
token.approve(amount?, spender)            // approves cToken itself to spender
token.getAllowance(check_contract, underlying=true)  // reads current allowance

// ERC20.approve behavior:
//   amount = null → approves UINT256_MAX (unlimited)
//   amount = Decimal → converts via decimalToBigInt then approves exact amount
```

**Approval targets by operation:**

| Operation | Asset approved | Spender |
|---|---|---|
| deposit (no zap) | underlying token | `token.address` (cToken) |
| deposit (with zap, simple) | zap input token | zapper plugin address |
| borrow | none needed | — |
| repay | underlying token | `token.address` (BorrowableCToken) |
| depositAndLeverage | underlying token | `positionManager.address` |

### Type 2: Plugin Delegate Approval

On-chain delegation via `setDelegateApproval(plugin_address, true)`. Checked via `isDelegate(owner, plugin)`.

```ts
token.isPluginApproved(plugin, type)  // checks isDelegate on-chain
token.approvePlugin(plugin, type)     // calls setDelegateApproval(plugin_address, true)
```

Plugin address resolution (`getPluginAddress`):

| type='zapper' | Looks up in `setup_config.contracts.zappers` via `zapperTypeToName` map |
|---|---|
| type='positionManager' | Looks up in `market.plugins` (simplePositionManager / vaultPositionManager / nativeVaultPositionManager) |

### Type 3: Zap Asset Approval

For zap deposits where the input token differs from the underlying. The input token must be approved to the zapper's plugin address.

```ts
token.isZapAssetApproved(instructions, amount)  // checks inputToken allowance to plugin
token.approveZapAsset(instructions, amount)      // approves inputToken to plugin
// instructions must be an object { type, inputToken, slippage }, not 'none'
```

### approval_protection Flag

```ts
setup_config.approval_protection: boolean
```

When `true` (v2 default): `_checkAssetApproval`, `_checkZapperApproval`, `_checkDepositApprovals` run before every tx and THROW on insufficient approval. The v2 UI handles approvals before calling SDK methods, so throws indicate a bug.

When `false`: all approval checks are skipped. The SDK assumes the caller has handled approvals externally. Useful for scripts or testing where approvals are pre-set.

### v2 Approval Flow (UI-side, before SDK call)

```ts
// Pattern from v2 repay mutation:
const asset = token.getAsset(true);  // ERC20 instance of underlying
const allowance = await asset.allowance(account.address, token.address);
const hasAllowance = toDecimal(allowance, token.asset.decimals).gte(requiredAmount);

if (!hasAllowance) {
  onApprovalStart?.();
  const tx = await asset.approve(
    token.address,
    approvalSetting === 'unlimited' ? null : requiredAmount  // null = UINT256_MAX
  );
  await tx.wait();  // MUST wait for approval tx to confirm before proceeding
}
onApprovalComplete?.();
// Now safe to call SDK method
```

### Approval Sequence by Operation

Each operation requires approvals in a specific order. Every approval tx must be confirmed (`await tx.wait()`) before the next step.

**Deposit (no zap):**
1. ERC20 allowance: underlying asset → cToken address

**Deposit (with zap, object instructions):**
1. Plugin delegate: `token.approvePlugin(zapType, 'zapper')` — delegate approval on cToken for the zapper
2. ERC20 allowance: zap input token → zapper plugin address (`approveZapAsset`)
3. ERC20 allowance: underlying asset → cToken address (checked by `_checkAssetApproval`)

**Deposit (collateralized):**
Same as above, but additionally: if `token instanceof BorrowableCToken`, the override checks `cache.userDebt > 0` and **throws before any approval step**. Must verify no outstanding debt first in UI.

**Repay:**
1. ERC20 allowance: underlying asset → BorrowableCToken address

**depositAndLeverage:**
1. ERC20 allowance: underlying asset → **position manager address** (NOT cToken)
2. Plugin delegate: `token.approvePlugin(leverageTypes, 'positionManager')`

**Standalone leverage-up:**
1. Plugin delegate: `token.approvePlugin(leverageTypes, 'positionManager')`
(SDK internally checks via `_checkPositionManagerApproval`, throws if not approved)

**Standalone leverage-down:**
1. Plugin delegate: `token.approvePlugin('simple', 'positionManager')`

**Withdraw (redeem) / Remove collateral:**
No approvals needed — user is withdrawing their own tokens.

### convertToShares: On-chain vs Virtual vs Raw

The SDK uses different conversion approaches depending on context:

| Context | Method used | Why |
|---|---|---|
| Zapper expected shares | `convertToShares` (async, on-chain) | Accuracy critical for slippage protection — bulk-loaded data may be behind if other users acted since load |
| `depositAndLeverage` expected shares (simple) | `getExpectedShares` → `convertToShares` (async, on-chain) | Same reason |
| `leverageUp` expected shares (simple) | `BigInt(quote.min_out)` — raw, NOT converted | Uses dex output directly as share approximation. Works because cToken decimals = underlying decimals and exchange rates near 1:1. Contract's `checkSlippage` provides real protection |
| `leverageUp`/`depositAndLeverage` expected shares (vault) | `getVaultExpectedShares` (async, two-hop on-chain) | Full conversion: asset → vault.previewDeposit → ctoken.convertToShares |
| redeem / postCollateral / removeCollateral | `virtualConvertToShares` (sync, from `.cache`) | Speed for UI responsiveness; contract enforces limits regardless |
| maxRedemption output conversion | `virtualConvertToAssets` (sync, from `.cache`) | Converting shares back to display amounts — approximate is fine |
| Collateral cap check in depositAsCollateral | `virtualConvertToShares` (sync, from `.cache`) | Pre-flight check only — contract re-validates |

---

## [MAX_REDEMPTION]

`maxRedemption(...)` has 7 overloads controlling output format, buffer, and breakdown:

```ts
// Basic: returns TokenInput (Decimal in asset terms)
maxRedemption(): Promise<TokenInput>

// Format control:
maxRedemption(in_shares: true): Promise<bigint>     // raw share count
maxRedemption(in_shares: false): Promise<TokenInput> // human-readable assets

// With buffer (extra seconds added to cooldown check):
maxRedemption(in_shares: true, bufferTime: bigint): Promise<bigint>
maxRedemption(in_shares: false, bufferTime: bigint): Promise<TokenInput>

// With breakdown (separate collateralized vs uncollateralized):
maxRedemption(in_shares: true, bufferTime: bigint, breakdown: true):
  Promise<{ max_collateral: bigint, max_uncollateralized: bigint }>
maxRedemption(in_shares: false, bufferTime: bigint, breakdown: true):
  Promise<{ max_collateral: TokenInput, max_uncollateralized: TokenInput }>
```

**Internal flow:**
1. Calls `market.reader.maxRedemptionOf(account, ctoken, bufferTime)` → returns `{ maxCollateralizedShares, maxUncollateralizedShares, errorCodeHit }`
2. If `errorCodeHit` → throws (stale price or oracle issue)
3. Combines: `all_shares = maxCollateralizedShares + maxUncollateralizedShares`
4. If `in_shares=false`: converts via `virtualConvertToAssets(all_shares)` then `bigIntToDecimal(assets, asset.decimals)`

**Collateral-specific seam (preferred for remove-collateral flows):**
```ts
maxRemovableCollateral(): Promise<TokenInput>
maxRemovableCollateral(in_shares: true): Promise<bigint>
maxRemovableCollateral(in_shares: false): Promise<TokenInput>
maxRemovableCollateral(in_shares: true, bufferTime: bigint): Promise<bigint>
maxRemovableCollateral(in_shares: false, bufferTime: bigint): Promise<TokenInput>
```

Internal flow:
1. Calls `market.reader.maxCollateralRemovalOf(account, ctoken, bufferTime)`
2. `removeCollateralExact()` and `removeMaxCollateral()` are built on this collateral-only seam

**v2 withdraw mutation uses this with dust protection:**
```ts
const maxRedemption = await token.maxRedemption();  // TokenInput
const tx = await token.redeem(
  Decimal(maxRedemption).lessThan(amount) ? Decimal(maxRedemption) : Decimal(amount)
);

// Inside token.redeem():
const buffer = this.market.userDebt.greaterThan(0) ? 100n : 0n;  // extra buffer if has debt
const balance_avail = await this.balanceOf(signer.address);
const max_shares = await this.maxRedemption(true, buffer);
const converted_shares = this.convertTokenInputToShares(amount);
let shares = max_shares < converted_shares ? max_shares : converted_shares;
if (balance_avail - shares <= 10n) {
  shares = balance_avail;  // dust sweep: if <10 shares left, redeem everything
}
```

---

## [REPAY_MECHANICS]

### Debt Balance Fetching

```ts
// BorrowableCToken.fetchDebtBalanceAtTimestamp overloads:
fetchDebtBalanceAtTimestamp(): Promise<USD>                          // current block, in USD
fetchDebtBalanceAtTimestamp(timestamp: bigint): Promise<USD>         // projected, in USD
fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: true): Promise<USD>
fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: false): Promise<bigint>  // raw tokens
```

The `timestamp` parameter adds seconds ahead of current block. E.g., `100n` = "what will the debt be in 100 seconds" (accounts for interest accrual). Used in leverage-down to ensure sufficient repayment covers accruing interest.

### Full-Repay Detection Pattern (from v2)

```ts
// 1. Fetch projected debt (0n = current block)
const usdUserDebt = await token.fetchDebtBalanceAtTimestamp();  // USD Decimal

// 2. Convert to token terms
const userDebt = token.convertUsdToTokens(usdUserDebt);  // Decimal in asset units

// 3. Check if paying ≥ 99.9% of debt
const threshold = userDebt.mul(0.999);
const isPayingAll = Decimal(amount).gte(threshold);

// 4. If full repay: add 1% buffer to allowance (covers interest accrual during tx confirmation)
const allowanceAmount = isPayingAll
  ? Decimal(amount).mul(0.01).add(amount)  // 101% of amount
  : Decimal(amount);

// 5. Call repay with 0 to signal full repay
const tx = await token.repay(isPayingAll ? Decimal(0) : Decimal(amount));
// On-chain: amount=0 triggers repay of entire outstanding debt balance
```

### repay() internals

```ts
async repay(amount: TokenInput) {
  const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
  // When amount=Decimal(0), assets=0n → contract interprets as "repay all"
  const calldata = this.getCallData("repay", [assets]);
  return this.oracleRoute(calldata);
}
```

---

## [SLIPPAGE_HANDLING]

### Contract-side: Four layers of slippage protection

The contract enforces slippage at four independent levels:

**Layer 1: Dex minimum output** — the dex aggregator enforces `quote.min_out` based on user slippage. The swap itself won't execute if output drops below this threshold.

**Layer 2: `_swapSafe` oracle check (SwapperLib.sol)** — after the dex swap executes, compares oracle-valued input vs output:
```solidity
// SwapperLib._swapSafe():
outAmount = _swapUnsafe(cr, action);  // executes dex swap, checks calldata minimum
uint256 valueIn = _getValue(om, action.inputToken, action.inputAmount);   // oracle price
uint256 valueOut = _getValue(om, action.outputToken, outAmount);          // oracle price
// If valueOut <= valueIn:
uint256 slippage = (valueIn - valueOut) * WAD / valueIn;  // rounded up
if (slippage > action.slippage) revert;  // action.slippage is user's WAD-scaled value
```
This catches dex manipulation that oracle prices don't reflect. If `valueOut > valueIn` (positive slippage), it passes immediately.

**Layer 3: `checkSlippage` modifier** — wraps every leverage/deleverage entry point. Measures pre/post position value:
```solidity
// Before action:
(collateralBefore, , debtBefore) = marketManager.statusOf(account);
valueIn = collateralBefore - debtBefore;
// After action:
(collateralAfter, , debtAfter) = marketManager.statusOf(account);
valueOut = collateralAfter - debtAfter;
// Check: (valueIn - valueOut) <= (valueIn * slippage / WAD)
```
The `slippage` parameter is in WAD directly (5e16 = 5%). This is the portfolio-level protection — checks overall equity change.

**Layer 4: Per-operation minimum checks inside callbacks:**
- `onBorrow` (leverage): checks `shares >= action.expectedShares` after depositing — reverts if received fewer cToken shares than expected
- `onRedeem` (deleverage): checks `action.repayAssets <= assetsHeld` — ensures minimum debt repayment amount was received from swap. The SDK's hardcoded 5% floor on `repayAssets` is intentional defense-in-depth against oracle/dex divergence (user slippage is enforced by layers 1-3). Then repays `min(assetsHeld, totalDebt)` — always repays as much as possible, capped at total outstanding debt

Contract NatSpec notes the checkSlippage modifier is "primarily a sanity check rather than a security guarantee." The real protection stack is layers 1-2 (`_swapSafe`), with layers 3-4 as safety nets.

### SDK-side: Slippage format conversion

Two scales exist between the SDK and contract:

**Raw BPS (for dex aggregator):**
```ts
// Used in: dexAgg.quoteAction(), dexAgg.quote()
const slippage = toBps(Decimal(0.05));  // → 500n (5%)
```

**WAD fraction (for position manager contract):**
```ts
// Contract expects slippage "in WAD (1e18)"
// SDK converts: Percentage → BPS → WAD
// FormatConverter.bpsToBpsWad does: BPS × 1e18 / 10,000
const slippageWad = FormatConverter.bpsToBpsWad(slippage);
// 500n → 5e16n   (0.05 in WAD = 5%)
// 100n → 1e16n   (0.01 in WAD = 1%)
```

### Default slippage

```ts
// SDK default for leverage operations:
slippage_: TokenInput = Decimal(0.05)  // 5%

// System constant (not used by leverage, available for other flows):
DEFAULT_SLIPPAGE_BPS = 100n  // 1%
```

### Slippage in zap instructions

```ts
const instructions = {
  type: zapType,
  inputToken: asset.address,
  slippage: Decimal(0.05)  // Percentage, converted to BPS internally:
  // → BigInt(slippage.mul(BPS).toString()) = BigInt(Decimal(0.05).mul(10000).toString()) = 500n
};
```

### expectedShares: leverage paths

Both `leverageUp` and `depositAndLeverage` use `virtualConvertToShares(BigInt(quote.min_out), LEVERAGE.SHARES_BUFFER_BPS)` for simple types — cached conversion with 2bps buffer for exchange rate drift. Vault types use `getVaultExpectedShares` (async, two-hop conversion).

The Zapper path uses `await ctoken.convertToShares(BigInt(quote.min_out))` — on-chain conversion with 2bps buffer. Both paths account for interest-driven exchange rate drift.

### Leverage-down special cases

```ts
// Full deleverage (newLeverage = 1):
//   _getLeverageSnapshot refreshes debt with 2min interest projection
//   debtInCollateral = snapshot debt converted to collateral asset terms
//   swapCollateral = debtInCollateral × (1 + (DELEVERAGE_OVERHEAD_BPS + feeBps) / 10000)
//   capped at maxCollateral (virtualConvertToAssets(userCollateral))
//   Min repay = 1n (contract repays min(assetsHeld, totalDebt), returns excess)
//   Contract slippage = user's slippage + (L−1) × (DELEVERAGE_OVERHEAD_BPS + feeBps)
//                       — see equity-amplification note below

// Partial deleverage:
//   collateralAssets = exact collateralAssetReduction from previewLeverageDown
//   Min repay = quote.min_out (DEX's slippage-adjusted guarantee)
//   Contract slippage = user's slippage (no amplification needed — exact sizing)
```

**Equity-amplification (the `(L−1)` term):** Full deleverage intentionally oversizes the swap by `DELEVERAGE_OVERHEAD_BPS + feeBps` in absolute terms to prevent dust debt. The `checkSlippage` modifier (Layer 3) compares pre/post equity as a fraction of starting equity. Since `equity ≈ collateral / L`, an absolute X-bps loss on `swapCollateral` becomes `(L−1) × X bps` in equity-fraction terms. The contract slippage tolerance must be expanded by exactly that forced amount, leaving the user's `slippage` budget available for variable DEX impact + oracle drift. This does NOT loosen MEV protection — that lives at the `_swapSafe` layer (Layer 2), which still receives raw user slippage. The expansion only loosens the `checkSlippage` sanity check, which is documented as "primarily a sanity check rather than a security guarantee" in the contract NatSpec.

The economic loss from the intentional overshoot is zero — the contract returns excess debt token to the user's wallet. The fee portion, however, IS real value loss from the position's perspective: it leaves via the swap input and is sent to `feeReceiver`, never returned. Both portions sit inside the expanded contract slippage tolerance.

### Fee policy interaction

When `setup_config.feePolicy` is non-zero (configured via `setupChain` options), KyberSwap deducts the fee from the swap input before swapping (`chargeFeeBy=currency_in`, `isInBps=true`). Effective swap input becomes `amount × (1 − feeBps/10000)`. Fees are mandatory — the on-chain `KyberSwapChecker` rejects swaps without exactly one fee receiver (DAO address) at exactly `FEE_BPS = 4`. Changing the fee requires redeploying the checker.

**Leverage-up / deposit-and-leverage:** The fee reduces swap output, which `checkSlippage` (Layer 3) sees as equity loss amplified by `(L−1)`. Each call site computes `contractSlippage = slippage + (L−1) × feeBps` for the `checkSlippage` modifier, separate from the `action.slippage` passed to `_swapSafe` (Layer 2). The rounding buffer (`LEVERAGE_UP_BUFFER_BPS`, flat) and the fee amplification (`(L−1) × feeBps`) serve different purposes and are additive.

**Deleverage (full):** The deleverage call site sizes `swapCollateral` with `(DELEVERAGE_OVERHEAD_BPS + feeBps)` so the post-fee swap output still covers the debt. The fee bps also enters the `(L−1)` contract slippage expansion — `contractSlippage = slippage + (L−1) × (overhead + feeBps)`. **Partial deleverage:** `swapCollateral` inflated by `10000 / (10000 − feeBps)` to compensate for fee deduction on swap input.

**`_swapSafe` fee budget consumption:** Layer 2 values the full `action.inputAmount` at oracle price but the swap only received `(inputAmount − fee)` worth of tokens. The fee appears as ~`feeBps` of apparent slippage, consuming that budget from the user's tolerance. At 4 bps this is negligible for ≥0.1% user slippage. The app enforces a 0.1% (10 bps) minimum slippage floor.

**DAO address desync risk:** The SDK hardcodes `CURVANCE_DAO_FEE_RECEIVER`. The on-chain checker validates against `centralRegistry.daoAddress()` dynamically. If `transferDaoPermissions()` changes the DAO address, the checker validates against the new address but the SDK still sends the old one — every swap reverts. Follow-up: read `daoAddress` at `setupChain` time via `protocolReader.centralRegistry()`.

Same-token zaps and native↔wrapped routes are exempted by the policy (return `0n`) and short-circuited at `Zapper.getSimpleZapCalldata` to skip the DEX call entirely — mirroring `SimpleZapper._isMatchingToken` on-chain behavior. These paths never reach the checker.

### Protocol fee on leverage/deleverage

Every leverage and deleverage action has a protocol fee applied inside the contract's `_validateInputsAndApplyFee`:
```solidity
uint256 fee = FixedPointMathLib.mulDivUp(
    actionAssets,
    centralRegistry.protocolLeverageFee(),  // in BPS
    BPS
);
// Fee is deducted from actionAssets and sent to centralRegistry.daoAddress()
// Remaining actionAssets are used for the swap/deposit
```
This fee reduces the effective borrow amount (leverage) or collateral amount (deleverage). **`protocolLeverageFee` must remain 0 while SDK fees are active.** The on-chain fee mutates `action.borrowAssets` before the swap callback, causing `swapAction.inputAmount != action.borrowAssets` in `SimplePositionManager` (revert). Additionally, users would be double-charged (protocol fee on collateral/borrow + SDK fee on swap input). If `protocolLeverageFee` needs activation, the SDK must first query the fee, subtract it from `swapAction.inputAmount`, and quote KyberSwap for the reduced amount.

---

## [ERC4626_VAULT_LAYER]

**cTokens themselves are ERC4626 vaults.** Every cToken wraps an underlying asset and mints/burns shares on deposit/redeem — that's the base ERC4626 pattern. `token.asset` is always the underlying, `token.decimals` are the vault share decimals, and `convertToShares`/`convertToAssets` are the standard ERC4626 conversion methods.

This section covers **vault-backed cTokens** — the special case where the cToken's underlying asset (`token.asset`) is itself a vault token (e.g., the underlying is stETH from Lido, or an LP token from a yield vault). These are flagged by `token.isVault = true` or `token.isNativeVault = true`, determined by matching `token.asset.address` against `chain_config.vaults[]` or `chain_config.native_vaults[]`.

### Two-layer vault chain

For vault-backed cTokens, there are two ERC4626 layers:

```
User's raw asset (e.g., WETH)
  → External vault deposit (e.g., Lido) → Vault token (e.g., stETH)  [cToken's underlying]
    → cToken deposit → cToken shares (e.g., cstETH)

App stays in asset terms throughout — the SDK and zappers handle vault routing transparently.
```

For non-vault cTokens, there's only one layer: `underlying asset → cToken shares`.

### Expected shares calculation (leverage)

```ts
// Vault-backed: two-hop conversion
// PositionManager.getVaultExpectedShares:
static async getVaultExpectedShares(deposit_ctoken: CToken, borrow_ctoken: CToken, borrow_amount: TokenInput) {
  const borrow_amount_bn = FormatConverter.decimalToBigInt(borrow_amount, borrow_ctoken.asset.decimals);
  const underlying_vault = deposit_ctoken.getUnderlyingVault();  // ERC4626 of the external vault
  const vault_shares = await underlying_vault.previewDeposit(borrow_amount_bn);  // raw asset → vault token amount
  return deposit_ctoken.convertToShares(vault_shares);  // vault token → cToken shares (on-chain)
}

// Non-vault: single-hop conversion
static async getExpectedShares(deposit_ctoken: CToken, amount: bigint) {
  return deposit_ctoken.convertToShares(amount);  // underlying asset → cToken shares (on-chain)
}
```

**Vault types always use on-chain `convertToShares` (async), via the two-hop `getVaultExpectedShares` path.** For simple (non-vault) types, `depositAndLeverage` uses `getExpectedShares` (on-chain convertToShares), but `leverageUp` uses raw `quote.min_out` directly — see convertToShares usage table in Approval Architecture section.

### Zap routing for vault types

```ts
// In CToken.zap(), vault type:
case 'vault':
  calldata = await zapper.getVaultZapCalldata(this, assets, collateralize);
  calldata_overrides = { to: zapper.address };
  // Internally: gets vault underlying → previewDeposit → convertToShares
  // Swap struct has same input/output token (no dex swap), zapper handles vault deposit atomically

case 'native-vault':
  calldata = await zapper.getNativeZapCalldata(this, assets, collateralize);
  calldata_overrides = { value: assets, to: zapper.address };
  // Native ETH sent as msg.value, zapper wraps and deposits into vault
```

### Accessing vault layers

```ts
token.isVault: boolean                    // true if underlying is a known vault token
token.isNativeVault: boolean              // true if underlying is a native vault (e.g., staking derivative)
token.getUnderlyingVault(): ERC4626       // ERC4626 instance of the external vault. THROWS if !isVault && !isNativeVault
token.getVaultAsset(true): Promise<ERC20>  // the vault's underlying raw asset (e.g., WETH under stETH)
token.getVaultAsset(false): Promise<address>
token.getAsset(true): ERC20               // cToken's direct underlying (the vault token itself, e.g., stETH)
token.getAsset(false): address
```

---

## [REDSTONE_ORACLE]

**File:** `src/classes/Redstone.ts`

### When it activates

`CToken.getPriceUpdates()` checks if `this.adapters` includes `AdaptorTypes.REDSTONE_CORE`. If yes, a price update action is prepended to every transaction via multicall.

### Payload construction

```ts
Redstone.buildMultiCallAction(ctoken):
  1. Get RedstoneCoreAdaptor address from setup_config.contracts.adaptors
  2. Fetch signed price payload:
     - dataServiceId: "redstone-primary-prod"
     - 3-of-4 authorized signers required
     - Returns { payload: bytes, timestamp: bigint }
  3. Encode writePrice(asset.address, true, timestamp)
  4. Concatenate: solidityPacked(["bytes", "bytes"], [writePrice_calldata, redstone_payload])
  5. Return as MulticallAction: { target: adaptor, isPriceUpdate: true, data: encoded }
```

### How it's used in oracleRoute

```ts
async oracleRoute(calldata, override = {}) {
  const price_updates = await this.getPriceUpdates();  // [] or [MulticallAction]

  if (price_updates.length > 0) {
    const token_action = this.buildMultiCallAction(calldata);
    // token_action: { target: cToken.address, isPriceUpdate: false, data: original_calldata }
    calldata = this.getCallData("multicall", [[...price_updates, token_action]]);
    // Now calldata = multicall([priceUpdate, realAction])
  }

  const tx = await this.executeCallData(calldata, override);
  await this.market.reloadUserData(signer.address);
  return tx;
}
```

**Effect:** If the token uses Redstone oracle, every tx is automatically wrapped as `multicall([updatePrice, userAction])`. Transparent to consumers.

---

## [ZAPPER_ARCHITECTURE]

**File:** `src/classes/Zapper.ts`. Extends `Calldata<IZapper>`.

### Zapper type mapping

```ts
const zapperTypeToName = new Map([
  ['native-vault', 'nativeVaultZapper'],
  ['vault', 'vaultZapper'],
  ['simple', 'simpleZapper'],
  ['native-simple', 'simpleZapper'],  // shares contract with 'simple'
]);
```

### Calldata generation by type

| Zap type | Method | Key behavior |
|---|---|---|
| `simple` | `getSimpleZapCalldata` | Gets dex quote → builds Swap struct → calculates expected shares via `convertToShares(min_out)` |
| `vault` | `getVaultZapCalldata` | Gets vault underlying → previews vault deposit → calculates expected shares |
| `native-vault` | `getNativeZapCalldata` | Direct `convertToShares(amount)` → sends native ETH as `msg.value` |
| `native-simple` | `getNativeZapCalldata(ctoken, amount, collateralize, true)` | Same as native-vault but wraps to wrapped native |

All routes call `swapAndDeposit(ctoken, depositAsWrappedNative, swap, expectedShares, collateralizeFor, receiver)` on the zapper contract.

### Deposit token discovery

```ts
token.getDepositTokens(search?): Promise<ZapToken[]>
// Returns list of { interface: ERC20|NativeToken, type: ZapperTypes }
// Priority order:
//   1. Underlying asset (type: 'none' — no zap needed)
//   2. Native token (if native-vault or native-simple supported)
//   3. Vault underlying asset (if vault type supported)
//   4. Dex-aggregator available tokens (if simple type supported, filtered by exclusion list)
```

---

## [ERC20_API_PATTERNS]

**File:** `src/classes/ERC20.ts`

### balanceOf overloads

```ts
balanceOf(account: address): Promise<bigint>                  // raw
balanceOf(account: address, in_token_input: true): Promise<TokenInput>  // Decimal
balanceOf(account: address, in_token_input: false): Promise<bigint>     // raw
```

### approve behavior

```ts
approve(spender: address, amount: TokenInput | null): Promise<TransactionResponse>
// amount = null → UINT256_MAX (unlimited approval)
// amount = Decimal → decimalToBigInt(amount, decimals)
```

### Price fetching (standalone, on-chain call)

```ts
getPrice(inTokenInput: true, inUSD: boolean, getLower: boolean): Promise<USD>
getPrice(inTokenInput: false, inUSD: boolean, getLower: boolean): Promise<bigint>
// Goes through OracleManager — on-chain RPC call
// Different from CToken.getPrice() which reads from bulk-loaded .cache synchronously
```

### Data model

ERC20 has an optional `cache: StaticMarketAsset`. When populated (by ProtocolReader during bulk load), getters like `decimals`, `symbol`, `name`, `totalSupply`, `balance`, `price` return synchronously from the loaded data. When not populated (standalone ERC20 instances created outside the market system), they return `undefined`. The `fetch*` methods always make RPC calls and update the `.cache` field.

---

## [ENSURE_UNDERLYING_AMOUNT]

```ts
// CToken.ensureUnderlyingAmount(amount, zap) — called at top of deposit/depositAsCollateral/depositAndLeverage
async ensureUnderlyingAmount(amount: TokenInput, zap: ZapperInstructions): Promise<TokenInput> {
  const balance = await this.getZapBalance(zap);  // resolves input token based on zap type (see below)
  const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);

  if (assets > balance) {
    console.warn('[WARNING] Detected higher deposit amount than underlying balance...');
    return FormatConverter.bigIntToDecimal(balance, this.asset.decimals);  // silently caps to balance
  }
  return amount;
}
```

**`getZapBalance(zap)` resolves the actual input token based on zap type:**

| Zap type | Token checked | Method |
|---|---|---|
| `'none'` | cToken's underlying asset | `this.getAsset(true).balanceOf(...)` |
| `'vault'` | Vault's underlying raw asset | `this.getVaultAsset(true).balanceOf(...)` |
| `'native-vault'`, `'native-simple'` | Native chain token (ETH/MON) | `NativeToken.balanceOf(...)` |
| `{ type, inputToken, ... }` (object) | The specified input token | `new ERC20(inputToken).balanceOf(...)` |

**This is a silent safety net.** If the user tries to deposit more than they have of the *input* token (not necessarily the underlying), the SDK caps the amount to their balance and logs a warning. No throw, no error — the deposit proceeds with the capped amount. v1 should validate input amounts against the correct token balance before calling SDK methods to provide explicit UI feedback.

---

## [FORMAT_MODULE]

Source: `src/format/`. Pure functions for app-side computation — SDK is the source of truth. App should import from SDK, not duplicate logic.

### format/leverage.ts

```ts
MIN_DEPOSIT_USD = 10
MIN_BORROW_USD = 10.1
HIGH_LEVERAGE_THRESHOLD = 60
MAX_LTV_RATIO = 0.85

calculateBorrowAmount(depositUsd: Decimal, leverage: number): Decimal
// Returns depositUsd × (leverage - 1). Returns 0 if leverage ≤ 1.

calculateLeverageRatio(totalValue: Decimal, debtAmount: Decimal): Decimal
// totalValue / (totalValue - debtAmount). Returns 1 if no debt, 0 if underwater.

calculateDeleverageAmount(currentLeverage: number, targetLeverage: number, totalValue: Decimal): Decimal
// Returns reduction in debt needed. 0 if target ≥ current.

calculatePositionSize(tokenAmount: Decimal, leverage: number): Decimal
// tokenAmount × leverage

validateLeverageInput(input: LeverageValidationInput): ValidationResult
// Checks: balance, min deposit ($10), min borrow ($10.1), liquidity, max leverage.
// Returns { isValid, error?, warning?, canProceed }

checkLeverageAmountBelowMinimum(input): boolean
// For edit leverage: checks if terminal debt < MIN_BORROW_USD (and not zero).
// For new: checks if borrowAmount > 0 and < MIN_BORROW_USD.

checkBorrowExceedsLiquidity(borrowAmount, availableLiquidity): boolean
```

### format/borrow.ts

```ts
MIN_LOAN_USD = 10

calculateMaxBorrow(userRemainingCredit, remainingDebt, availableLiquidity): Decimal
// min(credit, debt, liquidity) — all clamped to 0.

calculateMaxRepay(userBalance, userDebt): Decimal
// min(balance, debt)

validateRepayRemainder(currentDebtUsd, repayAmountUsd, minLoanUsd?): RepayValidation
// If remainder > 0.001 and < minLoanUsd → invalid (would leave dust loan).

calculateDebtPreview(currentDebt, amount, isRepaying): Decimal
// current ± amount

convertAmountByCurrencyView(amount, price, currencyView): { usdAmount, tokenAmount }
// Converts between dollar and token views using price.
```

### format/collateral.ts

```ts
calculateExchangeRate(assetBalance, shareBalance): Decimal
// assetBalance / shareBalance. Returns 1 if shareBalance is 0.

calculateCollateralBreakdown(assetBalance, collateralShares, exchangeRate): CollateralBreakdown
// Returns { exchangeRate, collateralAssets: min(assetBalance, shares×rate), uncollateralizedAssets }

calculateNewCollateral(currentCollateral, amount, action: 'add'|'remove'): Decimal
```

### format/health.ts

```ts
LOW_HEALTH_THRESHOLD = 10
CAUTION_HEALTH_UPPER = 20

getHealthStatus(percentageValue: number | null): HealthStatus
// <5 → 'Danger', 5-20 → 'Caution', >20 → 'Healthy', null → 'Healthy'

healthFactorToPercentage(rawHealthFactor: number | null): number
// (raw - 1) × 100, min 0. Null defaults to 5.

formatHealthFactorPercentage(value: number): string
// Intl.NumberFormat as percent, 0 fraction digits

formatHealthFactor(value?: number | null): string
// null → '∞', ≥999 → '>999%', else formatHealthFactorPercentage

getLiquidityStatus(ratio): 'green' | 'yellow' | 'red'
// <0.75 green, 0.76-0.9 yellow, >0.91 red
```

### format/amounts.ts

```ts
USD_DUST_THRESHOLD = Decimal('0.01')

clampUsdDustAmount(value): Decimal
// If abs(value) < 0.01 → 0, else value

normalizeAmountString(value, maxFractionDigits, roundingMode?): string
// Rounds to maxFractionDigits, trims trailing zeros. ROUND_DOWN default.

normalizeCurrencyAmounts({ amount, currencyView, tokenDecimals, price, ... }): { amount, usdAmount, tokenAmount }
// Master normalizer: converts between dollar/token views, preserves trailing zeros during input,
// clamps dust amounts, normalizes display. Handles 'dollar' and 'token' currencyView.
```

---

## [API_CLASS]

Source: `src/classes/Api.ts`. Static methods for backend API communication.

```ts
class Api {
    static async fetchNativeYields(): Promise<{ symbol: string, apy: number }[]>
    // Fetches from {api_url}/v1/{chain}/native_apy. Currently only supports 'monad' chain.
    // Returns empty array for unsupported chains or errors.

    static async getRewards(): Promise<{ milestones: Milestones, incentives: Incentives }>
    // Fetches from {api_url}/v1/rewards/active/{chain}.
    // Returns keyed by market address. Gracefully returns empty on failure.
}

// Types:
type MilestoneResponse = { market: address, tvl: number, multiplier: number, fail_multiplier: number, chain_network: string, start_date: string, end_date: string, duration_in_days: number }
type IncentiveResponse = { market: address, type: string, rate: number, description: string, image: string }
type Milestones = { [key: string]: MilestoneResponse }
type Incentives = { [key: address]: Array<IncentiveResponse> }
```

---

## [OPTIMIZER_READER]

Source: `src/classes/OptimizerReader.ts`. Reads optimizer (vault aggregation) data from on-chain reader contract.

```ts
class OptimizerReader {
    constructor(address, provider?)

    async getOptimizerMarketData(optimizers: address[]): Promise<OptimizerMarketData[]>
    // Returns per-optimizer: address, asset, totalAssets, markets (cTokens with allocatedAssets + liquidity),
    // totalLiquidity, sharePrice, performanceFee

    async getOptimizerUserData(optimizers: address[], account: address): Promise<OptimizerUserData[]>
    // Returns per-optimizer: address, shareBalance, redeemable

    async optimalDeposit(optimizer: address, assets: bigint): Promise<address>
    // Returns the cToken address for optimal deposit routing

    async optimalWithdrawal(optimizer: address, assets: bigint): Promise<address>
    // Returns the cToken address for optimal withdrawal routing

    async optimalRebalance(optimizer: address): Promise<ReallocationAction[]>
    // Returns { cToken, assets }[] rebalance actions
}
```

---

## [SNAPSHOT_INTEGRATION]

Source: `src/integrations/snapshot.ts`. Produces JSON-serializable portfolio state for indexers and cron jobs.

```ts
function snapshotMarket(market: Market): MarketSnapshot
// Snapshots a single market: positions (deposit/collateral/debt per token, prices, APY), health, daily earnings/cost.

async function takePortfolioSnapshot(account: address, options?: { refresh?: boolean }): Promise<PortfolioSnapshot>
// Full portfolio across all_markets. When refresh=true, reloads dynamic + user data (2 RPC calls, not 2×N)
// via shared reader before reading cache.
// Returns: account, chain, timestamp, totalDepositsUSD, totalDebtUSD, netUSD, dailyEarnings, dailyCost, markets[]
```

---

## [YIELD_CALCULATION_HELPERS]

Source: `src/helpers.ts`. Exported from SDK package — app imports directly: `import { getInterestYield, getDepositApy, getBorrowCost } from 'curvance'`. App-side `deposit.utils.ts` re-exports some with app-specific overrides but defers to SDK for core logic.

```ts
getNativeYield(token, apyOverrides?): Decimal
// Helper param uses `token.nativeYield`; CToken property is `nativeApy`. Returns value if nonzero, else falls back to apyOverrides by symbol.

getInterestYield(token): Decimal
// Returns token.getApy() — the lending APY. SDK canonical export; app no longer defines its own.

getMerklDepositIncentives(tokenAddress, opportunities): Decimal
// Matches Merkl opportunities by token address in tokens array. Returns best APR / 100.

getMerklBorrowIncentives(tokenAddress, opportunities): Decimal
// Matches Merkl opportunities by identifier. Returns best APR / 100.

getDepositApy(token, opportunities, apyOverrides?): Decimal
// Total deposit APY: native (or interest + overrides) + Merkl.
// When nativeApy > 0 it already includes interest, so used directly.

getBorrowCost(token, opportunities): Decimal
// Net borrow cost: borrowRate - merklIncentives. Can be negative when rewards exceed rate.
```

---

## [MARKET_METADATA_TYPES]

Source: `src/types.ts`. New type unions for market categorization:

```ts
type MarketCategory = "stablecoin" | "staking" | "restaking" | "yield-stablecoin" | "blue-chip" | "native"
type CollateralSource = "Renzo" | "Upshift" | "Yuzu" | "Native" | "Circle" | "Fastlane" | "Apriori" | "Mu Digital" | "Kintsu" | "Reservoir"

// Each has a CATEGORY_META / PROTOCOL_META record with { label, color } pairs.
// Colors in these maps are SDK defaults — app may override with brand-compliant colors.
```

Additional type additions: `TypeBPS` (bigint), `curvance_provider` (JsonRpcSigner | Wallet | JsonRpcProvider), `curvance_signer` (JsonRpcSigner | Wallet).

---


## [SECURITY_TRUST_BOUNDARIES]

### External fetch() inventory

Every external HTTP call in the SDK, with validation status after security hardening (v3.7.3+):

| File | Endpoint | Timeout | Response validation | Downstream usage |
|---|---|---|---|---|
| `Api.ts` | `{api_url}/v1/{chain}/native_apy` | `fetchWithTimeout` 15s | Structure check (array guard) | Display APY only |
| `Api.ts` | `{api_url}/v1/rewards/active/{chain}` | `fetchWithTimeout` 15s | Try/catch, empty fallback | Display incentives only |
| `Kuru.ts` | `{this.api}/generate-token` | `fetchWithTimeout` 15s | `.ok` check | JWT stored in memory |
| `Kuru.ts` | `https://api.kuru.io/api/v2/tokens/search` | `fetchWithTimeout` 15s | `validateAddress` per token, `safeBigInt` on numerics | ERC20 construction for zap list |
| `Kuru.ts` | `{this.api}/quote` | `fetchWithTimeout` 15s | `validateRouterAddress`, `safeBigInt`, calldata `0x` normalization | **Contract calldata** via PositionManager |
| `KyberSwap.ts` | `{this.api}/api/v1/routes` | `fetchWithTimeout` 15s | `.ok` check | Quote intermediate |
| `KyberSwap.ts` | `{this.api}/api/v1/route/build` | `fetchWithTimeout` 15s | `safeBigInt` on amountOut, router address check (L219) | **Contract calldata** via PositionManager |
| `merkl.ts` | `api.merkl.xyz/v4/users/{wallet}/rewards` | `fetchWithTimeout` 15s | `.ok` check | Display rewards |
| `merkl.ts` | `api.merkl.xyz/v4/campaigns` | `fetchWithTimeout` 15s | `.ok` check | Display campaigns |
| `merkl.ts` | `api.merkl.xyz/v4/opportunities` | `fetchWithTimeout` 15s | `.ok` check | APY enrichment in `Market.getAll()` |

### DEX router validation comparison

| Aggregator | SDK validates router? | On-chain calldata checker? | Risk if compromised API |
|---|---|---|---|
| KyberSwap | Yes — `routerAddress != this.router` (L219) | Yes — `KyberSwapChecker` in chain config | Low — dual defense |
| Kuru | Yes — `validateRouterAddress()` (added v3.7.3) | **No** — no `KuruChecker` in chain config | Medium — SDK-only defense |

### Validation utilities (`src/validation.ts`)

All exported from package root. Used at every external trust boundary:

- `safeBigInt(value, context)` — `BigInt()` with descriptive error on non-numeric
- `validateAddress(raw, context)` — ethers `getAddress()` runtime check
- `validateRouterAddress(actual, expected, name)` — format + allowlist
- `fetchWithTimeout(url, options?, timeoutMs?)` — 15s default, composes with caller `AbortSignal`
- `validateApiUrl(url)` — HTTPS scheme enforcement (called in `setupChain`)
- `validateSlippageBps(slippage, context)` — range [0, 10000] BPS

### Supply chain notes

`@redstone-finance/sdk@0.9.0` pulls `axios@1.14.0` into the oracle price path (`Redstone.getPayload()` → `requestDataPackages()` → `axios.get()`). Every `oracleRoute()` call for Redstone-priced tokens loads axios. Pinned to exact version in `package.json`; `.npmrc` enforces `save-exact=true` for future additions.

### Audit proof hierarchy

- Package-boundary claims are only proven by the artifact the app actually consumes (`npm pack` tarball or published version). Linked source, copied `dist`, or repo-local green status are not release proof.
- Liveness/equivalence claims are only proven by tracing a definitive endpoint: a real consumer callsite, deployed method, or packaged artifact behavior. Import hits, permissive types, and code-shape similarity are heuristics only.

---
