# BUG-10: Purged session directory could crash the host process

- **Status**: Fixed (commit bfd57dd)
- **Severity**: High (host crash) / realistic trigger (macOS purges /var/folders periodically)
- **Story**: FS-02

## Symptom

Two failure modes when the tmpdir session directory disappears mid-session (macOS tmp cleaner, manual `rm`):

1. The `fs.watch` FSWatcher had no `error` listener — an emitted watcher error is an unhandled EventEmitter `error`, which throws and takes down the whole pi process.
2. `writeAtomic` assumed the directory existed — the next answer/skip/note commit failed until restart.

## Fix

- `startRuntime` attaches `watcher.on("error", ...)`: closes the watcher and notifies ("external JSON edits no longer sync, answers still persist") instead of crashing.
- `writeAtomic` runs `mkdirSync(dirname, { recursive: true })` before writing — the first commit after a purge recreates the directory and state.

## Verification

`tests/grill-feature-audit.test.ts` › "FS-02: a purged session directory neither crashes the host nor loses the next answer" — `rm -rf` of the live session directory, then a panel answer: no crash, state file re-created with the answer committed.
