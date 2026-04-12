---
name: curvance-qa
description: "Use when triaging display bugs, reviewing PRs against a bug tracker, running browser QA on app.curvance.com, or classifying symptoms by owning layer (app vs SDK vs contract). Triggers: 'bug hunt', 'QA session', 'review this PR', 'trace this display issue', 'check the dashboard', browser exploration for issues, any session focused on finding or fixing frontend bugs. Compose with Skill_CurvanceApp.md for codebase navigation and Skill_CurvanceSDK.md for SDK method behavior. Do NOT use for feature development, UI design, or Solidity/protocol work."
---

# Curvance QA

Rules for finding, tracing, and classifying frontend bugs. Read before any QA session, PR review, or display bug investigation.

## Routing Table

| Task type | Context sections to read |
|---|---|
| Tracing a display bug | Context_CurvanceApp.md → #CORRECT_PATTERN_REGISTRY, #DISPLAY_BUG_PATTERNS |
| Browser QA session | Context_CurvanceApp.md → #QA_PAGE_CHECKLIST |
| PR review | Context_CurvanceApp.md → #PR_REVIEW_WORKFLOW |
| Loading state investigation | Context_CurvanceApp.md → #SENTINEL_VALUES |
| Checking a specific value path | Context_CurvanceApp.md → #CORRECT_PATTERN_REGISTRY |

## Diagnostic Trace (the core method)

Every display bug has a root in one layer. Trace backward from symptom until the value diverges from expected:

```
UI component (renders wrong value)
  → query hook (transforms SDK return)
    → SDK method (reads from .cache or RPC)
      → .cache (bulk-loaded at setup)
        → ProtocolReader (on-chain data)
```

**Fix lives at the layer where value diverges.** Don't fix downstream of the root — the symptom will resurface differently. When you find the divergent layer, grep for the same operation done correctly elsewhere in the codebase. The correct file is both proof of the bug and the fix template.

## Bug Ownership

| Divergence layer | Owner | Example |
|---|---|---|
| Component renders SDK return incorrectly | App bug | `getUserCollateral(false)` displayed as assets (shares ≠ assets) |
| Query hook transforms value wrong | App bug | `current.plus(preview.newDebt)` when `newDebt` is already total |
| SDK method returns wrong value from correct cache | SDK bug | `expectedShares: BigInt(quote.min_out)` — assets as shares |
| SDK method reads wrong cache field | SDK bug | Input token decimals used for output amount |
| Cache populated wrong by ProtocolReader | Contract bug | (rare — verify with on-chain call) |

**When both layers contribute:** Track as separate bugs per layer. Each gets its own fix.

## Six Display Bug Patterns (quick reference)

Check these first — they cover ~80% of display bugs. Full descriptions with detection greps: Context → #DISPLAY_BUG_PATTERNS

| # | Pattern | Signature |
|---|---|---|
| 1 | Share/asset confusion | Value less than expected by a factor of `exchangeRate` |
| 2 | Total vs delta | Value is `current + expected` instead of just `expected` |
| 3 | Loading defaults | Value flashes wrong for 1-5s then resolves |
| 4 | Stale cache vs live query | Two displays of same data differ by accrued interest |
| 5 | Null propagation (external API) | Crash on `.toString()` or property access on null |
| 6 | AbortError from signal cancellation | Console flooded with AbortError on every HMR/navigation |

## WGW (What Goes Wrong)

