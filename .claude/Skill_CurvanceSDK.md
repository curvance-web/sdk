---
name: curvance-sdk
description: "Use when reading, calling, extending, or debugging the Curvance contract-sdk (curvance npm package). Triggers: writing SDK functions, calling SDK methods from v1 app, understanding data flow from chain to UI, working with Market/CToken/BorrowableCToken classes, formatting on-chain values, building new query hooks, debugging SDK errors. Compose with Skill_CurvanceApp.md for app integration. Do NOT use for Solidity/protocol contract work."
---

# Curvance SDK (contract-sdk)

Rules for working with the SDK. Read before calling any SDK method, writing query hooks, or extending SDK classes.

## Routing Table

| Task type | Context sections to read |
|---|---|
| Calling SDK methods (quick ref) | #CTOKEN_API, #BORROWABLE_CTOKEN_API, #MARKET_API |
| Calling SDK methods (detailed) | #CTOKEN_SYNC_GETTERS, #BORROWABLE_EXTENDED_API, #MARKET_COMPUTED_PROPERTIES |
| Writing a new query hook | #V1_CONSUMPTION_LAYER, #DASHBOARD_QUERIES |
| Building a mutation | #V1_ACTION_PATTERNS, #TRANSACTION_EXECUTION |
| Building deposit flow | #DEPOSIT_MUTATION |
| Building borrow/repay flow | #BORROW_UTILITIES, #REPAY_MECHANICS |
| Building collateral flow | #COLLATERAL_UTILITIES |
| Building leverage flow | #LEVERAGE_UTILITIES, #STANDALONE_LEVERAGE_MUTATIONS, #LEVERAGE_FLOW |
| Formatting values | #FORMAT_CONVERTER_API, #FORMAT_MODULE |
| Understanding data flow | #SETUP_FLOW, #DATA_SHAPES |
| Approval logic | #APPROVAL_ARCHITECTURE |
| Shares ↔ assets conversion | #SHARES_ASSETS_PIPELINE, #DECIMAL_SYSTEM |
| Slippage handling | #SLIPPAGE_HANDLING |
| Zap/swap flow | #ZAPPER_ARCHITECTURE, #ZAP_FLOW |
| Type system / constants | #TYPE_SYSTEM_CONSTANTS |
| Store patterns | #STORE_ARCHITECTURE |
| Yield/APY calculation | #YIELD_CALCULATION_HELPERS, #REWARDS_INCENTIVES |
| Position previews | #POSITION_PREVIEW_METHODS, #POSITION_PREVIEW_HOOKS |
| Validation / form errors | #VALIDATION_HOOKS |
| Cooldown / hold period | #COOLDOWN_SYSTEM |
| ERC4626 vault layer | #ERC4626_VAULT_LAYER |
| DEX aggregators | #DEX_AGGREGATORS_API |
| RPC retry / error debugging | #RETRY_PROVIDER |
| Supporting classes | #PROTOCOL_READER_API, #ERC20_API, #ORACLE_MANAGER_API, #POSITION_MANAGER_API, #ZAPPER_API, #NATIVE_TOKEN_API, #CALLDATA_API |
| Optimizer / vault routing | #OPTIMIZER_READER |
| Snapshot / portfolio export | #SNAPSHOT_INTEGRATION |
| Market categorization types | #MARKET_METADATA_TYPES |
| ERC4626 / vault token layer | #ERC4626_VAULT_LAYER, #ERC4626_API |
| Redstone oracle / price updates | #REDSTONE_API, #REDSTONE_ORACLE |
| Max redemption / withdraw limits | #MAX_REDEMPTION, #ENSURE_UNDERLYING_AMOUNT |
| FormatConverter (complete ref) | #FORMAT_CONVERTER_COMPLETE |
| ERC20 usage patterns | #ERC20_API_PATTERNS |
| API class (backend calls) | #API_CLASS |
| SDK helper functions | #HELPERS |
| Write pattern (oracleRoute internals) | #WRITE_PATTERN |
| Task group mapping (bytes tasks) | #TOKEN_TASK_GROUP_MAP |
| Security audit / trust boundaries | #SECURITY_TRUST_BOUNDARIES |

