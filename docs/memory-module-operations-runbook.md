# Memory Module Operations Runbook

版本：V1 draft（2026-08-22）

## 启动前检查

- 生产配置：`AUTH_MODE=required`、`STORAGE_PROVIDER=postgres`、`DATABASE_SSL=true`/`verify-full`、`MEMORY_MODULE_SERVICE_TOKEN`。
- 迁移窗口显式运行 schema migration；稳定运行时建议 `MEMORY_MODULE_AUTO_MIGRATE=false`。
- 默认关闭自动派生能力。需要灰度时逐项打开：`MEMORY_AUTO_EXTRACT`、`MEMORY_AUTO_PROFILE_UPDATE`、`MEMORY_HYBRID_RETRIEVAL`、`MEMORY_VECTOR_RETRIEVAL`、`MEMORY_EPISODE_GROUPING`。
- `MEMORY_MODULE_REDIS_URL` 为可选派生缓存；缓存只服务 bounded ContextBundle read model，Redis 不可用时必须继续走 PostgreSQL canonical 路径，不得把缓存故障升级为治理或写入成功/失败语义。
- `MEMORY_MODULE_WORKER_ENABLED=false` 可在故障时停派生 worker；显式记忆、读取和治理 API 不应因此失效。
- 不在命令行、日志或工单中粘贴 `DATABASE_URL`、service token、model key 或用户正文。
- 如果 production 启动报 `MEMORY_EXTERNAL_POLICY_REQUIRED`，先补齐 provider retention policy 并完成供应商 retention/region/training 审计；不要通过设置 `unknown` 绕过。

## 健康与降级

- `/health` 失败：先检查数据库连通性、TLS、连接池和 schema；不要通过关闭认证或切换到共享 JSON 存储解决生产故障。
- `/metrics` 返回请求 SLI（含 p50/p95/p99、状态计数和有界延迟样本数）以及 `operational.outbox`（状态/最老 backlog age）、`operational.index`（freshness、stale、privacy epoch mismatch）和 `operational.deletions`（传播状态/年龄）；这些字段只包含计数、时间和错误元数据，不包含正文。
- Model Gateway 超时/不可用：保留 raw event；candidate、projection 和 vector 派生延迟或关闭；显式记忆继续工作。
- Redis/cache 超时或连接失败：记录无正文错误码并绕过缓存；不要关闭 canonical retrieve、治理或写入，也不要把 Redis 作为事实来源。
- Index/vector 故障：回退结构化查询/BM25；不得把索引当作权限真相。
- Worker backlog 增长：记录 `pending` 年龄、attempts、lease expiry、fencing、dead-letter；必要时先关闭对应 feature flag，再处理死信。

## Outbox/worker 故障处理

1. 观察 `memory_outbox_events` 的 `pending/processing/dead_letter` 数量和最老创建时间。
2. 检查是否存在持续 `MEMORY_STORAGE_CONFLICT`、`WORKER_FENCED`、`MODEL_*` 或数据库超时。
3. 关闭导致故障的派生 flag；不要直接删除 pending 事件。
4. 修复后通过 lease expiry/retry 继续处理；死信必须人工确认后重放，先确认 tombstone/epoch 没有阻止的内容。
   `UNSUPPORTED_OUTBOX_SCHEMA` 不应自动重试；先部署兼容 worker 或执行经过审查的 event migration，再人工重放。
5. 任何治理事件优先级高于派生事件；forget/delete 成功后必须验证旧事件不会重新生成 candidate。

## 删除与恢复

- 用户请求忘记：调用 `/v1/memories/{id}/forget` 或 `/v1/governance/forget`，随后验证 retrieve/context-bundle/snapshot/index/worker 都不可见。
- 用户请求删除：调用 `/v1/governance/delete`，保存 `deletion_operation_id`，轮询 operation 状态，不把“API 成功”与“所有物理副本已清理”混为一谈。
- 恢复 PITR：先停止对外流量；加载 canonical backup；重放独立 tombstone/redaction ledger；重建派生索引；执行负向检索；通过后再开放流量。
- 恢复后的 JSON canonical snapshot 与独立删除账本可先通过 `MEMORY_RECOVERY_STATE=... MEMORY_RECOVERY_LEDGER=... npm run check:memory-recovery` 执行离线账本重放和负向泄漏检查；该检查只证明输入 artifact 的恢复门禁，不替代真实 PostgreSQL/PITR、RPO/RTO 演练。
- 当前仓库已有内存态 recovery replay 测试；真实 PostgreSQL/PITR run 尚未执行，不能报告 RPO/RTO 已达标。

## 指标告警映射

- `outbox.pending.oldestAgeSeconds` 超过目标：检查 worker lease、数据库慢查询和 provider timeout；必要时关闭派生 flag。
- `index.staleByCanonicalUpdate` 或 `maxFreshnessLagSeconds` 超过目标：检查索引 worker/backlog，不把 stale index 当权限真相。
- `index.privacyEpochMismatch > 0`：立即执行隐私一致性排查，回源校验并暂停相关派生任务。
- `deletions.propagating` 长时间不下降或出现 `failed`：保留 operation ID，按删除账本和 tombstone 流程处理。

## 事故记录字段

至少记录：UTC 时间、tenant（必要时脱敏）、operation/event ID、feature flag、错误 code、影响范围、canonical 是否可见、索引清理时间、恢复动作、回滚决定和负责人。禁止记录正文和密钥。
