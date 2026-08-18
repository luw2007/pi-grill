# BUG-4: Converge question deregisters after first answer

- **Status**: Fixed (commit 80fd3a4)
- **Severity**: High (convergence permanently unreachable)
- **Story**: EVENT-07 / TOOL-07

## Symptom

`consumeConvergenceAnswer` deleted the question id from `pendingConvergenceQuestionIds` on the FIRST answer, keyword or not. Consequences:

- Answer "Not yet" first, change your mind, re-answer "确认" → dialog never re-triggers.
- Decline the dialog (BUG-3), re-answer with a keyword → dialog never re-triggers.

Either way convergence became unreachable unless the agent republished a fresh converge question.

## Root cause

Delete-on-consume conflated "answered once" with "no longer a converge question", contradicting the ledger contract that answered questions stay re-answerable with latest-wins.

## Fix

The id stays registered for the session lifetime; only skip (`commitPanelSkip`) deregisters. Keyword re-answers re-trigger the confirmation. Contract change documented in README ("Ending a session") and cemented by the updated unit test.

## Verification

`tests/grill-responsive-navigation.test.ts` › "matches convergence only for published converge questions and keeps them re-triggerable"; end-to-end re-trigger in the EVENT-07 audit test.
