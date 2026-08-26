# Cochpia 陪伴核心基座建设计划

> 状态：Draft v0.2（已完成一次对抗性审查）
> 目标：先建立可持续、可验证、可治理的聊天式情感陪伴核心，再将游戏、任务、日历和其他交互形态作为上层模块接入。

> 本文是目标架构与建设路线，不承担实时 changelog 职责。当前实现证据和未关闭门禁统一维护在 [`memory-module-evaluation-report.md`](./memory-module-evaluation-report.md) 与 [`memory-module-alpha-gate.md`](./memory-module-alpha-gate.md)；生成的本地验收 JSON 不作为仓库内 Markdown 链接引用。

## 0. 结论与建设原则

Cochpia 当前已有一个视觉上较完整的工作区、可运行的聊天链路，以及一套已经进入独立服务形态的 Memory Module；但各领域之间尚未形成稳定的系统闭环。后续不以继续堆叠 UI 或游戏功能为优先，而以 Companion Core（陪伴核心运行时）为第一建设目标。

本计划的核心判断：

```text
Memory Module 是陪伴基座中的核心模块，
但完整基座是 Interaction → Event → Context → Model → Commit → Memory/State 的闭环。
```

必须遵守以下原则：

1. 所有外部交互源都经过统一采集器，不允许聊天、游戏、任务各自直写记忆；内部派生事件由受信 dispatcher 发布，不能再次回流采集器。
2. 原始交互事件追加保存；记忆、人格、索引、缓存都是可追溯的派生结果。
3. 当前状态与长期记忆分离：状态可替换、有 TTL；记忆有版本、来源和治理。
4. 模型只能消费经过身份、权限、隐私和预算过滤的 Runtime Context。
5. 没有证据时返回 `not_found` / `uncertain`，不以模型置信度伪造记忆。
6. 用户可查看、纠正、Pin、撤回、忘记、删除和导出自己的记忆。
7. 游戏是交互源和上层领域，不是陪伴基座；它通过统一事件和状态接口接入。
8. 代码测试通过、真实环境验证通过、真实用户可用，必须分开标记，不能混为一谈。
9. 不跨 JSONB、Memory PostgreSQL 和主应用数据库假设原子事务；跨存储流程必须采用至少一次投递、幂等消费、状态机和可修复对账。

## 1. 当前基线与问题

### 1.1 已有资产

- 前端已有聊天工作区、设置、人格、记忆、成长证据、任务/日历、音乐和共生人生入口。
- Express 后端已集成 Auth、SSE、模型供应商、Memory Module runtime、任务、日历、Agent 和 MCP。
- Memory Module 已具备 raw event、assertion/version、scope、policy、retrieval、ContextBundle、治理、删除、worker、PostgreSQL、pgvector/Redis 可选路径和 SDK/OpenAPI。
- 聊天已经存在 `recordTurn → retrieve → model → finalize memory` 的局部闭环。

### 1.2 当前结构性问题

1. 主应用仍是较大的 JSON/JSONB 聚合状态；聊天、人格、成长证据和游戏状态没有统一领域边界。
2. Memory Module 的事件能力主要服务记忆处理，还不是整个应用的统一交互事件总线。
3. 共生人生状态已迁移到服务端 canonical LifeState，交互事件经过 Collector 写入 Memory Module；浏览器只保留可重放的离线命令队列，不保存 canonical state。
4. 人格与成长证据已接入可版本化 PersonalityProjection；关系 signal、source event/assertion provenance、CAS 和 rollback 已有代码与单测。
5. 独立 Memory Module 的大量能力已经有代码和单元测试；本地真实 PostgreSQL/Auth/TLS/备份恢复、lexical 1M benchmark、pgvector/HNSW 100k benchmark 和隔离 PITR/tombstone replay 已形成证据，但 pgvector 1M、生产 RPO/RTO、真实评测和正式生产链路尚未完成。
6. 现有 `server/index.js` 仍承担过多装配和业务编排职责，缺少清晰的 Companion Orchestrator、Context Builder 和 Interaction Finalizer 边界。

