# Bug records

One file per confirmed product defect from the 2026-08-18 feature audit (see `../feature-status.csv` for the full 62-story matrix). Round-1 test-harness errors (PANEL-17/20, EVENT-05 fixtures) are not product bugs and live only in the CSV.

| ID | Title | Status |
| --- | --- | --- |
| [BUG-1](BUG-1-grill-ask-empty-batch-typeerror.md) | grill_ask empty batch crashes with TypeError | Fixed |
| [BUG-2](BUG-2-widget-false-converged-and-open.md) | Widget claims "converged" / "[open]" falsely | Fixed |
| [BUG-3](BUG-3-convergence-decline-hidden-panel.md) | Declining plan confirmation strands a hidden panel | Fixed |
| [BUG-4](BUG-4-converge-question-one-shot.md) | Converge question deregisters after first answer | Fixed |
| [BUG-5](BUG-5-active-runtime-stale-map-order.md) | /grill rerun leaves grill_ask on the wrong session | Fixed |
| [BUG-6](BUG-6-no-questions-yet-misleading.md) | "No questions yet" shown while questions are open | Fixed |
| [BUG-7](BUG-7-ctrl-g-host-keybinding-conflict.md) | Ctrl+G shadows pi's built-in keybindings | Fixed |
| [BUG-8](BUG-8-toggle-key-swallowed-in-panel.md) | Toggle key silently swallowed while the panel is focused | Fixed |
| [BUG-9](BUG-9-cross-project-state-collision.md) | Same-named projects with the same idea shared one state file | Fixed |
| [BUG-10](BUG-10-watcher-error-crashes-host.md) | Purged session directory could crash the host process | Fixed |
| [BUG-11](BUG-11-ctrl-digit-dead-in-legacy-terminals.md) | Ctrl+1…0 / Ctrl+Alt+G silently dead in legacy terminals | Fixed (docs) |
| [BUG-12](BUG-12-idle-check-race-drops-prompts.md) | isIdle() race can silently drop the kickoff or plan prompt | Fixed |

Discovery methodology gap behind BUG-7 (and the follow-up audit round): a mock harness can never surface registration-domain conflicts — every host-facing registration (shortcut, command, tool) must be cross-checked against the host's actual registry (`node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js`, `pi-tui/dist/keybindings.js`), and acceptance criteria must state "absent from host registry", not just behaviour.

## Round-2 host-contract audit (2026-08-18, post BUG-7)

Methodology: verify every host-facing surface against the real host implementation (pi dist sources, OMP plugin space, user config), not mock harnesses. Three scouted surfaces, all clean except BUG-8:

- **Key routing** — focused overlay is pi's input terminal stop (`pi-tui/dist/tui.js:615-625`, no fallthrough): every panel key (Ctrl+S/N, Ctrl+1…0, Tab, Shift+Tab, Esc, arrows, Enter, Ctrl+C/D) is conflict-free; host ctrl+n/ctrl+s bindings are picker-scoped. Ctrl+Alt+G passes the host shortcut conflict gate (`runner.js:319-348`). Produced BUG-8.
- **Overlay/UI contract** — pi's `OverlayHandle` guarantees all six methods (`tui.d.ts:112-124`); OMP's native runtime provably omits only `focus()` (guarded `focus?.()`); `confirm/select/input/notify/setWidget` signatures identical across pi 0.84.2 and OMP-bundled 0.80.10.
- **Duplicate registration** — pi loads grill exactly once (`~/.pi/agent/extensions/grill.ts` is a symlink to this repo; no package copy) and OMP exactly once (pi-grill plugin); no other extension/plugin collides with `grill`, `grill-panel`, `grill_ask`, or `ctrl+alt+g`; hypothetical duplicates degrade to last-wins diagnostics, never double execution.

### Observations (not defects)

- `~/.pi/agent/extensions/grill.ts` symlinks the live worktree: every global pi session loads uncommitted WIP, and a torn write mid-edit briefly breaks extension load (observed once during the audit).
- `~/.omp/plugins/package.json` lists the `pi-grill` dependency key twice (harmless JSON last-wins; sign of a double install).
- `~/.pi/agent/extensions.incoming.*/grill.ts` are inert schema-v1 relics; if some external tool ever promotes them into `extensions/`, grill would double-register (host degrades this to diagnostics).
- While the panel is focused, Esc hides the panel rather than interrupting a running agent (`app.interrupt` is editor-scoped); interrupt is two keystrokes (Esc, Esc) or panel Ctrl+C. Deliberate host focus semantics.
- Host `shift+ctrl+d` (debug dialog) is the only chord that pierces a focused overlay.
- Version skew: repo typechecks against pi 0.84.2 while OMP bundles 0.80.10 — every surface grill touches is line-identical today; runtime verification remains the only trustworthy evidence per OMP release.

## Round-3 host-contract audit (2026-08-18, post BUG-8)

Surfaces: filesystem contract (audited by hand), terminal key-encoding, and message-delivery contract (two scouts against pi dist). Produced BUG-9/10/11/12. Clearances and observations:

- **Model context is safe from `details`** — `convertToLlm` maps custom messages to `{role:'user', content}` only (`messages.js:89-97`); `details.state` never reaches the LLM in live turns, session reloads, or compaction.
- Each grill-answers confirm appends the full ledger verbatim (`details`) to the session JSONL — disk-only, ~quadratic growth over a long interview; and each confirm's `content` carries a full state summary that accumulates in model context. If context size ever matters, trim `content`'s summary, not `details`.
- pi-tui negotiates the kitty keyboard protocol at startup (`\x1b[>7u\x1b[?u\x1b[c`, `terminal.js:13-15/120/173`) with a modifyOtherKeys fallback (`\x1b[>4;2m`); ctrl+digit has no legacy encoding at all (`rawCtrlChar` → null for digits), which is the mechanism behind BUG-11.
- `sendCustomMessage` drift between 0.84.2 and 0.80.10 (streaming branch triggerTurn gating) is benign for grill's fixed `{triggerTurn: true, deliverAs: "steer"}`.
- Two same-project pi sessions on one state file coordinate via watcher sync and monotonic revisions, but truly simultaneous commits are last-rename-wins; one answer can be lost. File locking would be overengineering for an interactive TUI — known limitation.
- Interview state stays in tmpdir (user decision 2026-08-18): it is interview scratch, not a durable artifact; README now states the lifetime. BUG-10 makes purges survivable.
- grill-answers/grill-note events now carry an incremental open-questions summary instead of the full state summary (user decision 2026-08-18) — the accumulating-context lever identified by the steer-contract audit; the `grill_ask` result keeps the full summary.
