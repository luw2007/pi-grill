# Grill：问题上下文与选项区滚动实施计划

- **状态**：已确认，待实施
- **日期**：2026-08-13
- **目标实现**：`~/.pi/agent/extensions/grill.ts`
- **验证范围**：`/Users/luwei.will/ai/grill/tests/`
- **唯一状态源**：当前 Grill JSON 状态文件
- **非目标**：HTML bridge；HTML 镜像不显示问题 `context`

## ① 背景与问题

Grill 的问题已有选项推荐与推荐理由，但缺少紧邻题干的“为什么问、答案决定什么”上下文。选项较多时，右侧答题区完整渲染所有选项，会挤压快捷键提示并影响窄终端可用性。

## ② 目标与非目标

目标：
- 为问题增加可选的单一 `context` 文本块，并在题干与选项之间显示。
- 选项超过配置阈值时，以完整选项块为原子单位滚动。
- 每题保存选项滚动 offset，复用现有 UI checkpoint 与 JSON 唯一状态源。
- 保持普通题目、`requiresText`、`其他`、异步提交、答案覆盖和完成态行为不变。

非目标：
- 不拆分为多个 context 字段。
- 不在 HTML 镜像显示 context。
- 不引入 sidecar 状态或 HTML 输入桥接。
- 不提供旧状态降级/自动迁移。

## ③ 现状调研结论

当前 runtime 已具备：异步 `grill_ask` 发布、单例 overlay、完整 ledger、JSON watcher、原子单题提交、500ms `grill-answers` 聚合、UI checkpoint，以及选项选择索引 `selectedOptionByQuestion`。现有左侧题目列表有固定窗口；右侧选项没有独立窗口。

新状态必须继续由 JSON 驱动。合法性失败时应拒绝加载并保留文件，不得静默覆盖。

## ④ 方案设计

### 4.1 问题 context

新增可选 `context?: string` 到 `GrillQuestion`、`AskQuestion`、`GrillOption` 输入对应的 TypeBox 问题 schema、pinned 快照。渲染顺序为：题干 → context 文本块（存在且非空时）→ 选项列表。HTML 不读取、不显示 context。

### 4.2 选项窗口

新增固定语义常量/配置读取：`optionScrollThreshold`，默认 8。配置来源为 `~/.pi/agent/grill.config.json`；配置项必须为正整数并通过上限校验，非法配置拒绝使用并提示，同时采用安全默认值（实现时固定并测试该策略）。超过阈值时只渲染当前窗口内的完整选项块；description、recommendationReason、`requiresText` 提示与选项标题同块显示。窗口下方显示 `showing x–y of n · ↑↓ scroll`。

每题 offset 存在于 `ui.optionScrollOffsetByQuestion: Record<string, number>`。上下键改变 selected option，并确保当前选项可见；offset 按题目可见块数量钳制。连续上下移动使用已有防抖 checkpoint，进入题目/提交/关闭 panel 等语义事件立即 flush。

## ⑤ 备选方案与权衡

- 单一 context 优于结构化两个字段：契约小、渲染简单、兼容缺失字段。
- 完整选项块优于按行 viewport：不会将标题与解释拆开，焦点语义清晰。
- JSON UI offset map 优于组件内状态或 sidecar：可恢复且维持唯一状态源。
- 默认阈值 8，但允许通过 `grill.config.json` 调整：保留默认稳健性，同时适配不同终端。

## ⑥ 接口/数据结构变更

- `GrillQuestion` / `AskQuestion` / pinned snapshot：`context?: string`。
- `GrillUiState` / schema：`optionScrollOffsetByQuestion: Record<string, number>`。
- 状态版本：将 `SCHEMA_VERSION` 从 2 升到 3；本功能为全新未发布能力，不提供 v2→v3 迁移。任何 `schemaVersion !== 3` 的状态，以及 v3 缺失/冲突的新必需字段，均视为损坏；拒绝加载并保留原文件，提示用户删除或修复后重新开始。
- 配置：`~/.pi/agent/grill.config.json` 增加 `optionScrollThreshold?: number`，与既有 `convergeKeywords` 校验合并。
- `migrateState`/加载校验对缺失或冲突的必需新字段拒绝加载并保留原文件；错误信息包含 JSON 路径及“请删除或修复后重新开始”。

