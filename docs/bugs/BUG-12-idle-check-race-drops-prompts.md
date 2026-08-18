# BUG-12: isIdle() race can silently drop the kickoff or plan prompt

- **Status**: Fixed
- **Severity**: Medium (rare, but silently loses the session's most important message)
- **Story**: HOST-05
- **Found by**: Round-3 steer-contract audit against pi-coding-agent dist

## Symptom

`/grill` kickoff and the post-convergence plan prompt were sent as `sendUserMessage(text, isIdle() ? undefined : { deliverAs: "followUp" })`. If the agent started a run between the `isIdle()` check and the send, the host's `prompt()` throws "Agent is already processing. Specify streamingBehavior..." (`agent-session.js:830-836`); the rejection is routed to an extension-error event (`agent-session.js:1855-1861`) and the prompt is silently dropped — no interview kickoff / no plan is written.

## Root cause

Check-then-act on shared host state. The conditional was needless: `deliverAs: "followUp"` runs immediately when idle and queues when streaming (`agent-session.js:830-836` else-branch) — it never throws.

## Fix

Both call sites now pass `{ deliverAs: "followUp" }` unconditionally; the `isIdle()` checks are gone.

## Verification

Suite green (79 tests); CMD-01 audit test now pins the contract: kickoff `options` must equal `{ deliverAs: "followUp" }`.

## Related round-3 clearances (no defects)

- `details.state` (full ledger JSON on every grill-answers/grill-note) never reaches the model: `convertToLlm` maps custom messages to `{role:'user', content}` only (`messages.js:89-97`), in live turns, reloads, and compaction alike.
- Observations: each confirm appends the full ledger verbatim to the session JSONL (disk-only, ~quadratic over a long interview), and each grill-answers `content` carries a full state summary that accumulates in model context across confirms — the context-size lever, if ever needed, is `content`, not `details`.
- 0.80.10 (OMP) vs 0.84.2 drift in `sendCustomMessage` streaming gating is benign for grill's fixed `{triggerTurn: true, deliverAs: "steer"}` calls.
