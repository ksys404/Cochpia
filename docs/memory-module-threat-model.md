# Memory Module Threat Model & Security Baseline

版本：V1 draft（2026-08-22）

## 信任边界

- Cochpia、Agent 和 Live2D 客户端只能通过 `/v1` API/SDK 访问 Memory Module，不能直接访问 canonical database。
- API 请求中的 `tenant_id`、subject user 和 caller agent 来自受信认证上下文；请求 body 中的同名字段只用于一致性校验，不能切换主体。
- PostgreSQL 是事实来源；索引、projection、episode、缓存和 worker queue 都是派生或可重建数据。
- Model Gateway 是不受信的外部处理器。S3 内容不得发送给它；模型返回只按结构化 data 校验，不能成为系统指令或权限变更。
- 日志、备份、PITR、外部模型和运维人员都属于潜在的二次泄漏面。

## 主要威胁与控制

| 威胁 | 控制 | 当前证据 | 剩余工作 |
| --- | --- | --- | --- |
| 跨 tenant/user 读取或写入 | context binding、body mismatch rejection、repository subject key | V1 API、domain、隔离测试通过 | 真实认证+PostgreSQL 负向验收 |
| relationship 记忆被其他 Agent 读取 | 精确 `(tenant,user,agent)` Scope | domain/API 测试通过 | 多 Agent 集成测试 |
| S3 secret 落库、进队列或发给模型 | 同步入口检测；extraction 再检查；日志不打印正文 | S3 ingress/model tests 通过 | 真实 WAL/log/model proxy 检查 |
| Prompt injection 改变 system/tool 行为 | memory content is data；不拼接为 tool/system instruction | contract/retrieval tests | 端到端 Agent harness |
| S2 健康/财务等内容自动激活 | pending confirmation、direct-query policy | S2 tests 通过 | 分类集假阴性率报告 |
| forget 后旧 worker 复活 | tombstone/epoch、lease/fencing、outbox redaction | worker/recovery tests 通过 | PostgreSQL 旧 worker 故障注入 |
| 索引或 snapshot 泄漏已删除内容 | 回源校验、epoch、derived rebuild/delete | domain/rebuild tests 通过 | 真实索引与备份恢复演练 |
| 重放/重复事件造成重复记忆 | idempotency key、source linkage、candidate dedupe | domain/extraction tests 通过 | 多进程并发验收 |
| 日志泄漏正文/凭据 | 结构化事件只记录 ID/status/code；密钥只来自环境变量 | 静态扫描和代码检查通过 | 生产日志采样与 DLP 检查 |

## 必须保持的生产基线

- `AUTH_MODE=required`、`STORAGE_PROVIDER=postgres`。
- 生产数据库使用 `DATABASE_SSL=true` 或 `verify-full` 并校验证书；`no-verify` 只允许明确的开发/自签名例外。
- 生产环境必须设置 Memory Module service token，所有密钥不得写入源码、日志或响应。
- `auto_extract`、`auto_profile_update`、`episode_grouping`、`vector_retrieval` 和主动提及必须可独立关闭。
- worker、index、backup、restore 失败时只能降级派生能力，不能伪造治理 mutation 成功。

## 未接受风险

当前没有可用的真实 PostgreSQL、PITR 或压测环境，因此数据库事务、TLS 证书链、RPO/RTO、p95/p99 和跨进程 fencing 尚未形成运行证据。进入真实用户 Alpha 前必须完成这些验证并记录负责人和结果。
