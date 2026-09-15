# Cochpia 后端运行底座重构 · Codex 执行流程

> 本文档是给 Codex（或任何编码 Agent）的完整执行手册。**先读完本文件、再做 Phase 0 审计、跑完测试基线，才允许动手改代码。**
>
> 目标一句话：把 `server/index.js`（约 1420 行、91KB 的单体）里的「聊天运行主链」抽成独立模块，让 index.js 退化成「启动 + 中间件 + 薄路由」。**全程不改变任何现有行为**，只做机械抽取 + 增量协议化。

---

## 0. 背景：现在是什么样

Cochpia 是 AI 陪伴 + 多 Agent 工作台。后端 Node.js + Express，端口 8787，前端 Vite 构建产物由 8787 托管。

`server/index.js` 单文件同时承担了：

1. 启动 / 中间件（CORS、安全头、JSON、observability、认证、`/v1` 记忆路由）
2. 全局状态 Proxy + AsyncLocalStorage 的**多用户隔离**
3. 一大堆运行时 Map（activeRuns / streamRuns / pendingApprovals / sessionApprovalGrants / collaborationRuns…）
4. 约 50 个 REST 端点（sessions / messages / agents / memories / models / music / profile / preferences / workbench / workflows / proposals / chat / sync / upload / export / import…）
5. 聊天运行主链（`handleChatStream`、群聊 `handleChatStream` 的 group 分支、`runModelWithTools` 工具循环、`runPiWorkMode`、`finalizeMemoryModule`、审批、SSE 事件发射与重放）
6. 静态服务 + 404 + 错误处理

**关键函数盘点（行号以当前文件为准，改动前自己重新核对）：**

| 区块 | 行号（约） | 说明 |
|---|---|---|
| 启动/中间件 | 42–210 | app、observability、state Proxy、memoryRuntime、agents、CORS/安全头/auth 中间件 |
| 运行时 helper | 212–347 | `send`/`fail`/`getSession`/`currentUserId`/`finishRun`/`attachStreamResponse`/`agentTasks`/`taskScheduler`… |
| REST 端点 | 348–930 | 见下方端点清单 |
| 聊天核心 | 932–1060 | `dispatchAgentTask`/`executeChatTool`/`runModelWithTools`/`runPiWorkMode`/`finalizeMemoryModule` |
| 聊天主链 | 1044–1277 | `handleChatStream`（含私聊/工作模式/SSE/审批/记忆/重连） |
| 群聊 | 1280–1386 | `app.post('/api/chat/group')` |
| MCP | 1386–1407 | `app.post('/mcp')` |
| 收尾 | 1407–1420 | 404 / 错误处理 / 静态服务 |

**端点清单（Phase 0 请据此生成现状映射）：**

- 系统：`/api/health` `/api/ready` `/api/version` `/api/metrics`
- 模型：`GET /api/models` `POST /api/models/:provider/test`
- 音乐：`/api/music/*`（environment/status/context/search/play/pause/resume/next/stop）
- 会话：`GET/POST /api/sessions` `PATCH/DELETE /api/sessions/:id` `GET/PATCH /api/sessions/:id/model` `GET/PATCH /api/sessions/:id/persona` `GET /api/sessions/:id/messages` `GET /api/sessions/:id/channels` `PATCH/DELETE /api/sessions/:id/messages/:messageId`
- Agent：`GET/POST /api/agents` `PATCH/DELETE /api/agents/:id`
- 记忆：`GET/POST /api/memories` `GET/POST /api/memories/export` `POST /api/memories/batch` `GET/PATCH/DELETE /api/memories/:id` `POST /api/memories/:id/revoke` `GET /api/memory/overview` `GET /api/memory/dream`
- 资料：`GET/PATCH /api/profile` `GET/PATCH /api/preferences`
- 同步/迁移：`GET /api/sync` `GET /api/export` `POST /api/import` `POST /api/upload`
- 模式：`GET/PATCH /api/mode`
- 聊天：`POST /api/chat/stream` `/api/chat/regenerate` `/api/chat/retry` `/api/chat/group` `/api/chat/approve` `/api/chat/cancel` `GET /api/chat/stream/:runId`
- 工作台：`GET /api/workbench/agents` `GET/POST /api/workbench/tasks` `GET /api/workbench/tasks/:id` `POST /api/workbench/tasks/:id/verify|review|merge|discard|cancel|approve|gate`
- 工作流：`POST /api/workflows` `POST /api/workflows/:id/run` `GET /api/workflows/runs/:id`
- 提案：`GET/POST /api/proposals` `POST /api/proposals/:id/approve|reject`