## Hard Constraints

- **ethers v6 only.** No v5 patterns.
- **Decimal.js for all user-facing math.** Precision 50, `ROUND_DOWN`. Never native JS `Number` for amounts/prices.
- **bigint for all on-chain values.** Conversion via `FormatConverter` at boundary.
- **Global mutable state.** `setupChain()` writes module-level `setup_config` and `all_markets`. Must run first.
- **Bulk-loaded data.** `setupChain()` → `Market.getAll()` → single batch RPC. Populates `.cache`. Getters read sync. Mutations call `reloadUserData()`.
- **All writes through `oracleRoute()`.** Encodes calldata → Redstone prices → multicall if needed → sends tx → reloads.
- **`contractWithGasBuffer` Proxy.** Auto gas estimate + 10% buffer. All calls async.

## Class Hierarchy (brief)

```
Calldata<T> (abstract) → CToken → BorrowableCToken
ERC20 → ERC4626
Market, ProtocolReader, OracleManager, PositionManager, Zapper, Redstone
FormatConverter (static), NativeToken, Api, OptimizerReader
IDexAgg → KyberSwap, Kuru, MultiDexAgg
```

Full APIs: Context → class-specific sections.

## Data Flow (brief)

```
setupChain(chain, provider, approval_protection, api_url)
  → ProtocolReader + OracleManager + Api.getRewards()
  → Market.getAll():
      1. reader.getAllMarketData(user) — 3 parallel RPC calls
      2. In parallel: Api.fetchNativeYields(), Merkl LEND opps, Merkl BORROW opps
      3. Construct Market/CToken instances, skip markets without deploy data
      4. Per-token: incentiveSupplyApy/incentiveBorrowApy from Merkl, nativeApy from API
  → return { markets, reader, dexAgg, global_milestone }
```

**Available chains (SDK `src/chains/index.ts`):** `'monad-mainnet'`, `'arb-sepolia'` (testnet only — no `'arb-mainnet'` yet). Chain string must match exactly.

V1 app wraps in `useSetupChainQuery()`. All hooks use `select`.

## Type System (brief)

| Type | Underlying | Meaning |
|---|---|---|
| `address` | `` `0x${string}` `` | Ethereum address |
| `TokenInput` | `Decimal` | Human-readable token amount |
| `USD` | `Decimal` | USD at human scale |
| `USD_WAD` | `bigint` | USD in WAD (1e18) |
| `Percentage` | `Decimal` | Fractional (0.75 = 75%) |

BPS: `Decimal(cache.value).div(10000)` → `Percentage`. Rate→APY: `.div(WAD).mul(SECONDS_PER_YEAR)`. Full constants: Context → #TYPE_SYSTEM_CONSTANTS

## Conversion Decision Tree

1. User types number → `TokenInput` (Decimal)
2. Sending to SDK method → pass Decimal directly
3. Sending to contract directly → `FormatConverter.decimalToBigInt(amount, decimals)`
4. Displaying → `FormatConverter.bigIntToDecimal(value, decimals)` or getter with `(true)`
5. USD display → `bigIntToUsd(wadValue)` or `token.getX(true)`
6. Cross-token → `token.convertTokenToToken(from, to, amount, true/false)`

## V1 Mutation Rules (brief)

**Every mutation** calls `resolveFreshToken(token)` before SDK writes (avoids stale provider from store) and wraps SDK calls in `safeWaitForTx()` (handles Monad `nonce: null` parsing error).

