# Bug remediation dispatch ledger

Owner: `codex_gpt/gpt-5.6-terra`

| Node | Role / model | Isolation | Attempt | Frozen contract | Completion signal |
| --- | --- | --- | --- | --- | --- |
| B1 | acceptance / `glm_anthropic/glm-5.2` | `../grill-wt/bug-accept-core` | `bug-core-a1-158820e3` | Read-only acceptance of BUG-1, BUG-2, BUG-5, BUG-6 against `grill.ts` and named regression tests. No code or test edits. | `.done/bug-core-a1-158820e3` contains the inspected HEAD SHA. |
| B2 | acceptance / `glm_anthropic/glm-5.2` | `../grill-wt/bug-accept-convergence` | `bug-conv-a1-75706355` | Read-only acceptance of BUG-3, BUG-4, BUG-8 against `grill.ts` and named regression tests. No code or test edits. | `.done/bug-conv-a1-75706355` contains the inspected HEAD SHA. |
| B3 | host-contract review / `claude_sub2api/claude-sonnet-5` | `../grill-wt/bug-accept-shortcut` | `bug-shortcut-a1-3a4b72b7` | Read-only acceptance of BUG-7: default shortcut must be absent from Pi host registries; documentation and tests must agree. No code or test edits. | `.done/bug-shortcut-a1-3a4b72b7` contains the inspected HEAD SHA. |

Frozen source commit: `b5b86e791e1adb33c6f61afc08a7fda4778aa56c`.

Uncommitted `README.md` and `tests/grill-responsive-navigation.test.ts` existed before dispatch and are excluded from all worker ownership.
