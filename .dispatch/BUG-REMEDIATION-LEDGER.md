# Bug remediation dispatch ledger

Owner: `codex_gpt/gpt-5.6-terra`

| Node | Role / model | Isolation | Attempt | Frozen contract | Completion signal |
| --- | --- | --- | --- | --- | --- |
| B1 | acceptance / `glm_anthropic/glm-5.2` | `../grill-wt/bug-accept-core` | `bug-core-a1-158820e3` | Read-only acceptance of BUG-1, BUG-2, BUG-5, BUG-6 against `grill.ts` and named regression tests. No code or test edits. | `.done/bug-core-a1-158820e3` contains the inspected HEAD SHA. |
| B2 | acceptance / `glm_anthropic/glm-5.2` | `../grill-wt/bug-accept-convergence` | `bug-conv-a1-75706355` | Read-only acceptance of BUG-3, BUG-4, BUG-8 against `grill.ts` and named regression tests. No code or test edits. | `.done/bug-conv-a1-75706355` contains the inspected HEAD SHA. |
| B3 | host-contract review / `claude_sub2api/claude-sonnet-5` | `../grill-wt/bug-accept-shortcut` | `bug-shortcut-a1-3a4b72b7` | Read-only acceptance of BUG-7: default shortcut must be absent from Pi host registries; documentation and tests must agree. No code or test edits. | `.done/bug-shortcut-a1-3a4b72b7` contains the inspected HEAD SHA. |

Frozen source commit: `b5b86e791e1adb33c6f61afc08a7fda4778aa56c`.

Uncommitted `README.md` and `tests/grill-responsive-navigation.test.ts` existed before dispatch and are excluded from all worker ownership.

## Round 3 acceptance

| Node | Role / model | Isolation | Attempt | Frozen contract | Completion signal | Worker surface UUID | Original / marked tab title | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B4 | acceptance / `glm_anthropic/glm-5.2` | `../grill-wt/bug-accept-filesystem` | `bug-fs-a1-2fb3125a` | Read-only acceptance of BUG-9 and BUG-10 against source, bug records, and named regression test. No code/test/doc edits. | `.done/bug-fs-a1-2fb3125a` contains report commit SHA. | `CC0DA700-967F-4A4C-A512-A4E3DC29BE91` | `Terminal` / `Terminal λ` | accepted 2026-08-18T08:38:50Z; close authorized |
| B5 | host-contract review / `claude_sub2api/claude-sonnet-5` | `../grill-wt/bug-accept-host` | `bug-host-a1-058a9132` | Read-only acceptance of BUG-11 and BUG-12 against source, README, named test, and actual host dist. No code/test/doc edits. | `.done/bug-host-a1-058a9132` contains report commit SHA. | `36834045-8C70-4599-AE88-EAB2D9030716` | `Terminal` / `Terminal λ` | accepted 2026-08-18T08:38:50Z; close authorized |

## Reusable workflow

1. Triage every `docs/bugs/BUG-*.md`, then group only non-overlapping source/host contracts.
2. Commit a frozen dispatch ledger and one task file per group before creating workers.
3. Give each worker an isolated worktree, a ` λ`-marked caller-workspace tab, a model-specific role, exclusive report/marker paths, and a fresh `.done/<attempt>` identity.
4. Accept only after the marker, report, source evidence, prescribed regression, and owner-level integration verification agree; host-facing claims additionally require real host-dist evidence.
5. Re-list worker UUID/title/cwd before closing the marked tab. Record acceptance and close authorization in the ledger; retain worktrees for separate explicit cleanup.
6. Finish with inventory-to-index parity, complete contract suite, and an actual extension load smoke. Use targeted retries only; never duplicate a live exclusive worker.

Frozen source: current `main` commit at ledger commit time. Existing dirty `grill.ts` and `tests/grill-responsive-navigation.test.ts` are user-owned and excluded from worker ownership.