### 1.3 Alpha 现实边界

Memory Module 当前文档明确标记为 `NOT READY FOR REAL USER DATA`。在完成真实数据库验收、备份恢复、真实 600-case 评测、1M/20 并发压测、Model Gateway 审计和生产安全验证之前，不将其描述为生产级记忆基础设施。

## 2. 目标架构

```text
[Interaction Sources]
 Chat / Game / Task / Calendar / Music / System / External
                         │
                         ▼
[Interaction Collector]
 normalize · validate · idempotency · privacy precheck · actor context
                         │
                         ▼
[Canonical Event Log + Outbox]
 append-only · ordering · replay · dispatch · source revision
                         │
                         ▼
[Companion Runtime]
 ├─ Identity & Relationship Context
 ├─ Session / Current State
 ├─ Memory Module
 ├─ Personality & Growth Projection
 ├─ Policy / Consent / Safety
 └─ Context Builder
                         │
                         ▼
[Model Gateway]
 provider adapter · streaming · extraction · embedding · timeout · cost
                         │
                         ▼
[Interaction Finalizer]
 assistant event · state commit · outbox enqueue · audit · metrics
                         │
                         └─────────────── back to Event Log
```

### 2.1 模块边界

#### A. Identity & Relationship Context

负责统一 `tenant / user / agent / relationship / session / actor / grant`。它是共享上下文，不复制 Memory Module 的权限事实；Memory Module 继续是记忆数据的最终治理者，但聊天、游戏和任务必须使用同一主体上下文。

#### B. Interaction Collector

所有外部交互的唯一入口。负责接收来源适配器提交的事件，补齐认证上下文、时间、schema version、request/trace id，执行大小和隐私预检查，生成幂等键，并交给事件层。`tenant_id`、`subject_user_id`、`actor_id`、`relationship_id`、`grant` 等安全字段必须从已验证 JWT/service identity 和服务端关系解析得到；客户端同名字段必须拒绝或覆盖。它不负责决定长期记忆。

当前 `/v1/events` 和主应用挂载的 `/v1` Memory runtime 写入口必须被视为 internal-only compatibility boundary；它们不能绕过 Collector 接受公共客户端写入。迁移期间可以由 Collector 调用这些接口，但必须绑定 service identity、禁止客户端自带主体字段，并记录 `producer/correlation_id`。

#### C. Canonical Event Log + Outbox

追加保存规范化外部事件，提供顺序、source revision、final/non-final、重试、replay、lease 和派发能力。必须区分两类事件：`Ingress/Command Events`（聊天、游戏、用户操作提交）和 `Internal Domain Events`（记忆候选、人格证据、状态投影完成）。后者由受信 dispatcher 产生，不回到 Collector，也不能被客户端伪造。Memory Module 的 raw event/outbox 能力应先作为聊天垂直切片复用；只有在 ownership 和一致性证明完成后，才抽象成跨领域事件能力，避免再造第三个事实源。

#### D. Memory Module

负责长期经验和事实：事件入库、候选提取、assertion/version、scope、敏感度、confirmation、promotion、检索、ContextBundle、episode、profile projection、retention、forget/revoke/delete、audit、recovery 和索引派生。它不负责最终回复，也不拥有全部游戏世界状态。

#### E. Session / Current State

负责短期、可替换、有 TTL 的状态，例如当前情绪、当前话题、当前关系阶段、会话目标、未完成交互。它与长期记忆分离，所有写入都应有 source event、resource revision 和过期策略。

#### F. Personality & Growth Projection

从有来源的事件、记忆和关系证据生成可版本化的人格/成长投影。每次变化必须可解释、可回滚；人格值不能由一次模型输出直接覆盖。

#### G. Policy / Consent / Safety

统一处理记忆读取目的、主动提及、敏感度、do-not-store、do-not-mention、用户边界、工具审批、模型输入输出脱敏和 context budget。Memory Module 内部 policy 是权威基础，但 Companion Runtime 需要统一调用它。

