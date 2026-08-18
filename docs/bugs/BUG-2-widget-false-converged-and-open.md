# BUG-2: Widget claims "converged" / "[open]" falsely

- **Status**: Fixed (commit 80fd3a4)
- **Severity**: Medium (misleading primary status surface)
- **Story**: PERSIST-06

## Symptom

Two false claims in the status widget:

- **2**: `current converged` whenever no question had status `current` — even with `pending` questions still open (e.g. after answering Q1 of a two-question batch, Q2 pending).
- **2b**: `[open] Esc to hide` right after `/grill`, before any panel existed.

## Root cause

`setWidget` used `currentQuestionId ?? "converged"` (ignores pending) and `runtime.panel?.hidden ? hidden : open` (undefined panel → falsy → "open").

## Fix

`setWidget`: current label falls back `currentQuestionId → first pending id → "none"` (empty ledger) `/ "converged"`; visibility reports `[open]` only for an existing, non-hidden panel.

## Verification

`tests/grill-feature-audit.test.ts` › "PERSIST-06: widget never claims converged while open questions remain" and "widget reports no panel as hidden before the panel ever opens". Existing assertions ("current Q1", "current converged" after all answered) unchanged.
