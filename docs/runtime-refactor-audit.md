# Cochpia Runtime Refactor Phase 0 Audit

审计对象：`server/index.js` 及 brief 指定的 `tools.js`、`model-provider.js`、`sse.js`、`store.js`、`runtime-context.js`、`agent-task.js`、`agent-scheduler.js`。

审计时间：2026-09-03。本文档是 Phase 0 只读审计产物；审计阶段未修改业务代码、测试、`.env`、`dist/` 或 Service Worker。

## 基线

- `server/index.js`：1423 行，约 92,670 bytes；与 brief 中约 1420 行的描述基本一致。
- `node --check server/index.js`：通过。
- `node --test server/*.test.js`：262 项；259 通过，3 失败，0 cancelled，0 skipped，耗时约 46.1s。
- 失败项均是 brief 预先标注的真实后端/token 集成测试：
  - `server/isolation.test.js`：`two-user isolation acceptance`，用户 A 鉴权返回 `AUTH_INVALID`（401，期望 201）。
  - `server/regenerate.test.js`：`missing target`，实际返回状态不在测试期望的 403/404 中。
  - `server/regenerate.test.js`：`success, ownership, concurrency, and model failure`，鉴权返回 `AUTH_INVALID`（401，期望 201）。
  这些是当前 AUTH/token 环境失败，暂记为既有环境问题，不作为重构回归结论。
- 已有后端监听 `localhost:8787`；`GET /api/health` 返回 HTTP 200：`ok:true`、`status:ready`、`storageProvider:postgres`、`storageReady:true`、`modelReady:true`。响应中的模型为当前运行环境配置值，未记录任何密钥。
- Phase 0 发现工作区已有大量未提交改动；本阶段仅新增本文件，没有覆盖或回滚它们。

## 现状链路图

```text
HTTP 请求
  |
  v
Express app
  -> CORS 中间件
  -> 安全响应头中间件
  -> express.json(limit=1mb)
  -> observability.middleware (request id / rate limit / metrics)
  -> 鉴权中间件
       public: health/ready/version/metrics/models
       protected: authenticateRequest -> loadUserState -> AsyncLocalStorage.run({user,state})
  -> /v1 memoryRuntime.router() (独立 Memory Module API)
  |
  +-- 非聊天 REST 路由 -> service/helper -> state Proxy -> saveState(state) -> JSON response
  |
  +-- POST /api/chat/stream|regenerate|retry
  |      -> handleChatStream 参数校验、session ownership、regeneration target 校验
  |      -> session/Agent 模型与 persona 选择
  |      -> resolveModelSelection -> createModelProvider
  |      -> routeMessage -> dynamic-alpha observation
  |      -> 写入 user message + saveState（失败时 pop 回滚）
  |      -> chatMemory.recordTurn / retrieve -> recalled + memoryBundle
  |      -> 创建 activeRuns/streamRuns run，attachStreamResponse，发送 meta
  |      -> maybeCompactConversation + saveState（changed 时）
  |      -> detectModeSwitch
  |          -> 模式切换文本 -> 写 assistant + saveState -> text -> done
  |          -> work -> runPiWorkMode
  |                    -> pi RPC text/tool events -> SSE
  |                    -> 写 assistant + saveState
  |                    -> finalizeMemoryModule -> done(engine=pi)
  |                 Pi 失败 -> work model generateWithTools 工具循环
  |          -> companion -> buildRuntimeContext
  |                    -> runModelWithTools（最多 12 step）或 model.stream
  |      -> assistant message + finalizeMemoryModule + saveState
  |      -> done -> finishRun -> response.end
  |
  +-- POST /api/chat/group
         -> session/group 参数校验、成员选择、写 user message + saveState
         -> chatMemory.retrieve
         -> activeRuns/streamRuns + meta
         -> parallel 或 turn 调用 model.stream
         -> agent_start/text/agent_done 或 agent_error/text/agent_done
         -> 写 replies + saveState -> recordTurn -> done -> finishRun

模型决策：model-provider.js
  mock / OpenAI-compatible / Anthropic / Gemini
  -> generate、stream、generateWithTools、composeSystemPrompt

工具/审批/记忆/输出：
  findTool/getToolRisk/executeTool
  -> requiresApproval 时 waitForApproval -> /api/chat/approve -> resolve
  -> executeChatTool（内含 dispatch_task -> agentTasks + taskScheduler）
  -> SSE send -> createSseEvent -> formatSseEvent -> run.response/res.write
  -> GET /api/chat/stream/:runId -> replaySseEvents(Last-Event-ID)
```

## 入口与路由现状映射

中间件和收尾：CORS、CSP/安全头、JSON、observability、鉴权、`/v1` Memory Module；`/api` 404；统一错误处理；静态托管 `dist/` 与 SPA fallback。

