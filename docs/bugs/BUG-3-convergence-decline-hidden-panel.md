# BUG-3: Declining plan confirmation strands a hidden panel

- **Status**: Fixed (commit 80fd3a4)
- **Severity**: High (dead-end UX on a primary flow)
- **Story**: EVENT-07

## Symptom

Answering the converge question hides the panel (normal post-answer behaviour), then the "Write the plan?" dialog appears. Declining it called `panel.handle?.focus()` on the still-hidden overlay: no panel visible, widget claiming `[hidden]`, focus stolen from the editor.

## Root cause

`maybeConfirmConvergence`'s `refocus` effect only focused; it never paired `setHidden(false)` + `hidden = false` + `setWidget` the way every other panel-reveal site does. `commitPanelAnswer` hides the panel synchronously before the async dialog resolves.

## Fix

`refocus` now reveals: `setHidden(false)`, `panel.hidden = false`, `focus?.()`, `setWidget(runtime)` — guarded by `finished` / generation / closed checks. README documents that declining reopens the panel.

## Verification

`tests/grill-feature-audit.test.ts` › "EVENT-07: declining the plan keeps the interview alive, reopens the panel, and stays confirmable". Independently confirmed as priority-1 by a reviewer subagent before the fix landed.
