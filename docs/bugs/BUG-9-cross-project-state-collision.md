# BUG-9: Same-named projects with the same idea shared one state file

- **Status**: Fixed (commit bfd57dd)
- **Severity**: High (cross-project interview contamination)
- **Story**: FS-01

## Symptom

`sessionPaths` keyed the state directory on `basename(cwd)` only. Two projects like `~/a/app` and `~/b/app` given the same idea text hashed to the identical `<tmpdir>/grill/app/<sha1(content)>.json`; `/grill` in project B found project A's state and offered to "Resume" a foreign interview (state.cwd said A, runtime ran in B, the plan would target B's directories with A's decisions).

## Root cause

Path namespace ignored the full cwd; nothing at load time validated `state.cwd === context.cwd` either.

## Fix

The session directory now appends an 8-char sha1 digest of the full cwd: `<tmpdir>/grill/<project>-<cwd-digest>/`. Collisions become impossible; README documents the shape. In-flight sessions from the old path lose resume (tmpdir state is ephemeral by design).

## Verification

`tests/grill-feature-audit.test.ts` › "FS-01: same-named projects with the same idea never share state" — two same-basename cwds, same idea; distinct paths, no foreign resume dialog, fresh session in B.