| 领域 | 当前注册路径（方法 + 路径） | 主要依赖 |
|---|---|---|
| 系统 | `GET /api/health`、`/ready`、`/version`、`/metrics`、`/models`；开发观测 `GET /api/dev/dynamic-alpha/observations` | storage status、model、observability、dynamicAlphaObservations |
| 音乐 | `GET /api/music/environment|status|context|search`；`POST /api/music/play|pause|resume|next|stop` | music service / optional Netease adapter |
| 会话 | `GET/POST /api/sessions`；`PATCH/DELETE /api/sessions/:id`；`GET/PATCH /api/sessions/:id/model`；`GET/PATCH /api/sessions/:id/persona`；`GET /api/sessions/:id/messages|channels`；`PATCH/DELETE /api/sessions/:id/messages/:messageId` | state、agents、queryCollection、model selection、saveState |
| Agent | `GET/POST /api/agents`；`PATCH/DELETE /api/agents/:id` | agent service |
| 记忆 | `GET/POST /api/memories`；`GET /api/memories/export`；`POST /api/memories/batch`；`GET/PATCH/DELETE /api/memories/:id`；`POST /api/memories/:id/revoke`；`GET /api/memory/overview|dream` | memoryRuntime compatibility/chat adapters、queryCollection |
| 资料/偏好 | `GET/PATCH /api/profile`；`GET/PATCH /api/preferences` | state、workspace preference sanitizer、growth evidence |
| 同步/迁移 | `GET /api/sync`；`GET /api/export`；`POST /api/import`；`POST /api/upload` | collectSyncChanges、mergeState、memoryRuntime、fs |
| 模式 | `GET/PATCH /api/mode` | state、saveState、collaboration state |
| 聊天 | `POST /api/chat/stream|regenerate|retry|group|approve|cancel`；`GET /api/chat/stream/:runId` | chat runtime dependencies below |
| 工作台 | `GET /api/workbench/agents`；`GET/POST /api/workbench/tasks`；`GET /api/workbench/tasks/:id`；`POST /api/workbench/tasks/:id/verify|review|merge|discard|cancel|approve|gate` | agentTasks、taskScheduler、runner、verifier、sandbox、evidenceLedger、proposals |
| 工作流/提案 | `POST /api/workflows`；`POST /api/workflows/:id/run`；`GET /api/workflows/runs/:id`；`GET/POST /api/proposals`；`POST /api/proposals/:id/approve|reject` | workflow specs、orchestrator、collaborationRuns、proposals |
| MCP | `POST /mcp` | MCP request handling and tool execution |

实际代码有两个同路径 `PATCH /api/sessions/:id` 注册（先处理基本字段，后处理 archived/pinned）。这是当前路由顺序的一部分，Phase 2 必须保持等价，不得借重构合并或修正其行为。

## 状态、持久化与隔离触点

- `index.js` 在启动时 `loadState()`，创建基于 `AsyncLocalStorage` 的 state Proxy；Proxy 的读写目标随请求上下文切换，`__userId` 从当前 user 派生。
- 请求鉴权后通过 `loadUserState(user.id, baseState)` 获取用户态，并以 `{ user, state }` 进入 `requestContext.run`；auth off 时使用 local-user/baseState。
- 启动初始化会补齐 sessions/agents/profile/mode/agentTasks/evidence/proposals/collaborationRuns 及 session mode/intent。
- `memoryRuntime` 通过 `getState` 读取当前上下文 state，`persistState` 调 `saveState`。
- `store.js`：JSON provider 写 `server/data/state.json`；Postgres provider 按 Proxy `__userId` 选择全局或用户状态，并维护 storage status、重试、用户缓存及迁移 claim。
- 直接可见的 `saveState` 触点位于会话创建/更新/删除、消息修改/删除、import、preferences、profile、mode、workflow、proposal、workbench、用户消息预写、compaction、模式切换、Pi/work/workflow/group/chat 收尾等路径；聊天主链中的时序必须原样保留。
- 聊天 run 隔离：`runtimeKey = userId:sessionId`；`activeRuns` 防止同用户同会话并发，`streamRuns` 保存 SSE replay；`finishRun` 清理 active run、heartbeat/deadline，并在 `SSE_RUN_RETENTION_MS`（默认 300s）后清理 stream run。
- 审批 Map：`pendingApprovals`、`approvalRecords`、`pendingAgentApprovals`、`sessionApprovalGrants`；写风险 grant 默认 30 分钟 TTL，单次等待默认至少 30 秒、默认 5 分钟超时，另有 10 分钟清理 interval。
- Agent 运行 Map/Set：`activeAgentRuns`、`activeVerifications`、`collaborationRuns`；它们与 state 中的 agentTasks/evidence/collaborationRuns 配合工作。

