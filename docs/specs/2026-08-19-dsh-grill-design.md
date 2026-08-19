# dsh-grill：面向 DSH Web 的异步设计访谈插件

日期：2026-08-19
状态：设计已确认（交互模型 A 异步面板 / 落座 shell.overlay 全局浮层 / 独立 bundle 仓库 / 范围 B 完整对齐 pi-grill）

## 目标

把 pi-grill（本 repo 的 `grill.ts`，pi 扩展）移植为 DeepSeek Harness（DSH）插件 `dsh-grill`，供 `dsh web` 使用。保留 pi-grill 的灵魂：**异步面板**——`grill_ask` 发布问题立即返回，agent 边调查边等答案；用户作答后答案以 steer 消息回注 agent loop。

v1 完整对齐 pi-grill 功能：问题批次发布、依赖驱动收敛、跳过、自定义答案、全局笔记、已答问题改答（deprecated 链）、会话 JSON+HTML 持久化、`/grill` 命令、plan 落盘。

## 非目标

- 不修改 deepseek-harness checkout（`/Users/luwei.will/ai/deepseek-harness/`）的任何 in-tree 代码；dsh-grill 是 out-of-tree bundle。
- 不做 TUI/Native 渲染面，只做 Web。
- 不进入 api-remotes 的 Typert Remote 事件白名单（编译期封闭，out-of-tree 不可达）；通信走自有 HTTP 路由 + SSE。
- pi-grill 的终端级快捷键 chord（Ctrl+Alt+G、Ctrl+1..0 等）不移植；Web 面板用点击 + 面板内键盘导航。

## 总体形态：独立双半包 bundle

本 repo 新增 `dsh-grill/` 目录（与 `grill.ts` 同级），一个 npm 包，同时声明两个清单：

- `dsh.bundle`（指向 `cordis.patch.yml`，插入插件行）→ `dsh plugin add` 可安装；开发期 `pnpm dsh web --patch dsh-grill/cordis.yml` 直接加载。
- `dsh.client`（`platform: "web"`，声明 `inject` 依赖边）+ `exports["./client"]` → DSH 的 client-modules 扫描器发现浏览器半，注入 `window.__DSH_BOOT__` 图并经 `/plugins/<id>/client.js` 发到每个打开的 Web 页面。

### 目录结构

```
dsh-grill/
├── package.json          # dsh.bundle + dsh.client 双清单
├── cordis.patch.yml      # bundle 安装层（按包名引用）
├── cordis.yml            # 开发期 --patch 覆盖层（相对路径引用 src）
├── build.mjs             # esbuild 客户端 bundle 构建脚本
├── src/
│   ├── index.ts          # host 半入口：name/inject/apply
│   ├── state.ts          # 访谈状态机（从 grill.ts 移植，去 TUI）
│   ├── tool.ts           # grill_ask 注册与 schema
│   ├── command.ts        # /grill 人类命令
│   ├── deliver.ts        # 答案→steer 消息组装与递送
│   ├── routes.ts         # /grill/* HTTP + SSE 路由
│   ├── persist.ts        # JSON + HTML 会话文件落盘
│   ├── prompts.ts        # 访谈 prompt / plan prompt（从 grill.ts 移植）
│   └── client/
│       ├── index.ts      # 浏览器半入口：注册 shell.overlay slot
│       ├── port.ts       # fetch/SSE 客户端（React 之外的 RPC seam）
│       ├── GrillBadge.tsx
│       ├── GrillPanel.tsx
│       └── *.module.css
├── lib/                  # 构建产物（node 半 ESM + client.js CJS bundle）
└── tests/                # vitest：状态机、递送、路由
```

## Host 半

### 插件形态

命名空间插件：具名导出 `name` / `inject` / `apply`（无 default export——见 DSH postmortem 0001）。`inject: ['tools', 'commands', 'webServer', 'agents']`。所有注册通过 `ctx` effect，卸载自动清理。

### grill_ask 工具

`ctx.tools.register(defineTool(...))`。schema 对齐 pi-grill v4：

- `questions[]`：`id` / `section` / `question` / `context?` / `options[]`（`value`/`label`/`description?`/`recommended?`/`recommendationReason?`/`requiresText?`）/ `recommended?` / `recommendationReason?`
- `deprecate[]` / `remove[]`：按 id 标记已发布问题失效/移除
- `converge?: boolean`：发布终局“写 plan？”问题

语义：**立即返回**。结果携带 stateSummary（section 进度、开放问题 frontier、笔记计数），agent 不阻塞。校验失败（重复 id、未知 deprecate 目标、空 options 等）loud 报错。

### 状态机（state.ts）

从 `grill.ts` 移植，剥离 TUI：

- 问题状态链：`pending → current → answered / skipped`，外加 `deprecated` / `removed`；refine 把 answered 问题重开为 current 并将旧答案挂到 deprecated 链（`pinned` 保留原问题快照）。
- 收敛判定：无 pending/current 且无未解决依赖 → agent 收到提示可 `converge=true`。
- 全局 notes 列表（不绑定问题）。
- 每 agent session 一个实例，键为 session id；host 内存持有，写穿到磁盘。

### 持久化（persist.ts）

与 pi-grill 相同的 JSON + HTML 会话文件对，目录可配置（Schemastery `Config`，默认 `<workspace>/.dsh-grill/`）。schemaVersion 沿用 4。HTML 是只读转录导出。UI 状态（选中项、滚动）不落盘——Web 面板自持。

### /grill 命令（command.ts）

`ctx.commands` 注册 `grill`，input hint 为访谈主题。handler 拿到确切 agent，`agent.followup(interviewPrompt(topic))` 发起访谈（对应 pi-grill 的 `deliverAs:"followUp"`）。

