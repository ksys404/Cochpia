# Memory Module Data Model

版本：V1 draft（2026-08-22）

## Canonical aggregates

PostgreSQL 是唯一事实来源；以下对象均带 `tenant_id`，用户主体字段只从认证 context 绑定：

| 聚合 | 关键字段 | 约束/索引 |
| --- | --- | --- |
| `raw_events` | event/source revision、session、role、content、retention、delete_after、commit_seq | `(tenant,user,event_id,source_revision)` 幂等；S3 不入表 |
| `memory_assertions` | Scope、canonical_key、status、sensitivity、policy、current_version_id | user/relationship/session Scope check；session 必须 TTL |
| `assertion_versions` | content、structured_data、trust、valid window、supersedes | version/source 外键；current version 延迟 FK |
| `assertion_version_sources` | version、source type/id | source 级外键关系，支持删除传播 |
| `current_states` | session、agent、value、expires_at、allow_persist | 不进入长期 assertion/profile |
| `profile_snapshots` | session、grant/privacy epoch、revision | 对话固定快照，读取时实时治理覆盖 |
| `memory_mention_cooldowns` | tenant/user/agent/memory/topic、冷却时间 | 主动提及后的无正文抑制记录，可过期重建 |
| `profile_projections` | Scope、policy/model version、source commit | 可重建派生物 |
| `index_documents` | source/version、Scope、policy/redaction epoch、lexical/vector version | JSONB embedding 保持兼容；显式 pgvector 迁移后写入 `embedding_vector` 并使用 HNSW，返回前仍回源 |
| `episodes`/`episode_members` | temporal grouping、成员 raw/version | 摘要不能替代成员证据 |
| `deletion_operations`/`memory_tombstones` | target、action、epoch、状态、时间 | 保留最小治理账本，不保留正文 |
| `memory_outbox_events` | user、`consumer_name`、event type、aggregate、lease、attempts | 当前派生 worker 使用 `memory-derived`；至少一次投递、租约和 fencing |

## State and identity rules

- `user` Scope：relationship/session 字段为空。
- `relationship` Scope：精确 `relationship_agent_id`，不允许通配。
- `session` Scope：必须有 `session_id` 和 `expires_at`；可绑定 caller agent。
- `current_version_id` 必须属于同一 tenant/assertion；版本替换生成新 version，不能原地改 Scope。
- PostgreSQL deferred constraint guard additionally requires an active assertion to have a `current` version, and rejects a pointer to a proposed/superseded version.
- 所有来源通过关系表保存，不把 source ID 只塞入 JSON。
- Index/projection/episode/cache 都必须带 source/version、policy epoch 和 redaction epoch，且可由 canonical 重建。
- `current_state_sources` 以 `user_id` 绑定并以复合外键关联 current state 与同一用户的 raw event；`profile_projection_sources` 逐 projection item 关联同一用户的 assertion version/source，不能只依赖 JSON source ID 数组。
- 所有带 `session_id` 的用户内容表都使用 `(tenant_id, user_id, session_id)` 复合外键绑定 `memory_sessions`，避免只校验 tenant 而跨用户引用会话；profile snapshot/item、projection/source、confirmation 和 pin 也使用 subject-bound 外键。
- pgvector 不是默认隐式启用：先运行 `MEMORY_MODULE_EMBEDDING_DIMENSIONS=<dimension> npm run migrate:memory-pgvector`，再设置 `MEMORY_MODULE_PGVECTOR_ENABLED=true`；服务启动会检查 extension 和 `embedding_vector` 列是否存在。
- Repository 提供 `searchIndexDocuments` 原生候选查询 hook，SQL 层执行主体、grant、session、lifecycle、privacy/policy epoch 和 current-version 硬过滤；独立服务在 `MEMORY_MODULE_NATIVE_RETRIEVAL=true` 下让 retrieve 使用轻量 read metadata、context-bundle 使用 bounded profile/current-state/episode read model，当前仍不能据此宣称 1M 性能已达标。

## Repository consistency

`memory_commit_sequences(tenant_id,user_id)` 是 subject 级 optimistic concurrency guard。Repository save 在删除/重写 snapshot 前锁定 sequence；sequence 不一致返回 `MEMORY_STORAGE_CONFLICT`，不会执行 destructive writes。