#### H. Context Builder

把身份、关系、session state、current state、Memory ContextBundle、人格投影、近期交互、用户边界和 token budget 合并成模型可消费的 bounded Runtime Context。Memory ContextBundle 不等于完整 Runtime Context。

#### I. Model Gateway

负责 provider/model 适配、SSE、structured extraction、embedding、timeout、retry、成本、保留策略和安全错误映射。模型永远不能直接访问数据库或未经策略过滤的记忆。

#### J. Interaction Finalizer

拆成两个边界：`Commit Coordinator` 负责本次交互结果、assistant event、source revision 和幂等提交；`Projection Dispatcher` 负责异步推进状态、记忆、人格、审计和指标。聊天有模型回复，游戏等交互源可以只有 domain result，不应被迫走同一套 LLM finalize 流程。

### 2.2 一致性与事实所有权

跨存储不提供假设性的 ACID。第一版统一采用：

```text
提交命令 → canonical event 状态 pending
         → outbox 至少一次投递
         → 消费者按 event_id/idempotency_key 幂等处理
         → 记录 applied/failed/dead_letter
         → repair/reconciliation job 可重放或补偿
```

每个状态必须有唯一 owner，禁止同一字段双写：

| 数据 | canonical owner | 派生读模型 |
| --- | --- | --- |
| 原始交互事件 | Event Log（迁移期间可由 Memory raw event 承担） | Memory、审计、指标 |
| 长期记忆/assertion/version | Memory Module | ContextBundle、profile/index/episode |
| session current state | Companion Runtime State | Context Builder |
| relationship state | Relationship Projection | Context Builder、UI |
| personality/growth | Personality Projection | Context Builder、UI |
| life world state | Life Domain（Phase 5 才建立） | 游戏 UI、Memory event |

主应用 JSONB、Memory PostgreSQL、外部服务之间不得对同一个 canonical 字段同时拥有写权限。JSONB 迁移期间必须有 `resource_revision`/CAS 或明确的串行写策略。

## 3. 统一交互事件契约

### 3.1 Canonical envelope

```json
{
  "event_id": "evt_01",
  "schema_version": 1,
  "event_type": "conversation.message.created",
  "source_type": "chat",
  "source_id": "session_01",
  "tenant_id": "server-derived",
  "subject_user_id": "server-derived",
  "caller_agent_id": "server-derived",
  "actor_type": "server-derived",
  "actor_id": "server-derived",
  "relationship_id": "server-derived",
  "session_id": "session_01",
  "occurred_at": "2026-08-24T00:00:00.000Z",
  "source_revision": "1",
  "is_final": true,
  "content_type": "plain_text",
  "content": "...",
  "structured_data": {},
  "privacy_directive": "default",
  "idempotency_key": "...",
  "request_id": "...",
  "correlation_id": "turn_01",
  "causation_id": "evt_parent",
  "producer": "chat-adapter"
}
```

上例中的主体字段是内部规范化结果，不是客户端可提交的字段。服务间调用除 service token 外，应绑定网络边界或 mTLS、audience、issuer、过期时间和重放防护；trusted headers 不能单独构成授权。

### 3.2 第一批事件类型

```text
conversation.user_message.created
conversation.assistant_message.completed
conversation.turn.failed
life.action.completed
life.decision.resolved
relationship.signal.observed
```

内部派生事件单独命名和发布：

```text
memory.candidate.created
memory.assertion.promoted
memory.governance.changed
personality.evidence.created
state.current.updated
```

事件必须有 schema registry、PII 字段分类、时间语义、兼容/弃用矩阵、producer/consumer contract tests。流式交互至少需要 `run_id`、`chunk_seq`、`parent_event_id`、`attempt`、`completion_reason`、`resume_cursor` 和明确的 `partial/final/failed/superseded` 状态；partial assistant 内容默认不得进入长期记忆。

### 3.3 事件不等于记忆

所有重要交互都应记录事件，但只有经过 policy、提取、冲突和生命周期判断的内容才成为记忆。事件层保留发生事实；Memory Module 决定哪些内容进入长期记忆、以何种 scope 和敏感度保存，以及如何被召回。

