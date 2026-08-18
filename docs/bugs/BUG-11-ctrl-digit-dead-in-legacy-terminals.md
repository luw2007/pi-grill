# BUG-11: Ctrl+1…0 / Ctrl+Alt+G silently dead in legacy terminals

- **Status**: Fixed (documentation + existing escape hatches; no code change by design)
- **Severity**: Medium (documented keys do nothing, no error, terminal-dependent)
- **Story**: HOST-04

## Symptom

README promised `Ctrl+1`…`Ctrl+0` (ledger jump) and `Ctrl+Alt+G` (toggle) unconditionally. In Terminal.app and default tmux they do nothing.

## Root cause (verified from pi-tui 0.84.2 dist)

pi-tui negotiates the kitty keyboard protocol at startup (`\x1b[>7u\x1b[?u\x1b[c`, terminal.js:13-15/120/173) and falls back to xterm modifyOtherKeys mode 2 (`\x1b[>4;2m`, terminal.js:259). But ctrl+digit has NO legacy encoding at all — `rawCtrlChar` returns null for digits (keys.js:563-577), and the parser accepts only CSI-u (`\x1b[49;5u`) or modifyOtherKeys (`\x1b[27;5;49~`) forms. Terminal.app supports neither protocol; default tmux eats the kitty push and answers device-attributes itself. Result: the terminal sends a plain digit, grill never sees the chord. `Ctrl+Alt+G` survives via legacy `ESC+\x07` only where the terminal emits Option-as-Meta. The host itself binds zero ctrl+digit and zero ctrl+alt+letter chords — grill exceeded host precedent.

Round-1/2 tests could not catch this: they inject CSI-u sequences directly into `handleInput`, proving parsing, not terminal deliverability.

## Resolution

Documentation + escape hatches instead of code (lazy path; all navigation already reachable):

- README key table now carries a terminal note naming the protocol requirement, the working terminals, and the fallbacks (arrow-key navigation; configurable `toggleShortcut`).
- Ledger rows 1–10 were always reachable via `↑`/`↓`/`←`; the jump chords are accelerators, not the only path.
- `toggleShortcut` (config) lets legacy-terminal users pick a deliverable chord (e.g. `alt+g`, legacy `ESC g` everywhere).

## Deliverability matrix (from parser + init evidence)

| Chord | kitty terminals | Terminal.app | default tmux |
| --- | --- | --- | --- |
| Ctrl+1…0 | OK (CSI-u) | dead | dead |
| Ctrl+Alt+G | OK | only with Option-as-Meta | OK (legacy ESC+ctrl-char) |
| Ctrl+S / Ctrl+N / Shift+Tab / arrows / Esc / Enter | OK | OK | OK |

## Lesson

Key handling has a third contract layer below host routing: terminal encoding. A chord must have (1) a registry-free binding, (2) a reachable dispatch path, and (3) a deliverable encoding in the user's terminal class. Tests injecting escape sequences validate only layers 1–2.
