# pi-grill

A dependency-driven design interview for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

The agent interviews you about a plan or design one decision at a time, then writes an implementation plan once you confirm. The panel is **asynchronous**: publishing questions never blocks the agent, so it keeps investigating while you answer.

## Install

```bash
pi install git:github.com/luw2007/pi-grill@v0.1.0
```

Then restart pi or run `/reload`. To try it without installing: `pi -e git:github.com/luw2007/pi-grill`.

## Usage

```text
/grill port the review command to a pi extension
```

The agent then calls the `grill_ask` tool with one or more questions. They appear in a persistent TUI panel: a ledger of every question on the left, the selected question on the right.

| Keys | Action |
| --- | --- |
| `↑` / `↓` | Move between options |
| `←` | Previous question in the ledger |
| `→` / `Enter` | Confirm the selected option |
| `Tab` / `Shift+Tab` | Switch between the ledger and the answer pane |
| `Ctrl+1` … `Ctrl+9`, `Ctrl+0` | Jump straight to ledger question 1–10 |
| `Ctrl+S` | Skip the current question |
| `Ctrl+N` | Add a note for the agent, not tied to any question |
| `Esc` | Hide the panel; state is kept, reopen with `/grill-panel` |
| `Ctrl+C` / `Ctrl+D` | Return focus to the editor, then abort / shut down |

Ordinary options commit on `Enter`. Options marked `requiresText`, and the built-in *Something else (type it)*, open a mandatory text field first.

### Commands

| Command | Action |
| --- | --- |
| `/grill <idea>` | Start or resume an interview for that idea |
| `/grill-panel` | Reopen and focus the panel after `Esc` |

### Skips, notes, and changing your mind

- `Ctrl+S` marks a question `skipped`. Skipped questions do **not** block convergence and can still be answered later.
- `Ctrl+N` records a free-form note. Notes are appended to the state, steered to the agent immediately, and preserved in the final plan.
- Any answered or skipped question can be reopened and overwritten; the ledger keeps the latest answer.

### Ending a session

Convergence is dependency-driven: once no `pending` or `current` questions and no unresolved decision dependencies remain, the agent asks a final confirmation. Section coverage is never a convergence requirement. Confirming writes the plan into the first existing directory among `docs/plans/` and `plans/`, then closes the panel and clears the status widget. The plan derives its body headings and their order freely from substantive content—there is no fixed heading pool, required order, minimum section count, empty sections, or `N/A` placeholders—and always ends with a complete `## Interview transcript`. **The JSON state file is kept** — rerun `/grill` with the same description to resume, or delete it yourself.

## Tool contract

`grill_ask` takes a batch of questions and returns immediately:

```jsonc
{
  "questions": [
    {
      "id": "Q1",
      "section": "4. Design",          // free-form grouping label
      "question": "Which storage layer?",
      "context": "Why this matters and what the answer decides.",
      "options": [
        { "value": "sqlite", "label": "SQLite", "description": "…",
          "recommended": true, "recommendationReason": "…" },
        { "value": "other", "label": "Something custom", "requiresText": true }
      ],
      "recommended": "sqlite"
    }
  ],
  "converge": false
}
```

Answers arrive back asynchronously as a `grill-answers` custom message (batched within 500 ms), and notes as `grill-note`. The `section` value only groups and indexes ledger questions; it does not constrain or decide which headings appear in the plan.

## State

Each session has a single JSON state source under `<tmpdir>/grill/<project>/<hash>.json`, plus an HTML mirror rendered from it. The JSON is authoritative: the panel, the status widget, and the plan all derive from it. The section index is a derived `section → [{ id, status }]` projection of `questions`; it is not persisted as a second source of truth.

The state is `schemaVersion 4`. Upgrades are **not** backward compatible: a state file from an older schema, or one with missing or conflicting required fields, is treated as corrupt. pi-grill refuses to load it, leaves the file untouched, and asks you to delete or repair it.

## Configuration

Optional, at `~/.pi/agent/grill.config.json`:

```json
{
  "convergeKeywords": ["confirm", "converge", "yes"],
  "optionScrollThreshold": 8
}
```

`optionScrollThreshold` is how many option blocks are shown before the answer pane starts scrolling (1–100, default 8). An invalid config is reported and safe defaults are used.

## Alternate entrypoint

`grill-omp.ts` re-exports the same extension for hosts that load a differently named entrypoint:

```ts
export { default } from "./grill.ts";
```

The implementation stays single-sourced in `grill.ts`; the re-export exists only so such a host can point at `grill-omp.ts` without a second copy of the code. If you install with `pi install`, ignore it and use `grill.ts`.

## Notes for developers

Runs entirely in the pi TUI via `@earendil-works/pi-tui`. No network access and no npm runtime dependencies — `@earendil-works/pi-tui` and `typebox` are provided by pi as peer dependencies.

```bash
bun test
bunx tsc -p tsconfig.tests.json
```

## License

MIT
