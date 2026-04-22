---
name: curvance-app
description: "Use when working on or navigating the curvance-app codebase (curvance-web/app, production frontend). Triggers: adding pages/routes, creating modules, modifying navigation, importing components, deploying to Vercel, understanding module boundaries, any file creation/editing in the repo. Compose with Skill_CurvanceUI.md for UI/design rules and Skill_CurvanceSDK.md for SDK method behavior. Do NOT use for Solidity/protocol work."
---

# Curvance App (curvance-web/app)

Rules and conventions for working in `curvance-web/app` (branch: `dev`). Read before any file creation or modification.

## Routing Table

| Task type | Context sections to read |
|---|---|
| Creating a new page/route | #DIRECTORY_STRUCTURE |
| Adding/editing components | Context_CurvanceUI.md → #ESTABLISHED_COMPONENTS; Context_CurvanceApp.md → #V2_PRIMITIVES_BARREL |
| Understanding query hooks / SDK shape | #QUERY_INVENTORY, #SDK_OBJECT_MODEL |
| App component APIs | #APP_COMPONENT_APIS |
| Store/state work | #STATE_MANAGEMENT |
| Table columns or data display | #TABLE_COLUMNS |
| Transaction/mutation flow | #TRANSACTION_FLOWS |
| Market detail page work | #MARKET_DETAIL, #MARKET_DETAIL_PRIMITIVES, #MARKET_DETAIL_DESIGN |
| Dashboard page work | #DASHBOARD_ARCHITECTURE, #DASHBOARD_PAGE_IMPORTS |
| Explore page work | #EXPLORE_PAGE, #EXPLORE_PAGE_BEHAVIOR |
| Chain/network handling | #CHAIN_CONFIGURATION |
| Wallet/session or statusbar/network parity | #STATE_MANAGEMENT, #CHAIN_CONFIGURATION, #SOURCE_AUDIT_TESTS |
| RPC transport / fallback config | #RPC_TRANSPORT |
| Query architecture (dual hook pattern) | Inline: `src/modules/market/v2/queries/index.ts` — useMarketDataQuery (public) vs useUserDataQuery (wallet-gated) |
| Merkl rewards integration | #MERKL_INTEGRATION |
| Merkl rate computation / APY display | Skill_CurvanceSDK.md → Merkl WWK + WGW entries |
| Liquidation logic | #LIQUIDATION_CALCULATIONS |
| Utility function reference | #UTILITY_FUNCTIONS |
| Sidebar reuse across pages | #SIDEBAR_REUSE |
| Dead code audit | #DEAD_CODE |
| Security / CSP / headers | #CSP_ARCHITECTURE |
| Loading/empty states | #LOADING_STATES |
| Large refactor review / source-audit regression tests | #PR_REVIEW_WORKFLOW, #SOURCE_AUDIT_TESTS |
| Tech stack / version lookup | #TECHNOLOGY_STACK |
| Color tokens | Context_CurvanceUI.md → #COLOR_TOKENS |

## Hard Constraints

- **Static export** (production only). `output: 'export'` conditional on `NODE_ENV`. No SSR. Dynamic routes fail silently — use query params + `useSearchParams`. `headers()`, `rewrites()`, `redirects()` in next.config.ts are documentation-only — they appear in build output but don't execute. Security headers served by Amplify `customHttp.yml` (repo root). Both files must stay in sync. Tailwind v4 with `@config` compat. Image optimization disabled — pre-optimize manually. Tailwind v4 dropped `cursor: pointer` — global restore in `globals.scss`.
- **yarn only.** npm → wrong rainbowkit, bun → corrupts package.json. `yarn install && yarn build`.
- **Node 18+.** Next.js 14.2.x requirement.
- **Vercel: gas-limit account only.** Other accounts show ❌ but code may be correct.
- **Windows:** Folders with `!` break webpack.

## Module Architecture

| Module | Role | When |
|---|---|---|
| `modules/market` | Transaction layer — deposit, borrow, repay, withdraw, leverage, approvals, modals | Sidebar actions, CTA wiring |
| `modules/market/v2` | Explore + data — SDK queries, tables, stats, search, stores | Page layouts, SDK data |
| `modules/dashboard` | Dashboard presentation — overview, cards, stores, providers | Dashboard UI |
| `modules/dashboard/v2` | Dashboard data — queries, tables, leverage mutations | Dashboard data layer |
| `modules/app` | Shared foundation — Button, Badge, Typography, InputField, Leverage, hooks, stores | Cross-module imports |
| `modules/bytes` | Bytes game — 63 files, ~10.1k lines | Cross-ref: Skill_CurvanceBytes |
| `modules/earn` | Vault/earn | Vault UI |