---

## 1. 目标架构（借鉴 Kli Space，但不照搬、不一次到位）

最终让 `index.js` 只做四件事：**bootstrap（加载状态/建服务）→ 中间件 → 路由挂载 → 静态服务与错误处理**。

聊天运行主链单独成一个模块，遵循这条链（这就是 Kli Space 的核心）：

```
请求(事件) → 校验/分流(Disposition) → 组装上下文(Context) → 模型决策(Decision)
          → 工具/审批/记忆/SSE(执行与反馈 Action) → 记录结果(ActionOutcome)
```

**第一阶段只做机械抽取，第二阶段才做薄路由，协议对象(ActionOutcome)放第三阶段。**

建议目标目录（第一阶段先建前两个，其余按阶段追加）：

```
server/
  index.js                  # 退化后的启动入口（thin）
  runtime/
    runs.js                 # activeRuns/streamRuns/attachStreamResponse/finishRun/SSE 重放
    approval.js             # pendingApprovals/sessionApprovalGrants/waitForApproval/respondApproval
    chat-runtime.js         # 聊天主链：handleChatStream + group + runModelWithTools + runPiWorkMode + finalizeMemoryModule + executeChatTool + dispatchAgentTask
    contracts.js            # (第三阶段) 轻量协议对象与校验
  routes/                   # (第二阶段) 按域拆的薄路由
    sessions.js agents.js memories.js workbench.js workflows.js music.js profile.js misc.js
```

**模块间依赖用「工厂函数 + 依赖注入」，不要用全局单例互相 import，避免循环依赖。** 示例：

```js
// server/runtime/chat-runtime.js
export function createChatRuntime(deps) {
  const { state, saveState, send, getSession, touchSession, currentUserId,
          agents, model, chatMemoryForRequest, findRegenerationTarget,
          resolveModelSelection, createModelProvider, routeMessage,
          recordDynamicAlphaObservation, waitForApproval, executeChatTool,
          runPiWorkMode, finalizeMemoryModule, streamRuns, activeRuns,
          attachStreamResponse, finishRun, randomUUID, ... } = deps;
  // ... 把现有 handleChatStream / group 逻辑原样搬进来，只改「引用来源」
  return { handleChatStream, handleGroupChat };
}
```

`index.js` 里：

```js
const chatRuntime = createChatRuntime({ state, saveState, /* ...全部依赖 */ });
app.post('/api/chat/stream', (req, res) => chatRuntime.handleChatStream(req, res));
app.post('/api/chat/regenerate', (req, res) => chatRuntime.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId||'').trim()||null }));
app.post('/api/chat/retry', (req, res) => chatRuntime.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId||'').trim()||null, retry: true }));
app.post('/api/chat/group', (req, res) => chatRuntime.handleGroupChat(req, res));
```

---

## 1.5 Codex ↔ pi（复核者）协作闭环：每个检查点调动 pi，未获通过不得继续

> 你（Codex）是执行者，pi 是规划者/审查者。**不要一次性闷头做完再汇报**，而是在每个阶段关键点主动调动 pi 复查，收到指令后继续，直到 pi 明确判定「全部完成」。

### 调动 pi 的方式（项目已内置 pi RPC 协议，见 `server/pi-client.js`）

```bash
pi --mode rpc --no-session
# stdin 写一行 JSON：{"type":"prompt","message":"<完整上下文+请求>"}
# stdout 读 JSONL，读到 {"type":"agent_settled"} 表示 pi 完成；中间事件忽略即可
```

⚠️ **`--no-session` 是无状态新实例**：它不是你当前窗口里那个带着完整上下文的我。所以每次调动，必须把「brief 路径 + 当前阶段 + 已改文件 + 测试结果 + 具体问题」全部写进 message，否则那个 pi 不知道前因后果，给不出有效指令。

若 pi 命令不可用（`PI_NOT_AVAILABLE`）或超时：**停止，把卡点写给用户**，由用户把我（当前窗口的复核者）贴进来审；不要自行猜测继续。

