---
name: curvance-sdk
description: "Use when reading, calling, extending, or debugging the Curvance contract-sdk (curvance npm package). Triggers: writing SDK functions, calling SDK methods from v1 app, understanding data flow from chain to UI, working with Market/CToken/BorrowableCToken classes, formatting on-chain values, building new query hooks, debugging SDK errors. Compose with Skill_CurvanceApp.md for app integration. If the task crosses into ProtocolReader contract work, deployment-candidate ABI, or bytecode sizing, also load Skill_AerariumSolidity.md."
---

# Curvance SDK (contract-sdk)

Rules for working with the SDK. Read before calling any SDK method, writing query hooks, or extending SDK classes.

If the task crosses from SDK code into `ProtocolReader` contract changes, deployment-candidate ABI decisions, or bytecode budgeting, also load `Skill_AerariumSolidity.md`.

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
| Fee policy / calldata checker | #SLIPPAGE_HANDLING, #DEX_AGGREGATORS_API |
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
| Collateral Remove | Use SDK `removeCollateralExact(amount)` / `removeMaxCollateral()`. Current app path still builds exact calldata capped to fresh `maxRedemption(..., breakdown).max_collateral` until the package rollout lands |

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
| Shipping a new ProtocolReader fast path | Assume the method exists in every deployment, fork, and stale test environment | Keep a compatibility path until `test:fork` is green against the deployed reader and all target environments are upgraded. Remove the fallback only after explicit environment audit or a full release cycle | [H] |
| Using `getMarketSummaries(...)`, `reloadUserSummary(...)`, or `reloadUserMarketSummaries(...)` | Treat token getters or token-derived market helpers as refreshed too | Summary refresh only makes market aggregates fresh. Any token-level or token-derived read needs a later full user refresh | [H] |
| Rate to APY | Divide by WAD | Divide by WAD **then** × SECONDS_PER_YEAR | [H] |
| Utilization to percentage | Divide by WAD × SECONDS_PER_YEAR | Divide by WAD **only** — not annualized | [H] |
| Displaying deposit APY | `getApy()` (base only) | `getDepositApy(token, opportunities, apyOverrides)` for deposits. `getBorrowCost()` for borrow. These use Merkl data | [H] |
| Merkl `rewardsRecord.breakdowns[].value` | Treat as APR percentage points | Dollar value of daily rewards — use only for proportional splitting between reward tokens, never as a rate | [H] |
| Merkl `opportunity.apr` for display | Use directly — it's the API's APR | Can diverge from campaign APRs (uncapped, stale). All rates through `getOpportunityRate()` / `computeMerklRates()` in `shared/api/merkl.ts` | [H] |
| Importing SDK `getMerklDepositIncentives` / `getMerklBorrowIncentives` | Quick Merkl rate lookup | SDK reads `opp.apr` directly, bypassing shared rate logic. Use `getOpportunityRate` from `@/shared/api/merkl` or hooks (`useMerklNativeApy`, `useMerklBorrowApy`) | [H] |
| Store-held CToken used for writes after wallet connect | Assume provider is current | `resolveFreshToken(token)` before every SDK write. CToken.provider is set at construction — if stored during signerless setupChain, provider is read-only. Resolves from module-level `all_markets` | [H] |
| Leverage down type | Hardcode `'simple'` | Resolve via `getHighestPriority(leverageTypes)`, then fall back to `'simple'` only if vault/native-vault. SDK's `leverageDown` only handles `case 'simple'` but plugin approval must match the position's actual type | [H] |
| App mutation wrapping SDK calls | `await sdk.method().then(tx => tx.wait())` — or insidious variant: `const txRes = await sdk.method(); safeWaitForTx(Promise.resolve(txRes), token)` which looks correct but `await` before `safeWaitForTx` means error escapes before hash extraction | `await safeWaitForTx(sdk.method(), token)` — pass the promise directly, never `await` then re-wrap. Handles Monad `nonce: null` BAD_DATA error where tx IS broadcast | [H] |
| Expected shares on zap/leverage | `virtualConvertToShares` without buffer | Vault types: `getVaultExpectedShares` two-hop. Simple leverage: `virtualConvertToShares(amount, LEVERAGE.SHARES_BUFFER_BPS)` — 2bps buffer for exchange rate drift since cache load | [M] |
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
| Slippage value in DEX aggregator `quoteAction` Swap struct | Pass raw BPS from `quote()` | Must be WAD for `_swapSafe`: `FormatConverter.bpsToBpsWad(slippage)`. Kuru was passing BPS — every leverage swap would revert | [H] |
| Approval types | One flow | Three: ERC20 allowance, plugin delegate, zap asset approval | [L] |
| `approval_protection` flag | SDK guards are safety net | Defaults `false`. App-side checks are the only gate | [L] |
| Consuming external API response as `BigInt()` | `BigInt(response.field)` — crashes on non-numeric | `safeBigInt()` from `validation.ts`. KyberSwap/Kuru responses are untrusted — `"null"`, `""`, floats all throw `SyntaxError` | [H] |
| Using DEX quote `to` address for on-chain execution | Trust API response (Kuru had no check) | `validateRouterAddress()` against expected. KyberSwap validates; Kuru didn't AND no on-chain `KuruChecker` — double gap | [H] |
| Casting external API string to `address` type | `value as address` — compile-time only | `validateAddress()` via ethers `getAddress()` at trust boundaries. The type alias has no runtime enforcement | [H] |
| Adding or modifying a `fetch()` call in the SDK | Bare `fetch()` — no timeout, no size limit | `fetchWithTimeout()` from `validation.ts`. 15s default, composes with caller `AbortSignal` | [M] |
| Adding or updating an npm dependency | Caret range (`^x.y.z`) | Exact pin for production deps. `@redstone-finance/sdk` controls axios via transitive deps. `.npmrc` `save-exact=true`. Always `npm ci` in CI | [H] |
| App integration looks green locally | Trust linked/patched `node_modules`, copied `dist/`, or source-only app validation as release proof | Validate the actual SDK artifact in the app (`npm pack` tarball or published version). Repo-green is not package-green | [H] |
| Refactoring `setupChain()` provider wiring or collapsing read paths | Treat type cleanup as independent from transport semantics | Diff primary/fallback ordering separately. Connected signers should keep wallet-primary reads unless the architecture change is explicit and re-validated | [H] |
| Changing retry classification or fallback behavior | Use one predicate for both "retry same provider" and "try a different provider" | Keep retry and failover as separate decisions. Contract/user errors stop both; unknown transport/endpoint errors may still fail over | [H] |
| Auditing whether an SDK change is live, equivalent, or safe in the app | Infer success from repo source, import hits, permissive types, or code-shape similarity | Trace a definitive endpoint: packaged artifact in the app, deployed method presence, or real consumer callsite. Surface signals are heuristics, not proof | [H] |
| Sizing a leverage operation (borrowAmount, collateralReduction) | Use `getPrice`, `market.userDebt` from setupChain cache | `_getLeverageSnapshot` → single ProtocolReader RPC refreshes prices + debt (with 2min interest projection) into cache before preview. Stale state causes `_swapSafe` to see false slippage because amounts are sized for old prices but valued at fresh Redstone | [H] |
| Setting repayAssets or expected output from DEX quote | `quote.out × 0.95` — hardcoded floor unrelated to user's slippage | `quote.min_out` — the DEX's own slippage-adjusted minimum, aligned with user's tolerance. Hardcoded floor was 5× looser than what the user asked for | [M] |
| Adding OR inheriting a buffer, tolerance, or safety margin to leverage | Add at point of concern without auditing compound effect, OR trust the inherited constant's comment about its cause | Check total undershoot across all buffers (maxLeverage cap + rounding margin + overhead). For inherited constants, trace to actual code path — comments rot when underlying cause is fixed (e.g., leverage-up buffer documented as share-rounding compensation actually compensated for cache staleness, eliminated when snapshot refresh was added). Centralize in named `LEVERAGE` constants — each buffer must have exactly one non-overlapping purpose | [M] |
| Engineer already has an empirical threshold for a bounded SDK tuning bug | Launch architecture-first or formula-first design work before checking the knob | Verify the simplest knob-first fix against the reported threshold first, then escalate only if the simple answer breaks another invariant | [M] |
| Refactoring a previously-required parameter into an optional one to "preserve historical behavior" | Default the optional param to the old hardcoded value (e.g., `feeBps = 10` fallback) | Default to `0` / `undefined` / no-op. The "historical behavior" was the bug being refactored away — preserving it via default re-introduces the inconsistency. Caught: Kuru `referrerFeeBps` defaulted to 10 during fee policy refactor, silently re-introducing the inconsistency the policy was meant to fix | [H] |
| Editing `leverageUp` and `leverageDown` together as mirror operations | Apply the same buffer/scaling logic to both | Asymmetric in two ways. (1) Rounding buffer: `LEVERAGE_UP_BUFFER_BPS` is flat (leverageUp only); deleverage uses `(L−1) × DELEVERAGE_OVERHEAD_BPS`. (2) Fee amplification: `(L−1) × feeBps` applies to BOTH paths via `contractSlippage` — `checkSlippage` measures equity-fraction loss on both. The rounding buffer is asymmetric; the fee term is symmetric. → Context_CurvanceSDK #SLIPPAGE_HANDLING | [H] |
| Designing or extending an SDK interface with a field unused by the current consumer but exists for future use | Pass `0n` / `null` / placeholder with comment "not consulted by current implementation" | Pass best available estimate even when current consumer ignores it. Dummy values silently break future consumers and the comment rots faster than the field. Caught: `inputAmount: 0n` in fee policy lookup — `flatFeePolicy` ignores it, but any future notional-tiered policy would silently misroute | [M] |
| Adding or modifying fee parameters on DEX swaps | Pass fee params to DEX API, assume on-chain accepts them | On-chain calldata checker (`KyberSwapChecker`) validates `feeReceivers` + `feeAmounts` in every swap. Current checker enforces exact `FEE_BPS = 4`, DAO-only receiver, `flags == REQUIRED_FLAGS (0x80)`. Fee changes require checker redeployment. Trace: `_swapUnsafe` → `cr.externalCalldataChecker(target)` → `checkCalldata()` → `_validateFeeConfig()` → `flags == REQUIRED_FLAGS`. Also: `protocolLeverageFee` must remain 0 while SDK fees active (inputAmount mismatch in `_validateInputsAndApplyFee`). SDK `CURVANCE_FEE_BPS` and checker `FEE_BPS` must match — change one without the other → all swaps revert. `CURVANCE_DAO_FEE_RECEIVER` must match `centralRegistry.daoAddress()` (checker reads dynamically per-swap). Both couplings fail closed but cause operational outage | [H] |
| Receiving calldata blob from DEX aggregator API | Trust the blob — embed in tx without decoding | Decode and validate fee-relevant fields (`flags`, `feeReceivers`, `feeAmounts`) before submitting tx. API misconfiguration (e.g., `flags=0` instead of `0x80`) surfaces as unexplained on-chain revert without client-side validation. `validateSwapCalldata()` in KyberSwap.ts. On decode failure: warn but don't block — on-chain checker is ground truth for structural issues | [H] |
| Setting `action.slippage` for a leverage swap with fees active | Pass raw user slippage — fee is a separate concern | `_swapSafe` measures `(valueIn - valueOut) / valueIn` where `valueIn` is the FULL input (pre-fee). KyberSwap deducts fee before swapping, so `_swapSafe` sees `feeBps` as "slippage." Expand: `action.slippage = bpsToBpsWad(slippage + feeBps)` after `quoteAction`. KyberSwap `minReturnAmount` still uses raw slippage (DEX-level protection stays tight). Applies to all 3 call sites: leverageUp, leverageDown, depositAndLeverage | [H] |
| Handling a non-200 response from a DEX aggregator API | `await response.json()` unconditionally to extract error details | Infrastructure errors (502, 504, CDN timeouts) return HTML, not JSON. `.json()` throws a parse error that masks the actual failure. Try/catch the parse, fall back to `${response.status} ${response.statusText}` | [M] |