New pages → `market/v2` or new module. Shared utils → `shared/`. Full module list: Context → #DIRECTORY_STRUCTURE

## SDK Integration (brief)

Root query `useSetupChainQuery` → `setupChain()`. Two semantic wrappers: `useMarketDataQuery` (public, always fires, `keepPreviousData`) for explore/TVL/stats, and `useUserDataQuery` (gates on `isConnected && hasSigner`, no `keepPreviousData`) for dashboard/positions. All other queries derive via `select`. SDK returns `Decimal` (not BigNumber). Full SDK rules: Skill_CurvanceSDK.md

**Merkl rates:** All Merkl APR values flow through `getOpportunityRate()` / `computeMerklRates()` in `shared/api/merkl.ts`. Never import `getMerklDepositIncentives` / `getMerklBorrowIncentives` from `curvance` SDK — they bypass shared rate logic.

**Query provider:** Global `retry: 0`, `staleTime: 40s`, `refetchOnWindowFocus: false`. AbortError + CALL_EXCEPTION + SIGNATURE_UNAVAILABLE filtered. HTTP queries can opt into `retry: 1`. Exception: `setupChain` gets `retry: 2` with exponential backoff. Transport layer adds `retryCount: 3` on all RPC calls — see #RPC_TRANSPORT.

## Transaction Flow (4-step)

1. Plugin approval → 2. Asset approval (unlimited vs 1/1) → 3. Execute SDK method → 4. Cleanup (`invalidateUserStateQueries`, transaction store, tasks)

Tracking: `createTransactionsStore(address)` in `transactions_{address}` localStorage. Cooldowns: `market.cooldown` Date.

## Health Factor

Two systems: **3-tier** (`getStatus()`: <5 Danger, 5-20 Caution, >20 Healthy) and **4-tier** (`getHealthTier()`: ≤5 critical, ≤20 warning, ≤50 caution, >50 healthy). Raw `market.positionHealth` Decimal. Display: `>999%` → `>999%`, null → `∞`. Non-linear viz via `getStepPercent`.

## Adding a Route

`app/(core)/feature/page.tsx` + `'use client'` + `useSearchParams`. Add to `navigation-data.ts` (mobile) and `statusbar.tsx` (desktop). Active routes: `/`, `/dashboard`, `/market?address=`, `/vault?address=`, `/bytes`, `/bytes/fortune`, `/bridge`, `/leaderboard`, `/leaderboard/referrals`.

## Verified Imports

| Import | Path |
|---|---|
| `Icon` | `import Icon from '@/ui/icon-selector/icon-selector'` (default) |
| `cn()` | `import { cn } from '@/shared/functions'` |
| `Button` | `import { Button } from '@/modules/app'` |
| `Tooltip` | `import { Tooltip } from '@/ui/v2-primitives'` (named) |
| `Dropdown` | `import { Dropdown } from '@/ui/dropdown/dropdown'` |
| `ContextTooltip` | `import { ContextTooltip, TipRow, TipDivider } from '@/ui/v2-primitives'` |
| `DragSlider` | `import { DragSlider } from '@/ui/v2-primitives'` |
| `formatSidebarUSD` | `import { formatSidebarUSD, formatSidebarToken, inputFontSize } from '@/shared/v2-formatters'` |
| Chain configs | `import { SUPPORTED_CHAINS } from '@/blockchain/logic/concepts/chain-configs'` |

## Tailwind Token System

One system only. System A (`text-text-primary`) and System B (`new-*`) fully deleted. Theme via `next-themes`. Full token values: Context_CurvanceUI → #COLOR_TOKENS.

**Inline styles** for chart/tooltip: `var(--content-secondary)`, `var(--color-supply)`, `var(--chart-axis)`, `var(--dotted-underline)`. `color-mix()` for tinted backgrounds.

**Custom breakpoints:** xs, newsm, xsm, base. Non-standard Tailwind config.

## WGW (What Goes Wrong)