### 必须调动 pi 的检查点（不许跳过）

| 检查点 | 时机 | 交给 pi 的内容 |
|---|---|---|
| C0 | Phase 0 审计完成、动手前 | 依赖清单 + 现状链路图，求「可以开始 Phase 1 吗」 |
| C1 | Phase 1 抽取完成 | 改了哪些文件、测试通过数 vs 基线、冒烟结果，求「是否零行为变化，能否进 Phase 2」 |
| C2 | Phase 2 完成 | index.js 最终行数、路由清单、`npm run build`/冒烟结果，求「能否收尾」 |
| C3 | 遇到「要不要顺手改」 | 把两难原样描述，求「改 or 不改」，pi 说了算 |
| C4 | 测试失败/卡住/不确定 | 贴完整报错，求「下一步怎么做」 |

### 每次调度的 message 固定模板

```
[角色] 我是 Codex（执行者）。你在审查 Cochpia 后端重构（docs/codex-runtime-refactor-brief.md，先读它）。
[当前阶段] Phase N
[已完成] （改了哪些文件、做了什么、有没有顺手改）
[验证结果] （node --check / node --test 通过数 / 冒烟结果，如实贴）
[问题/待你决定] （一句话说清要 pi 拍板什么）
请只回复：继续（进下一阶段）/ 修正 X（具体到文件与做法）/ 回滚阶段 N，并说明理由。
```

### 收到 pi 指令后的处置

- **继续** → 进下一阶段。
- **修正 X** → 只按指令改 X → 重跑验证 → 再调 pi 复查，确认通过再继续。
- **回滚阶段 N** → `git checkout` 回滚该阶段涉及文件，重来。
- **无法调动 / 超时 / 无回复** → 停止并交给人，不自行继续。

### 终止条件（唯一判据）

- **「全部完成」只以 pi 明确说「全部阶段完成/通过」为准**；Phase 4 收尾也要得到 pi 最终确认。
- 未经 pi 最终确认，Codex 不得自行宣告完成、不得自行加做 brief 之外的功能。

### 防死循环

- 每个阶段调动 pi 最多 3 次；连续 2 次「修正」仍未解决，或出现「pi 说 A、你做了 B」的分歧 → **停下交给人**。
- pi 只给方向，不替你写代码；你仍是唯一改文件的人。

---

## 2. 分阶段执行（每阶段独立验收、独立可回滚）

> 铁律：**每完成一个阶段，跑一次 `node --check` + 单元测试 + 手动冒烟，确认行为不变，再进下一阶段。** 任何一步行为变化都是 bug，立即回滚该阶段。

### Phase 0 · 现状审计（不写代码）

**做：**
1. 通读 `server/index.js`、`tools.js`、`model-provider.js`、`sse.js`、`store.js`、`runtime-context.js`、`agent-task.js`、`agent-scheduler.js`。
2. 画一张「入口 → 校验 → 上下文 → 模型 → 工具/审批/记忆 → 输出」的现状链路图，标出每处读写 `state`、每处 `saveState`、每处 SSE `send` 的事件名。
3. 列出 `handleChatStream` 与群聊里所有跨函数依赖的变量/函数，形成**依赖清单**（这是 Phase 1 注入参数的依据）。
4. 建立基线：`node --test server/*.test.js` 记录通过数；`node --check server/index.js` 通过；后端能起、`/api/health` 返回 ok。

**产出：** 一份 `docs/runtime-refactor-audit.md`（依赖清单 + 现状链路图 + 测试基线数字）。

**验收：** 文档写清，基线数字记录在案。

### Phase 1 · 机械抽取聊天主链（最大单步收益，零行为变化）

**做：**
1. 新建 `server/runtime/runs.js`：搬 `activeRuns`/`streamRuns`/`finishRun`/`attachStreamResponse`/SSE 重放逻辑，导出一个 `createRunRegistry(deps)`。
2. 新建 `server/runtime/approval.js`：搬 `pendingApprovals`/`approvalRecords`/`sessionApprovalGrants`/`waitForApproval`/`respondApproval`（如果 `respondApproval` 在端点里），导出 `createApprovalRegistry(deps)`。
3. 新建 `server/runtime/chat-runtime.js`：把 `handleChatStream`、群聊 handler、`runModelWithTools`、`runPiWorkMode`、`finalizeMemoryModule`、`executeChatTool`、`dispatchAgentTask`、`toolTerminationMessage`、`detectModeSwitch` 原样搬入，**只改变量来源**（从 deps 取），**不改任何一行逻辑**。
4. `index.js` 顶部 `createChatRuntime({...})` 并替换 4 个聊天端点为一层调用。删除已搬走的函数体。

