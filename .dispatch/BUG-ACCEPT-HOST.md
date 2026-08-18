# 目标

Read-only acceptance for BUG-11 and BUG-12 at the committed frozen source stated in the dispatch ledger.

# 输入（只读）

- `docs/bugs/BUG-11-ctrl-digit-dead-in-legacy-terminals.md`
- `docs/bugs/BUG-12-idle-check-race-drops-prompts.md`
- `README.md`, `grill.ts`, `tests/grill-feature-audit.test.ts`
- installed host dist under `node_modules/@earendil-works/pi-tui/dist` and `node_modules/@earendil-works/pi-coding-agent/dist`

# 输出

Create root `BUG-ACCEPT-HOST.md`. Give PASS or BLOCKED for each bug, citing exact source, documentation, test, and host-dist evidence. Do not edit production code, tests, README, or bug records.

# 独占文件/接口

Only `BUG-ACCEPT-HOST.md` and `.done/bug-host-a1-058a9132`.

# 完成信号

Commit the report. Then write `.done/bug-host-a1-058a9132` containing that report commit SHA.

# 验证标准

Run only `bun test tests/grill-feature-audit.test.ts`. No formatter, linter, or project-wide suite mid-flight.
