# BUG-8: Toggle key silently swallowed while the panel is focused

- **Status**: Fixed
- **Severity**: Medium (documented key does nothing in the most common focus state)
- **Story**: PANEL-23
- **Found by**: Round-2 host-contract audit (key-routing scout), not by behaviour tests

## Symptom

README promises "Ctrl+Alt+G — Toggle the active Grill panel", but with the panel focused the chord did nothing: not hide, not error.

## Root cause

pi's dispatch makes the focused component a terminal input stop with no fallthrough (`pi-tui/dist/tui.js:615-625`); extension shortcuts registered via `registerShortcut` are wired only onto the editor's input path (`custom-editor.js:25-28`). So the global toggle handler is unreachable whenever the overlay holds focus — and the panel's own `handleInput` had no branch for the toggle chord.

## Fix

Panel `handleInput` matches `runtime.config.toggleShortcut` in the select phase and hides the panel (same semantics as the global handler's open→hide arm). Text phases (note/other/reason) are untouched, so a draft can never be lost to the toggle key.

## Verification

`tests/grill-feature-audit.test.ts` › "PANEL-23: the toggle shortcut hides a focused panel and never commits a draft" — kitty CSI-u sequence `ESC [103;7u` hides from select phase; the same chord inside a note draft leaves the panel open.

## Lesson

Key-routing conflicts have two directions: a global chord can shadow the host (BUG-7), and the host's focus model can starve a global chord (BUG-8). Auditing registration tables alone catches only the first; the dispatch chain must be read too.
