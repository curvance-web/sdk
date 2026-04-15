# Curvance App Context

---
Context file for curvance-app codebase (curvance-web/app). Load specific sections via grep on `## [LABEL]` headers, routed from Skill_CurvanceApp.md. Also contains QA sections (correct patterns, bug catalog, checklists, sentinels) routed from Skill_CurvanceQA.md.
---

## [TECHNOLOGY_STACK]

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.1.6 | `src/app/` for routes. `output: 'export'` (static, production only). Turbopack in dev. |
| Language | TypeScript | 95.6% of codebase | Strict typing throughout. |
| Styling | Tailwind CSS + SCSS | ^4.2.1 / 1.3% | Tailwind primary, SCSS for edge cases. `@config` compat layer in `globals.scss`. |
| UI Primitives | Radix UI | Full suite (~20 pkgs) | Accordion, Dialog, Dropdown, Popover, Select, Slider, Tabs, Toggle, Tooltip |
| Charts | recharts | ^2.15.3 | Market detail charts (area/line/composed). |
| Data Fetching | @tanstack/react-query | ^5.90.21 | Module queries pattern. |
| Tables | @tanstack/react-table | ^8.21.3 | Market + dashboard tables. |
| State | zustand | ^5.0.11 | Per-module stores in `modules/*/stores/`. Zustand 5 requires individual selectors — no bare `useStore()`. |
| Forms | react-hook-form | ^7.71.2 | With @hookform/resolvers. |
| Animation | framer-motion | ^12.35.0 | Transitions. Avoid in long lists — use plain `<div>` for off-screen items. |
| Wallet | wagmi + viem + RainbowKit | 2.19.5 / ^2.47.0 / ^2.2.10 | Lite → Default mode switch. |
| Theming | next-themes | ^0.4.6 | Light/dark via class toggle. Live site = light. |
| Package Manager | yarn | yarn.lock canonical | bun/npm break builds. `bunfig.toml` exists but DO NOT USE bun. |
| Testing | Vitest | test / test:ui / test:run | Unit tests in `src/test/`. |
| SDK | curvance | 3.7.2 | `setupChain()` root query. `Decimal` (decimal.js), NOT BigNumber. |

---

## [DIRECTORY_STRUCTURE]

```
curvance-web/app/src/
├── app/                              # Next.js App Router
│   ├── layout.tsx                    # Root layout
│   ├── providers.tsx                 # Query, wallet, theme providers
│   ├── page.tsx                      # Home/explore page
│   ├── (core)/
│   │   ├── dashboard/page.tsx        # Dashboard (mega-component)
│   │   ├── market/page.tsx           # Market detail (thin shell → MarketDetailPage)
│   │   ├── earn/page.tsx             # Earn/vault listing
│   │   └── vault/page.tsx            # Vault detail
│   ├── (bytes)/bytes/                # Bytes game: page.tsx, fortune/
│   ├── (leaderboard)/leaderboard/    # Leaderboard + referrals/
│   └── (legal)/                      # privacy-policy/, terms-of-use/
│
├── layout/                           # App shell
│   ├── app-layout.tsx
│   └── components/
│       ├── navigation/               # Mobile bottom nav, mobile-menu, navigation-item, rewards-drawer
│       ├── statusbar/                # Top bar: desktop nav (NavItem[] + NavItemRenderer), network, profile, notifications (tasks, header)
│       ├── sidebar/                  # Footer
│       └── toggle-theme/
│
├── modules/                          # Domain feature modules
│   ├── market/                       # TRANSACTION + DATA LAYER (116 files, 27.5k lines)
│   │   ├── components/
│   │   │   ├── deposit/              # deposit.tsx, deposit-content.tsx
│   │   │   ├── borrow/               # borrow.tsx, borrow-content.tsx
│   │   │   ├── repay/                # repay-content.tsx
│   │   │   ├── withdraw/             # withdraw-content.tsx
│   │   │   ├── manage-collateral/    # manage-collateral-content.tsx
│   │   │   ├── dialogs/              # borrow.tsx, lend.tsx, deposit/leverage.tsx
│   │   │   ├── health-factor/        # Health visualization
│   │   │   └── tables/               # deposit.tsx (dashboard v2 table)
│   │   ├── v2/                       # Explore + data layer
│   │   │   ├── components/
│   │   │   │   ├── tables/           # deposit-table.tsx, borrow-table.tsx, cells/
│   │   │   │   └── market-detail/    # market-detail-page, market-header, stat-cards,
│   │   │   │       ├── overview/     # token-market-section, apy-chart, rates-chart, unified-chart
│   │   │   │       ├── sidebar/      # action-sidebar.tsx, variants.ts
│   │   │   │       ├── leverage/     # leverage-tab.tsx
│   │   │   │       └── interest-rate/ # irm-chart.tsx
│   │   │   ├── queries/index.ts      # setupChain, all derived hooks
│   │   │   ├── mutations/index.ts    # borrow, repay, withdraw, deposit, collateral, leverage
│   │   │   ├── stores/               # market.ts (493), borrow-token.ts (283), manage-collateral.ts (234), table.ts (11)
│   │   │   └── utils/                # borrow.ts, collateral.ts, leverage.ts
│   │   ├── constants/, enums/, hooks/, icons/, layout/, models/, queries/, stores/, utils/
│   │
│   ├── dashboard/                    # Dashboard presentation
│   │   ├── v2/                       # Data layer — queries, tables, hooks, stores, utils
│   │   │   └── queries/index.ts      # overview, deposits, loans, health, rewards, leverage mutations
│   │   ├── components/rewards/       # Rewards table
│   │   ├── gas/                      # Gas optimization experiment (hooks, components)
│   │   └── providers/, stores/
│   │
│   ├── app/                          # Shared foundation
│   │   ├── components/               # Button, Badge, Typography, InputField, Leverage, slider, popover, etc.
│   │   ├── hooks/, providers/, queries/, store/, types/, utils/, wallet/, wallet-signature/
│   │
│   ├── bytes/                        # Bytes game
│   ├── earn/                         # Vault pages
│   ├── feedback/                     # In-app feedback
│   ├── achievements/                 # Badge/achievement display
│   ├── leaderboard/                  # Leaderboard
│   ├── referral/                     # Referral system
│   ├── faucet/                       # Testnet faucet (7 files)
│   ├── rewards/                      # Milestone queries (1 file)
│   ├── lock/                         # Lock types (3 files)
│   └── monad/                        # Monad-specific (3 files)
│
├── ui/                               # Shared UI components
│   ├── v2-primitives/                # V2 design system — see V2 Primitives Barrel
│   ├── dashboard/                    # Dashboard-specific UI: loans-table, deposit table, shared/
│   ├── skeleton/                     # Table/card skeleton builders
│   ├── icon-selector/                # Icon component + type registries
│   ├── new-dialog/                   # Radix Dialog wrapper
│   ├── button/                       # Button variants + logic
│   ├── home/                         # Landing page components
│   ├── toast/, tooltip/, tabs/, table/, popover/, badge/, spinner/, dropdown/
│   ├── shared/                       # SearchEmptyState, search-input
│   ├── task/                         # Task components + types
│   └── wallet/                       # Wallet UI
│
├── shared/                           # Cross-cutting utilities (31 files, 2k lines)
│   ├── api/merkl.ts                  # Merkl API fetchers (fetchMerklOpportunities, fetchMerklCampaignsBySymbol)
│   ├── functions/                    # cn(), getHighestPriority, safe-tx-wait, formatting helpers
│   ├── hooks/                        # useStableTable, useIsUnsupportedChain, useScrollRestoration, etc.
│   ├── store/                        # Modal, nav, dropdown stores
│   ├── v2-formatters.ts              # formatSidebarUSD, formatSidebarToken, inputFontSize, ghostFontSize
│   ├── format.tsx                    # usdFormatter, tokenFormatter
│   └── enums/route.ts               # ROUTE enum
│
├── blockchain/                       # SDK + chain interaction (18 files, 3k lines)
│   ├── blockchain.tsx                # BlockchainProvider
│   ├── hooks/                        # useProvider, useSigner
│   ├── logic/                        # blockchain.store, .actions, .methods, .errors, .map
│   │   └── concepts/                 # chain-configs, markets, zapping, multi-call, faucet, locks
│   └── functions/tasks/              # Task completion logic
│
├── config/                           # App config, navigation, home data, meta
├── styles/                           # Global CSS, SCSS
├── env.ts                            # Environment variables
└── tailwind.config.js                # Heavily customized (custom breakpoints, extendTailwindMerge)
```

