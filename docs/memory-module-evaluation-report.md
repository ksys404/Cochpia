# Memory Module Evaluation Report

版本：V1 draft（2026-08-25）

## 已执行的自动化证据

- `npm test`：362 tests，357 passed，5 skipped，0 failed；默认回归现已包含 LifeState 离线队列、Companion Model Gateway、Pi RPC Gateway、Pi client policy、MCP/API memory ingress、上传治理、记忆生命周期和聊天 source-revision reconciliation。
- `npm run test:companion-core-memory-boundary`：隔离临时 JSON/上传目录 acceptance 通过，覆盖 API/MCP hold 重放、grow source-event 重放、未授权 MCP 拒绝、Collector provenance、上传导出和账户删除清理。
- skipped 项均依赖外部认证、PostgreSQL 或隔离集成环境，不代表通过。
- `npm run build`：通过。
- 本轮真实验收汇总由 `npm run test:companion-core-auth`、`npm run test:memory-postgres`、`npm run test:memory-postgres-acceptance`、`npm run test:memory-multiprocess`、`npm run check:companion-backup-restore` 等命令生成；本机 PostgreSQL 17.11 下 Memory smoke、双进程 worker、lexical/pgvector acceptance、required Auth、TLS 和 backup/restore 均通过。原始 JSON 只保存在本地 `artifacts/`，不作为仓库源码证据提交。
- 隔离 PITR acceptance：`npm run check:companion-pitr` 通过删除前时间点恢复、tombstone ledger 重放，以及 raw event/assertion/index/outbox/negative-read 验证；本次小型演练恢复窗口约 1.027 秒，不构成生产 RPO/RTO SLO 承诺。
- Companion Core 本地真实验收：`npm run test:companion-core-auth` 通过 required Auth + PostgreSQL 双用户隔离、LifeState 隔离、同用户 CAS 冲突、导出、会话/账户删除传播。
- TLS 验收：`npm run test:companion-core-tls` 通过临时证书链校验，`pg_stat_ssl.ssl=true`，并复用 required Auth 主应用验收。
- 备份恢复：`npm run check:companion-backup-restore` 通过 custom-format `pg_dump`/`pg_restore` 探针恢复；不等同于 PITR/RPO/RTO。
- PostgreSQL Memory Module smoke/acceptance：本地真实库通过 subject/tenant isolation、native lexical、outbox lease fencing、CAS 和 schema advisory-lock 重复/并发初始化。
- 独立 Memory Module SDK smoke：本轮在临时本地 PostgreSQL 独立服务上通过 create → retrieve → ContextBundle → export snapshot → forget negative-read external caller chain；原始结果只保存在本地 `artifacts/`。
- 真实本地 lexical benchmark：1M documents、20 concurrent、20 requests，p50 39.49ms、p95/p99 368.29ms、20/20 成功、orphan=0。另有真实 pgvector/HNSW hybrid benchmark：100k documents、20 concurrent、HNSW 重建后 p50 138.05ms、p95/p99 142.18ms、20/20 成功、orphan=0。两者均使用显式 fast seed；1M vector seed 因本机临时卷空间不足失败，不能把 100k 结果扩展为 1M 生产容量结论。
- `git diff --check`：通过。
- 新增 `npm run test:memory-multiprocess`：本轮在真实 PostgreSQL 环境中启动两个独立 worker 进程，验证同一 outbox event 只消费一次、完成后 lease 清理、过期 lease takeover 和旧 worker fencing；原始结果只保存在本地 `artifacts/`。
- 新增 `npm run test:companion-core-chat-concurrency`：在隔离临时端口和数据目录启动主应用，两个并发 chat stream 对同一 session 得到 `200/409`，最终只留下一个 user message 和一个 assistant message；现有 8787 服务未触碰。
- 新增 `npm run test:companion-core-memory-lifecycle`：隔离 HTTP acceptance 覆盖 `/api` compatibility 层的 candidate/confirmation、correct、pin/unpin、revoke、forget、delete、幂等重放/冲突和 legacy export。
- 新增 `npm run test:companion-core-chat-edit`：隔离 HTTP acceptance 覆盖用户/助手消息 source revision 编辑、最新 revision reconciliation 和多 revision 删除传播。
- 新增 `npm run test:companion-core-life-outbox`：在隔离临时端口和 JSON 数据目录验证 LifeState action 经 Interaction Outbox 完成 Collector 投递、保留 `rawEventId`，并验证相同命令的幂等 replay 不重复推进状态。
- 任务/日历 service 增加入队与持久化失败回滚；LifeState outbox acceptance 同时验证 task/calendar ingress 完成并保留 raw-event provenance。
- 本轮新增并通过 export operation 的 domain/API/SDK/OpenAPI/retention 回归：导出元数据只保存 subject-bound commit sequence，canonical 变化后下载 fail-closed 为 `EXPORT_SNAPSHOT_STALE`，过期 operation 可被 retention sweep 清理；PostgreSQL smoke 和 SDK smoke 已接入对应验证路径。
- 本轮隔离临时 PostgreSQL 真实环境复跑：Memory schema/smoke/acceptance、required Auth 双用户隔离、产品级 export operation、账户删除 manifest、TLS certificate verification 和 custom-format backup/restore 均通过；required Auth 非 TLS 运行仍明确记录 `tlsVerified=false`，独立 TLS acceptance 记录证书链校验通过。pgvector 小规模 acceptance 实际观察到 HNSW index scan；PITR/RPO/RTO、真实评测和供应商审计仍未完成。
- OpenAPI 3.1 artifact：Ruby YAML 解析通过，包含 21 个 V1 path、27 个 schema；路由/安全契约测试通过。
- 静态密钥扫描：未发现 live credential；命中的 `AKIA...` 仅是 S3 入口拒绝测试 fixture，API key 命中仅为环境变量名称。
- V0.1 baseline：50 条，覆盖 preference、relationship、current_state、no_answer、conflict、scope。
- V0.2 scaffold：600 条 synthetic，类别配额为 120/90/120/90/60/60/30/30，并带 development/holdout/acceptance split。
- Synthetic baseline：`npm run evaluate:memory-synthetic` 已使用真实 in-memory domain 跑完 600 条并在本地 `artifacts/memory-module-eval-v0.2-synthetic-results.json` 生成结果；Recall@5/Recall@10/MRR/nDCG/no-answer/conflict/authorization/Scope/evidence support 均为 1.0，category slice 也已输出；当前 scaffold 没有 S2/S3 或 proactive-mention 字段，因此这些指标明确为 `available:false`。该结果是 seeded synthetic harness sanity check，不是真实/脱敏对话评测，也不计入 Alpha acceptance。
- 真实评测入口已增加 fail-closed validator：`npm run evaluate:memory` 必须显式提供 real/deidentified cases 与 results envelope；两者都要求相同的版本、`datasetKind`、`synthetic:false` 和非空 `provenance`，cases 必须完整 600 条，results 必须一一覆盖且不允许额外 case。默认 split 为 `all`，子 split、synthetic scaffold、缺失元数据或不完整结果都不会生成指标；这项门禁只保证评测输入不会被误标为真实证据，不等同于真实评测已经完成。
- 主应用生产启动现在对 `AUTH_MODE=required`、`STORAGE_PROVIDER=postgres` 和证书校验型 `DATABASE_SSL` 做 fail-closed preflight；独立 Memory Module 复用同一 PostgreSQL TLS 规则。该代码门禁不替代正式托管证书链、HTTPS、日志、缓存和容量验收。
- Companion Model Gateway 已接管普通聊天、工作模式工具调用、群聊和 Pi RPC 的模型边界：输入及嵌套 Context 禁止 S3 secret，非流式模型/工具输出和带滚动安全窗口的流式输出同样 fail-closed；该代码门禁不替代供应商 retention/region/training/deletion 审计。
- 主聊天外部 provider 现在也要求显式 `MODEL_RETENTION_POLICY` 才能在 production 启动；这只是配置门禁，真实 retention/region/training/deletion SLA 仍需供应商审计。
- 独立 Memory Module service-auth v1 已加入：生产默认要求签名的 method/path、audience、issuer、timestamp、一次性 nonce 和 PostgreSQL replay ledger；SDK 自动生成签名，真实本地 PostgreSQL HTTP smoke 验证了 create → retrieve → ContextBundle → export → forget negative-read，以及同 nonce 重放拒绝。该证据不替代托管网络边界、mTLS/证书链和生产密钥轮换审计。
- Chat run 状态机已显式约束 `created → streaming ↔ disconnected → completed|failed|cancelled|superseded`，SSE cursor 绑定 run；PostgreSQL 路径新增 TTL chat stream journal，终态 replay 已通过两次独立主应用进程的真实 acceptance；活跃 run 仍不会被另一进程伪造接管。