## SSE 事件与重放

通用 `send(res,event,data,run)` 先调用 `createSseEvent`，将 `{id,event,data}` 写入 `run.events`，再由 `formatSseEvent` 输出 `id/event/data` 三行 SSE wire format。`GET /api/chat/stream/:runId` 调 `replaySseEvents`，只回放序号大于 `Last-Event-ID` 的事件。

当前聊天代码实际发送的事件名：

- 普通/工作模式：`meta`、`text`、`tool`、`tool_pending`、`tool_result`、`agent_task_dispatched`、`error`、`done`。
- 连接保活/重连：`heartbeat`；重连时先 replay 已缓存事件，再继续使用当前 response。
- 群聊额外：`agent_start`、`agent_done`、`agent_error`，以及带 `agentId`/`messageId` 的 `text`、最终 `done`。
- 取消路径：`error`（`CHAT_CANCELLED`）及 `done`（`cancelled:true`）。

字段形状必须保持原样，尤其是 `runId`、`messageId`、`toolCallId`、`agentId`、`senderName`、`delta`、`result`、`memoryId`、`provider`、`model`、`Last-Event-ID` replay 行为。

## 聊天主链跨函数依赖清单

以下是把 `handleChatStream`、群聊 handler、工具循环和工作模式机械抽取到工厂模块时必须注入或以等价闭包提供的依赖。

### 共享运行时与状态

- `state` Proxy（不能替换为提前缓存的普通对象）
- `saveState`
- `requestContext` 语义对应的 `currentUserId`、`runtimeKey`
- `getSession`、`getMessage`、`sessionBelongsToCurrentUser`、`touchSession`
- `randomUUID`、`agentAvatar`
- `activeRuns`、`streamRuns`、`streamRetentionMs`、`chatRunTimeoutMs`
- `attachStreamResponse`、`finishRun`、`send`、`fail`

### 记忆、上下文与模型

- `memoryRuntime` / `chatMemoryForRequest`（含 `recordTurn`、`retrieve`、`remember`）
- `compatibilityMemoryForRequest` 仅为相邻的记忆端点依赖，不应被聊天抽取误带入
- `shouldRemember`
- `maybeCompactConversation`
- `buildRuntimeContext`、`findRegenerationTarget`
- `createModelProvider`、`resolveModelSelection`
- `routeMessage`、`recordDynamicAlphaObservation`
- `state.profile`、session mode/persona/summary/model fields
- `agents.get`、`resolveMessageAvatar`、`agentAvatar`

### 工具与审批

- `executeTool`、`findTool`、`getToolRisk`、`toOpenAITools`
- `dispatchAgentTask`、`executeChatTool`
- `waitForApproval`
- 审批端点共享的 `pendingApprovals`、`approvalRecords`、`sessionApprovalGrants`、`approvalTimeoutMs`、`sessionApprovalGrantTtlMs`
- 审批记录的 `approvalStage`、`awaitingSecondApproval`、`acceptForSession`、`interrupt`、`feedback` 语义

### Agent/work 模式

- `createPiClient`
- `agentTasks.create`、`taskScheduler.enqueue`
- `agentTaskOwner`（dispatch 使用当前 user）
- `runModelWithTools`、`runPiWorkMode`
- `toolTerminationMessage`、`detectModeSwitch`
- 工作模式专用环境变量 `WORK_MODEL_PROVIDER`、`WORK_MODEL_NAME`

### 群聊专用

- `state.sessions`、`state.messages`、`session.agentIds`、`session.groupMode`
- `agents.get`/list、`model` provider、`buildRuntimeContext`
- `chatMemoryForRequest`、`finalizeMemoryModule`
- `activeRuns`/`streamRuns`、`attachStreamResponse`、`finishRun`、`send`
- `parallel` 与 `turn` 分支、成员流式合并、`agent_start`/`agent_done`/`agent_error` 事件

## 指定模块职责摘要

- `tools.js`：工作区路径校验、敏感文件保护、文件/目录读取与搜索、命令/patch 等工具执行；导出 `executeTool`、`findTool`、`getToolRisk`、`toOpenAITools`。
- `model-provider.js`：provider preset/config/selection；mock、OpenAI-compatible、Anthropic、Gemini 的 generate/stream/tool 协议适配和安全错误码。
- `sse.js`：单调 run event id、SSE 格式化、按 Last-Event-ID 重放；无状态业务逻辑。
- `store.js`：JSON/Postgres 状态装载与保存、连接重试/状态、用户态缓存、legacy claim；导出 `loadState`、`loadUserState`、`saveState`、`getStorageStatus`、`storageProvider`。
- `runtime-context.js`：限制历史消息长度、裁剪 recall/summary/persona/profile/group/dynamic routing，及 regeneration target 查找。
- `agent-task.js`：任务规格清洗、owner 隔离、幂等创建、依赖输入、状态机、事件和结果持久化。
- `agent-scheduler.js`：有界并发、依赖满足/失败级联、ready/waiting 队列和运行数维护。