---

## [QUERY_INVENTORY]

### market/v2/queries/index.ts (SDK-based, primary data layer)

| Hook | Purpose | Key Dependencies |
|---|---|---|
| `useSetupChainQuery` | Root query — `setupChain()`, sanitizes names, returns `{markets, ...chainData}` | signer, chainId |
| `useMarketsQuery` | Select markets from setup | useSetupChainQuery |
| `useBorrowableTokensQuery` | `{eligible, ineligible}` filtered by `hasPositiveDebtCap()` | useSetupChainQuery |
| `useMarketStatsQuery` | `{totalDeposits, activeLoans}` aggregated | useSetupChainQuery |
| `useGlobalTvlQuery` | Sum `market.tvl` across all markets | useSetupChainQuery |
| `useZapTokensQuery` | `token.getDepositTokens(search)` → zap tokens with zapperType | token, search |
| `useBalancePriceTokenQuery` | Balance + price for deposit token | token |
| `useZapTokenQuoteQuery` | `zapToken.quote()` with slippage → `{output, minOut}` | zapToken, amount |
| `useMaxRedemptionQuery` | `token.maxRedemption()`, rounds down | token, signer |
| `useMaxLeverageQuery` | `market.reader.hypotheticalLeverageOf()` | market, token, amount |
| `useMerklBorrowOpportunitiesQuery` | Merkl opportunities filtered by `action='BORROW'` | MERKL_PROTOCOL_ID |

### dashboard/v2/queries/index.ts (dashboard data layer)

| Hook | Purpose | Key Dependencies |
|---|---|---|
| `useDashboardOverview` | `{deposits, debts, portfolio}` + day changes from market methods | markets |
| `useDepositDashboardQuery` | Tokens where `getUserAssetBalance(true) > 0` | markets |
| `useLoanDashboardQuery` | Borrowable tokens where `getUserDebt(false) > 0` | markets |
| `useGetPositionHealthQuery` | `market.reloadUserData()` → positionHealth as percentage + status | token |
| `useDepositV2Mutation` | Full deposit flow: plugin→approval→zap→deposit→invalidate | token, amount |
| `useBalanceQuery` | `asset.balanceOf()` → Decimal | asset, address |
| `useLeverageDownMutation` | `token.approvePlugin` + `token.leverageDown()` | token |
| `useLeverageUpMutation` | `token.approvePlugin` + `token.leverageUp()` | token |
| `useRewardsDashboardQuery` | Merkl user rewards aggregated by token+chain, enriched with campaigns | wallet, chainId |

### market/queries/index.ts (v1 pre-SDK queries, still active)

| Hook | Purpose | Key Dependencies |
|---|---|---|
| `useMarketAndAssetQuery` | `getAllMarkets()` → `{marketData, allMarketsAndAssets}` | enabled: false (manual) |
| `useMarketsQuery` (v1) | Select marketData only | useMarketAndAssetQuery |
| `useAllMarketAssetsQuery` | Flatten pTokens + eTokens with isPToken flag | useMarketAndAssetQuery |
| `usePTokenMarketAssetsQuery` | Only pTokens (deposit assets) | useMarketAndAssetQuery |
| `useNonPTokenMarketAssetsQuery` | Only eTokens (borrow/lend assets) | useMarketAndAssetQuery |
| `useUserAssetsQuery(category)` | Filter by 'All'\|'Deposit'\|'Borrow'\|'Lend' based on balances | useMarketAndAssetQuery |
| `useHoldExpiresQuery` | `market.functions.holdExpiresAt()`, auto-refetch on expire | market |
| `useHypotheticalLiquidityQuery` | `asset.functions.hypotheticalLiquidityOf()` | asset |
| `useAssetDebtWatcherQuery` | Polls `debtAt(THIRD_SECONDS)` every 30s | asset |
| `useHealthFactorQuery` | `market.functions.getHealthFactor()` → percentage + status | market, address |
| `useMaxLeverageQuery` (v1) | `Zapping.getMaxLeverageMultiplier()` | market, token |
| `useIsPluginEnabledQuery` | Check simpleZapper plugin approval | market, address |
| `useIsZapperLeverageEnabledQuery` | Check positionManagementBase plugin | market, address |
| `useAllowanceCheck` | ERC20 allowance check | token, spender |
| `useSupportsZappingQuery` | `zapManager.hasSolverSupport()` | market |

### app/queries (app-level)

| Hook | Purpose | Key Dependencies |
|---|---|---|
| `useUserTransactionHistoryQuery` | Combine store transactions, deduplicate by txHash, 60s refetch | address, chainId |
| `useNextHealthFactor` | `getHealthFactor` with debt/collateral changes | market, changes |
| `usePreviewPositionHealth*` | 7 variants: Deposit, Redeem, Borrow, Repay, LeverageUp/Down, LeverageDeposit | market, token, amount |
| `usePreviewImpactQuery` | `market.previewAssetImpact` for deposit/borrow on 'day' timeframe | market, token |
| `useShareReportErrorMutation` | POST to Discord webhook (message or file) | error data |

### rewards/queries

| Hook | Purpose |
|---|---|
| `useGetActiveRewardsQuery` | GET `/v1/rewards/active/{networkSlug}` → `{milestones: {market, tvl, multiplier}[]}` |

---

## [SDK_OBJECT_MODEL]

> For complete class APIs (all methods, params, return types), see **Context_CurvanceSDK.md → Class APIs**. Below covers only V1-app-specific usage notes.

### V1 Consumption Notes

- **`Decimal` boundary:** SDK returns `decimal.js` Decimal everywhere. The V1 `market` module uses `BigNumber` internally. Convert at boundaries with `FormatConverter`.
- **`setupChain()` sanitizes market names:** `&` → `|`. Don't assume raw SDK names match displayed names.
- **`positionHealth` is raw Decimal:** Multiply by 100 for percentage display. `null` means infinite (no debt).
- **`cooldown` is a Date:** Compare against `Date.now()` to determine if withdraw/repay is blocked.
- **Preview methods are synchronous:** All `previewPositionHealth*` methods read cached state — call `market.reloadUserData()` first if state may be stale.
- **`token.getPrice()` default is share price:** Pass `true` for asset/USD price. Common mistake in dashboard calculations.
- **`isBorrowable` determines type:** If `true`, token is already typed as `BorrowableCToken` with `getUserDebt`, `getBorrowRate`, `getLiquidity`, `liquidationPrice`. No casting needed.

---

## [APP_COMPONENT_APIS]

### Icon Systems

Two separate systems serve different use cases:

**`Icon` component** (`ui/icon-selector/icon-selector.tsx`) — build-time SVG imports via `@svgr/webpack`. Looks up keys in `ICON_TYPE` registry. Used for UI icons, chain logos, navigation, market names.
```tsx
import Icon from '@/ui/icon-selector/icon-selector';
<Icon iconType="weth" className="w-7 h-7" />
```
- Default export. Keys lowercase. `iconType={null}` returns `null`. Sizing via `className`.
- **Two registries exist:** `type/index.ts` and `types/index.ts` — both must be updated when adding/removing icons.

**`TokenImage` component** (`modules/app/components/token-image.tsx`) — runtime `next/image` loading `/tokens/{symbol.toLowerCase()}.svg`. Falls back to `/tokens/placeholder.svg` on error. Used in tables, dashboards, input fields.
```tsx
<TokenImage symbol="USDC" className="w-6 h-6" />
```
- CVE uses theme-aware variant (`cve-dark.svg` / `cve-light.svg`).

**Canonical asset locations:**
- `public/tokens/` — all token icons (lowercase filenames, 52 files)
- `public/chains/` — all chain icons + notification variants (17 files)
- `public/protocols/` — protocol logos for points boosts (6 files, runtime paths in `points-boosts.ts`)

**`chain-configs.ts`** uses runtime string constants for market/chain icons (`'/tokens/btc.svg'`, `'/chains/monad.svg'`). File moves require updating these paths — `scripts/check-asset-refs.ts` catches mismatches.

