# Curvance Contract SDK

## Critical Constraints

- **ethers v6.** Never mix v5 patterns (`BigNumber`, `Contract.connect(signer)`).
- **Decimal.js** for all numeric math. Never use native JS `Number` for token amounts, prices, or rates.
- **Bulk-loaded cache model.** `setupChain()` fetches all data upfront; class getters read from cache synchronously.
- **All external fetch calls use `fetchWithTimeout()`** from `src/validation.ts`. No bare `fetch()`.
- **All production dependencies pinned to exact versions.** No caret ranges. `.npmrc` enforces `save-exact=true`.
- **Build:** `node node_modules/typescript/bin/tsc` (Windows-safe). CI uses `npm ci`, never `npm install`.

## Skills

Read the relevant Skill file(s) **in full** before starting any task. Most tasks touch 1-2 Skills. Follow Cross-References at the bottom of each Skill to find related ones.

| Skill | When to read |
|---|---|
| `Skill_CurvanceSDK.md` | Any SDK class work, method calls, type usage, security boundaries, or error handling. |
| `Skill_CurvanceApp.md` | How the v1 app consumes SDK methods — query hooks, mutations, store patterns. |
| `Skill_CurvanceQA.md` | Triaging display bugs, running browser QA, classifying symptoms by owning layer (app vs SDK vs contract). |
| `Skill_EpistemicHygiene.md` | Every session. Premise-checking, confidence calibration, gap-filling prevention. |

- Skill rules are hard constraints. If a rule feels wrong, flag it — don't silently skip it.
- Every Skill has a **WGW (What Goes Wrong)** table. Check output against relevant WGW entries before presenting work.
- If a referenced file is missing: stop and ask. Don't guess or reconstruct.

## Context Documents

Deep lookup companions. Only load specific `## [SECTION]` headers when a Skill's routing table directs you — never load Context files in full.

To load a section: `grep -n "^## \[" Context_File.md` → get labels + line numbers, then view the target range.

| Context | Companion skill |
|---|---|
| `Context_CurvanceSDK.md` | `Skill_CurvanceSDK.md` |
| `Context_CurvanceApp.md` | `Skill_CurvanceApp.md` |
| `Context_EpistemicHygiene.md` | `Skill_EpistemicHygiene.md` |

If Context content contradicts a Skill rule, flag the conflict — don't silently pick one.

## Behavior

- **Ambiguity:** if blocking or high-risk, stop and ask immediately. If minor, raise at next natural checkpoint.
- **Failed approach:** if it fails twice, stop and diagnose. Don't tweak and retry.
- **Verifying against source:** trace actual code paths (file, function, line) — don't self-assess from memory. Flag unverified claims.
- **Present output files** at the end of every task. No exceptions.
- Show the work. Skip preamble and recap.
- **README sync:** any change to public API surface (new methods, removed methods, renamed parameters, new classes, new exports, new chains, new types) must be reflected in `README.md` before the task is considered complete.

## Quick lookup

- **"What's the SDK method for X?"** → `Skill_CurvanceSDK.md` routing table
- **"How does the app consume this?"** → `Skill_CurvanceApp.md`
- **"This display value looks wrong"** → `Skill_CurvanceQA.md`
- **"Security audit / trust boundaries"** → `Skill_CurvanceSDK.md` → `#SECURITY_TRUST_BOUNDARIES`