## 4. 最小陪伴闭环（MVP）

第一阶段只做聊天，不依赖游戏：

```text
用户消息
  → Interaction Collector
  → 身份 / 权限 / 隐私 / 幂等检查
  → 写入 canonical event
  → 读取 session state + relationship context + Memory ContextBundle
  → Context Builder
  → Model Gateway 流式生成
  → Interaction Finalizer 提交 assistant event
  → 更新 current state / relationship signal
  → outbox 异步触发 extraction / projection / index
  → 下一次交互可读取新状态和记忆
```

### 4.1 MVP 必须支持

- 多轮会话和有 cursor 的断线恢复；重试、regenerate、cancel 和 assistant commit 必须有明确状态机。
- user / relationship / session 三类记忆 scope。
- 记忆候选、确认、激活、修正、撤回、忘记、删除和可追踪的导出 job。
- ContextBundle 有 token budget、来源和 policy 证据。
- 无记忆时明确返回 uncertain/not_found。
- 失败可重试且不会重复写入。
- 用户边界和 do-not-store / do-not-mention 生效。
- 每次人格/关系变化可以追溯到事件或记忆证据。

### 4.2 MVP 明确不做

- 社区多 Agent。
- 完整生命模拟。
- 生育、死亡、传承和复杂经济系统。
- 复杂向量基础设施作为硬依赖。
- 让模型直接控制记忆、人格或工具权限。

MVP 的“导出/删除”范围必须覆盖主应用消息、Memory Module 原始/派生数据、缓存、人格/关系投影、游戏派生物、日志和备份语义；外部模型供应商的保留/删除 SLA 需要单独记录，不能只删除 Memory Module 表。

## 5. 分阶段路线

### Phase 0：基线冻结与边界整理

目标：先让当前代码有唯一事实来源。

- 以远端已合并的 Memory Module 为基线，整理本地未提交实现和旧 memory-gateway/memory-service 边界。
- 建立 `docs/companion-core-foundation-plan.md`、事件契约和模块责任表。
- 固定当前测试基线，区分 unit、contract、integration、acceptance。
- 明确 in-process Memory Module 与独立 PostgreSQL 服务的兼容关系和迁移路径。
- 不在此阶段增加游戏玩法。
- 先完成最小真实 PostgreSQL + required Auth + tenant/user 隔离的 smoke gate；未通过时不得把新 Runtime 宣称为生产可用。
- 记录当前聊天的 state-first / memory-second 写入顺序，制定迁移期间的补偿、对账和 repair job。

完成标准：模块边界和 canonical 数据来源得到代码评审确认；没有两个模块同时拥有同一事实的写权限。

### Phase 1：统一采集器与聊天垂直切片

目标：聊天是第一个事件源，但架构上为游戏和其他来源留出入口。

- 定义 canonical event envelope 和第一批事件类型。
- 实现 `InteractionCollector`，统一认证上下文、隐私预检查、幂等和 source revision。
- 将现有 chat `recordTurn` 和 assistant finalize 迁移到统一 collector。
- 先以 Memory Module raw event/outbox 支撑聊天垂直切片；定义 ownership 和故障恢复证据后，再决定是否抽出跨领域 Event Log。
- 增加事件 replay、重复提交、非 final stream、顺序冲突测试。

完成标准：聊天通过 Collector 提交 canonical event；Memory Module 作为第一消费者处理。迁移期间若仍需同步写入，必须有单一 owner、幂等键和 reconciliation 证据，不能无条件双写。

### Phase 2：陪伴运行时与 Context Builder

目标：形成第一次稳定的聊天陪伴闭环。

