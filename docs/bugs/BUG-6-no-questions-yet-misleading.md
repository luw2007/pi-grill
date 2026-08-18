# BUG-6: "No questions yet" shown while questions are open

- **Status**: Fixed (commit 80fd3a4)
- **Severity**: Low (misleading copy in a niche state)
- **Story**: PANEL-22

## Symptom

After the completion summary was exited because an externally-added question appeared (watcher path, selection deliberately not moved), the answer pane claimed "No questions yet" although the ledger listed an open question.

## Root cause

`renderAnswer`'s no-row fallback did not distinguish "empty ledger" from "no selection".

## Fix

"No questions yet" only when `rows.length === 0`; otherwise "No question selected · ← or Ctrl+1…Ctrl+0 to pick one". (The concurrent `adoptOpenQuestion` work further narrows this state by auto-adopting open questions into a hidden panel.)

## Verification

`tests/grill-async-integration.test.ts` › "external current question is adopted into a hidden panel without reopening or focusing it" asserts the misleading string is absent.