### StatCard (`ui/dashboard/shared/stat-card.tsx`)
```tsx
// Compound component:
Stats.Root  → div.flex.flex-1.flex-col.bg-surface-elevated.border.border-edge.shadow-card.px-4.py-3.5.rounded-md
Stats.Label → span.text-xs.font-medium.text-content-secondary.uppercase.tracking-[0.04em]
Stats.Value → span.text-xl.md:text-[28px].font-semibold.tabular-nums.tracking-tight.leading-none.text-content-primary
```
Note: Market detail page does NOT use this — built custom `MarketStatCard` with micro-viz slots. V2 primitives also have `StatCard` and `DashboardStatCard` with different APIs.

### Table Infrastructure

All tables use `@tanstack/react-table` with `fuzzyFilter` from `ui/table/logic/fuzzy-filter`.

**Common patterns across all tables:**
- Column visibility persisted in localStorage (`*-columns-visibility`)
- Column order persisted in localStorage (`*-column-order`)
- Row pinning via `useRowsPinning()` hook (localStorage)
- Row IDs include `chainId` for uniqueness
- Left pin: first column (asset/market name). Right pin: actions column
- `keepPinnedRows: false` — pinned rows don't duplicate in main list
- Touch device detection via `useIsTouchDevice()` for responsive column sizes

**Rendering locations:**
- Explore page tables: `market/v2/components/tables/` (deposit-table, borrow-table, cells/)
- Explore column definitions: `market/components/tables/` (market, deposit, borrow, lend)
- Dashboard deposits table: `dashboard/v2/tables/deposit.tsx`
- Dashboard loans table: `ui/dashboard/loans-table.tsx`
- Dashboard history/rewards: inline in `app/(core)/dashboard/page.tsx`

→ Full column specs in **Table Column Definitions** section above.

---

## [EXPLORE_PAGE]

Source: `app/page.tsx` — Key cross-module dependencies: data from `market/v2` queries/stores, transaction overlays from `market`, shared UI from `ui/dashboard/shared` and `ui/v2-primitives`.

## [DASHBOARD_PAGE_IMPORTS]

Source: `app/(core)/dashboard/page.tsx` (mega-file) — Key cross-module dependencies: data from `dashboard/v2` queries/stores/utils, navigation state machine from `dashboard/providers` (SelectedRowProvider), transaction overlays from `market`, shared stores from `market/v2`, SDK types from `curvance`.

---

## [EXPLORE_PAGE_BEHAVIOR]

Explore page (`app/page.tsx`):

- Two stat cards: Total Deposits, Active Loans
- Milestone progress bar with BONUS BYTES badge
- Deposit/Borrow tab toggle (data-driven via `MARKET_TAB_OPTIONS`)
- SortFilter extracted to `ui/v2-primitives/sort-filter.tsx` (reusable)
- MarketFilters component handles both desktop/mobile layouts responsively
- Store resets on tab change via `useResetMarketStores()` hook
- Tables wrapped with `useStableTable()` for stable deps
- **Click row → expands inline** with per-token breakdown (v1 deposit sidebar)
- Right sidebar: DepositOverview / BorrowOverview (will be replaced by market detail page)

**Market detail route:** `/market?address=0x...` loads `MarketDetailPage` from `modules/market/v2/components/market-detail/`. No wallet required.

**Vault detail route:** `/vault?address=0x...` loads `VaultDetailPage`. `/earn` redirects to `/vault`.

---

## [CHAIN_CONFIGURATION]

Single file: `src/blockchain/logic/concepts/chain-configs.ts`

```ts
// SUPPORTED_CHAINS is derived from SDK — only chains the SDK has contracts for.
// Filters AllChainConfigs by networkSlug present in SDK's `chains` export.
// Mainnets sorted first, then testnets. First entry = DEFAULT_CHAIN.
const SDK_SLUGS = new Set(Object.keys(sdkChains));
export const SUPPORTED_CHAINS: ChainConfig[] = ALL_CHAINS
  .filter((c) => SDK_SLUGS.has(c.networkSlug))
  .sort((a, b) => (a.isTestNet !== b.isTestNet ? (a.isTestNet ? 1 : -1) : 0));
export const DEFAULT_CHAIN = SUPPORTED_CHAINS[0]!;
export const DEFAULT_GAS_RESERVE_LIMIT = 1_000_000n;

// Helpers — all search SUPPORTED_CHAINS only
isSupportedChain(chainId)   // → boolean
getChainConfig(chainId)     // → ChainConfig | undefined
getNetworkSlug(chainId)     // → string | undefined (for SDK setupChain)
```

**Adding a chain:** Define a `ChainConfig` in the file, add to `AllChainConfigs`. If the SDK has contracts for it (`chains` export includes the slug), it auto-appears in `SUPPORTED_CHAINS`. No wagmi, dropdown, or query changes needed.

**`ChainConfig` notable fields:** `gasReserveLimit?: bigint` — per-chain gas limit for native-token zap reserve (Monad = 1.2M, others fall back to `DEFAULT_GAS_RESERVE_LIMIT`). `networkSlug` — must match SDK `chains` key exactly.

**`AllChainConfigs`:** `{ ArbSepolia, Sepolia, Monad, MonadTestnet }`. Used by `blockchain.map.ts` for `BlockchainContractMap` (legacy v1 support). Hyperliquid removed (dead). Not for feature-gating.

**`Chain` enum removed.** Was in `modules/app/enums/chains.ts` — duplicated chain IDs from configs. All consumers migrated to `chain-configs.ts` named exports (`Monad.chainId`, `ArbSepolia.chainId`, `getChainConfig(id)?.chainName`).

**Unsupported chain UX (Aave/Uniswap pattern):**
- `useIsUnsupportedChain()` hook (`shared/hooks/use-is-unsupported-chain.ts`) — `!isSupportedChain(chainId)` when connected
- `UnsupportedNetworkBanner` (`layout/components/unsupported-network-banner.tsx`) — amber banner below nav with "Switch to Monad" CTA
- `CautionIcon` (`ui/v2-primitives/caution-icon.tsx`) — rounded-triangle amber warning, `sm`/`md`/`lg` sizes
- Network dropdown shows `CautionIcon` + "Unsupported" instead of chain name when on unsupported chain
- Explore/Dashboard pages show empty state message, no skeletons
- **No auto-switching.** Never switch wallet programmatically — not on connect, not on toggle, not before tx. Banner is the only chain-switch prompt. User clicks to switch.

**`safeWaitForTx`** (`shared/functions/safe-tx-wait.ts`): Wraps SDK transaction promises to handle Monad RPC `nonce: null` bug. When ethers throws `INVALID_ARGUMENT` before `.wait()`, extracts tx hash from error object and falls back to `provider.waitForTransaction(hash)`. Used by all mutations in `market/v2/mutations/index.ts` and `dashboard/v2/queries/index.ts`.

**Wallet disconnect:** `useSetupChainQuery` falls back to `useChainId()` when wallet chainId is undefined. On unsupported chain, query stays disabled (no fallback to DEFAULT_CHAIN for data — page shows empty state).

**Merkl:** Protocol ID 'curvance' is hardcoded in query keys (`MERKL_LEND_QUERY_KEY`, `MERKL_BORROW_QUERY_KEY` in `src/shared/api/merkl.ts`). API fetches don't filter by protocol — opportunities are fetched from Merkl v4 API directly. No env var.

**Feature flags:** `FeatureGate`, `featureFlags`, `isFeatureEnabled`, and `NEXT_PUBLIC_BYTES_REWARDS` have been removed. Only env vars are `NODE_ENV` and `NEXT_PUBLIC_API_URL`.

---

## [CSP_ARCHITECTURE]

CSP is enforcing on both app (`next.config.ts`) and lander (`next.config.mjs`).

