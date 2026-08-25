# Companion Core Event Contract

状态：V1，代码注册表与 Collector/Finalizer 共用。

## 权威实现

- schema registry：`server/interaction-schema-registry.js`
- canonical normalization：`server/interaction-events.js`
- ingress boundary：`server/interaction-collector.js`
- product-state durability boundary：`server/interaction-outbox.js`
- assistant/failure publisher：`server/interaction-finalizer.js`
- chat reconciliation/repair：`server/companion-reconciliation.js`

`EVENT_SCHEMA_COMPATIBILITY` 是当前兼容矩阵。V1 目前只允许读取和写入 schema version `1`；未知版本在进入 canonical event 或 worker business processing 前 fail-closed。

## Envelope 要点

| 字段 | 语义 | 约束 |
| --- | --- | --- |
| `event_id` | 事件幂等身份 | 与 `source_revision` 共同形成 event key |
| `event_type` | 注册事件类型 | 未注册类型拒绝 |
| `schema_version` | envelope 版本 | 必须命中兼容矩阵 |
| `tenant_id` / `subject_user_id` / `actor_*` | 已验证主体 | 由服务端 context 派生，客户端字段拒绝 |
| `occurred_at` | 来源发生时间 | 规范化为 ISO 时间 |
| `received_at` | 服务端接收时间 | 不接受客户端覆盖 |
| `source_revision` | 来源顺序 | 旧 revision 不得覆盖新 revision |
| `run_id` / `parent_event_id` | 流式运行和因果关系 | 由 adapter/finalizer 绑定 |
| `event_status` | `partial` / `final` / `failed` / `superseded` | 与 `is_final` 一致性校验 |
| `privacy_directive` | `default` / `do_not_store` / `do_not_mention` | 进入 Memory 前执行门禁 |

字段的 PII/安全分类由 `EVENT_FIELD_CLASSIFICATIONS` 提供；`content` 和 `structured_data` 在 Collector 入口执行敏感信息拒绝，失败事件只写固定的 content-free marker，并使用 `do_not_store`。

## Producer / consumer

事件类型、允许 producer、消费者和是否允许 partial stream 均登记在 `EVENT_DEFINITIONS`。公共请求不能发布 internal event；internal event 只能由受信 Finalizer/Projection dispatcher 使用 `allowInternal` 发布。

LifeState、任务、日历和音乐的产品状态变更先写入应用侧 Interaction Outbox，再由受信请求上下文驱动 Collector 至少一次投递：

| 来源 | 事件类型 | producer | 持久化语义 |
| --- | --- | --- | --- |
| life | `life.action.completed` / `life.decision.resolved` / `life.state.reset` / `life.mode.changed` | `life-adapter` | LifeState canonical mutation 成功后写入用户 outbox；commandLog 保留 session provenance，若 pending command 与 outbox 脱节，下一次同用户 LifeEvent 请求会按幂等键重建；pending/processing/completed/dead-letter 可重试，客户端保留 pending 命令 |
| task | `task.created` / `task.updated` / `task.deleted` | `task-adapter` | 与用户产品状态同次保存，pending/processing/completed/dead-letter 可重试 |
| calendar | `calendar.event.created` / `calendar.event.updated` / `calendar.event.deleted` | `calendar-adapter` | 与用户产品状态同次保存，按 event id 幂等 |
| music | `music.playback.changed` | `music-adapter` | 命令成功后写入用户 outbox；播放状态本身仍由音乐 adapter 拥有；outbox 持久化失败返回稳定可重试错误并保留 pending entry |
| MCP/API memory write | `memory.write.requested` | `mcp-adapter` / `memory-api-adapter` | `hold`/`grow` 先通过 Collector 记录带主体上下文的 external ingress，再执行受边界保护的兼容写入；原始 event id 作为 memory/growth provenance |

Outbox 不携带客户端身份字段；dispatch 时重新从已验证请求解析 tenant/user/actor，并在有会话关联时建立对应 Memory session。Collector 或 Memory 暂时不可用时不回滚已经提交的产品状态，而是保留重试或 dead-letter 证据，避免把跨存储流程误当成原子事务。

聊天流至少保留 `run_id`、`chunk_seq`、`parent_event_id`、`attempt`、`completion_reason`、`resume_cursor` 和 `event_status`。partial assistant 内容不进入长期记忆；失败、取消和 regenerate 产生的 superseded 事件保持可追溯但默认不存正文。

### SSE resume 边界