## WWW (What Worked Well)

| Task type | Approach | Outcome |
|---|---|---|
| SDK BAD_DATA diagnosis | Trace from error to sentinel address — native MON arrives typed as `'simple'` bypassing native guards | Found `zapTypes.push('native-simple')` was missing in CToken.ts constructor. Fix applied — now pushes 'native-simple' for wrapped native tokens |
| Conversion confusion debugging | Follow the Conversion Decision Tree step by step | Eliminates guesswork about which format at which boundary |
| New query hook | `useSetupChainQuery({ select })` pattern — never separate `setupChain()` | Zero unnecessary RPC calls, cache consistency |
| SDK security audit | Map every `fetch()` → trace URL source, response validation, calldata flow to on-chain execution. Cross-ref on-chain calldata checkers against SDK-level assumptions | Found 5 unguarded trust boundaries in one pass. Kuru: no router validation + no on-chain checker = double gap. KyberSwap has both layers |
| Leverage stale-state fix | Single `getLeverageSnapshot` ProtocolReader call wrapping `hypotheticalLiquidityOf` + individual prices + projected debt. Updates cache before preview runs | 1 RPC replaces 3+ calls. Eliminated all stale-state issues, enabled removal of 4 redundant buffers, simplified full deleverage from 20 lines to 5 |
| Cross-layer slippage diagnosis | Traced app → SDK → on-chain for each value, verified stale vs fresh at each boundary. KyberSwap nonsense USD values were a red herring (same root cause: volatility, but unrelated code path) | Found stale cache root cause in one pass. Symptom correlation ≠ causation — KyberSwap USD values aren't consumed anywhere |
| SDK release validation | Keep `test:transport` (deterministic transport policy) separate from `test:fork` (Anvil/fork integration) and require both before publish confidence | Transport regressions and deployment/runtime mismatches surfaced in the correct layer instead of hiding behind one coarse test run |
| SDK/app equivalence audit | Trace the actual packaged artifact and real consumer endpoint before calling a fix live | Prevented repo-green and surface-signal heuristics from standing in for release proof |
| Multi-stage feature build with explicit sign-off gates | Stage 1 = API shape with its own gate. Plumbing stages batched together. Tests stage at end. Each gate lets user redirect before sunk cost | Stage 1 sign-off on fee policy caught two API design issues (wrappedNative resolution, NO_FEE_POLICY receiver) before any plumbing was written. Saved a stage worth of rework |
| End-of-build self-audit before final packaging | Walk every changed file, list potential issues as numbered items, present to user for review (don't fix yet) | Caught two latent footguns in fee policy work (`inputAmount: 0n` lookup, `NO_FEE_POLICY` mutability) that wouldn't have surfaced in normal review |
| Fee integration debugging | Read the on-chain calldata checker contract FIRST, before debugging SDK-side fee plumbing | Found KyberSwapChecker `feeReceivers.length != 0` rejection in 10 minutes. Without this, would have debugged SDK fee params for hours — the SDK was correct, the on-chain gate was the blocker |

## WWK (What We Know)

| Principle | Evidence |
|---|---|
| SDK has two price scales that look similar but aren't — share price (`getPrice(false)`) vs asset price (`getPrice(true)`), BPS vs WAD slippage, sync CToken.getPrice vs async ERC20.getPrice. At every SDK boundary, verify which scale you're operating in | WGW: getPrice, slippage scale, FormatConverter rounding, rate vs utilization |
| Every SDK write must go through `oracleRoute()` and every `oracleRoute()` must be `await`ed before any cache read. Direct contract calls bypass Redstone price updates; missing `await` reads pre-tx state | WGW: write to contract, cache reload. Transaction Flow Checklist |
| The three approval types (ERC20 allowance, plugin delegate, zap asset) are independently checked and independently gated. `approval_protection` defaults false so app-side checks are the only gate. Each operation needs its specific approval sequence | WGW: approval types, approval_protection. V1 Mutation Rules |
| Merkl API has three rate-adjacent fields that look similar but aren't — `opportunity.apr` (total APR, possibly uncapped), `rewardsRecord.total` (can differ from apr), `rewardsRecord.breakdowns[].value` (dollar amounts, not APR). Every Merkl rate must flow through `getOpportunityRate()` / `computeMerklRates()` in `shared/api/merkl.ts` — never read these fields directly | WGW: breakdown.value as APR, opportunity.apr divergence, SDK getMerkl* bypass |
| Every app mutation has three infrastructure layers between store and SDK: `resolveFreshToken` (stale provider), `safeWaitForTx` (Monad nonce parsing), and component error dispatching (`catch`/`onError` → `TransactionFailure`). The third layer can override mutation-layer BAD_DATA recovery if it fires first — `classifyMutationError()` guards it. These aren't optional wrappers — without them, mutations silently fail on wallet connect, throw on successful broadcasts, or show false failure screens. Documentation that shows bare `token.method()` or `tx.wait()` in mutation context is outdated | WGW: store-held CToken, mutation wrapping, Promise.resolve variant. Transaction Flow Checklist |
| The SDK has three external trust boundaries with different security postures: RPC (retried via proxy, deterministic errors filtered), Curvance API (URL-injectable, graceful degradation), DEX APIs (response calldata forwarded to on-chain — highest risk). Each needs its own validation layer (`validation.ts`). DEX calldata is validated on-chain by calldata checkers where they exist — but Kuru has no checker, only KyberSwap does. `@redstone-finance/sdk` pulls axios into the oracle price path via `requestDataPackages` | WGW: BigInt on API, router validation, address casting, fetch timeout, npm pinning. Chain config: `KyberSwapChecker` exists, no `KuruChecker` |
| Every SDK operation that sizes a trade from cached state (prices, debt, collateral, exchange rates) is vulnerable when the contract validates with fresh state (Redstone updates in oracleRoute multicall). The fix is always: refresh the specific state the preview consumes before computing, composed into as few RPC calls as possible. `getLeverageSnapshot` is the template — compose ProtocolReader view methods to return everything in one call. Centralize tunable buffers in named constants (`LEVERAGE` block) so compound effects are auditable | WGW: leverage sizing from stale cache, buffer accumulation, minRepay floor. WWW: getLeverageSnapshot architecture. Three instances of same root cause (stale prices, stale debt, stale exchange rate) found in one leverage flow |
| For SDK release and audit work, endpoint traces beat surface signals. Repo source, import presence, permissive types, and code-shape similarity only show possibility; packaged artifacts, deployed methods, and real consumer callsites show reality | WGW: app integration green locally, SDK change inferred live from surface signals. WWW: SDK release validation, SDK/app equivalence audit |
| Read-path resiliency is two-layered: connected wallets should read through the wallet provider first, and retry/failover should still try healthy alternate RPCs for non-contract failures even when same-provider retry is skipped | WGW: `setupChain()` provider wiring, retry/fallback classification. Current SDK source in `setup.ts` and `retry-provider.ts` |

## Cross-References

| Topic | Skill |
|---|---|
| App codebase, module map, queries | Skill_CurvanceApp.md |