| Trigger | Wrong | Right | Conf |
|---|---|---|---|
| New page | `[param]/page.tsx` dynamic route | `app/(core)/feature/page.tsx` + `useSearchParams` | [H] |
| First build | npm/bun install | `yarn install && yarn build` | [H] |
| Deploy to Vercel | Push from non-gas-limit | Push from gas-limit account | [H] |
| `|| []` to hook (useReactTable, useMemo) | Seems harmless | New ref every render → infinite loop. Module-level `const EMPTY: T[] = []` | [H] |
| SDK method in Zustand selector | Computed value — should be fine | SDK + `.find()` defeat equality → cascades. Extract primitives, compute in useMemo | [H] |
| Inline `new Decimal()` in deps | Stable-looking fallback | New object invalidates memo. Module-level constants | [H] |
| Zustand selector creates new values | `useStore(s => new Decimal(s.x))` | Return existing refs/primitives. Compute in useMemo outside selector | [H] |
| `useReactTable` in deps/callbacks | `[table, ...]` or inline arrow | `useStableTable(table)` Proxy. Stable ref for deps, raw for JSX | [H] |
| Delivering multi-file changes | Bash/sed scripts | Zip with real `src/` structure. No scripts (Git Bash breaks) | [H] |
| Conditional return before hooks | Place return before hooks | All returns AFTER all hooks | [H] |
| Running sed to rename classes | Target base class only | Cover ALL prefix variants + `.scss`/`.css` + `var(--old)` in inline/SVG | [H] |
| Styling component during dark-mode dev | Hardcoded `rgba(255,255,255,N)` | Semantic tokens. S4+S8 purged 100+ values → Context_CurvanceUI #COLOR_TOKENS | [H] |
| Adding tooltip to stat label | `InfoIcon` (ⓘ circle) | `ContextTooltip` with dotted underline. InfoIcon deprecated for labels | [H] |
| Plain function in useEffect deps | Include it — linter says to | Recreates every render → infinite effect. `useCallback`, or `[]` + `cancelledRef` | [H] |
| useMeasure + framer-motion `layout` nested | Both animate | ResizeObserver ↔ layout feedback loop. Remove `layout` from inner element | [M] |
| Passing `className` to Tooltip | Expect it styles popup | Styles trigger `<span>`. Popup styled inline in source | [M] |
| ReactNode to Tooltip content | Assume padding handled | String auto-padded, JSX flush. Add `padding: '10px 14px'` wrapper | [M] |
| Custom hook returning bare object | `{ state, callbacks }` — callbacks stable | New object ref defeats consumer memos. Wrap return in useMemo | [M] |
| React Query mutation in useMemo deps | "It's from a hook" | New ref on every status transition. Ref `.mutate` for handlers, extract primitives | [M] |
| `select` closure reading `account.address` | Gate on address — truthy when connected | Updates before `useSigner().address`. Gate on `signer?.address` to match query key | [M] |
| `keepPreviousData` on user-address query | Keeps data during refetch | Bridges key transitions — null-signer data serves for connected wallet. `keepPrevious: false` on user queries | [M] |
| Showing ConnectWallet based on `!account.address` | Seems like correct wallet check | During wagmi reconnect, `address` is `undefined` but wallet IS persisted. Three tiers: `isDisconnected` for UI rendering (lenient — false during connecting), `isConnected` for query gating (strict — only true when handshake complete), `isConnected && hasSigner` for user data (strictest — signer resolved). Wrong tier = flash or address(0) leak | [H] |
| Wallet/session or statusbar/network shell logic | Read raw `useAccount()` / `useChainId()` in shell, notification, or task consumers | Use the shared seams: `useWalletSessionState` for signer-gated surfaces, `useConnectionUiState` for UI-only shells, and `useResolvedAccountAddress` / `useResolvedAccountChainId` for E2E-aware account or chain state | [H] |
| Disabling a query via `enabled: false` to hide data | Assume disabled query won't surface data | `enabled` controls fetching, not cache access. If the current key has a cache entry (e.g., signerless data from explore page), React Query returns it to all consumers regardless of `enabled`. UI must independently gate on readiness (`walletReady = isConnected && hasSigner`) | [H] |
| User-facing query can keep cached data or catches fetch failures | Fall through to ready/zero/healthy/empty UI because some data exists | Decide stale-ready behavior per surface. If the data is not safe to present as fresh truth, render unavailable/error explicitly instead of silent fallback | [H] |
| Migrating a page to v2/setupChain queries | Move visible consumers but leave provider/store side-effects on legacy keys | UI migration is incomplete until background sync, notification counts, and other side-effects move too. During rollout, route those effects through shared helpers that can read both current and legacy roots | [H] |
| Changing a `useMediaQuery` breakpoint value | Change JS query only | Must also change corresponding Tailwind CSS classes (`xl:grid-cols`, `hidden xl:block`, `block xl:hidden`) in same file, same commit. JS controls component logic; CSS controls layout visibility. Desync shows desktop table with no sidebar | [H] |
| Component with Framer Motion height animation mounts via CSS breakpoint | Expect instant render | `animate={{ height: bounds.height }}` plays entry animation from 0 on mount — looks like drawer sliding open. Add `initial={false}` to skip mount animation. Inner `AnimatePresence` for tab-switching is unaffected | [M] |
| Passing inline arrow to `useComposedRefs` | `useComposedRefs(ref, (node) => {})` | `useCallback` first, pass stable reference | [M] |
| Multiple `AnimatePresence` children | Conditional without `key` | Every direct child needs explicit `key` | [M] |
| State reset in Zustand action | Reset some fields | Audit ALL reset actions — `onSelectMarket`, `swapTokens`, wallet-change. If one resets leverage, all must | [M] |
| Dialog.Content without Title | Radix TitleWarning | Always include `<Dialog.Title>`. `className="sr-only"` if no visible heading | [M] |
| Delete file or git reset | Expect HMR to pick up | `rm -rf .next node_modules/.cache && yarn dev` | [M] |
| grep finds file | Edit first result | Verify import path consumed — dead copies exist | [M] |
| Radix Popover inside vaul Drawer | Expect portal opens on tap | Vaul intercepts `onPointerDown`. Use inline disclosure + state toggle | [M] |
| `additive Tailwind class` via `tv()` | `className="text-white"` overrides base | `tv()` appends, doesn't twMerge. Use `!text-white` important modifier | [M] |
| Hover + mobile tap | `onMouseEnter`/`onClick` toggle | Mobile fires mouseenter→click same tap. `onPointerEnter` gated on `e.pointerType !== 'touch'` | [M] |
| Icon SVG wrong size | Adjust container | Check SVG: hardcoded w/h, oversized viewBox, non-square aspect. Fix at source | [M] |
| Zustand updater syntax | `setStepIndex(prev => prev + 1)` | Custom actions take plain values. Function stored as value. Use `setStepIndex(stepIndex + 1)` | [M] |
| CSS-hidden container + Radix portal | Assume `hidden` prevents interaction | Portal to `<body>` escapes. Gate with `useMediaQuery` matching breakpoint | [M] |
| Adding `retry` to React Query | Apply broadly | Only HTTP-backed (Merkl, leaderboard). Never RPC — doubles on-chain costs. Exception: `setupChain` (root query, read-only, one failure empties entire page) gets `retry: 2` with backoff | [M] |
| ErrorBoundary scope | Only page content | Any crashable component needs own boundary — crash takes siblings | [M] |
| Adding custom Tailwind class via cn() | Define class, use in component | `twMerge` classifies unknown `text-*` as textColor. Register in `extendTailwindMerge` | [M] |
| useEffect reset with `isTransactionContent` | Status change fires reset | `prevTokenRef` — track `token.address`, only reset on address change | [M] |
| Destructuring `useStore()` no selector | `const { x, y } = useStore()` | Subscribes to entire store. One selector per field: `useStore(s => s.x)` | [M] |
| Decimal/object in queryKey | `[amount, tokenObj]` | `.toString()` all non-primitives. Structural equality fails | [M] |
| motion.div for every list item | All items get framer wrappers | Plain `<div>` off-screen. `motion.*` only for visible/animating | [L] |
| Updating icon barrel | Edit one registry | Both `type/index.ts` and `types/index.ts` must update together | [L] |
| Non-sticky divider | `<div>` at page top | `border-b border-edge` on sticky `<nav>` element | [L] |
| Box-shadow + overflow-hidden | Both on same element | Shadow clipped. Wrapper: outer=shadow+radius, inner=overflow-hidden | [L] |
| Inline SVG `<defs>` IDs | Reuse source IDs | Global DOM first-wins. Unique per instance | [L] |
| `@utility` custom class | Standard CSS or `@apply` | Tailwind v4 requires `@utility name { }` syntax | [L] |
| `@container` + `@xl:flex-row` on same element | Expect container query to self-reference | CSS container queries only query ancestors, never the element itself. No error, no warning — query silently never matches. Use standard breakpoint (`md:`, `newmd:`) on the same element, or put `@container` on a parent wrapper | [M] |
| Expanded table row columns | Match parent column widths | Self-contained `grid grid-cols-N` — expanded is independent | [L] |
| Chain icon via fuzzy matcher | Pass chain key | "monad" matches "staked-monad". Use `chain.icon` exact path | [L] |
| Adding origins to CSP connect-src | Trace only app-side code (chain-configs.ts, wagmi.tsx) | Also trace: app `chainRPCBackup` in chain-configs.ts (backup RPCs used by `fallback()` transport), SDK fallback providers (chains/*.ts), DEX aggregators (KyberSwap.ts, Kuru.ts), API calls (Api.ts, merkl.ts). Wallet services making page-context API calls (Safe Client Gateway) also need entries. Extension wallets bypass page CSP via background service worker | [H] |
| Adding `target="_blank"` to Link or anchor | Assume Next.js adds rel automatically | Next.js `<Link>` does NOT add `rel="noopener noreferrer"`. Must be explicit. Audit regex: `<(?:a\|Link)\b[^>]*target="_blank"[^>]*>` without `noopener` | [H] |
| Mutation using token from Zustand store | Use store token directly for SDK write calls | Store token may carry read-only provider from signerless setupChain. `resolveFreshToken(token)` resolves from `all_markets` at execution time — same address, fresh provider | [H] |
| Chain-switch behavior | Auto-switch wallet | Never auto-switch. Show banner + disabled actions. User clicks "Switch to Monad" | [L] |
| Thresholded, quoted, or freshly re-resolved mutation amount | Let preview/history/copy use requested amount while execution uses a different resolved amount | One flow, one amount. Thread the resolved submitted amount through preview, mutation input, pending history, and success/failure copy | [H] |
| User says remove something | Substitute alternative | Remove it. Ask before adding replacement | [L] |
| User states layout preference | Acknowledge but output old | Apply stated preference in same edit | [L] |
| New barrel export | Refresh → "Element type invalid" | Kill and restart `yarn dev` | [L] |
| Detecting if connected wallet is a Safe/SCW | `eth_getCode` — bytecode means contract wallet | EIP-7702 EOAs have delegated bytecode → false positive. Query Safe Client Gateway (`/v1/chains/{chainId}/safes/{address}`) — authoritative, returns threshold/owners, 404 for non-Safes | [H] |
| Naming a specific wallet in `MutationCache.onError` | "Safe service unavailable" toast | WalletConnect users are indistinguishable at handler level. Keep messages generic unless wallet type detected before the call via hook/store | [M] |
| Checking or modifying security headers in next.config.ts | Assume `headers()` executes in production | `output: 'export'` makes `headers()` dead code. Actual enforcement: Amplify `customHttp.yml`. Build warns but doesn't error. Both must stay in sync | [H] |
| Build fails with type error | Fix the error, rebuild, repeat | Run `npx tsc --noEmit` first — see full count, group by pattern, batch-fix. Iterative build-fix-build hides scope and wastes cycles on errors sharing a root cause | [M] |
| Auditing whether a broad refactor is live or equivalent | Infer from import hits, permissive types, or code-shape similarity | Trace to a live route, rendered consumer, or actual value domain. If the invariant is structural, pin it with a source-audit test | [H] |
| Fix scoped to a Root/Drawer or desktop/mobile pair | Patch the explicit surface and assume the mirror is covered by similarity | Check whether a live mirror exists. Patch both or surface the scoped omission explicitly | [M] |
| Modifying wagmi config `ssr` setting or removing `ssr: false` | Enable `ssr: true` for faster initial render or SSR hydration benefits | `ssr: false` is load-bearing. wagmi with `ssr: true` restores `isConnected` from persisted connector during SSR hydration, but server always has `isConnected=false`. The mismatch triggers React recovery → full tree re-render → wagmi re-initialization → auth cycling → route loss. Admin panel S2: four fix attempts before identifying `ssr: false` as root cause | [H] |
| Adding a new SDK-side validation marker or DEX-specific pre-flight error path | Let the generic DEX-name selector bucket catch it | Add a more-specific classifier before generic selectors so the recovery copy matches the real fix | [M] |
| Transaction confirm chain gating | Pass the wallet's current chain id back into `ensureChain(...)` | Resolve the required chain from market setup metadata via `resolveRequiredTransactionChainId(token)` before calling `ensureChain(...)` | [H] |
| Transaction UI reset during disconnect or drawer teardown | Reset the visible panel only | Also invalidate stale async callbacks with `useTransactionAttemptGuard()` so late success/failure handlers cannot repaint reset UI | [H] |
| Seeded browser harness plumbing | Feature code reads raw override storage or resolver modules directly | Keep storage in the provider/testing layer and expose typed feature-facing seams through `shared/testing/curvance-e2e-bridge.ts` | [M] |

## WWW (What Worked Well)

| Task type | Approach | Outcome |
|---|---|---|
| Infinite loop diagnosis (S6) | Binary-split shell components + dep-change tracker | Found RewardsDrawer || [] in one session. 10 fixes, 8 files |
| Token migration (S4) | Final hardcode sweep (inline style, arbitrary Tailwind, SVG fill/stroke, HSL) | Caught ~85 values that class-level sweep missed |
| Shared stable defaults | `stable-defaults.ts` with EMPTY_ARRAY, DECIMAL_ZERO, DECIMAL_ONE | Structural prevention of reference equality bugs |
| Sidebar reuse (market detail) | Rebuild from pattern, don't port old code | Cleaner result, no legacy baggage |
| Stale provider fix | `resolveFreshToken` — in-memory scan of SDK `all_markets` at mutation time, single file covers all 9 mutations | Zero RPC calls, zero render-path risk, falls back to original if `all_markets` hasn't refreshed |
| Safe wallet detection | Safe Client Gateway API (`/v1/chains/{chainId}/safes/{address}`) — 200 = Safe with threshold/owners, 404 = not Safe. Degrades silently on 503 | Correct for EIP-7702, provides multi-sig info, no false positives on delegated EOAs |
| setupChain resilience | `retry: 2` with exponential backoff (2s, 4s) + error state with retry button instead of "No Results Found" | Transient RPC blips invisible to user; persistent failures get honest message + one-click recovery |
| Merkl APY consolidation | Single `computeMerklRates` + `getOpportunityRate` in `shared/api/merkl.ts` — all 7 consumer files call through | Eliminated 14 inline `opp.apr / 100` references; header and breakdown guaranteed consistent by construction |
| Query architecture split | `useMarketDataQuery` (public, keepPreviousData) + `useUserDataQuery` (gates on `isConnected && hasSigner`, no keepPreviousData) — two wrappers over same setupChain cache | New features auto-inherit correct gating. Dashboard can't leak address(0) data. Explore page unaffected by wallet state |
| Live route query cleanup | Extract one page-boundary composition hook first (`useExplorePageData`, `useDashboardPageData`, etc.), then add source-audit tests (`route-boundaries.test.ts`, `test:query-quality`) | Reduced duplicated subscriptions/branching without increasing query count, and made architecture regressions fail fast |
| setupChain race elimination | `!isReconnecting` in `baseEnabled` prevents premature signerless query during wagmi reconnect window | Single setupChain call per chain after reconnect settles. No race on module-level `all_markets` |
| RPC fallback transport | `fallback([http(primary, RPC_OPTS), http(backup, RPC_OPTS)], { rank: false })` in wagmi.tsx with `retryCount: 3`, `timeout: 10_000` per endpoint. `chainRPCBackup` in chain-configs.ts | Universal retry + failover for every RPC read. Silent failover — user never sees the switch |
| High-churn frontend regression audit | Source-audit tests that read source, anchor on named code regions, and assert structural invariants | Caught retry-cap, selector-map, route-boundary, and Root/Drawer parity regressions in fast CI without mocking the whole feature stack |
| Wallet/network/statusbar parity hardening | One thin shared E2E bridge over provider actions and resolved account/chain hooks, then one dedicated `statusbar` Cypress spec | Found wallet-shell, switch-chain, unsupported-network, and notification/task drift without global wagmi mocks |
| Shared wallet-aware action surfaces | Funnel signer-dependent summary actions through `transaction-summary-actions.tsx` and pin the seam with route-boundary audits | Closed the stale confirm bug class across borrow, deposit, withdraw, repay, and manage-collateral with one reusable component |

## WWK (What We Know)

| Principle | Evidence |
|---|---|
| Reference equality drives React renders — any new-object-per-render (`|| []`, `new Decimal()`, SDK in selectors, bare object returns, mutation objects) cascades into loops or re-render storms. The fix is always stable references: module-level constants, primitive extraction, useMemo, useStableTable Proxy | WGW: 8+ entries. WWW: stable-defaults.ts. S6 found 10 instances across 8 files |
| Token/class migrations have a long tail — class-level sed catches ~80%, but inline styles, arbitrary Tailwind values, SVG attributes, and prefixed variants hide the remaining ~20%. The final sweep (inline style, `bg-[#hex]`, SVG fill/stroke, `var(--old)`) is not optional | WGW: sed rename, declaring migration complete. WWW: S4 final sweep found 85 values |
| Turbopack caches stale module graphs across file deletions and branch switches — HMR won't pick up the change. `rm -rf .next && rm -rf node_modules/.cache && yarn dev` is the only reliable reset | WGW: delete/move file, git reset |
| `output: 'export'` makes all Next.js runtime configuration documentation-only — `headers()`, `rewrites()`, `redirects()` compile and appear in build output but never execute. The hosting layer (Amplify `customHttp.yml`, Cloudflare rules) is the actual enforcement point. Keeping both in sync is a maintenance requirement, not redundancy | WGW: headers() dead code. Hard Constraints: static export. Previous audit misattributed working headers to next.config.ts when they were served by customHttp.yml |
| React Query cache is a shared namespace — `enabled` controls fetching, not visibility. When a query key can match both public and private cache entries (e.g., `['setupchain', undefined, slug]` from explore and from signer-resolving dashboard), the UI must independently verify data appropriateness. The query layer and UI layer are independent gates — neither substitutes for the other | WGW: disabled query leaking cached data, three-tier connection model. WWW: query architecture split. Three iterations of `enabled`-only fixes failed before adding UI-layer `walletReady` gate |
| wagmi `ssr: true` (default) in Next.js App Router SSR triggers a cascade: hydration mismatch → React recovery re-renders full tree → wagmi re-initializes → auth state cycles → route context lost. Each workaround (mounted guards, null gates) fixes one layer but breaks another. Root fix: `ssr: false` prevents the initial server/client divergence. Applies to any wagmi + App Router SSR deployment | Admin panel S2: four attempted fixes before root cause. App-dev already has `ssr: false` in both `getLiteConfig` and `getCustomConfig` — confirmed working |
| In broad app audits, endpoint traces beat surface signals. Import presence, type allowance, and code-shape similarity only show possibility; live route mounts, rendered consumers, value-domain checks, and source-audit tests show actuality | WGW: broad refactor audit, mirrored surface assumption. WWW: live route query cleanup, high-churn frontend regression audit |
| Wallet state in this app has three distinct consumers — signer-gated query/mutation surfaces, UI-only connected/disconnected shells, and E2E-aware account/chain surfaces — and each needs its own shared helper (`useWalletSessionState`, `useConnectionUiState`, `useResolvedAccountAddress` / `useResolvedAccountChainId`) | WGW: wrong-tier wallet checks, raw wagmi shell reads. Source-audit tests now pin these seams across statusbar, notifications, tasks, dashboard, bytes, and action sidebars |
| Transaction safety in the UI depends on two different guards: resolve the required chain from market setup metadata before confirm, and fence late async completions with `useTransactionAttemptGuard` after reset/disconnect | WGW: wrong-chain no-op, stale callback repaint. Source-audit tests pin `resolveRequiredTransactionChainId` and `useTransactionAttemptGuard` across all five transaction panels |

## Cross-References

| Topic | Skill |
|---|---|
| UI/design conventions, color tokens | Skill_CurvanceUI.md + Context_CurvanceUI.md |
| SDK methods, type system | Skill_CurvanceSDK.md |
| Display bugs, QA (load when doing QA) | Skill_CurvanceQA.md |
| UI anti-patterns (load when reviewing UI quality) | Skill_UIPatterns.md |
