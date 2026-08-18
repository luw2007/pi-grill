# BUG-5: /grill rerun leaves grill_ask on the wrong session

- **Status**: Fixed (commit 80fd3a4)
- **Severity**: High (silent cross-session state corruption risk)
- **Story**: CMD-06 / LIFE-03

## Symptom

With two sessions in one cwd (idea A, then idea B), rerunning `/grill A` did not make A active: `grill_ask` kept publishing into B.

## Root cause

`activeRuntime` picks the last-inserted non-closed runtime by Map iteration order, but `runtimes.set(paths.json, runtime)` on an existing key updates in place — JS Maps preserve the ORIGINAL insertion position, so the rerun never became "latest".

## Fix

`runtimes.delete(paths.json)` before `runtimes.set(...)` in the `/grill` handler, refreshing insertion order.

## Verification

`tests/grill-feature-audit.test.ts` › "CMD-06/LIFE-03: rerunning targets the latest runtime for the cwd" — publishes into A after A→B→A rerun and asserts the questions land in A's ledger.
