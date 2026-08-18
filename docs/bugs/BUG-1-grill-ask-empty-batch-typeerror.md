# BUG-1: grill_ask empty batch crashes with TypeError

- **Status**: Fixed (landed in worktree during the audit; commit 80fd3a4)
- **Severity**: Low (agent-facing error quality)
- **Story**: TOOL-04

## Symptom

`grill_ask` with `questions: []` threw `undefined is not an object (evaluating 'questions[0].id')` instead of the intended validation error.

## Root cause

`execute` read `questions[0]!.id` before `addQuestions()` ran its "at least one question is required" guard.

## Fix

Reorder: `addQuestions(runtime, questions)` first, then read `questions[0]!.id` for `revealPanelCurrent`.

## Verification

`tests/grill-feature-audit.test.ts` › "TOOL-04: invalid batches are rejected atomically, including the empty batch" — asserts the clean message and that state is unchanged after every rejected batch.