| Trigger | Wrong | Right | Conf |
|---|---|---|---|
| Reviewing a loading-state value | Assume only final resolved value matters | Check default/fallback — `?? Decimal(0)` or sentinels are user-panic triggers → #SENTINEL_VALUES | [H] |
| `getUserCollateral(false)` in display code | Assume returns asset-denominated | Returns shares — multiply by exchangeRate for assets, or `(true)` for USD | [H] |
| `current.plus(preview.something)` | Assume preview returns delta | Check SDK source — preview methods often return totals. `current + total` double-counts | [H] |
| Starting to trace a display bug | Jump into component render logic | Trace backward: component → hook → SDK → cache. Find divergent layer first | [H] |
| Verifying a display value | Eyeball — "looks right" | Trace actual path through each hop against source, not expectation | [H] |
| `|| []` passed to useReactTable | Seems harmless fallback | New `[]` ref every render → TanStack infinite loop. Module-level `const EMPTY: T[] = []` | [H] |
| SDK method in Zustand selector | Selector returns computed value — should be fine | SDK methods + `.find()` defeat equality → re-render cascades. Extract primitives, compute in useMemo | [H] |
| Inline `Decimal(1)` or `Decimal(0)` as fallback | Stable-looking fallback | New Decimal every render invalidates memo. Module-level constants | [H] |
| Gating UI on `isPending` for a query with its own `enabled` flag | Expect `isPending: false` when disabled | RQ v5 disabled: `isPending: true, fetchStatus: 'idle'`. Use `isLoading` instead (= `isPending && fetchStatus !== 'idle'`). Hit S11, S12, S13 | [H] |
| Switching `isPending` → `isLoading` on setupChainQuery derivatives | Assume `isLoading` is universally correct | `useSetupChainQuery` derivatives change queryKey on signer transition + `keepPrevious: false` → `isLoading: false` while data is `undefined` → component renders with no data. `isPending` is correct here. `isLoading` only safe on queries with independent `enabled` | [H] |
| Conditional render on a numeric value (`healthPercentage ?`) | Truthy check — works for most values | 0 is falsy. Health of 0% (at liquidation) renders as ∞. Use `!= null` to distinguish "no data" from "value is zero" | [M] |
| PR changes a file not in any tracked bug | Accept as cleanup | Flag as untracked — could be undocumented fix or new issue | [M] |
| Symptom matches multiple known bugs | Investigate as new standalone | Check convergence — defer and retest after component fixes merge | [M] |
| QA on Vercel preview URL | Assume matches production | Use `app.curvance.com` — preview branches may differ | [M] |
| External API fails (KyberSwap 4000) | Assume SDK handles errors | Check null guards between response and first property access | [M] |
| Comparing current vs preview APY/rate | Preview is complete | `previewAssetImpact` raw rate doesn't include Merkl subsidies — subtract same offset | [M] |
| Catch block in queryFn passing `signal` | `console.error` without filtering | Filter AbortError: `if (error.name === 'AbortError') throw error;` Re-throw for RQ silent handling | [M] |
| `query.data` that can be `null` (e.g., ∞ health) | `data?.toNumber()` — collapses null to undefined | Check `=== null` first. `null` = ∞, `undefined` = no data yet. See `deposit-content.tsx` nextHealthFactor | [M] |
| Repay preview with max amount | Show `currentDebt - truncatedAmount` (leaves dust) | Clamp to 0 when ≥ 99.9% of debt — matches mutation full-repay threshold | [M] |
| Renaming a design token | Assume old name = new semantic meaning | Audit usage context. `content-muted` had 209 readable labels → needed `content-secondary`, not muted | [M] |
| sed to migrate Tailwind classes | Replace base class only | Cover ALL prefix variants: `hover:`, `group-hover:`, `dark:`, `data-[*]:`, `focus:`, `disabled:` | [M] |
| Declaring token migration "complete" | Trust class-level sweep | Final hardcode sweep: inline `style={{ color }}`, `bg-[#hex]`, SVG `fill`/`stroke`, HSL. S4 found ~85 | [M] |
| Outputting fixed files during multi-branch QA | Edit one branch, output as patches for another | Always patch against target branch's uploaded files. Different branches = different base | [M] |
| Page freezes on navigation | Assume crash is destination page | Check always-mounted shell components first (Navigation, Statusbar). Binary-split disable | [M] |
| Page freezes on row click | Assume click handler or expanded content | Crash may be unrelated always-mounted component re-rendering on store change | [M] |
| Infinite loop with normal render counts | Assume React re-render cycle | May be sub-React: ResizeObserver ↔ layout, Zustand selector sync. Use dep-change tracker | [M] |
| Tooltip/wrapper flickers on data refetch | Assume CSS issue | Wrapper defined inside useCallback — deps change → new component type → unmount/remount subtree | [L] |
| User reports wallet/infra error, scoping a fix | Design fix architecture from the error description | Capture actual error shape first (DevTools output, error object). A 503 rejection, hanging promise, and returned safeTxHash need completely different fix architectures | [H] |
| Merkl breakdown values in tooltip don't match Merkl page | Assume API field is APR and use directly | Verify field semantics against Merkl campaign page. `breakdown.value` is dollar amounts; `opportunity.apr` is the only APR field. All rates through `shared/api/merkl.ts` | [H] |
| Delivering files sourced from a staging zip | Treat zip as current codebase | Zip may predate repo — diff delivered files against current repo before shipping. Stale zip silently reverts already-applied fixes (e.g., ThemeProvider dedup already merged but zip had old version) | [H] |
| Tightening on-chain validation (calldata checker, parameter checks) | Assume existing test fixtures still pass | Pre-fetched calldata, hardcoded params, and fork-pinned test data encode the OLD validation assumptions. Tests compile fine — failure is at runtime when the stricter check rejects old-format data. After any validation change: inventory all test fixtures that pass through the changed path, re-capture or update with params matching the new rules | [M] |
| Reviewing a checker/validator that enforces a numeric parameter value | Validate the value only — `feeAmounts[0] == 4` looks complete | Also validate the flag/mode that controls how the value is interpreted. `4` means 4 BPS with `_FEE_IN_BPS`, 4 wei without it. Same number, completely different semantics | [H] |
| Enabling a previously-disabled code path in externally-audited code | Focus on the changed parameter (e.g., `feeReceivers.length` going from 0 to 1) | Re-audit all adjacent fields that interact with the new path. The audit validated a different execution path — flags, fee denomination mode, token routing, and permit handling all need review when the fee path activates | [H] |