**禁止：**
- 不改任何条件、不重排任何语句、不「顺手优化」。
- 不动 `state` Proxy / AsyncLocalStorage / `saveState` 的调用次数与时机。
- 不动 SSE 事件名（`meta`/`text`/`tool`/`tool_pending`/`tool_result`/`agent_task_dispatched`/`done`/`error`）与 `Last-Event-ID` 重放。

**验收：**
- `node --check server/index.js server/runtime/*.js` 通过。
- `node --test server/*.test.js` 单元测试数不变、无新增失败（regenerate/isolation 两个集成测试若因无 token/后端离线失败，属既有环境问题，不算本阶段回归，但要在 audit 里记录）。
- 重启后端，私聊、工作模式（触发 `dispatch_task`）、审批弹窗、SSE 断线重连、群聊（并行/轮流）各手动冒烟一次，行为与之前一致。

### Phase 2 · 端点薄路由化（把 index.js 压到 ~200 行）

**做：**
1. 新建 `server/routes/`，按域拆：`sessions.js`、`agents.js`、`memories.js`、`workbench.js`、`workflows.js`、`music.js`、`profile.js`、`misc.js`。
2. 每个路由文件导出一个 `createRouter(deps)`，返回 Express `Router`；端点 handler 只做「取参数 → 调 service/helper → 回 JSON」，**不写业务逻辑**。
3. `index.js` 里 `app.use('/api/sessions', createSessionsRouter(deps))` 之类挂载。**注意保持原有 URL 完全一致**（含 `/api` 前缀与参数名）。
4. `workbench.js` 与 `workflows.js` 依赖 `agentTasks`/`taskScheduler`/`runAgentTask`/`runTaskVerification`/`evidenceLedger`/`proposals`/`collaborationRunView` 等，全部走 deps 注入；`runAgentTask`/`runTaskVerification` 也可顺势抽到 `server/runtime/agent-runner.js`（可选，若太复杂就留在 index.js，别硬拆）。

**禁止：**
- 不引入新的 URL、不改请求/响应 JSON 结构、不改错误码。
- 不使用巨大 `switch(event.type)`；用「每个路由一个 handler」。
- 不在本阶段动 chat-runtime 内部。

**验收：** 同 Phase 1 的 check + 测试 + 冒烟；另跑 `npm run build` 确认前端不受影响；`index.js` 行数显著下降（目标 < 250 行）。

### Phase 3 · 协议化执行结果（可选、低优先，行为可观察、不可破坏）

**做（仅当前两阶段全绿后再做）：**
1. 新建 `server/runtime/contracts.js`：定义 `makeActionOutcome({ id, intent, status, result, errorCode, completedAt })`、`makeDisposition(...)` 等**纯构造器 + 校验**。
2. 让工具执行路径统一返回 ActionOutcome，而不是裸字符串（`executeChatTool` 返回结构，`runModelWithTools` 里再取 `.result` 拼给模型）。**模型侧看到的文本保持不变。**
3. 给每个模型调用 / 工具调用 / 审批决策补 `event_id`/`action_id` 幂等字段，写入 audit 记录（先只记，不改行为）。

**验收：** 单元测试覆盖 contracts 构造器；聊天冒烟结果文本与 Phase 2 一致。

### Phase 4 · 收尾

1. 更新 `docs/runtime-refactor-audit.md` 记录最终结构、变更文件清单、行为对照结论。
2. 确认 `.env` 未改动、`dist/` 未误删、SW 缓存版本未动。
3. 汇报：改了哪些文件、测试结果、如何回滚。

---

## 3. 硬约束与禁止项（违反即回滚）