- 抽出 `CompanionOrchestrator`。
- 抽出 `IdentityRelationshipContext`。
- 明确 `SessionState`、`CurrentState` 和 `RelationshipState` 的读写契约。
- 抽出 `ContextBuilder`，统一 Memory ContextBundle、人格、关系、当前状态和边界。
- 将模型调用收敛到 `ModelGateway`。
- 将 assistant event、状态更新和异步任务收敛到 `InteractionFinalizer`。
- 为 run/turn/chunk/finalizer 定义状态机，明确断线恢复、retry、regenerate、cancel 和 supersede。
- 明确 RelationshipState、PersonalityProjection、Memory current-state 和主应用 session state 的唯一 owner 与 CAS/revision 策略。

完成标准：一次交互可从 collector 走完整链路并安全提交；模型不可绕过 policy 读取未经授权的数据。

### Phase 3：Memory Module 最小真实验收与 Alpha

目标：先证明记忆系统在最小真实链路上可安全运行，再扩展性能和质量验收。

- 真实 PostgreSQL schema/repository smoke 和 acceptance。
- 真实 Auth + tenant/user/relationship/session 隔离。
- 最小删除传播图：消息、raw event、assertion/version、episode、index、snapshot、outbox、cache、人格/关系投影的 owner、状态和验证方式。
- worker lease、retry、dead-letter、fencing 故障注入。
- forget/delete 后 snapshot、index、episode、outbox、cache 不复活。
- 真实脱敏 600-case retrieval/extraction/governance 评测。
- 1M documents、20 concurrent 的 PostgreSQL/pgvector 压测；必须提供数据集版本、SLO、p50/p95/p99、降级率和可复现 artifact。
- Model Gateway 数据保留、S2/S3 假阴性和供应商输入输出审计。
- 备份恢复、PITR、RPO/RTO 演练。

完成标准：Alpha Gate 从 `NOT READY FOR REAL USER DATA` 更新为有证据支撑的可控试运行状态。

### Phase 4：人格、关系与成长投影

目标：让记忆真正改变陪伴行为。

- 统一 relationship signal 和 relationship state。
- 将成长证据绑定到 source event / assertion version。
- 人格投影按版本、证据、置信度更新，支持回滚。
- Context Builder 使用稳定人格和当前状态改变表达策略。
- 增加关系连续性、冲突记忆、用户纠正和边界回归测试。

完成标准：同一用户在后续会话中能感受到可解释的连续性；变化不会来自无来源的模型幻觉。

### Phase 5：游戏作为交互源接入

目标：让共生人生成为陪伴内核之上的第一个上层领域。

- 将游戏状态从 localStorage 迁移到服务端 `WorldState` / `LifeState`。
- 游戏行动通过 `life.action.completed` 进入 Interaction Collector。
- 游戏读取经过 policy 过滤的关系/记忆/人格上下文。
- 游戏只拥有自己的世界规则，不拥有第二套用户关系和长期记忆；world event 必须带 provenance，删除/忘记时按投影图重建或失效。
- 实现离线推进、回归、重复提交和跨设备一致性。

完成标准：游戏事件能影响记忆、关系和人格；聊天能正确引用游戏产生的共同经历；删除/忘记规则对游戏派生内容生效。

## 6. 验收与质量门禁

### 6.1 代码级

- domain unit tests
- API contract tests
- event schema tests
- idempotency/concurrency tests
- policy negative tests
- ContextBundle budget tests
- replay and migration tests

### 6.2 真实环境级

- PostgreSQL with TLS verification
- required Auth
- service token and trusted context headers
- real worker and multiple processes
- Redis/pgvector degradation
- backup/restore
- production-like logs and metrics

### 6.3 产品行为级

- 记得正确的事情
- 不记不该记的事情
- 不越权使用关系记忆
- 能承认不确定
- 用户纠正后不继续坚持旧事实
- 用户忘记后不从派生物中复活
- 长时间后仍能保持关系连续性

## 7. 迁移与兼容策略

1. 先保留现有 `/api` 兼容路由，但所有新写入走 canonical event 和 Memory Module。
2. 旧 `state.memories` 只允许一次性迁移；迁移成功后删除旧字段，不再双写。
3. 游戏第一阶段可以保留 UI，但禁止把 localStorage 视为 canonical source；迁移期间只读或作为临时草稿。
4. in-process runtime 和独立 Memory Module 必须共享同一 V1 contract；最终生产路径以独立 PostgreSQL 服务为准。
5. 每个迁移步骤提供 replay、rollback 和数据一致性检查，不直接覆盖用户数据。

