# Memory Module Evaluation Report

版本：V1 draft（2026-08-22）

## 已执行的自动化证据

- `npm test`：231 tests，226 passed，5 skipped，0 failed。
- skipped 项均依赖外部认证、PostgreSQL 或隔离集成环境，不代表通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- OpenAPI 3.1 artifact：Ruby YAML 解析通过，包含 21 个 V1 path、27 个 schema；路由/安全契约测试通过。
- 静态密钥扫描：未发现 live credential；命中的 `AKIA...` 仅是 S3 入口拒绝测试 fixture，API key 命中仅为环境变量名称。
- V0.1 baseline：50 条，覆盖 preference、relationship、current_state、no_answer、conflict、scope。
- V0.2 scaffold：600 条 synthetic，类别配额为 120/90/120/90/60/60/30/30，并带 development/holdout/acceptance split。
- Synthetic baseline：`npm run evaluate:memory-synthetic` 已使用真实 in-memory domain 跑完 600 条并生成 [`memory-module-eval-v0.2-synthetic-results.json`](./memory-module-eval-v0.2-synthetic-results.json)；Recall@5/MRR/nDCG/no-answer/conflict/authorization/evidence support 均为 1.0。该结果是 seeded synthetic harness sanity check，不是真实/脱敏对话评测，也不计入 Alpha acceptance。

## 已覆盖的行为

- tenant/user/relationship/session 边界、body context mismatch、S3 入口门禁。
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
- `state_current` route now performs session-bound current-state retrieval with normalized source evidence instead of returning only a route hint.
- Numeric source-revision ordering and stale outbox fencing prevent older stream revisions from generating derived candidates.
- ContextBundle token budget enforcement：Core/Pin 与 evidence metadata 保留，正文压缩，无法满足固定包装时返回明确错误。
- Mutation API 幂等：`Idempotency-Key` / `idempotency_key` 支持 namespace、24 小时过期、payload 冲突、tenant/user 隔离、response replay、资源关联，以及 forget/delete 后的正文 replay 清理；事件 endpoint 保留原有 `event_id + source_revision` 语义。
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
- 新增真实环境验收入口 `npm run test:memory-postgres-acceptance`、显式开关保护的 `npm run benchmark:memory-postgres`，以及恢复 artifact 的 `npm run check:memory-recovery`；当前环境没有 `DATABASE_URL` 或恢复 artifact，因此这些真实环境证据尚未产生。
- 新增 `npm run test:memory-sdk` 外部 caller smoke 和独立服务 `/metrics` 的 backlog/index/deletion/privacy 聚合指标；当前真实独立服务未连接，指标只完成 wiring/unit 验证。
- 通用 observability 增加有界 p50/p95/p99 latency、HTTP status counts 和 sample count，避免用平均延迟掩盖尾延迟；生产采样仍需真实部署验证。

## 尚未形成的量化证据

- v0.2 已有 deterministic synthetic baseline（Recall@5=1.0、MRR=1.0、nDCG=1.0、no-answer/conflict/authorization/evidence support=1.0），但它只验证 seeded in-memory harness；它不是 600 条真实/脱敏对话，不能替代真实 Recall@5/10、MRR、nDCG、no-answer precision/recall、conflict precision/recall 和自动晋升误激活率。
- 没有真实 PostgreSQL/pgvector 的 1M index documents、20 concurrent requests 的 p50/p95/p99 压测结果；本地 synthetic 单进程 BM25 已完成同规模 sanity check，但不计入路线图 acceptance。
- 没有真实 PostgreSQL schema/repository smoke、并发冲突、旧 worker fencing、PITR/RPO/RTO 或删除传播计时结果；smoke 入口已扩展为可覆盖重复 schema、tenant/user 隔离和 lease 到期 fencing，但当前因无 `DATABASE_URL` 未运行。
- 已有统一 Model Gateway wrapper、OpenAI-compatible HTTP embedding adapter、S2/S3 输入门禁、embedding 输出校验、统一 timeout/AbortSignal、可分类错误/retry 和 content-free provider/model/token telemetry 单测；仍没有正式结构化模型的抽取精确率、S2/S3 假阴性率和供应商数据保留审计。
- 已有异步 index embedding 回填、超时降级和 BM25 fallback 单测；新增显式 pgvector 迁移、JSONB 回填、HNSW cosine 索引和可选 `embedding_vector` 写入路径，但真实 pgvector 查询计划和规模性能仍尚未验收。
- 新增 PostgreSQL 原生 `searchIndexDocuments` 候选查询 hook，覆盖 tenant/user、Agent grant、relationship/session Scope、生命周期、redaction/policy epoch 和 current version 硬过滤；独立服务在 `MEMORY_MODULE_NATIVE_RETRIEVAL=true` 下让 retrieve 使用轻量 metadata、context-bundle 使用 bounded profile/current-state/episode read model，再经过内存层 finalization；native lexical/vector/hybrid 已接入可选服务端 embedding gateway，并保留 lexical fallback，真实 vector/hybrid 规模性能仍未验收。
- `npm run test:memory-postgres` 已提供真实环境 smoke；当前因未配置 `DATABASE_URL` 只安全跳过，未计入通过证据。
- `npm run evaluate:memory` 已提供版本化结果文件驱动的 600-case 指标入口；当前未提供真实/脱敏结果 JSON，因此不会生成虚假指标。
- `npm run benchmark:memory` 已提供本地 HTTP 并发 synthetic BM25 入口：本次最新默认 10,000 文档/20 并发为 p50 472.38ms、p95/p99 572.57ms；此前 1,000,000 文档/20 并发观测为 p50 13.20s、p95/p99 24.63s。两者均为单进程内存 BM25，不代表 PostgreSQL/pgvector acceptance run。

## Alpha 判定

当前状态：**not ready for real-user Alpha**。代码级基线和离线状态机证据已达到继续集成的条件，但必须完成真实 PostgreSQL、恢复/故障注入、安全日志采样、性能压测和真实/脱敏评测后，才能接受 Alpha 发布门禁。

逐项 gate 状态见 [`memory-module-alpha-gate.md`](./memory-module-alpha-gate.md)。