**What page CSP controls (connect-src):**
- App's wagmi HTTP transport RPCs (from `chain-configs.ts`) — fetch() from page context
- SDK fallback `JsonRpcProvider` RPCs (from SDK `src/chains/*.ts`) — used when `setupChain()` receives null provider (no wallet connected). Currently different domains from app RPCs (e.g., `rpc1.monad.xyz` vs `rpc-mainnet.monadinfra.com`). TODO: consolidate by passing app's read-only provider to SDK
- SDK DEX aggregators — KyberSwap (`aggregator-api.kyberswap.com`), Kuru (`ws.kuru.io`, `api.kuru.io`) — called from page context during swap/leverage/zap flows
- App APIs (`*.curvance.com`, `api.merkl.xyz`, `discord.com`)
- WalletConnect relay/verify endpoints — fetch/wss from page context

**What page CSP does NOT control:**
- Extension wallet RPCs (MetaMask, Rabby, Phantom) — calls route through extension background service worker, exempt per W3C CSP spec
- User's custom RPCs configured in wallet settings — same bypass

**Active chains (determined by SDK `chains` export):**
Only `monad-mainnet` and `arb-sepolia` are in the SDK's chain config. Sepolia (`eth-sepolia`) and MonadTestnet (`monad-testnet`) are defined in `chain-configs.ts` but filtered out by `SUPPORTED_CHAINS` because the SDK doesn't export those slugs. Their RPC URLs are in the CSP for forward compatibility but are never called.

**RPC co-dependency risk:**
App and SDK use different RPC endpoints for the same chain. If either goes down independently, different features break. App RPCs serve wagmi read queries; SDK RPCs serve disconnected-wallet `setupChain()`. Future fix: app passes its own `JsonRpcProvider(chainRPC)` as the second arg to `setupChain()` so both share one dependency.

**Maintenance:**
- Adding a chain to `chain-configs.ts` → add its `chainRPC` URL to `rpcSources` in `next.config.ts`
- SDK adds/changes a chain → also add the SDK's fallback RPC from `sdk/src/chains/*.ts`
- SDK adds a DEX aggregator → add its API domain to `sdkExternalApis`
- SDK Merkl domain: currently `api-merkl.angle.money` — remove from CSP when SDK migrates to `api.merkl.xyz`
- WalletConnect endpoints → verify against https://docs.reown.com/advanced/security/content-security-policy

**Headers beyond CSP:**
- `X-XSS-Protection` removed — deprecated by all modern browsers. Chrome removed XSS Auditor in 2019. CSP supersedes it.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` added — prevents tabnabbing during WalletConnect popup/OAuth flows. Per Reown docs. Applied to both app and lander.

**img-src:**
- Broadened to `https:` — app token icons are all local (`/public/`), but Merkl campaign metadata (`rewardToken.icon`) and Kuru's token list (`imageurl`) return arbitrary CDN URLs. Images can't execute code, so `https:` is low risk.

---

## [MARKET_DETAIL]

**Market detail** in `modules/market/v2/components/market-detail/`.

### File Tree
```
market-detail/
├── index.ts, types.ts, constants.ts
├── market-detail-page.tsx (orchestrator)
├── market-header.tsx
├── market-stat-cards.tsx
├── market-tabs.tsx (Radix Tabs)
├── overview/ (unified-chart, rates-chart, token-market-section)
├── interest-rate/ (irm-chart)
├── leverage/ (leverage-tab — earnings simulator)
└── sidebar/ (action-sidebar, 3-tab; variants.ts)
```
Note: primitives (DeltaBadge, Pills, CapacityRow, etc.) promoted to `ui/v2-primitives/` barrel.

---

## [MARKET_DETAIL_PRIMITIVES]

Originally in `market-detail/primitives/`, now promoted to `ui/v2-primitives/` barrel. Import via `@/ui/v2-primitives`.

### DeltaBadge
```tsx
import { DeltaBadge } from '@/ui/v2-primitives';
<DeltaBadge value={2.8} size="md" />  // ▲ 2.8% (green) or ▼ -1.2% (red)
```
- `size`: `sm` (10px, px-[5px] py-[2px]) | `md` (12px, px-1.5 py-[3px], default)
- Auto-colors: positive → `text-semantic-supply`, negative → `text-semantic-error`
- Background: `color-mix(in srgb, var(--color-supply) 15%, transparent)` / `color-mix(in srgb, var(--color-error) 15%, transparent)`
- Classes: `inline-flex items-center gap-0.5 font-semibold leading-none rounded tabular-nums`

### LiquidityBadge
```tsx
import { LiquidityBadge } from '@/ui/v2-primitives';
<LiquidityBadge availablePercent={71} size="md" />
```
- Same box model as DeltaBadge for pixel alignment
- Health-coded: ≥30% green, 10-29% yellow, <10% red
- Contains 28×5px inline fill bar (HTML div, not SVG)

### Pills
```tsx
import { Pills } from '@/ui/v2-primitives';
<Pills options={['Deposits','Borrow','Liquidity']} value={selected} onChange={setSelected} size="md" />
```
- `size`: `sm` (text-[11px]) | `md` (text-xs, default)

### CapacityRow
```tsx
import { CapacityRow } from '@/ui/v2-primitives';
<CapacityRow label="Total Collateral" current={78.8} cap={95} unit="M" tooltip="..." />
```
- Ring gauge + amount/cap display + hover tooltip
- Shows `$78.8M / $95M` with ring fill proportional to usage

---

## [STATE_MANAGEMENT]

### Zustand Stores (persisted)

| Store | Location | Persisted Key | State |
|---|---|---|---|
| `useApprovalSettingStore` | `app/store` | `approvalSettings` | `{approvalSetting: 'unlimited'\|'1/1'}` |
| `createTransactionsStore(addr)` | `app/store` | `transactions_{addr}` | `{walletAddress, transactions[], addTransaction, updateTransaction}` |
| `createClaimStore(addr)` | `app/store` | `claim_{addr}` | Same shape as transactions |
| `useNotificationStore` | `app/store` | `notification-storage` | `{data: Record<Address, {count}>, increment, decrement, reset, getCount}` |
| `useTestnetToggleStore` | `dashboard/stores` | `testnetEnabled` | `{testnetEnabled, setTestnetEnabled, toggleTestnetEnabled}` |

### Zustand Stores (ephemeral, with partial persistence)

These stores are ephemeral for most fields but persist `currencyView` preference via `zustand/middleware/persist`:

| Store | Location | Persist Key | State |
|---|---|---|---|
| `useDepositStore` | `market/v2/stores/market` | `deposit.store` (currencyView only) | `{depositToken, market, zapToken, amount, leverage, currencyView, depositStatus, editLeverage, isCollateralized, isLeverageInteracting, slippage, borrowToken}` |
| `useBorrowStore` | `market/v2/stores/borrow-token` | `borrow.store` (currencyView only) | `{token, market, amount, usdAmount, tokenAmount, borrowStatus, isIneligible, currencyView, leverage}` |
| `useSelectedManageCollateral` | `market/v2/stores/manage-collateral` | `manage-collateral.store` (currencyView only) | `{token, market, amount, action, currencyView, isMax, isCollateralized}` |

### Zustand Stores (fully ephemeral)
| `useTableStore` | `market/v2/stores/table` | `{search, onSearchChange}` |
| `useDashboardTableStore` | `dashboard/v2/stores/table` | `{search, onSearchChange}` |
| `useTokenStore` | `market/stores` | `{selectedToken, balance, setSelectedToken}` |
| `useSidebarStore` | `shared/store/nav` | Sidebar open/close state |
| `useRewardsDrawerStore` | `shared/store/nav` | Rewards drawer open/close |

### Context Providers

| Provider | Location | Provides |
|---|---|---|
| `AssetContextProvider` | `market/stores` | Scoped IPToken\|IEToken + market to a table row |
| `SelectedRowProvider` | `dashboard/providers` | `{selectedRow, currentView, navigateTo, goBack}` — navigation state machine with views: `'dashboard'\|'deposit'\|'withdraw'\|'borrow'\|'repay'\|'manage-collateral'\|null` |
| `TransactionsStoreContext` | `app/providers` | Transaction store scoped to current wallet address |

### localStorage Direct Usage

| Key Pattern | Used By | Data |
|---|---|---|
| `deposit-columns-visibility` | useDepositTable | Column visibility state |
| `borrow-columns-visibility` | useBorrowTable | Column visibility state |
| `lend-columns-visibility` | useLendTable | Column visibility state |
| `*-column-order` | All tables | Column reorder state |
| `rows-pinned` | useRowsPinning | Pinned row IDs |
| `favorites-markets-${chainId}` | useFavoritesMarkets | Favorited market addresses |
| `healthFactor-*` | checkHealthFactorAlerts | Previous health factor for alert detection |

---

## [TABLE_COLUMNS]

### Explore Page Tables

**Market Table** (`market/components/tables/market.tsx`):
Columns: Market Name | TVL | Total Deposits | Total Lent
- Data type: `IMarket[]`
- Values: `market.usdTVL`, `market.usdCollateralPostedTVL`, `market.usdTotalLent`

**Deposit Table** (`market/components/tables/deposit.tsx`):
Columns: Asset | Market Name* | Price | TVL | LTV | Collateral Capacity | Your Deposits | Actions
- Data type: `DepositAsset` = `IPToken & {isPToken, market}`
- *Market Name hidden when `hideMarketNameColumn=true`
- Collateral Capacity shows fill status (90% = almost full, 100% = full)
- Your Deposits tooltip shows collateral breakdown
- Responsive: Collateral Capacity hidden max-lg, TVL hidden max-sm

**Borrow Table** (`market/components/tables/borrow.tsx`):
Columns: Asset | Market Name* | Price | Available Liquidity | Utilization Rate | Interest Rate | Your Debt | Actions
- Data type: `BorrowAsset` = `IEToken & {isPToken, market}`
- Interest Rate shows `borrowRatePerYear` via `getValueSymbol`
- Responsive: Available Liquidity hidden max-lg, Interest Rate hidden max-md

**Lend Table** (`market/components/tables/lend.tsx`):
Columns: Asset | Market Name* | Price | Utilization Rate | Supply vAPY | Available Liquidity | Your Deposits | Actions
- Data type: `LendAsset` = `IEToken & {isPToken, market}`

### Dashboard Tables

**Dashboard Deposits Table** (`dashboard/v2/tables/deposit.tsx`):
Columns: Asset | Deposits | Collateral | Leverage | Position Health | Actions (chevron)
- Data type: `CToken[]` (SDK objects directly)
- Expandable rows with: Price, Liquidation Price, Collateral Cap, LTV, Deposit vAPY, Position Health bar
- Asset column shows both tokens in market pair
- Deposits: `getUserAssetBalance(true)` in USD, `convertUsdToTokens` for token amount.
- Collateral: `getUserCollateral(true/false)` with edit pencil icon — NOTE: `getUserCollateral(false)` returns SHARES (cToken units via `collateralPosted`), not asset tokens. Conversion needed: `collateralShares × exchangeRate`
- Leverage: `getLeverage()?.toFixed(2)x` or `-`
- Position Health: `market.positionHealth * 100` with color-coded badge

**Dashboard Loans Table** (`ui/dashboard/loans-table.tsx`):
- Referenced from `app/(core)/dashboard/page.tsx`, uses `useLoanDashboardQuery`
- Columns defined in separate LoansTable component
- DebtCell uses correct fallback: `debtBalanceQuery.data ?? token.getUserDebt(true)` (cached snapshot)

**Dashboard History Table** (inline in `app/(core)/dashboard/page.tsx`):
Columns: Type | Amount | Date | Actions (View tx link)
- Data source: `useTransactionsStore` filtered by `status === 'success'`
- Type display map: deposits→Deposit, withdrawals→Withdrawal, borrows→Borrow, etc.
- Export support: CSV/JSON with date range picker

**Dashboard Rewards Table** (`dashboard/components/rewards/table.tsx`):
- Data source: `useRewardsDashboardQuery` (Merkl aggregated rewards)
- Type: `RewardsTableRow[]` with token, chain, amount, usdValue

---

## [TRANSACTION_FLOWS]

> For step-by-step mutation flows (deposit, borrow, repay, withdraw, collateral, leverage), see **Context_CurvanceSDK.md → V1 Action Patterns**. Below covers V1-app-specific transaction infrastructure.

### Common Post-Transaction Sequence
All mutations follow the same cleanup: `invalidateUserStateQueries(queryClient)` → complete tasks → update transaction store. Cooldown begins after deposit/borrow — `market.cooldown` provides the end Date.

### Transaction Record Shape
```ts
type TransactionType = {
  id: string;
  status: TransactionStatusType;       // 'pending' | 'success' | 'failed'
  txMethod: TransactionMethodType;     // 'deposits' | 'borrows' | 'repay' | 'withdrawals' | ...
  assetAddress?: string;
  network: string;
  underlyingTokenAddress?: string;
  marketAddress?: string;
  user: string;
  timestamp: string;
  tokenName?: string;
  tokenSymbol?: string;
  amount: string;
  txHash?: string;
  lockType?: LockType;
  reward?: string;
  asset?: Asset & { marketName: string };
};
```

Persisted via `createTransactionsStore(address)` → localStorage key `transactions_{address}`. Dashboard history tab filters by `status === 'success'`.

---

## [DASHBOARD_ARCHITECTURE]

`app/(core)/dashboard/page.tsx` is a large single-file page with these key sections:

### Layout
```
┌────────────────────────────────────────────────────────┐
│ DashboardStats (4 stat cards)                          │
│ [Total Rewards] [Portfolio Value] [Deposits] [Debt]    │
├────────────────────────────────┬───────────────────────┤
│ DashboardTabs                  │ DashboardViewManager  │
│ [Deposits|Loans|History|Rewards]│ (sticky sidebar)      │
│                                │                       │
│ Active tab content:            │ Context-dependent:     │
│ - DepositsTable (expandable)   │ - SelectedRowCard      │
│ - LoansTable                   │ - DepositOverview      │
│ - HistoryTable                 │ - WithdrawOverview     │
│ - RewardsTable                 │ - BorrowOverview       │
│                                │ - RepayOverview        │
│                                │ - ManageCollateral     │
└────────────────────────────────┴───────────────────────┘
```

### Navigation State Machine (SelectedRowProvider)
```
null (default card) ─→ 'deposit' ─→ DepositOverview
                    ─→ 'withdraw' ─→ WithdrawOverview
                    ─→ 'borrow' ─→ BorrowOverview
                    ─→ 'repay' ─→ RepayOverview
                    ─→ 'manage-collateral' ─→ ManageCollateralOverview
