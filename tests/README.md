# SDK Test Harness

This directory now has two explicit validation layers:

1. `test:transport`
   - Fast, deterministic, no live chain required
   - Validates transport policy, setup wiring, reader normalization, and query-budget expectations
2. `test:fork`
   - Real integration against an Anvil-compatible fork
   - Validates the SDK against live chain state, real writes, and real post-write refreshes

Use them for different jobs. `test:transport` is the routine safety net. `test:fork` is the integration gate.

## Recommended Workflow

### Every dev session

Run:

```bash
npm run test:transport
```

This is the right default after transport/setup/query changes because it is fast and deterministic.

### Before publishing the SDK

Run:

```bash
npm run test:transport
npm run test:fork
npm run build
```

WGW candidate: treating `test:transport` as sufficient for publish confidence. It proves policy logic, not live fork correctness.

## Test Suites

### `npm run test:transport`

Runs:

- `tests/retry-fallback.test.ts`
- `tests/rpc-ranking.test.ts`
- `tests/protocol-reader.test.ts`
- `tests/setup-race.test.ts`
- `tests/query-budget.test.ts`

What it proves:

- retry vs non-retryable classification
- fallback cascade and cooldown behavior
- dynamic fallback ranking
- debug snapshot privacy constraints
- `setupChain` read-provider vs signer wiring
- `ProtocolReader` normalization for public and connected loads
- query-budget expectations for boot and targeted refresh paths

What it does not prove:

- real provider compatibility
- real chain state correctness
- write/read freshness on a live fork

The transport harness used by these tests lives in:

- `tests/support/transport-harness.ts`

### `npm run test:fork`

Runs:

- `tests/fork-integration.ts`

What it proves:

- public account-only `setupChain` can rehydrate signer-created state
- `getMarketStates([market])` matches live cache after a real write
- `refreshActiveUserMarkets()` only refreshes the markets that actually became active

What it depends on:

- an Anvil-compatible fork endpoint
- Anvil/debug RPC methods such as:
  - `evm_snapshot`
  - `evm_revert`
  - `anvil_setStorageAt`
  - `anvil_setBalance`
  - `anvil_impersonateAccount`

If `TEST_RPC` is not set, the suite skips and prints an explicit warning.

## Environment

### Required for `test:fork`

- `TEST_RPC`

### Optional for `test:fork`

- `TEST_CHAIN`
  - defaults to `monad-mainnet`
- `TEST_API_URL`
  - defaults to `https://api.curvance.com`

### Not required for the new fork harness

- `DEPLOYER_PRIVATE_KEY`

Some older tests still use `DEPLOYER_PRIVATE_KEY`, but the new `fork-integration.ts` flow does not.

## Why `TEST_RPC` Is Usually `127.0.0.1:8545`

`TEST_RPC` should usually point to your local Anvil fork, not your upstream provider.

Example:

```text
TEST_RPC=http://127.0.0.1:8545
```

Reason:

- the SDK fork tests need Anvil-only RPC methods
- hosted RPC providers do not expose those methods
- Anvil does, so the test target is usually the local fork node

The upstream provider is only used to start the fork.

## Bringing Up the Fork

### Git Bash

Start Anvil:

```bash
anvil --fork-url "https://your-upstream-rpc" --auto-impersonate
```

Set env and run:

```bash
export TEST_RPC=http://127.0.0.1:8545
export TEST_CHAIN=monad-mainnet
npm run test:fork
```

### PowerShell

Start Anvil:

```powershell
anvil --fork-url "https://your-upstream-rpc" --auto-impersonate
```

Set env and run:

```powershell
$env:TEST_RPC="http://127.0.0.1:8545"
$env:TEST_CHAIN="monad-mainnet"
npm.cmd run test:fork
```

## Do I Need an API Key?

Not for the SDK test command itself.

You only need an API key if your upstream RPC provider requires one when you start Anvil, for example:

```bash
anvil --fork-url "https://arb-mainnet.g.alchemy.com/v2/<API_KEY>"
```

Once Anvil is running, the SDK test uses `TEST_RPC` and talks to the local fork.

## Current Test Inventory

### New harness-backed / release-gate direction

- `retry-fallback.test.ts`
- `rpc-ranking.test.ts`
- `protocol-reader.test.ts`
- `setup-race.test.ts`
- `query-budget.test.ts`
- `fork-integration.ts`

### Older feature/integration coverage

- `basic.test.ts`
- `leverage.test.ts`
- `zap.test.ts`
- `optimizer.test.ts`
- `conversion.test.ts`
- `arb-basic.test.ts`
- `position-health-preview.ts`
- `position-health-anvil.ts`

These older tests are still useful, but they are not yet organized as the new harness-based publish gate.

## Practical Release Gate

For SDK changes that affect chain interaction, use this minimum gate:

```bash
npm run test:transport
npm run test:fork
npm run build
```

For app-side rollout after publishing the SDK:

1. install or link the new SDK build into the app
2. run the app's targeted query/integration tests
3. run `yarn build`
4. run app smoke coverage on the release candidate