## C0 结论与边界

- Phase 0 审计产物已完成，基线数字和环境失败已记录。
- 当前没有发现需要在重构中顺手修复的行为；重复 session PATCH 路由、认证失败和现有状态/SSE 时序均视为基线事实。
- 未进入 Phase 1。必须先获得 C0 的 pi 审查指令；收到 `继续` 前不得创建 `server/runtime/` 或移动任何业务函数。

## Phase 2 / C2 状态

- `server/index.js` 当前 239 行，仅保留启动装配、共享依赖、中间件、路由挂载和 API fallback。
- 域路由位于 `server/routes/` 的八个模块；聊天流、重试、重生成、群聊、审批、取消、重放和 MCP 由 `misc.js` 挂载。
- `sessions.js` 保留两个同路径 PATCH，并保持原顺序；任务 runner 已移至 `server/runtime/agent-runner.js`，工作台验证逻辑仍在 `workbench.js`。
- `node --check`、全量测试和 `npm run build` 已验证：259 通过、3 个鉴权/token 环境失败；mock/auth-off 冒烟覆盖会话、陪伴 SSE、重放、群聊和 MCP。DeepSeek 正式配置 health 为 ready。
- 未宣称真实 `dispatch_task`/审批正向流程通过：mock 不产生工具调用，当前没有可安全执行外部任务的真实模型审批 fixture。

## Phase 4 收尾回答

1. **请求链路**：`/api/chat/*` 由 `misc.js` 进入 `chatRuntime`，完成参数、会话和并发校验；`runtime-context.js` 构造上下文；动态路由决定 companion/work；模型 provider 调模型，工具、审批和记忆分别由对应 service 处理；`runs.js` 和 `sse.js` 输出及重放事件。
2. **搬迁范围**：聊天主链进入 `runtime/chat-runtime.js`，运行注册表进入 `runtime/runs.js`，审批进入 `runtime/approval.js`；Phase 2 域端点进入八个 `routes/*.js`；`runAgentTask` 进入 `runtime/agent-runner.js`，工作台验证仍在 `routes/workbench.js`。
3. **deps**：factory 通过 `routeDeps`/runtime deps 注入 state、存储、模型、记忆、工具、审批、SSE、任务、工作流和 service；阶段验证发现的 `proposals`、`removeTaskSandbox` 装配遗漏已修复。
4. **SSE**：事件名、字段、`Last-Event-ID` 重放和 300 秒 stream retention 仍由同一批 Map/registry 处理；已完成结构核对和基础 replay 冒烟。
5. **持久化**：未改变 `saveState(state)` 调用点、失败处理和时机；state Proxy/AsyncLocalStorage 保留在 index bootstrap。
6. **专项验证**：陪伴 SSE、SSE replay、群聊基础完成和 MCP 已冒烟；群聊并行/轮流、审批正向、工具循环和真实 `dispatch_task` 未完整实测，见下方清单。
7. **测试**：与基线一致，262 项中 259 pass、3 项既有 token/auth 环境失败。
8. **回滚**：Phase 1 检查点为 `1508f90`；Phase 2 为本次提交，撤销本提交可恢复 Phase 1 检查点，其他工作区改动未纳入。
9. **入口规模**：`server/index.js` 最终 239 行，不存在 500+ 行函数。
10. **顺手改动**：本阶段没有有意行为改动；装配遗漏已修复。`.env`、SW、测试和 `dist` 的既有工作区状态均被保留，没有纳入本阶段提交；SW 的既有缓存差异为 `v22`→`v24`，测试文件也有既有断言增补。
11. **pi 确认**：用户转达复核者的 C2 审查为“通过”；Phase 3 按批准跳过，未虚构新的 Phase 4 pi 输出。

## 未实测项

- 真实 DeepSeek `dispatch_task` 工具调用和完整任务执行链。
- 审批正向流程，包括等待、accept/decline、session grant 和二次确认。
- 多 agent 群聊 parallel/turn 的全量 SSE 字段逐项对照。
- 真实模型下工具循环上限和中断路径端到端验证。

## 本阶段文件清单

- `server/index.js`
- `server/routes/sessions.js`
- `server/routes/agents.js`
- `server/routes/memories.js`
- `server/routes/workbench.js`
- `server/routes/workflows.js`
- `server/routes/music.js`
- `server/routes/profile.js`
- `server/routes/misc.js`
- `server/runtime/agent-runner.js`
- `docs/runtime-refactor-audit.md`