```

### Position Earnings Calculation (`usePositionEarnings`)
```ts
// Deposit earnings per day
earningPerDay = positionValueUsd * (nativeApy + merklApy) / 365

// Borrow cost per day (net of Merkl subsidies)
effectiveBorrowApy = borrowApy - merklBorrowApy
changePerDay = debtValueUsd * effectiveBorrowApy / 365

// Net
netEarningPerDay = totalDepositEarningPerDay - totalBorrowChangePerDay
```

Native APY sources: `getDepositApy(token, undefined)` from `deposit.utils.ts` — returns `getNativeYield(token) + getInterestYield(token)` (Merkl added separately in `usePositionEarnings`)

### Mobile: Drawer-based Management
On mobile/tablet (`<1280px`, below `xl` breakpoint), the sidebar becomes a drawer triggered via "Manage" button on each row card, using the same navigation state machine.

### Rewards Table
Located at `modules/dashboard/components/rewards/table.tsx`. Exports: `useRewardsTable`, `RewardsMobileTable`, `RewardsEmptyState`, `RewardTokenIcon`. Consumed by the dashboard page and the nav rewards drawer.

### SelectedRowCard Desktop/Mobile Split
`SelectedRowCard` is a single shared component used in both the desktop sidebar (via `DashboardViewManager`) and the mobile drawer (via `ManagePosition`). It uses CSS breakpoints to show different content:

- `hidden lg:flex` → Desktop-only rows: Total Deposits, Available to Withdraw
- `flex lg:hidden` → Mobile-only rows: Deposits (compact), Collateral (with edit button), Leverage (with edit button)

**Values should be computed once at the top of the component**, not inline per breakpoint. The deposit display follows this correctly (computes `userDepositsUsd` and `userDepositTokens` once via `getUserAssetBalance(true)`, references in both desktop and mobile JSX). The collateral display now also uses `getUserCollateral(true)` correctly. When adding new data rows to this component, always compute at the top and reference in both paths.

The desktop expanded row (`DashboardExpandedRowContent`) is a **separate component** that matches column widths to the table header via ResizeObserver. It shows: Price, Liquidation Price, Collateral Cap, LTV, Deposit vAPY. This component does NOT share data computation with `SelectedRowCard`.

---

## [LIQUIDATION_CALCULATIONS]

From `dashboard/v2/utils/liquidation.ts`:

### `getLoanLiquidationPrice(token: BorrowableCToken)`
1. Find collateral token: prefers non-borrowable token with `getUserCollateral(false) > 0`, falls back to highest collateral token
2. Try SDK: `token.liquidationPrice` (Decimal)
3. If SDK fails, manual calculation:
   - Method A: `marketDebt / marketMaxDebt` ratio applied
   - Method B: `tokenDebt / (collateralUsd * collReqSoft)`
4. Returns `{priceUsd: Decimal | null, ratioToSpot: Decimal | null, collateralToken: CToken | null}`

### Display Formatting
- `formatLiquidationPrice(price)`: Compact notation with M/B/T/Q suffixes for values > 1M
- Null/zero → "—"

---

## [UTILITY_FUNCTIONS]

### market/utils/health-factor.ts
- `getStatus(value)`: `<5` → 'Danger', `5-20` → 'Caution', `>20` → 'Healthy'
- `healthFactorToPercentage(raw)`: `(raw - 1) * 100`, min 0
- `formatHealthFactor(raw)`: null → '∞', ≥999 → '>999%', else formatted %
- `getStepPercent(value)`: Non-linear mapping for health bar visualization
- `getTextColorFromZone(value)`: Returns Tailwind text color class
- `getBackgroundColorFromZone(value)`: Returns Tailwind bg color class

### market/utils/index.ts
- `getColorByMarketName(name)`: Governance→orange, Stable→green, Savings→blue, Volatile→pink

### market/v2/utils/index.ts
- `getLiquidityStatus(ratio)`: `<0.75` → green, `0.75-0.91` → yellow, `>0.91` → red
- `tokenTaskGroupMap`: Maps task group names to token symbols (`'Kintsu Tasks'` → `'smon'`)

**Borrowability & bidirectionality (canonical app pattern):**
- `hasPositiveDebtCap(token)`: `token.getDebtCap(true) > 0`. The real borrowability check — `token.isBorrowable` is always `true` on all Curvance tokens (architectural, not a bug), so it's useless as a filter.
- `isBorrowableTokenWithDebtCap(token)`: Type guard combining `isBorrowable && hasPositiveDebtCap(token)`. Used in 10+ files for borrow eligibility, table filtering, and CTA visibility.
- **Collateral token discovery:** `market.tokens.find(t => getDebtCap(true).eq(0))` — the token with zero debt cap is collateral-only. Used in `asset-mobile-cell.tsx` and explore table rendering.
- **Bidirectional detection:** `borrowableTokens.length === market.tokens.length` — if all tokens pass `isBorrowableTokenWithDebtCap`, the market is bidirectional (shows `⇌`), otherwise unidirectional (shows `→`).
- **Admin panel shortcut:** The Morning Brief API route uses array position (`tokens[0]` = collateral, `tokens[1]` = loan) which works in practice because the SDK returns them in that order. The app's debtCap-based approach above is more robust.

### app/utils/index.ts
- `getSignature({walletAddress, signer})`: Signs "I am the owner of: {address}", caches in localStorage keyed by `task-signature-{address}`. Deduplicates concurrent calls via promise cache.
- `buildExplorerURL(chainConfig, txHash)`: `${chainConfig.explorer}tx/${txHash}` — uses chain's explorer URL directly
- `isURL(value)`: URL validation via `new URL()`
- `getFormattedWalletAddress(value, limits?: {left?, right?})`: Address truncation, defaults `left=6, right=3`

### Hooks (market/hooks)
- `useTotalActivities()`: Aggregates all user positions → `{usdTotalCollateral, usdTotalDeposits, usdTotalLent, usdTotalBorrow}`
- `useWithdrawBalancePToken(token)`: Max withdraw considering collateral requirements
- `useWithdrawBalanceEToken(token)`: Max withdraw considering liquidity
- `useBorrowBalance(token)`: Available borrow = min(maxBorrow - debt, availableLiquidity)
- `useDebtValue(token)`: Returns min(debt, underlyingBalance)
- `useTransactionSteps({hasApproval, hasPlugin})`: State machine: plugin→approval→transaction→complete
- `useResetOnWalletChange(callback)`: Fires callback when wallet address changes

---

## [DEAD_CODE]

### Confirmed Dead
| Path | Evidence |
|---|---|

(None currently identified.)

### Likely Dead (verify imports before deleting)
| Path | Last Touched | Evidence |
|---|---|---|

(None currently identified.)

### NOT Dead Despite Age
| Path | Why Alive |
|---|---|
| `modules/market/components/borrow/` | Active transaction flow |
| `modules/market/components/deposit/` | Active deposit flow |
| `modules/market/components/withdraw/` | Active withdraw flow |
| `modules/market/components/repay/` | Active repay flow |
| `modules/market/components/manage-collateral/` | Active |
| `modules/market/components/transaction-steps.tsx` | Active transaction UI |

---

## [MARKET_DETAIL_DESIGN]

### Typography Scale (8 tiers, dark background optimized)

| Tier | Size | Use |
|---|---|---|
| Input value | 26→15px responsive | Amount input field — `inputFontSize(value)` from v2-formatters. ≤7 chars: 26px, 8-10: 22px, 11-13: 18px, 14+: 15px. Ghost label tracks via `ghostFontSize()`. |
| Chart headline | 24px bold | Primary value in all chart tab headers |
| Token header | 19px bold | Token name in market info panels |
| Token pills | 16px | Token selector buttons |
| Section labels | 14px semibold uppercase | COLLATERAL, DEPOSITS, BORROW headings |
| Body / row labels | 13px | Position rows, metric labels, APY labels |
| Section context | 12px | "You pay in", "Borrowable", USD conversions |
| Badge / micro | 11px | InfoIcon, tertiary annotations |

**Rule:** 11px is the absolute floor. Section labels that were 11px got bumped to 12px for readability on dark backgrounds.

### Chart Header Contract (all 4 tabs standardized)

```
24px bold value   [DeltaBadge md]        ← same across all tabs
⊙ WETH  ⊙ USDC   context text           ← same token pills
```

- **Overview**: `$74.5M` + `▲ 2.8%` → tokens + `Deposits · 30d`
- **Deposit APY**: `15.07%` + `▲ 43.5%` → tokens + `30d`
- **Borrow APR**: `5%` + `▲ 108.3%` → tokens + `30d`
- **IRM**: `72.0%` + `Normal` → tokens + `Deposit 1.97% · Borrow 3.04%`

When adding a new chart tab, match this structure exactly.

### Stat Card Micro Visuals (final layout)

```
[TOTAL DEPOSITS    ▲ 2.8%]   [TOTAL LIQUIDITY    ━━● 71%]   [DEPOSIT APY    ▲ 2.1%]
[$155.7M                  ]   [$110.5M                    ]   [20%                   ]
```

- Labels use dotted underline as tooltip affordance (no ⓘ icons)
- Total Deposits + Deposit APY: `DeltaBadge` (md size) showing 7-day change
- Liquidity: `LiquidityBadge` (md size) with health-coded fill bar (green ≥30%, yellow 10-29%, red <10%)
- Available % = `(1 - totalBorrowed/totalDeposits) × 100`

### Sidebar Dimensions

- 320px width, 10px border-radius, 12px padding
- Ghost pill inputs (no recessed wells)
- Free-floating APY headline at 20px bold
- Advanced details: rotating chevron, 3 rows (health, position, debt)
- Zapper: right-aligned balance (matches main input), white/25 opacity

### Leverage Slider Layout

```
1x ━━━━━●━━━ [5.6x]
```

- "1x" label inline left of track (13px, white/30)
- Input field doubles as max indicator — no redundant label row
- Max computed client-side: `1 / (1 - LTV/100)`, rounded to 1 decimal
- Shared `computeMaxLeverage` helper between sidebar and leverage tab

### Market Info Panels

- No vertical divider between token cards (card borders + backgrounds handle separation)
- `gap-3` between cards (matches stat card gap above)
- `pt-3.5 pb-2` card padding

### Contracts Disclosure

Row order per token card: Underlying → Oracle → cToken → Market Manager.
- Oracle badge: single combined label. `guardedOracleType` present → use it ("Guarded Exchange Rate" / "Guarded Market Price"). No guard + Exchange Rate → "Raw Exchange Rate". No guard + Market Price → "Market Price".
- cToken badge: "Borrowable" or "Non-Borrowable".
- Market Manager icon: Curvance brand mark (source: `BrandMarkSVG` in `statusbar.tsx`). Hardcoded brand colors — works in both themes.
- Badges render via `ContractRow` `badges` prop. 11px `white/40` text on `white/5` bg, `rounded-sm`, inline after label before address.
- IRM contract link: on Interest Rate Model tab below Model Parameters, not in token cards.

---

## [SIDEBAR_REUSE]

Migration complete. LeverageSlider, TokenSelect, amount-card rebuilt fresh. ApprovalButton, transaction-steps, useTokenStore, useDepositStore, useBalancePriceTokenQuery all wired. `v2-formatters.ts` replaced usdFormatter/tokenFormatter for sidebar displays (`formatSidebarUSD`, `formatSidebarToken`, `inputFontSize`, `ghostFontSize`, `shortenAddress` — import from `@/shared/v2-formatters`).

---

## [LOADING_STATES]

| Component | Loading | Empty / No Wallet |
|---|---|---|
| Stat cards | NeoSkeleton placeholders | Show $0 / 0% |
| Charts | Skeleton rectangle with pulse | "No data available" centered |
| Market info sections | Skeleton rows (ring + text) | Show zeros |
| Sidebar balance | Skeleton text | "Connect wallet" |
| Sidebar position summary | Skeleton rows | Hidden entirely |
| IRM chart | Skeleton rectangle | "IRM data unavailable" |
| Leverage chart | Show chart with default $10K/1x | — |

---

## [BYTES_ENGAGEMENT]

> **Migrated** to `Context_CurvanceBytes.md`. See that file for: Bustabyte game design (state machine, multiplier tiers, edge cases), partner task system (notification panel, task detection, completion flow), achievement badge inventory (24 badges), share card specs, referral page layout, rank tier visuals.

> Onboarding tour UI patterns remain in `Context_CurvanceUI.md` → Onboarding Tour Patterns (UI implementation specs, not engagement feature logic).

---

## [MERKL_INTEGRATION]

External rewards via Merkl, now managed by the SDK (`curvance` package `integrations/merkl.ts` + `helpers.ts` yield functions).

**SDK functions (Merkl data fetching):**
- `fetchMerklOpportunities({ action?: 'LEND' | 'BORROW' })` — fetches from `api.merkl.xyz/v4/opportunities`, filtered by `mainProtocolId: 'curvance'`
- `fetchMerklUserRewards({ wallet, chainId })` — user rewards aggregated by token+chain
- `fetchMerklCampaignsBySymbol({ tokenSymbol })` — enriches with name, icon, price
- SDK also exports `getDepositApy` and `getBorrowCost` in `helpers.ts` (supports `apyOverrides`)

**App-side yield functions (what the UI actually uses):**
- `getDepositApy(token, opportunities)` in `modules/market/components/deposit/deposit.utils.ts` — `getNativeYield(token) + getInterestYield(token) + getMerklDepositIncentives(token.address, opportunities)`. All dashboard/table components import this version, NOT the SDK's.
- `getBorrowCost(token, opportunities)` in same file — net borrow cost (rate - Merkl incentives)
- `getNativeYield(token)` — reads `token.nativeYield` or `token.nativeApy` directly
- The SDK version in `helpers.ts` has different logic (falls back to `getApy() + apyOverrides` when `nativeYield === 0`). The two versions are NOT interchangeable.

**App-side integration:**
- During `Market.getAll`, SDK matches Merkl LEND/BORROW opportunities to tokens by address and sets `token.incentiveSupplyApy` / `token.incentiveBorrowApy`
- APY calculation: `nativeApy + interestApy + merklApy = totalApy` per token
- Protocol ID hardcoded in SDK as `'curvance'`

**Query config (`useRewardsDashboardQuery` in `dashboard/v2/queries`):**
- `staleTime: 5 * 60 * 1000` — Merkl data changes slowly, prevents Turbopack HMR refetch storms
- `retry: 1` — HTTP-backed, safe to retry (unlike RPC queries)
- `signal?.throwIfAborted()` before `Promise.all` of campaign fetches — prevents firing N doomed requests after cancellation
- Catch block filters `AbortError` (re-throws for React Query silent handling) and only `console.error`s actual failures
- Global `queryCache.onError` in `app/providers/query.tsx` also filters AbortError, `CALL_EXCEPTION` (RPC read-only reverts), and axios `ERR_CANCELED`. `mutationCache.onError` filters `SIGNATURE_UNAVAILABLE` (user bypassed signing prompt).

---

## [V2_PRIMITIVES_BARREL]

`ui/v2-primitives/index.ts` — shared UI building blocks for v2 pages. Import via `@/ui/v2-primitives`.

**Barrel-exported:**
- **Badges & indicators:** `DeltaBadge`, `DonutGauge`
- **Layout:** `StatCard`, `ContractRow`, `DashboardStatCard`, `Sparkline`
- **Health:** `HealthBar`, `getHealthTier`, `getHealthColor`
- **Interactive:** `Pills`, `TogglePills`, `InfoIcon`, `Tooltip`, `TooltipPopup`, `DragSlider`
- **Context:** `ContextTooltip`, `TipRow`, `TipDescription`, `TipDivider`, `ChainProvider`, `CautionIcon`
- **Charts:** `ChartTooltip`, `APYBreakdown` (+ `APYBreakdownRow`, `APYBreakdownProps` types)
- **Utilization:** `UtilizationBar`
- **Filters:** `SortFilter`
- **Types only:** `ExposureSlice`

**In directory but NOT barrel-exported (internal or unused):**
- `CapacityRow` — ring gauge + amount/cap, not imported externally
- `LiquidityBadge` — consumed internally by `StatCard`
- `HoverRow` — consumed internally by `StatCard`, `TooltipPopup`
- `Shimmer` — loading placeholder, imported directly when needed
- `ExposureChart` — pie chart component (only its `ExposureSlice` type is exported)

**Chart utilities** (import directly from `@/ui/v2-primitives/chart-utils`): `formatChartDate`, `formatDateForRange`, `formatAxisPct`, `formatAxisVolume`, `CHART_AXIS_STYLE`, `CHART_GRID_STROKE`, `CHART_CURSOR`, `evenTicks`.

Note: `SearchInput` and `SearchEmptyState` live in `ui/shared/`, not in this barrel.

---

# QA Sections (routed from Skill_CurvanceQA.md)

## [CORRECT_PATTERN_REGISTRY]

When tracing a display bug, grep for the same operation done correctly elsewhere. These are verified-correct implementations:

**Debt display fallback:**
Correct: `borrow-table.tsx` — `debtBalanceQuery.data ?? token.getUserDebt(true)` (cached snapshot as fallback). Grep: `debtBalanceQuery.data ??`. Same pattern: `repay-content.tsx`, `borrow-content.tsx`, `borrow-token.ts` stores (4+ usages).

**Collateral in asset terms:**
Correct: `withdraw-content.tsx` — `exchangeRate = assetBalance.div(shareBalance)`, then `collateralAssets = collateralShares.mul(exchangeRate)`. Grep: `collateralShares.mul(exchangeRate)`.
Correct (USD→tokens): `loans-table.tsx` — `getUserCollateral(true).div(getPrice(true))`.

**Position size for edit leverage:**
`useDepositPositionSize` in `market/v2/stores/market.ts`: increasing → `previewLeverageUp(newLev, debtToken)` → `{ newCollateral }` (USD), `{ newCollateralInAssets }` (tokens). Decreasing → `current × newLev / currentLev` (proportional). New deposit → `calculatePositionSize(tokenAmount, leverage)` + current.

**Debt preview for edit leverage:**
`useDepositDebt` in `market/v2/stores/market.ts`: decrease → `currentDebt × (newLev-1) / (currentLev-1)`. Increase → `previewLeverageUp().newDebt` used directly as `new.usd` (NOT added to current).

**Health factor preview gating:**
`deposit-content.tsx` — `nextHealthFactor` checks `isEditLeverage` first, then `hasAmount` with leverage/non-leverage branch. Each branch checks `=== null` before `.toNumber()` to preserve null→∞ semantics. `isHealthUpdating` must mirror same branch structure. Also OR's in `isLeverageInteracting` and `isLeverageDebouncing`.

**Success modal deposit amount:**
`deposit.tsx` — `submittedAmount` snapshotted via `useState` before mutation. Passed as prop to `TransactionCompleted`.

**Zap deposit approval + inputToken:**
`dashboard/v2/queries/index.ts` — branches: `isNativeZap` → skip ERC20, `isZapping` → `token.isZapAssetApproved()`/`approveZapAsset()`, else → `asset.allowance()`. `inputToken` uses `zapToken.interface.address` for zaps, `asset.address` for direct.

**Borrow preview rate with Merkl offset:**
`borrow-content.tsx` — extract `merklBorrowApy` into own `useMemo`, subtract from `borrowRate`: `token.getBorrowRate(true).sub(merklBorrowApy)`. Two instances: initial content (~line 399), transaction content (~line 653). Note: `borrow-content.tsx` does NOT use `previewImpactQuery` — that's for `deposit-content.tsx`.

**Leverage operation type routing:**
`deposit.tsx` — `if (leverage > 1)` routes to `depositAndLeverage`. Truthy check (`leverage && newLev.gt(0)`) fires at 1x, wasting gas on plugin approvals for 0-borrow deposit.

## [DISPLAY_BUG_PATTERNS]

### Pattern 1: Share/Asset Confusion

**Signature:** Displayed value less than expected by factor of `exchangeRate` (e.g., shows 1000 when actual 1100, exchangeRate 1.1).

**Detection:** `getUserCollateral(false)` in any file under `components/` or `src/app/`. Every hit in display code is suspicious. Legitimate uses exist in stores where raw shares feed into exchangeRate computation.

**Root cause:** `getUserCollateral(false)` returns raw cToken shares from `collateralPosted()`. Shares ≠ assets when exchangeRate > 1.

### Pattern 2: Total vs Delta

**Signature:** Value is roughly `current + expected` instead of `expected` (e.g., debt $15k instead of $10k — double-counted $5k).

**Detection:** `current.plus(preview.X)` or `currentValue + sdkReturnValue`. Check SDK source.

SDK methods returning totals: `previewLeverageUp().newDebt` (total), `previewLeverageUp().newCollateral` (total). SDK methods returning deltas: `previewLeverageUp().borrowAmount` (additional borrow needed).

### Pattern 3: Loading Defaults

**Signature:** Value flashes wrong 1-5 seconds, then resolves.

**Detection:** `?? new Decimal(0)`, `?? 0`, `?? null` as query fallbacks.

**Severity:** Default alarms users ($0 debt, 0% health) → real bug. Neutral default (skeleton, null → hidden) → acceptable.

### Pattern 4: Stale Cache vs Live Query

**Signature:** Two displays differ by interest accrued since page load.

**Detection:** Compare sources — `market.userDebt` (page-load snapshot) vs `debtBalanceQuery.data` (real-time fetch).

**Severity:** Usually P3 (sub-cent). Escalate only if visible in same viewport.

### Pattern 5: Null Propagation from External APIs

**Signature:** Crash `Cannot read properties of null`.

**Detection:** Trace to API call returning null. Common: KyberSwap `quote()` null on rejection (code 4000).

**Fix:** Null guard between response and first property access. Throw descriptive error.

### Pattern 6: AbortError from Signal Cancellation

**Signature:** Console flooded with `AbortError: signal is aborted without reason` per token symbol on HMR/navigation.

**Detection:** `catch` blocks in `queryFn` passing `signal` to `fetch`/`Promise.all` without filtering.

**Root cause:** React Query cancels in-flight queries by aborting signal. `fetch()` with aborted signal throws `DOMException { name: 'AbortError' }`.

**Fix:** (1) `signal?.throwIfAborted()` before `Promise.all`. (2) In catch: `if (error instanceof DOMException && error.name === 'AbortError') throw error;`. (3) `staleTime` to reduce refetches. (4) Global `queryCache.onError` filter.

## [QA_PAGE_CHECKLIST]

### Dashboard (`/dashboard`)

**Overview cards:** Total Rewards, Portfolio Value, Deposits, Debt — check sums match positions. Change indicators.

**Deposits tab:** Position list (amount, collateral, leverage, APY, health). Loading: watch ∞ health on leveraged positions (sentinel 9.99). Expand: Available to Withdraw, liquidation price, cap, LTV, health bar. Sort: verify order (share/asset confusion in sort accessor).

**Loans tab:** Debt amount, rate, health. Loading: watch 0.00% health (sentinel 0). Expand: debt details, repay availability.

**History tab:** Transaction rendering, pagination.

**Rewards tab:** Merkl aggregation, claimable amounts.

### Market Detail (`/market?address=0x...`)

**Sidebar actions:** Deposit, Borrow, Withdraw, Repay. Check: input validation ($10 min deposit, $10.10 min borrow), approval flows, TransactionSummary values, success modal values.

**Leverage flow:** Edit leverage slider. Position size preview matches result. Debt preview (total-vs-delta risk). Health preview for both increase AND decrease.

### Mobile Viewport

Components with `flex lg:hidden` / `hidden lg:flex` have separate rendering paths. Check collateral displays specifically. Check expanded details at narrow widths.

### Bytes Game (`/bytes`)

**State transitions:** Default→Running→Cashout/Busted. Multiplier smooth updates. "Busted" red text, frozen value.

**Multiplier colors:** Test at each boundary: 1.20x, 1.50x, 2.00x, 5.00x, 10.00x, 25.00x, 50.00x, 100.00x.

**Bet controls:** MAX → confirmation popup. Auto Cashout target. Amount persistence between rounds.

**Edge cases:** Insufficient balance, wallet disconnect mid-game, pending bet cancel, repeat bet with depleted balance.

**Mobile:** All states at narrow viewport. Vertical bet controls. Bottom sheet for MAX confirmation.

### Partner Tasks (Notification Panel)

**Auto-detection:** Complete each action → checkbox fills without refresh. Check timing.

**Accordion:** Expand/collapse, chevron rotate, no clipping. Multiple open simultaneously.

**Badge count:** Accurate incomplete count. Decrements. Disappears at 0.

**Completion flow:** All 4 checked → `Done` badge → snackbar → celebration modal → badge in collection.

**Desktop:** Dropdown ~320px, right-aligned from bell, dismiss outside/✕.

**Mobile:** Full-width bottom sheet, footer buttons, swipe dismiss.

## [PR_REVIEW_WORKFLOW]

1. **Check known bugs** — note unfixed bugs and file paths
2. **List changed files** in PR diff
3. **Per file:** Does it appear in tracked bug's path? Verify diff matches documented fix. Deviation → verify independently. Not tracked → flag as untracked change
4. **Untracked changes:** New fix → document + add to tracker. Refactor → check for new bugs. Feature → note, out of scope
5. **Check SDK deps** — if PR references fields like `newCollateral`, `newCollateralInAssets`, verify they exist in deployed SDK version
6. **Update tracker** — mark fixed, add discovered, update status

## [SENTINEL_VALUES]

| Field | Default/Sentinel | Displayed as | Risk |
|---|---|---|---|
| `positionHealth` (no debt) | `null` (SDK returns null for UINT256_MAX) | ∞ | Safe |
| `positionHealth` (very healthy) | Clamped `9.99` when ≥ 999 | ∞ | Low — misleading during loading for leveraged |
| `positionHealth` (loading) | `undefined` | Component-dependent | Watch new components — `loans-table` uses truthiness + InfinityIcon (safe) |
| `debtBalanceQuery.data` (loading) | `undefined` | Fallback-dependent | **High if `?? Decimal(0)`** → shows $0. Safe if `?? token.getUserDebt(true)` |
| `positionHealthPercentage` (no wallet) | `null` | ∞ | Safe |
| `maxRedemption` (loading) | Skeleton | Loading indicator | Safe |