## 已覆盖的行为

- tenant/user/relationship/session 边界、body context mismatch、S3 入口门禁。
- LifeState 离线命令队列按认证主体隔离；客户端只接受不低于当前 canonical `resourceRevision` 的服务端状态，避免跨账号重放或旧响应回退。
- S2 confirmation、current state TTL、read-your-write、profile snapshot 的实时治理覆盖。
- correct/pin/unpin/revoke/forget/delete。
- source/session/relationship/account forget 与 physical delete。
- `current_state_sources` 与 `profile_projection_sources` 规范化来源关系已接入内存态、PostgreSQL schema/repository、恢复回放和治理清理路径。
- PostgreSQL canonical schema 已补充 session、snapshot、projection、confirmation、pin 和 normalized source relation 的 subject-bound 复合外键；直接写库也不能跨同租户用户引用 session/来源。
- BM25/CJK、vector timeout fallback、RRF 接口、candidate dedupe。
- outbox lease/retry/dead-letter/fencing、tombstone recovery replay。
- Outbox worker 对未知 `schemaVersion` 在业务处理前 fail-closed 并进入 non-retryable dead-letter，避免新事件被旧 worker 部分消费。
- 独立服务 worker 的 extraction/profile/index/episode feature-flag wiring。
- async retrieve/context-bundle 的 hybrid/vector flag、embedding gateway 注入和 BM25 fallback。
- 确定性 query route hint：profile、state、episode、relationship、bridge 和 unknown。
- Query router 对带下划线的属性名（例如 `current_plan`）不再误判为 current-state；冲突问题可继续进入 assertion 检索并返回 conflict。
- list/confirmation endpoint 的稳定不透明 cursor 分页、非 final 流式事件不入 extraction outbox，以及 system/tool 事件默认 no-store。
- `/v1` request/trace ID、完成日志、metrics 和 rate-limit wiring；日志不记录用户正文。
- 新增可执行 Companion Core event schema registry：V1 兼容矩阵、事件 producer/consumer、字段 PII 分类、`occurred_at/received_at` 时间语义，以及 `run_id`、`parent_event_id`、`event_status` 流状态校验；未知 event schema 在 Collector 入口 fail-closed。
- 新增显式 `IdentityRelationshipContext` 边界：主体、actor、caller agent、relationship、session、request/trace provenance 在 Collector/Memory runtime 入口统一校验；required Auth acceptance 覆盖跨用户隔离。
- 聊天 assistant/model/finalize 失败现在发布 content-free、`do_not_store` 的 `conversation.turn.failed`，保留 run/parent/attempt/provenance，不把错误正文送入 Memory。
- 聊天 user event Collector 或 Context Builder 预检失败时 fail-closed；已写入但未完成的本地 user message 会回滚，不继续调用模型；临时 Memory retrieval outage 只在已提交 canonical user event 后降级为空 Context。
- cancel 与 regenerate 分别发布 content-free failed/superseded provenance event；旧 assistant 正文不会因 superseded 标记再次进入 Memory。
- `state_current` route now performs session-bound current-state retrieval with normalized source evidence instead of returning only a route hint.
- LifeState action/decision/reset/mode events now create idempotent source-event-bound draft growth evidence and first enter the application Interaction Outbox; Collector/Memory outage leaves pending/processing/dead-letter evidence and the browser command queue retains pending commands for replay. `/api/life/events/{id}/forget` 和 `DELETE /api/life/events/{id}` 会清理 LifeState recent/current event、growth evidence、relationship signal，并在已确认成长证据存在时重建 Personality projection。新增 policy-filtered `/api/life/context`、按 source event/action 的治理 operation ledger、`GET /api/life/events/{id}/governance` 和 repair endpoint，使游戏读取经过 Memory policy/Context Builder，且物理删除先成功而本地投影暂时失败时仍可恢复；required Auth acceptance 已真实覆盖 context isolation 与 forget/delete/retry/status。
- Numeric source-revision ordering and stale outbox fencing prevent older stream revisions from generating derived candidates.
- ContextBundle token budget enforcement：Core/Pin 与 evidence metadata 保留，正文压缩，无法满足固定包装时返回明确错误。
- Mutation API 幂等：`Idempotency-Key` / `idempotency_key` 支持 namespace、24 小时过期、payload 冲突、tenant/user 隔离、response replay、资源关联，以及 forget/delete 后的正文 replay 清理；事件 endpoint 保留原有 `event_id + source_revision` 语义。
- Export operation：新增 `/v1/export-operations` 创建/状态/下载闭环；操作本身不复制 canonical 正文，下载绑定 operation commit sequence，状态变化或 TTL 到期不会静默混合数据。
- Session visibility hard filter 与 deterministic `sweepRetention`：session assertion 只能在 active session 内读取；过期 session/current state/assertion/confirmation、raw event 和 mutation idempotency record 可在内存态 sweep 中清理或失效。
- 账号物理删除与恢复账本重放现在均按 tenant/user 及关联派生 ID 范围化清理，不会清空其他用户/租户；实时删除账本和恢复重放均有回归测试覆盖。
- 恢复账本重放与实时 forget 语义一致：受影响 session 会关闭，assertion/current-state/session 的 `resource_revision` 会推进，旧客户端写入不能凭旧 revision 复活。
- PostgreSQL repository 的 outbox load/save 按 subject 绑定；legacy `user_id IS NULL` 行只通过同 tenant 的 raw/assertion 所属关系回源，不再使用任意 tombstone/deletion target ID 参与跨用户读取或删除。
- PostgreSQL worker state save 现在在同一事务内校验 claimed outbox 的 `lease_owner/status`；失效 lease 返回 `WORKER_FENCED`，独立 service worker 的派生保存不再允许旧 worker 覆盖新 worker。
- assertion version 的 `content_type` 已统一 domain、OpenAPI 与 PostgreSQL schema，覆盖 `tool_output`、`imported` 和 `quoted_content`，并提供幂等 CHECK constraint migration。
- correction 的 sensitivity transition 已遵循 S2 confirmation 优先级：S2 correction 先保存 proposed version、保留旧 current version并绑定 assertion revision；S1 correction 不得进入长期 assertion。
- `retrieve` 与 `ContextBundle` 的 current-state 路径现在共享 active-session 硬过滤；无 session、closed/expired session 或错误 Agent 均不会返回 session state。
- session-scoped episode 只在对应 active session 内进入 ContextBundle；无 session 或 closed/expired session 不会返回其摘要和成员证据。
- active session 缺少 profile snapshot 时 ContextBundle fail-closed，不回退到会话外实时画像；snapshot 仍会回源校验 tenant/user/session。
- episode rebuild 不会把 session 原始事件提升为 user episode，也不会重建已被 tombstone、S2 或未完成流事件屏蔽的摘要；ContextBundle 对 episode 成员执行当前主体、生命周期和权限回源校验。
- ContextBundle 会过滤 `do_not_mention` 与非 `allow` 的 `direct_query_policy`；`contextualizable_only` 可进入 Bundle，但只有当前请求已直接授权的 memory evidence 才能绕过 mention/direct-query 过滤。episode 若其来源 assertion 处于隐藏策略，或成员回源校验不通过，则不返回该 episode 或对应成员证据。
- `proactive_mention` 独立 flag 已 fail-closed；新增 Agent 授权后的 content-free `(memory, topic)` cooldown 记录、过滤、过期清理和 `/v1/mentions` API 回归覆盖。
- 新增可选 Redis ContextBundle 派生缓存：只缓存无 query 的 bounded read model，缓存键不含查询正文，subject generation/commit/grant/privacy 版本变化会失效，Redis 故障不会阻塞 PostgreSQL canonical 路径；真实 Redis/TLS/容量行为仍未验收。
- Model Gateway 拒绝空文本输入，并对 extraction `structuredData` 做大小与 S3 内容门禁，避免模型输出携带未受控正文或密钥结构。
- 独立服务新增 OpenAI-compatible HTTP embedding adapter：API key 仅从服务端环境读取，query vector 经过统一 Model Gateway 的 S2/S3 输入门禁和向量 schema 校验；native vector/hybrid 查询在 provider 超时、错误或 pgvector 未启用时回退 PostgreSQL lexical candidates。此 wiring 仍不等于真实 provider、HNSW 查询计划或规模性能验收。
- 独立服务新增可选 OpenAI-compatible structured extraction adapter；原始 event content 作为 untrusted data 发送，统一 gateway 负责输入门禁与候选 schema 过滤，未配置时继续使用 heuristic extraction。
- 新增真实环境验收入口 `npm run test:memory-postgres-acceptance`、显式开关保护的 `npm run benchmark:memory-postgres`、`npm run test:companion-core-auth`、`npm run test:companion-core-tls` 和 `npm run check:companion-backup-restore`；本地临时 PostgreSQL 证据已产生，但正式托管环境仍需复验。
- 新增 `npm run test:memory-sdk` 外部 caller smoke 和独立服务 `/metrics` 的 backlog/index/deletion/privacy 聚合指标；本轮独立服务 SDK 链路已通过，真实 Redis/托管网络边界与容量仍需验收。
- 通用 observability 增加有界 p50/p95/p99 latency、HTTP status counts 和 sample count，避免用平均延迟掩盖尾延迟；生产采样仍需真实部署验证。