| Operation | Critical Rule |
|---|---|
| Borrow | Amount is Decimal, not bigint |
| Repay | ≥99.9% → `isPayingAll=true` → `token.repay(Decimal(0))` |
| Withdraw | Clamp to `token.maxRedemption()`. Returns `{ receipt, wasCapped, effectiveAmount }` |
| Deposit+Leverage | Approve to **position manager**, not cToken |
| Leverage Up | `getHighestPriority(leverageTypes)` → `approvePlugin` |
| Leverage Down | Resolve type via `getHighestPriority`, fall back to `'simple'` if vault/native-vault |
| Zap deposit | Three branches: native (no ERC20), zap (`approveZapAsset`), direct (`allowance`). `inputToken`: zapping → `zapToken.interface.address` |
| Collateral Add | `BorrowableCToken.postCollateral()` throws if `cache.userDebt > 0`. `isMax` → pass full asset balance |
| Collateral Remove | Passes `isMax` as second arg to `removeCollateral()` |

Invalidation: `invalidateUserStateQueries` → 13 query keys including `['setupchain']`, `['positionHealth']`, `['balance']`, `['zap-tokens','balance']`, `['user-debt']`, `['maxLeverage']`, 6× `['previewPositionHealth*']`, `['previewAssetImpact']`

**Protocol constants:** `MIN_DEPOSIT_USD = 10`, `MIN_BORROW_USD = 10.1`, `MARKET_COOLDOWN_LENGTH = 20 min`

## Transaction Flow Checklist

1. `resolveFreshToken(token)` — get current-provider CToken from `all_markets`
2. Allowance check → prompt approval → `await safeWaitForTx(approve(...), asset)`
3. Plugin approval (if zap/leverage) → `isPluginApproved()` → `approvePlugin()`
4. Call SDK method with Decimal amounts
5. `await safeWaitForTx(sdkCall, token)` → handles Monad nonce parsing error
6. Invalidate queries (13 keys via `invalidateUserStateQueries`)
7. Error handling — `txStatusForError(error)` marks BAD_DATA nonce errors as 'success'

## WGW (What Goes Wrong)