## WWW (What Worked Well)

| Task type | Approach | Outcome |
|---|---|---|
| Infinite loop diagnosis (S6) | Binary-split shell components + dep-change tracker (useRef + Object.is per dep) | Found RewardsDrawer `|| []` root cause in one session. 10 fixes across 8 files |
| Display bug triage | Grep for operation done correctly elsewhere → use as fix template | Correct file = proof + pattern. Faster than understanding the bug from scratch |
| Multi-symptom QA | Check convergence with known bugs before investigating new | Avoided 3+ re-investigations of symptoms explained by existing tracked bugs |
| RQ disabled query bugs | Standard guard: `isLoading` instead of `isPending` everywhere | Eliminated class of bugs across 3 sessions (S11-S13) |
| Refresh race diagnosis | Compared useAccount() vs useSigner() resolution timing, mapped wagmi status progression (reconnecting → connecting → connected) | Identified signer gap window — useAccount resolves from persisted state, useSigner needs connectorClient → ethers provider → JsonRpcSigner. Gap causes query disable + ConnectWallet flash |
| Breakpoint testing without target device | Zoom on 1920px monitor: 150% = 1280px (MacBook 13"), 175% = 1097px, 190% = 1010px. Matches CSS viewport exactly. Test at boundary ±1% to verify threshold | Quick visual QA for any breakpoint change without needing physical devices |
| Merkl rate display bug | Screenshots → Merkl campaign page comparison → traced `opportunity.apr` vs `breakdown.value` field semantics | Found dollar-amounts-as-APR root cause in one trace. Three iterations were from wrong unit assumption, not wrong method |
| Console extension triage | Filter by script filename before investigating: `evmAsk.js`, `provider-bridge.js`, `injected.js`, `share-modal.js`, `inpage.js`, `lockdown-install.js` = wallet extension code, not ours. "Cannot redefine property: ethereum" = extensions fighting over `window.ethereum` | Avoided investigating MetaMask/Backpack/Pelagus/Rabby provider conflicts as app bugs. Focus on errors from app bundles only |
| Calldata checker security review | Field-by-field struct audit: decode the calldata struct, trace each field to router consumption, classify as validated/unvalidated/inert. Start from the struct definition, not the checker code | Found 5 unvalidated fields (`approveTarget`, `srcReceivers`, `srcAmounts`, `flags`, `minReturnAmount`) in one systematic pass. Closed all 5 |

## WWK (What We Know)

| Principle | Evidence |
|---|---|
| Every display value has a layer owner (component → hook → SDK → cache → contract). Fix at the divergent layer — downstream fixes resurface differently. Correct implementations elsewhere in the codebase are both proof of the bug and the fix template | Diagnostic Trace method, WWW: grep-for-correct pattern |
| Loading defaults that alarm users ($0 debt, 0% health) are real bugs even though they resolve — the 1-5 second user experience matters. The fix is always cached SDK values as fallback, never zero/null | WGW: loading-state value. Sentinel table in Context |
| Reference equality drives React renders — any new-object-per-render (`|| []`, `new Decimal()`, SDK methods in selectors, bare object returns) cascades into loops. The fix is always stable references (module-level constants, primitive extraction, useMemo) | WGW: || [], SDK-in-selector, Decimal, tooltip wrapper. Also: Skill_CurvanceApp WWK |
| When multiple tracked bugs affect the same flow, the symptom is convergent — investigate after fixes merge, not before. Signals: symptom only in multi-buggy paths, wrong value ratio matches known error factor | WGW: convergence. WWW: multi-symptom triage |
| `isPending` vs `isLoading` correctness depends on query architecture — not interchangeable. `isPending` is correct for setupChainQuery derivatives (key transitions, `keepPrevious: false`). `isLoading` is correct for independently-enabled queries (disabled = show empty state). The choice is about what "no data" means to the consumer | WGW: isPending guard (S11-13), setupChainQuery isPending revert (this session). WWW: refresh race diagnosis |

## Cross-References

| Topic | Skill |
|---|---|
| Codebase navigation, module structure | Skill_CurvanceApp.md |
| SDK method signatures, WGW for SDK calls | Skill_CurvanceSDK.md |
| Reference equality patterns (codebase-specific) | Skill_CurvanceApp.md WGW + WWK |