## 尚未形成的量化证据

- v0.2 已有 deterministic synthetic baseline（Recall@5=1.0、MRR=1.0、nDCG=1.0、no-answer/conflict/authorization/evidence support=1.0），但它只验证 seeded in-memory harness；它不是 600 条真实/脱敏对话，不能替代真实 Recall@5/10、MRR、nDCG、no-answer precision/recall、conflict precision/recall 和自动晋升误激活率。
- 真实 PostgreSQL lexical 1M 和 pgvector/HNSW 100k 压测结果已形成；1M pgvector seed 因本机临时卷空间不足失败，因此 1M/HNSW 仍未关闭。fast seed 资格、积压/降级场景和正式 SLO 仍需 Alpha 评审明确保留。
- 隔离 PITR/tombstone replay 与 claim 后进程崩溃接管已通过；生产 RPO/RTO SLO、长期 outage/backlog 注入、正式托管环境的证书链/HTTPS 和真实删除传播计时仍未完成。
- 已有统一 Model Gateway wrapper、OpenAI-compatible HTTP embedding adapter、S2/S3 输入门禁、embedding 输出校验、统一 timeout/AbortSignal、可分类错误/retry 和 content-free provider/model/token telemetry 单测；仍没有正式结构化模型的抽取精确率、S2/S3 假阴性率和供应商数据保留审计。
- 已有异步 index embedding 回填、超时降级和 BM25 fallback 单测；新增显式 pgvector 迁移、JSONB 回填、HNSW cosine 索引和可选 `embedding_vector` 写入路径，但真实 pgvector 查询计划和规模性能仍尚未验收。
- 新增 PostgreSQL 原生 `searchIndexDocuments` 候选查询 hook，覆盖 tenant/user、Agent grant、relationship/session Scope、生命周期、redaction/policy epoch 和 current version 硬过滤；独立服务在 `MEMORY_MODULE_NATIVE_RETRIEVAL=true` 下让 retrieve 使用轻量 metadata、context-bundle 使用 bounded profile/current-state/episode read model，再经过内存层 finalization；native lexical/vector/hybrid 已接入可选服务端 embedding gateway，并保留 lexical fallback，真实 vector/hybrid 规模性能仍未验收。
- `npm run test:memory-postgres`、`npm run test:memory-postgres-acceptance` 和 `npm run test:companion-core-auth` 已在临时真实 PostgreSQL 重跑；pgvector/HNSW 小规模 acceptance 与 100k vector benchmark 也已产生独立 artifact。正式托管环境仍需复验。
- `npm run evaluate:memory` 已提供版本化结果文件驱动的全量 600-case 指标入口，输出 Recall@5/10、MRR、nDCG、category/Scope、no-answer、conflict、authorization、S2/S3 false-negative 和 proactive-mention precision/recall；真实/脱敏 cases 与 results JSON 仍未提供，因此当前不会生成真实评测指标。
- `npm run benchmark:memory` 已提供本地 HTTP 并发 synthetic BM25 入口：本次最新默认 10,000 文档/20 并发为 p50 472.38ms、p95/p99 572.57ms；此前 1,000,000 文档/20 并发观测为 p50 13.20s、p95/p99 24.63s。两者均为单进程内存 BM25，不代表 PostgreSQL/pgvector acceptance run。

## Alpha 判定

当前状态：**not ready for real-user Alpha**。代码级基线和离线状态机证据已达到继续集成的条件，但必须完成真实 PostgreSQL、恢复/故障注入、安全日志采样、性能压测和真实/脱敏评测后，才能接受 Alpha 发布门禁。

逐项 gate 状态见 [`memory-module-alpha-gate.md`](./memory-module-alpha-gate.md)。