| Trigger | Wrong | Right | Conf |
|---|---|---|---|
| Display token amount | `Number()` or raw bigint | `FormatConverter.bigIntToDecimal(value, decimals)` | [H] |
| Pass amount to contract | Pass Decimal directly | `FormatConverter.decimalToBigInt(amount, decimals)` | [H] |
| Get asset price | `token.getPrice()` (share price) | `token.getPrice(true)` for asset, `(false)` for share | [H] |
| Write to contract | `this.contract.deposit(...)` | `getCallData()` → `oracleRoute()` | [H] |
| New query hook | Create new `setupChain()` call | `useSetupChainQuery({ select: ... })` | [H] |
| Rate to APY | Divide by WAD | Divide by WAD **then** × SECONDS_PER_YEAR | [H] |
| Utilization to percentage | Divide by WAD × SECONDS_PER_YEAR | Divide by WAD **only** — not annualized | [H] |
| Displaying deposit APY | `getApy()` (base only) | `getDepositApy(token, opportunities, apyOverrides)` for deposits. `getBorrowCost()` for borrow. These use Merkl data | [H] |
| Merkl `rewardsRecord.breakdowns[].value` | Treat as APR percentage points | Dollar value of daily rewards — use only for proportional splitting between reward tokens, never as a rate | [H] |
| Merkl `opportunity.apr` for display | Use directly — it's the API's APR | Can diverge from campaign APRs (uncapped, stale). All rates through `getOpportunityRate()` / `computeMerklRates()` in `shared/api/merkl.ts` | [H] |
| Importing SDK `getMerklDepositIncentives` / `getMerklBorrowIncentives` | Quick Merkl rate lookup | SDK reads `opp.apr` directly, bypassing shared rate logic. Use `getOpportunityRate` from `@/shared/api/merkl` or hooks (`useMerklNativeApy`, `useMerklBorrowApy`) | [H] |
| Store-held CToken used for writes after wallet connect | Assume provider is current | `resolveFreshToken(token)` before every SDK write. CToken.provider is set at construction — if stored during signerless setupChain, provider is read-only. Resolves from module-level `all_markets` | [H] |
| Leverage down type | Hardcode `'simple'` | Resolve via `getHighestPriority(leverageTypes)`, then fall back to `'simple'` only if vault/native-vault. SDK's `leverageDown` only handles `case 'simple'` but plugin approval must match the position's actual type | [H] |
| App mutation wrapping SDK calls | `await sdk.method().then(tx => tx.wait())` | `await safeWaitForTx(sdk.method(), token)`. Handles Monad `nonce: null` BAD_DATA error where tx IS broadcast. Direct `tx.wait()` throws, losing the receipt | [H] |
| Expected shares on zap/leverage | `virtualConvertToShares` everywhere | Vault types use `getVaultExpectedShares` two-hop. Exchange-rate drift → `BaseZapper__ExecutionError` | [M] |
| SDK `is*` check method | Assume returns boolean | Some threw on failure pre-v3.7. Verify in source | [M] |
| DEX rejection in leverage flow | Assume amounts correct | Verify `amountIn` denomination matches token being sold. `leverageDown` was passing borrow-token amount as collateral swap input | [M] |
| SDK write reloading cache | Assume `oracleRoute` awaited | Check for missing `await` before `fetch*` calls. Without it, reads pre-tx state | [M] |
| Get USD value of tokens | Manually multiply | `token.convertTokensToUsd(bigintAmount)` or `FormatConverter.bigIntTokensToUsd()` | [M] |
| User remaining borrow capacity | Calculate manually | `market.userRemainingCredit` (has 0.1% buffer) | [M] |
| Position health display | Raw bigint | `market.formatPositionHealth(bigint)` → Decimal (0=liquidation, null=∞) | [M] |
| Safe multisig `tx.wait()` hangs via WalletConnect | Add generic timeout to `safeWaitForTx` | Timeout can't distinguish "Safe hung" from "low gas, slow confirm." Detect wallet type before the call and branch behavior — don't timeout after | [M] |
| Determining if a token is actually borrowable | Check `token.isBorrowable` | Always true on all Curvance tokens — architectural, not a bug. Use `isBorrowableTokenWithDebtCap(token)` from `market/v2/utils` (checks `isBorrowable && getDebtCap(true) > 0`). Collateral-only token = `getDebtCap(true).eq(0)`. Bidirectional market = all tokens pass this check | [H] |
| Check if borrowable | `token.isBorrowable` then cast | Type is already `BorrowableCToken` if `isBorrowable` | [L] |
| getLiquidity(false) | Expect Decimal | Returns bigint → `toDecimal(token.getLiquidity(false), decimals)` | [L] |
| Deposit approval target | Approve to position manager | Approve to `token.address` (cToken). `depositAndLeverage` → position manager | [L] |
| Dashboard change rates | `getUserDepositsChange()` no arg | Must pass rate: `getUserDepositsChange('day')` | [L] |
| FormatConverter rounding | Standard rounding | Always truncates (ROUND_DOWN + floor) | [L] |
| CToken.getPrice() vs ERC20.getPrice() | Same behavior | CToken sync (bulk-loaded), ERC20 async (on-chain call) | [L] |
| Slippage scale | Same for dex and position manager | Dex: raw BPS. Position manager: WAD. SDK converts via `bpsToBpsWad()` | [L] |
| Approval types | One flow | Three: ERC20 allowance, plugin delegate, zap asset approval | [L] |
| `approval_protection` flag | SDK guards are safety net | Defaults `false`. App-side checks are the only gate | [L] |
| Consuming external API response as `BigInt()` | `BigInt(response.field)` — crashes on non-numeric | `safeBigInt()` from `validation.ts`. KyberSwap/Kuru responses are untrusted — `"null"`, `""`, floats all throw `SyntaxError` | [H] |
| Using DEX quote `to` address for on-chain execution | Trust API response (Kuru had no check) | `validateRouterAddress()` against expected. KyberSwap validates; Kuru didn't AND no on-chain `KuruChecker` — double gap | [H] |
| Casting external API string to `address` type | `value as address` — compile-time only | `validateAddress()` via ethers `getAddress()` at trust boundaries. The type alias has no runtime enforcement | [H] |
| Adding or modifying a `fetch()` call in the SDK | Bare `fetch()` — no timeout, no size limit | `fetchWithTimeout()` from `validation.ts`. 15s default, composes with caller `AbortSignal` | [M] |
| Adding or updating an npm dependency | Caret range (`^x.y.z`) | Exact pin for production deps. `@redstone-finance/sdk` controls axios via transitive deps. `.npmrc` `save-exact=true`. Always `npm ci` in CI | [H] |