## 8. 风险与反模式

- 只加表和 API，不定义事件语义，最终仍会产生孤岛。
- 把所有状态都塞进 Memory Module，导致当前状态和长期事实混乱。
- 让聊天、游戏分别写记忆，产生重复事件和不一致事实。
- 先上向量检索再做评测，无法证明召回真的改善。
- 让模型直接决定记忆晋升、人格变化或权限，绕过用户授权和 policy。
- 把单元测试全绿当成真实 PostgreSQL/生产就绪。
- 为了支持游戏过早引入复杂世界模拟，反过来拖慢陪伴闭环。
- 在未解决生产 TLS、认证、删除恢复和敏感数据治理前接入真实用户数据。

## 9. 第一批实施任务（建议顺序）

1. 评审本计划和事件 envelope，冻结模块 ownership。
2. 建立 `InteractionCollector` 和事件 schema 包。
3. 把聊天 user/assistant turn 迁移到 collector + canonical event。
4. 抽出 `CompanionOrchestrator`、`ContextBuilder`、`InteractionFinalizer`。
5. 将现有 Memory Module 作为第一消费者，保持现有 `/v1` contract。
6. 完成真实 PostgreSQL/Auth 的 Memory Module Alpha Gate 必要证据。
7. 接入关系状态和人格成长投影。
8. 最后将共生人生改造成第二个交互源。

## 10. 完成定义

陪伴核心基座完成，不以“有聊天页面”判断，而以以下闭环成立判断：

```text
任意交互源
  → 统一事件采集
  → 身份/权限/隐私检查
  → 读取可用记忆和当前关系
  → 生成受策略约束的回复或结果
  → 提交完整事件
  → 更新状态、记忆和成长证据
  → 下一次交互可验证地感受到连续性
```

只有当这条链在聊天场景中稳定、可测试、可治理，并且至少经过真实 PostgreSQL/Auth 验收后，才把游戏、社区 Agent 和其他玩法作为上层模块大规模扩展。

## 11. 对抗性审查记录

本版本由子代理按反对立场审查，重点检查“是否过度设计、是否与现有代码冲突、是否存在安全/一致性漏洞、是否不可落地”。审查结论已合并，主要修订如下：

- 将外部 Ingress Events 与内部 Domain Events 分离，禁止内部派生事件回流 Collector。
- 增加跨 JSONB、Memory PostgreSQL 和主应用状态的至少一次投递、幂等、repair/reconciliation 一致性模型。
- 明确 canonical envelope 的主体字段只能由服务端身份上下文派生，trusted headers 不能单独授权。
- 将 Memory raw event/outbox 定位为第一阶段聊天垂直切片，避免未经证明就再造第三个全局事件事实源。
- 增加 Current State、Relationship、Personality、World State 的 canonical owner 表，禁止同一字段双写。
- 补充 run/turn/chunk/resume/retry/regenerate/finalizer 事件语义，禁止 partial assistant 内容进入长期记忆。
- 将 Interaction Finalizer 拆为同步 `Commit Coordinator` 与异步 `Projection Dispatcher`。
- 将最小真实 PostgreSQL/Auth 隔离和删除传播作为早期硬门禁，而不是等到所有性能验收完成后才验证。
- 补充导出、删除、缓存、日志、备份和外部模型供应商副本的治理范围。

仍需在后续实现评审中继续验证：Memory raw event 到通用 Event Log 的迁移时机、Relationship/Personality projection 的冲突裁决，以及真实环境中的 SLO 和数据保留证据。

## 12. 历史实施审计记录（2026-08-25）

以下表格保留本轮拆分前的审计快照，便于追溯设计决策；它不是实时状态。当前分支的测试、构建和 Alpha 门禁以 `memory-module-evaluation-report.md`、`memory-module-alpha-gate.md` 及实际命令输出为准。