- SSE wire event id 使用 `${run_id}:${sequence}`；客户端通过 `Last-Event-ID` 或 `afterEventId` 请求同一 run 的后续事件。
- 服务端拒绝不属于当前 `run_id`、格式非法或不是非负整数序列的 cursor，避免跨 run 错误跳过事件。
- JSON 开发路径的 replay 只来自进程内 `streamRuns`/journal memory，并受 `SSE_RUN_RETENTION_MS`（默认 5 分钟）限制；超出保留窗口后，`/api/chat/stream/:runId` 返回 `STREAM_RUN_NOT_FOUND`。
- PostgreSQL 部署还会把受限的 `meta/text/tool/error/done` replay 数据写入带 TTL 的 `cochpia_chat_stream_runs`；终态 run 可在进程重启后按 `Last-Event-ID` replay，活跃 run 若没有本地 owner 则明确返回 `STREAM_RUN_OWNER_UNAVAILABLE`，不会伪造跨进程接管模型生成。可用 `DATABASE_URL=... npm run test:companion-core-chat-stream-restart` 验证。
- 在 run 仍可见时，assistant final、failure 和 superseded canonical event 会携带已发出的最后一个 cursor/chunk 序号；partial assistant 正文仍不作为长期记忆写入。

run 生命周期由 `server/chat-run-state.js` 显式约束：`created → streaming ↔ disconnected → completed|failed|cancelled|superseded`；终态不可再次进入流式状态。retry/regenerate 使用新的 run/attempt，旧 assistant 只通过 `superseded` provenance 追踪。

## 兼容与修复

- Collector 负责身份、来源、隐私、幂等和 revision normalization。
- Memory Module raw event/outbox 是当前聊天垂直切片的第一消费者，不与主应用状态无条件双写。
- `/api/sessions/:id/reconciliation` 比较主应用消息与 raw event；`/repair` 以 canonical expected event 重放缺失项。
- `server/interaction-outbox.js` 的 reconciliation 会从持久化的 pending LifeState command 重建缺失 ingress envelope，并以 idempotency key 抑制重复入队。
- session delete 先提交主应用删除，再执行 Memory session delete；Memory 失败时恢复主应用 session、messages 和 mapping，避免两边静默分叉。
- account cleanup 或 import 替换 `state.memoryModule` 后，MemoryModuleRuntime 会检测对象身份变化并重新绑定 module，避免后续写入旧 canonical state。
- `/api/import` 和 `/api/sync` 会先触发一次性 legacy memory migration；旧 `state.memories` 不作为同步事实源继续暴露。
- session/account delete 在活动 chat/group-chat run、pending reservation 或 deletion lock 存在时 fail-closed；删除进行期间拒绝新的交互，避免模型结果在删除后写回。
- Pi RPC 通过 Companion Model Gateway 以 text-only 模式运行，显式关闭 tools、extensions、skills、project context 和 prompt templates；任何 tool execution event 都被拒绝，需工具时回退到带审批的本地 Model Gateway 路径。
- MCP `breath`/`dream`/`trace` 仅走主体认证读取路径；MCP `hold`/`grow` 和兼容 `POST /api/memories` 写入都先通过 `memory.write.requested` + Collector 记录主体上下文；MCP 写工具另需 `x-mcp-service-token`，未配置或不匹配时拒绝，不得绕过 Memory internal-only 写边界。
- outbox worker 对未知 schema version 在业务处理前进入 non-retryable dead-letter。
- 跨存储流程采用至少一次投递、幂等消费、CAS/revision 和可重放 repair；不假设 JSONB 与 PostgreSQL 之间存在原子事务。

## Contract evidence

`server/interaction-events.test.js`、`server/interaction-collector.test.js`、`server/interaction-outbox.test.js`、`server/interaction-finalizer.test.js`、`server/companion-reconciliation.test.js`、`scripts/companion-core-group-chat-acceptance.js`、`scripts/companion-core-music-outbox-acceptance.js`、`scripts/companion-core-session-delete-acceptance.js` 和 worker schema-version tests 覆盖注册表、字段分类、主体隔离、流状态、失败事件、重复提交、顺序冲突、outbox 至少一次投递和 repair 行为；group chat acceptance 还验证 Collector 拒绝 S3-like 内容时不会留下本地用户消息，music acceptance 验证持久化失败返回可重试错误并可通过同一幂等键完成恢复，session delete acceptance 验证持久化失败时两侧 session 都保留。