## WWW (What Worked Well)

| Task type | Approach | Outcome |
|---|---|---|
| SDK BAD_DATA diagnosis | Trace from error to sentinel address — native MON arrives typed as `'simple'` bypassing native guards | Found `zapTypes.push('native-simple')` was missing in CToken.ts constructor. Fix applied — now pushes 'native-simple' for wrapped native tokens |
| Conversion confusion debugging | Follow the Conversion Decision Tree step by step | Eliminates guesswork about which format at which boundary |
| New query hook | `useSetupChainQuery({ select })` pattern — never separate `setupChain()` | Zero unnecessary RPC calls, cache consistency |
| SDK security audit | Map every `fetch()` → trace URL source, response validation, calldata flow to on-chain execution. Cross-ref on-chain calldata checkers against SDK-level assumptions | Found 5 unguarded trust boundaries in one pass. Kuru: no router validation + no on-chain checker = double gap. KyberSwap has both layers |

## WWK (What We Know)

| Principle | Evidence |
|---|---|
| SDK has two price scales that look similar but aren't — share price (`getPrice(false)`) vs asset price (`getPrice(true)`), BPS vs WAD slippage, sync CToken.getPrice vs async ERC20.getPrice. At every SDK boundary, verify which scale you're operating in | WGW: getPrice, slippage scale, FormatConverter rounding, rate vs utilization |
| Every SDK write must go through `oracleRoute()` and every `oracleRoute()` must be `await`ed before any cache read. Direct contract calls bypass Redstone price updates; missing `await` reads pre-tx state | WGW: write to contract, cache reload. Transaction Flow Checklist |
| The three approval types (ERC20 allowance, plugin delegate, zap asset) are independently checked and independently gated. `approval_protection` defaults false so app-side checks are the only gate. Each operation needs its specific approval sequence | WGW: approval types, approval_protection. V1 Mutation Rules |
| Merkl API has three rate-adjacent fields that look similar but aren't — `opportunity.apr` (total APR, possibly uncapped), `rewardsRecord.total` (can differ from apr), `rewardsRecord.breakdowns[].value` (dollar amounts, not APR). Every Merkl rate must flow through `getOpportunityRate()` / `computeMerklRates()` in `shared/api/merkl.ts` — never read these fields directly | WGW: breakdown.value as APR, opportunity.apr divergence, SDK getMerkl* bypass |
| Every app mutation has two infrastructure layers between store and SDK: `resolveFreshToken` (stale provider) and `safeWaitForTx` (Monad nonce parsing). These aren't optional wrappers — without them, mutations silently fail on wallet connect or throw on successful broadcasts. Documentation that shows bare `token.method()` or `tx.wait()` in mutation context is outdated | WGW: store-held CToken, mutation wrapping. Transaction Flow Checklist |
| The SDK has three external trust boundaries with different security postures: RPC (retried via proxy, deterministic errors filtered), Curvance API (URL-injectable, graceful degradation), DEX APIs (response calldata forwarded to on-chain — highest risk). Each needs its own validation layer (`validation.ts`). DEX calldata is validated on-chain by calldata checkers where they exist — but Kuru has no checker, only KyberSwap does. `@redstone-finance/sdk` pulls axios into the oracle price path via `requestDataPackages` | WGW: BigInt on API, router validation, address casting, fetch timeout, npm pinning. Chain config: `KyberSwapChecker` exists, no `KuruChecker` |

## Cross-References

| Topic | Skill |
|---|---|
| App codebase, module map, queries | Skill_CurvanceApp.md |
| UI conventions, color tokens | Skill_CurvanceUI.md |
| Display bug patterns, QA | Skill_CurvanceQA.md |