## ⑦ 风险与影响面

- 旧 JSON 无新必需 UI 字段时会被拒绝，符合用户选择；不得自动删除。
- 长 context 与长选项块可能占满答题区，需要复用现有 ANSI 可见宽度与换行逻辑。
- watcher 外部更新可能移除/重排选项；重新读取时必须按当前选项数量钳制 selected index 与 offset。
- option offset 不能进入业务答案或 `grill-answers` payload。
- 配置非法不能导致 panel 崩溃；需要明确日志/notify 与默认行为。

## ⑧ 测试计划/验证方式

### 纯函数/状态测试

- context 缺失的历史题仍可读；context 能写入 pinned 快照。
- 新状态 UI 字段形状校验；旧/冲突字段拒绝加载且原文件不变。
- option index/offset 在 0、阈值边界、超长选项集合、外部更新后正确钳制。
- 配置缺失、合法、零/负数、过大数、非法 JSON 的行为。

### fake TUI 集成测试

- context 出现在题干之后、选项之前。
- 7 项不滚动，8 项按配置语义处理，超过阈值显示窗口和 `showing x–y of n · ↑↓ scroll`。
- 上下键滚动完整选项块且当前选项始终可见；重新进入题目恢复 offset。
- context/offset 不破坏普通即时提交、`requiresText`、其他、答案覆盖、完成摘要、隐藏/展开 widget、500ms steer。

### 真实 Pi TUI 冒烟

在 80/120/160 列和至少 9/12 个选项下验证：context 可读、选项块不截断、上下键窗口移动、底部帮助可见、关闭/`/grill-panel` 重开后 offset 恢复；记录 Pi 版本、宽度和 JSON 快照。

## ⑨ 回滚/清理方案

只前滚修复，不提供降级脚本。新版本遇到旧/冲突 JSON 时保留文件并提示用户删除或修复后重开。配置可删除以回到默认阈值。若实现发布前失败，继续发布兼容当前新 schema 的修复版本，不切回旧读取器。

## ⑩ 开放问题/待跟进事项

- 真实 TUI 冒烟后再根据证据调整默认值或配置上限。
- 若未来需要 HTML context 展示，另开独立设计，不在本轮扩大范围。

## 原始问答流水账

- **Q1｜answered｜① 背景与问题**：选项区默认最多显示多少项后启用滚动窗口？用户选择：8 项。理由：无。
- **Q2｜answered｜② 目标与非目标**：问题级 context 采用何种结构？用户选择：单一 context 文本块。理由：无。
- **Q3｜answered｜③ 现状调研结论**：context 覆盖哪些投影？用户选择：只保留 JSON 题目和 pinned 快照。理由：无。
- **Q4｜answered｜④ 方案设计**：选项描述与推荐理由如何随滚动处理？用户选择：完整选项块为原子单位滚动。理由：无。
- **Q5｜answered｜⑤ 备选方案与权衡**：offset 如何持久化？用户选择：ui 内按题目 id 的 offset map + 现有检查点机制。理由：无。
- **Q6｜answered｜⑥ 接口/数据结构变更**：schema 如何演进？用户选择：全新未发布功能，直接不兼容升级；字段冲突视为数据损坏，让用户删除。理由：无。
- **Q7｜answered｜⑦ 风险与影响面**：校验失败如何恢复？用户选择：拒绝加载并保留文件，提示用户删除或修复。理由：无。
- **Q8｜answered｜⑧ 测试计划/验证方式**：验收层级？用户选择：纯函数/迁移测试 + fake TUI 集成 + 真实 Pi TUI 冒烟。理由：无。
- **Q9｜answered｜⑨ 回滚/清理方案**：回滚策略？用户选择：只前滚修复；损坏/旧状态由用户删除后重开。理由：无。
- **Q10｜answered｜⑩ 开放问题/待跟进事项**：是否配置化阈值？用户选择：加入 grill.config.json 可配置阈值。理由：无。
- **Q11｜answered｜⑩ 开放问题/待跟进事项**：是否生成 plan？用户选择：确认生成 plan。理由：无。
