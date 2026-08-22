# Memory Module Data Retention & Deletion Spec

版本：V1 draft（2026-08-22）

## 保留策略

| 数据 | 默认策略 | 说明 |
| --- | --- | --- |
| session raw event | session TTL 或默认 35 天，以较短者为准 | session 不自动升级为长期事实 |
| user/relationship raw event | 默认 35 天 `delete_after` | 到期后物理清理；长期事实依靠 assertion/version/source 追溯 |
| active assertion/version | 按 `retention_policy` | superseded/revoked/expired 不进入普通召回 |
| current state | 必须有 `expires_at` | 过期后不进入 Stable Profile 或长期检索 |
| profile snapshot/projection | 可从 canonical 重建 | forget/delete 后不能成为可见副本 |
| proactive mention cooldown | 仅保存 memory/agent/topic 标识与时间，不保存正文 | 随 memory、relationship、session 或 account 删除；过期 sweep 清理 |
| index/vector/episode | 派生物 | canonical mutation 成功后立即回源不可见，异步物理清理目标 p99 ≤ 60 秒 |
| audit/deletion ledger | 只保留治理所需最小元数据 | 不保存用户正文、secret 或模型原文 |
| backups/PITR | V1 默认最长 35 天 | 恢复开放流量前必须重放独立删除账本 |

## 治理语义

- `revoke`：事务内不可见，历史可按策略保留；新显式操作才可恢复。
- `forget`：事务内不可见，进入 tombstone/epoch；不再用于 projection、index 或 candidate。
- `delete`：指定 memory、source event、session、relationship 或 account 的 canonical 数据物理删除；返回 `deletion_operation_id`。
- `do_not_store`：入口判定后不写 raw event、outbox、模型任务、向量或普通日志；响应不回显检测到的 secret。
- `do_not_mention`：仍可按权限检索，但主动提及过滤；`direct_query_policy=deny` 时即使用户直接询问也不能返回。

## Delete 传播

1. 先在同一 canonical mutation 中建立 operation、tombstone 和 privacy epoch。
2. 同一事务内移除或隐藏指定 raw event、assertion/version、snapshot item、projection item、index document、episode member、confirmation、pin 和 queued work。
3. 回源校验保证 API 成功返回后旧内容不会因 stale index、快照或 worker 再次出现。
4. 派生物和缓存可异步物理清理；删除 operation 记录不含正文，用于追踪传播状态。
5. 任何备份恢复必须先重放 tombstone/redaction ledger，再允许流量访问。

## 当前实现边界

Memory domain 已实现 memory/source/session/relationship/account 的物理 delete，独立 API 暴露 `/v1/governance/delete`，并提供 `sweepRetention` 对过期 raw event、session assertion/current state、confirmation 和 mutation idempotency record 做确定性清理或失效处理。PostgreSQL repository 已按 user-scoped outbox 清理；新增 `check:memory-recovery` 可对恢复 artifact 执行 tombstone replay 与负向泄漏检查。真实 PostgreSQL 调度、级联、备份/PITR 和删除延迟仍需环境演练后才可标记为已验收。