### 答案递送（deliver.ts）

面板动作（answer/skip/note/refine/converge 确认）→ host 更新状态机 → 组装与 pi-grill 相同格式的用户消息 → `agent.steer(message)`。DSH steer 语义：空闲 driver 起新 turn，忙则注入最近 step——等价 pi-grill `deliverAs:"steer", triggerTurn:true`。递送前 `ctx.agents.get(id)` 校验 agent 仍是 live root（schedule 包模式）；agent 已死则动作返回失败并在面板呈现。

## Host↔Web 通信：自有路由 + SSE（routes.ts）

api-remotes 白名单编译期封闭，out-of-tree 不可达，故走 `ctx.webServer.register()`：

- `GET /grill/state` — 全量状态快照（所有 session 的访谈 + 开放问题 + 笔记）；页面加载/SSE 重连时拉取。
- `POST /grill/answer` — `{ sessionId, questionId, value|custom, reason? }`
- `POST /grill/skip` — `{ sessionId, questionId }`
- `POST /grill/note` — `{ sessionId, text }`
- `POST /grill/refine` — `{ sessionId, questionId }`（重开问题）
- `GET /grill/events` — SSE：`state`（连接即推全量）+ `change`（增量通知，客户端收到后重拉 `/grill/state`，pull-model 仿 client-modules 的 onGraphChanged）

Host 是唯一权威：POST 成功 = 状态机已更新 + steer 已递送；面板不自持权威状态，刷新后从 `/grill/state` 恢复。路由 handler 异常按 webserver 语义答 400，不出进程。

## Web 半（src/client/）

### 落座

注册 `shell.overlay`（ui-layout 声明的 `{ kind: 'list', scope: 'root' }` root 槽，ui-cordis 面板同款）。`dsh.client.inject` 声明 `@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots`、ui-layout 等实际消费的 client 服务。

### 界面

- **徽标**：浮动徽标计数开放问题；点击开合面板；新问题批次到达自动展开并选中该批次当前问题。
- **面板**：左 ledger（全部问题按 section 分组、状态着色；answered 行可点击 refine），右当前问题（context、选项列表、推荐徽章与理由、`requiresText` 与内置 “Something else (type it)” 打开必填文本框、跳过按钮）。
- **笔记**：面板内常驻自由输入框（对应 pi-grill Ctrl+N）。
- **收敛**：converge 问题醒目样式；确认后 agent 收 steer 并写 plan。
- **多会话**：问题按 session 分组，当前选中 session 组置顶（仿 ui-cordis 面板的分组规则）。
- **键盘**：面板内 ↑↓（选项/ledger 行）、Enter（确认）、Tab（切 pane）、Esc（收起面板）。不做终端级 chord。

### 状态与生命周期

- 组件不自持权威状态：`port.ts` 持 SSE 订阅 + 状态快照 observable，React 只读渲染。
- 草稿（选中项、未提交文本）为组件本地状态，刷新丢失（与 ui-user-questions 同款权衡，文档声明）。
- SSE 断线重连后重拉 `/grill/state`。

## Plan 产出

与 pi-grill 相同：converge 确认后 host 向 agent steer plan prompt，agent 用自身 write/edit 工具把实现计划写入 `docs/plans/`（含访谈转录）。dsh-grill 不代写文件。

## 构建（build.mjs）

esbuild 两道产物：

1. node 半：`src/*.ts` → `lib/*.js`（ESM，platform=node，external 全部 `@deepseek-ai/*`）。
2. client 半：`src/client/index.ts` → `lib/client.js`，仿制 DSH `clientBundle` 约定：
   - CJS，platform=browser，banner `window.__ModuleLoader__.load({ id: "dsh-grill", factory: (require) => {` / footer `return module.exports; } });`
   - externals = DSH platform module 表（react、react/jsx-runtime、`@deepseek-ai/dsh-client-runtime` 等），其余全部内联
   - CSS Modules 内联为 `<style data-plugin>` 注入（lightningcss 或 esbuild css-modules，产出 hashed class map + 注入代码，与 DSH 约定一致）
   - `process.env.NODE_ENV` define 为 production

风险点：platform module 表以 DSH `packages/client/web/src/platform.ts` 为准，构建脚本硬编码一份并在 README 标注对齐来源；表漂移表现为浏览器 require 抛错，loud 可见。

## 测试

- **状态机**（tests/state.spec.ts）：状态链、refine deprecated 链、收敛判定、deprecate/remove 校验——从 grill.ts 既有测试移植语义。
- **递送**（tests/deliver.spec.ts）：answer/skip/note → steer 消息文本格式；dead agent 失败路径。
- **路由**（tests/routes.spec.ts）：POST 校验、SSE change 通知、state 快照形状。
- 客户端组件 v1 不做自动化测试（DSH client 测试基建 out-of-tree 不可复用），以手工验证清单代替。

## 验证路径

1. `cd dsh-grill && npm run build`
2. 从 deepseek-harness checkout：`pnpm dsh web --patch /Users/luwei.will/ai/grill/dsh-grill/cordis.yml`
3. 在现有 GUI `http://127.0.0.1:3080`（刷新页面）验证：`/grill <topic>` 起访谈 → agent 调 grill_ask → 徽标亮 → 面板作答/跳过/笔记/refine → agent 收 steer 继续 → converge → plan 落 `docs/plans/`。

## 明确留到 v2

- 面板打开期间的乐观更新/草稿持久化。
- 多 Web 页面并发作答的先答先赢收敛提示（v1 依赖 host 权威 + 重拉，后答者收到"问题已回答"失败即可）。
- TUI/Native 渲染面。
- 答案审计视图（deprecated/removed 历史的富展示；v1 ledger 仅着色标记）。
