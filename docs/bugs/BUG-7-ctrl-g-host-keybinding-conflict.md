# BUG-7: Ctrl+G shadows pi's built-in keybindings

- **Status**: Fixed (rebind amended into 80fd3a4; test alignment in 9a165f6)
- **Severity**: High (breaks a host feature for every pi user of the extension)
- **Story**: CMD-08

## Symptom

`pi.registerShortcut(Key.ctrl("g"))` collided with two host defaults in `@earendil-works/pi-coding-agent/dist/core/keybindings.js`:

- `app.editor.external`: `"ctrl+g"` — open external editor
- `tui.altScreen.searchNext`: `["enter", "ctrl+g"]` — next search match

## Root cause

The chord was chosen without cross-checking the host keybinding registry.

## Why the audit initially missed it

1. Mock harness: `registerShortcut` is a bare `Map.set` that always accepts — registration-domain conflicts are structurally invisible.
2. Live smokes were headless (`-p`), exercising zero key routing.
3. Methodology gap: acceptance criteria said "toggles the panel", never "chord absent from host registry".

## Fix

Rebound to `Key.ctrlAlt("g")` — the host registry has no `ctrl+alt+*` bindings and its alt-letter usage is only `alt+v`/`alt+enter`/`alt+arrows`. README key table and omp/integration tests updated.

## Verification

Host registry cross-check (app-level ctrl singles occupied: c d g l n o p t v x z, plus pi-tui editor emacs keys a b d e f j k u w y; `ctrl+alt+g` free in both `pi-coding-agent` and `pi-tui` keymaps); `bun run check` green; CSV CMD-08 acceptance now includes the registry-absence requirement.
