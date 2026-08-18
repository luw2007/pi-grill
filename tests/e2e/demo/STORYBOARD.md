# README demo GIF storyboard

Goal: one continuous, real-TUI take that shows what makes pi-grill different —
an **asynchronous** interview where the agent keeps investigating and refining
questions while you answer, skip, and steer it, ending in a real plan file.

Cast: real `pi` in a PTY, deterministic local mock model
(`mock-model-server.ts` demo scenario), VHS as the camera.

Scene: designing "a sync engine for the team snippets CLI".

| # | Beat | On screen | Feature showcased |
| --- | --- | --- | --- |
| 1 | `/grill sync engine for the team snippets CLI` | Agent immediately publishes a 2-question batch; panel opens: ledger Q1+Q2, Q1 focused, SQLite marked `· recommended` with a reason | Dependency-driven batch, ledger+answer panes, recommendations with reasons |
| 2 | Browse options (↓ ↓ ↑ ↑), Enter on the recommended option | Selection moves through descriptions, then Q1 commits; the panel hides while the agent keeps working | Answer commit; panel gets out of the way; agent is **not** blocked |
| 3 | Agent reacts to the answer | Panel reopens by itself with a NEW refinement question Q3 (sync transport) selected — ledger grew to 3 | Asynchronous steer loop: your answer immediately shapes the next question |
| 4 | Pick "Something else (type it)", type `CRDT log over SSH` | Mandatory free-text field, custom answer committed | Free-form answers beyond the offered options |
| 5 | Panel reopens on Q2 (conflict policy); Ctrl+S | Q2 flips to `↷ skipped`; summary shows it stays re-answerable | Skips never block convergence |
| 6 | Ctrl+N, type `encryption is out of scope for v1` | Note field, steered to the agent instantly | Off-script steering without touching the ledger |
| 7 | Agent converges | Final question "Ready to write the plan?" appears (converge batch) | Dependency-driven convergence — no section quotas |
| 8 | Enter → "Write the plan?" dialog → Yes | Confirm dialog; success notification; widget clears | Explicit, cancellable convergence gate |
| 9 | `cat docs/plans/*.md` | Real plan file with `## Interview transcript` listing answered/skipped/custom entries and the note | The deliverable: a plan that preserves every decision, produced by the real `write` tool |

Timing: ~35 s total, FontSize 14, 1200×800, ~15 fps. Every wait is padded
(mock turns answer in <1 s) so the tape is deterministic run-to-run.

Regenerate: `bash tests/e2e/demo/record-demo.sh` → `assets/demo.gif`.
