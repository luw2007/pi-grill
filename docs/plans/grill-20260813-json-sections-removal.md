# grill JSON 初始化去除固定 10 个 sections：设计记录

- **状态**：已实现
- **日期**：2026-08-13
- **目标文件**：`~/.pi/agent/extensions/grill.ts`
- **决策来源**：直接对话确认（非 `grill_ask` 访谈），未使用 `/grill` 工具本身

## ① 背景与问题

用户观察到每次 `/grill` 会话的 JSON 状态在启动时固定带有十个字段的 `sections` 记录（`① 背景与问题`…`⑩ 开放问题/待跟进事项`，值均为空字符串），误以为是"固定生成 10 个初始化问题"，认为应改为动态生成。

排查确认：这不是 10 个问题，`initialState()` 生成时 `questions: []`；固定的是 `GrillState.sections`——十章节 plan 模板在会话状态里以空字符串预先占位。该模板本应是工具内置常量（`SECTION_KEYS`），却被同时建模进了每个会话的持久化 JSON，造成"状态数据"与"工具模板"边界不清。

## ② 目标与非目标

### 目标

- 只从 JSON 初始化状态里删除 `sections` 字段本身；十章节模板改为工具运行时按需从 `questions` 派生，不再持久化空占位。

### 非目标

- 不删除十章节模板概念本身：`SECTION_KEYS` 常量、`question.section` 合法性校验、收敛门槛（十章节皆有结论方可收敛）、最终 plan 必须包含十个二级标题的硬约束——均评估为有意保留的产出质量契约（对照已有两份历史 plan 均遵循此结构），用户确认保留。
- 不改变问题动态生成、面板交互、收敛关键词匹配等其余既有逻辑。

## ③ 现状调研结论

`~/.pi/agent/extensions/grill.ts` 中 `sections: Record<string, string>` 曾同时承担三重职责：

1. `initialState()` 用 `sectionRecord()` 生成十个空字符串键作为会话初始状态；
2. `rebuildSections()` 在每次 `applyAnswerBatch` 后原地重写 `state.sections`，从已回答/废弃问题按 `question.section` 归类拼接结论文本；
3. `canConverge()`、`stateSummary()` 直接读取 `state.sections` 做收敛判定与向 agent 展示的摘要。

`renderHtml`/`questionHtml` 从不读取 `state.sections`（HTML 卡片按单题渲染），不受影响。

## ④ 方案设计

- `GrillState` 类型与 `GrillStateSchema` 删除 `sections` 字段；`initialState()` 不再写入该字段。
- `rebuildSections()`（原地修改）改造为纯函数并导出：`deriveSections(state): Record<string, string>`，每次调用从 `state.questions` 现算，不写回 state、不持久化。
- `canConverge()`、`stateSummary()` 改为调用 `deriveSections(state)` 取现算结果，语义不变。
- `applyAnswerBatch()` 去掉对 `rebuildSections` 的原地调用（不再需要维护持久字段）。
- `migrateState()` 显式 `delete candidate.sections`：无论迁移自 v1 还是校验已是 v2 的输入，一律剥离历史遗留的 `sections` 键，防止脏数据随外部编辑或旧文件继续存在于状态里。

## ⑤ 备选方案与权衡

- **整体移除十章节模板**（连带 `SECTION_KEYS`、`question.section` 校验、收敛门槛、plan 标题硬约束）：评估后否决。该模板是工具产出文档的质量把关——防止访谈过早收敛、缺失测试计划/回滚方案/风险评估；且两份既有历史 plan 均严格遵循该结构，整体移除会破坏产出一致性与既有文档规范。用户明确选择保留。
- **`sections` 保留但允许为空/可选字段**：否决。既然收敛判定和摘要都能现算，持久化任何形式的 `sections`（哪怕可选）都是冗余状态，违反单一数据源原则。

## ⑥ 接口/数据结构变更

- `GrillState`：删除 `sections: Record<string, string>` 字段。
- `GrillStateSchema`（typebox）：同步删除 `sections: Type.Record(...)`。
- 新增导出纯函数 `deriveSections(state: GrillState): Record<string, string>`，替代原内部私有的原地修改函数 `rebuildSections`。
- `migrateState()` 对任意输入（含合法 v2）统一剥离 `sections` 键；已回答/废弃问题的 `userChoice`/`reason`/`pinned` 等事实字段不受影响。
- `grill_ask` 工具参数、`AskQuestion`、`AskAnswer` 对外契约不变。

## ⑦ 风险与影响面

- 若存在直接读取 disk JSON `sections` 字段的外部脚本/消费者，该字段将不再出现——排查确认仓库内仅 `grill.ts` 自身与测试引用，无其他已知消费者。
- HTML 外部镜像不受影响（未读取该字段）。
- 旧版 v1 JSON 迁移路径仍可用：`sections` 会被静默丢弃，不影响 `questions` 中已回答题的题面、选项、用户选择、理由等历史事实。

## ⑧ 测试计划/验证方式

- `bun test tests/grill-async-integration.test.ts tests/grill-responsive-navigation.test.ts`：34 pass / 0 fail。
- 调整原先直接断言 `disk.sections["…"]`/`migrated.sections`/`next.sections["…"]` 的用例，改为断言磁盘 JSON 不含 `sections`（`toBeUndefined()`/`not.toHaveProperty("sections")`），或改为调用导出的 `deriveSections(state)` 现算校验派生结论内容。

## ⑨ 回滚/清理方案

纯代码回滚：还原 `grill.ts` 中 `GrillState`/`GrillStateSchema`/`initialState`/`validateState`/`deriveSections`/`canConverge`/`stateSummary`/`migrateState` 对应改动即可，无需数据迁移。旧 `/tmp/grill/**/*.json`（若仍含 `sections`）会在下次经 `migrateState` 读取时被自动剥离，不需要手工清理。

## ⑩ 开放问题/待跟进事项

无——本轮范围（仅移除 JSON 初始化的 `sections`，不动其余逻辑）已在对话中明确并完整落地。

## 决策记录

本轮决策通过直接对话（`AskUserQuestion`）确认，未经 `/grill` 工具访谈，故无 `grill_ask` 流水账；记录两个关键决策点：

1. **JSON 初始化的 `sections` 字段是否保留？** 选项：删除 `sections`（推荐）/ 删除 `questions`。推荐理由：当前初始化的是 `questions: []`（本就为空，删除无意义），真正被固定预置的是 10 个空 `sections`。**用户选择**：删除 `sections`。
2. **十章节模板（收敛门槛 + plan 标题约束 + section 校验）是否整体移除？** 选项：保留（推荐）/ 整体移除。推荐理由：该模板是产出质量契约，两份既有历史 plan 均遵循此结构。**用户选择**：保留。