1. **行为零变化**：这是一次结构性重构，不是功能开发。任何「顺手改 bug」「顺便优化」都必须先停下、单独记录、等批准。
2. **不动 state 隔离**：`state` Proxy + `AsyncLocalStorage` + `loadUserState` 的多用户隔离是地基，禁止改变其读写方式。
3. **不动持久化时机**：`saveState(state)` 的调用点、次数、失败回滚（如 `state.messages.pop()`）保持原样。
4. **不动 SSE 协议**：事件名、字段名、`Last-Event-ID` 重放、`streamRuns` 保留期全部保持。
5. **不动审批状态机**：`waitForApproval` 的 grant / 超时 / `acceptForSession` 语义不变。
6. **禁止巨大 switch / 巨大文件**：新增代码不重新堆成几千行单文件。
7. **禁止一次性大爆炸**：每阶段独立可回滚；未经验证不进入下一阶段。
8. **禁止改动**：`.env`、`client/public/sw.js` 的缓存版本号、`dist/`（构建产物）、任何 `.test.js` 的既有断言（除非 Phase 3 明确要求新增测试）。

---

## 4. 验证与回滚命令

```bash
# 语法检查
node --check server/index.js
node --check server/runtime/*.js

# 单元测试（regenerate/isolation 需后端在线+token，离线会失败属既有环境问题）
node --test server/*.test.js

# 前端构建（确认不受影响）
npm run build

# 重启后端（改 server/ 后必须）
netstat -ano | grep :8787          # 找 PID
taskkill //PID <pid> //F
node server/index.js               # 或 npm run server

# 健康检查
curl http://localhost:8787/api/health
```

**回滚：** 用 git 逐阶段 `git stash` / `git checkout` 该阶段涉及的文件；每阶段结束 commit 一次，注明「Phase N 完成，行为不变」。

---

## 5. 已知坑位（务必绕开）

1. **`state` 是 Proxy**：`state.collaborationRuns`、`state.agentTasks` 等经 Proxy 走 `requestContext` 的 per-user 状态；搬代码时不能把 `state` 换成某个提前缓存的普通对象。
2. **`saveState` 走 postgres 用户态**：`saveState(state)` 内部按 `state.__userId` 判断存哪个用户，Proxy 的 `__userId` getter 来自 `requestContext`。不要「优化」成直接调 `saveUserState`。
3. **SSE 重放**：`GET /api/chat/stream/:runId` 依赖 `streamRuns` Map 与 `Last-Event-ID`，`finishRun` 里 300s 后删 entry。搬到 runs.js 时保留这个时序。
4. **工具循环上限**：`runModelWithTools` 的 `for step < 12`、`TOOL_LOOP_REPEATED`/`TOOL_LOOP_LIMIT` 文案，是已修复过的行为，别动。
5. **审批第二段确认**：`respondApproval` 的 `awaitingSecondApproval` → `approvalStage: 2` 逻辑（deploy 二次确认）别丢。
6. **群聊并行/轮流**：group handler 里的 `groupMode`、`agent_done`/`done` 事件、成员流式合并逻辑，搬的时候连注释一起搬。
7. **集成测试**：`regenerate.test.js` / `isolation.test.js` 需要真实后端 + token；跑全量前先确认后端在线，否则这俩失败不算回归。
8. **CRLF**：项目文件是 CRLF 行尾，编辑后保持一致，避免整文件 diff 噪音。

---

## 6. 交付标准（Codex 完成后应回答这 11 个问题）

1. 一次聊天请求经过了哪几个模块？（入口 → 校验 → 上下文 → 决策 → 执行 → 结果）
2. 哪些函数被搬走了、哪些留在 index.js，各自为什么？
3. 依赖注入的 deps 清单是什么？（有没有遗漏导致的 undefined 风险？）
4. 每个 SSE 事件名和字段是否与重构前完全一致？
5. `saveState` 调用次数/时机是否一致？
6. 审批、工具循环上限、SSE 重连、群聊并行/轮流是否逐一冒烟通过？
7. 单元测试通过数 vs 基线是否一致？
8. 每阶段如何单独回滚？
9. `index.js` 最终行数、是否还存在 500+ 行的函数？
10. 有没有任何「顺手改」的行为差异被单独记录并等待批准？
11. pi 是否明确给出了「全部阶段完成/通过」的最终确认？

---

*本手册基于 Cochpia 当前 `server/index.js` 实况编写。若实际代码与此处行号/函数名有出入，以实际代码为准，并在 audit 文档中标注差异。*