| 范围 | 当前实现 | 当前证据 | 仍未关闭的门禁 |
| --- | --- | --- | --- |
| Collector → Event → Context → Model → Finalizer | `InteractionCollector`、显式 `IdentityRelationshipContext`、canonical event、`CompanionOrchestrator`、`ContextBuilder`、`InteractionFinalizer` 已接入聊天和 LifeState 适配器；聊天预检 fail-closed；LifeState、任务、日历和音乐经 `InteractionOutbox` 接入统一 ingress，任务/日历提交失败会回滚 | domain/contract/unit tests、LifeState/task/calendar outbox HTTP acceptance、chat concurrency acceptance、outbox at-least-once/dead-letter tests、required Auth acceptance、双独立 worker crash-takeover acceptance、虚拟时钟 outage/backlog acceptance | 生产类独立事件日志、长期 outage SLO 和 provider 恢复证据 |
| Memory Module 治理 | scope、CAS、forget/delete、projection/index/episode/outbox 清理、worker fencing、Memory export snapshot 已实现 | 全量测试、独立 Memory API/SDK smoke、本机 PostgreSQL lexical/pgvector acceptance、双进程 worker crash-takeover acceptance、隔离 PITR/tombstone replay | 托管 PostgreSQL、1M pgvector/HNSW、生产 RPO/RTO |
| 产品级记忆生命周期与聊天修正 | `/api` compatibility adapter 支持候选、确认/拒绝、激活、修正、Pin/Unpin、撤回、忘记、删除、导出；聊天编辑使用 source revision，reconciliation 与多 revision 删除已接入 | `server/memory-module-runtime.test.js`、`scripts/companion-core-memory-lifecycle-acceptance.js`、`scripts/companion-core-chat-edit-acceptance.js`、`server/companion-reconciliation.test.js` | 外部生产数据传播延迟和供应商副本语义仍需部署证据 |
| 产品级导出 | `POST /api/export-operations`、状态、下载；旧 `GET /api/export` 兼容；manifest 包含消息、Memory、人格、关系、LifeState、任务、事件、偏好和 reconciliation | 新增 governance unit tests、隔离临时 JSON HTTP smoke | 真实缓存清理、日志/备份导出语义、供应商副本 SLA |
| 产品级账户删除 | local state 清理、Memory account delete、删除 manifest；Memory 已提交而主应用最终保存失败时恢复本地主应用快照并保留删除账本；缓存、备份和供应商职责显式列为 operator/provider obligation | `scripts/companion-core-account-delete-recovery-acceptance.js` 隔离 HTTP acceptance、既有 Auth acceptance 代码路径、Memory delete/recovery tests、隔离 PITR/tombstone replay | 真实删除延迟、生产 RPO/RTO、供应商审计 |
| 人格/关系/生命状态 | 版本化 personality projection、source-event growth evidence、relationship signal/state、policy-filtered `/api/life/context`、游戏事件 forget/delete 投影清理、可恢复 LifeState governance operation ledger、服务端 canonical LifeState、离线 command queue | domain tests、Life context HTTP smoke、`companion-core-life-outbox` HTTP acceptance 覆盖双客户端同 revision 的 CAS 冲突与原幂等键重试、required Auth acceptance 覆盖 context isolation 与 forget/delete/retry/status、LifeState/relationship/personality/life-event projection tests | 正式多设备/生产数据回归 |
| 质量和容量 | 代码级 600-case scaffold、真实 PostgreSQL lexical 1M/20 benchmark、真实 pgvector/HNSW 100k/20 benchmark、lean pgvector/HNSW 1M/20 benchmark、outage/backlog recovery artifact | synthetic 结果、lean 1M 与带容量限制说明的本机 benchmark | 真实脱敏 600-case、完整 canonical 1M pgvector/HNSW、生产积压/降级 SLO |

因此，本计划当前应标记为“核心实现已完成、Alpha/生产证据未完成”，而不是“生产就绪”。
