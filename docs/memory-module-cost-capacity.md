# Cost & Capacity Report

版本：V1 planning estimate（2026-08-22）

本报告只用于容量和运维规划，不作为付费等级或记忆质量降级规则。

## 需要实测的变量

| 变量 | 采集方式 |
| --- | --- |
| raw event bytes/day | canonical row size × events/day |
| assertion/version growth | promotion rate × active users |
| index/vector bytes | document count × lexical/vector payload size |
| worker CPU/backlog | event rate、model latency、retry rate |
| PostgreSQL storage/IO | table/index size、WAL、backup growth |
| API p50/p95/p99 | structured/retrieve/bundle/governance 分端点测量 |
| model spend | extraction/embedding calls × provider unit cost |

## Capacity scenarios

至少建立 small/medium/large 三档，分别记录 active users、events/user/day、retention days、candidate rate、embedding rate、concurrency、index freshness 和 backup size。每档都必须包括多 tenant 倾斜、空结果、Scope 高选择性和 backlog 积压场景。

## Stability protections

- canonical write 和 governance 不依赖 embedding/model 成功。
- worker 并发、lease、retry、dead-letter 和 circuit breaker 限制外部成本。
- vector/hybrid 可一键关闭并回退 BM25。
- 不因用户付费等级主动削弱召回、治理或删除质量。
- 独立服务 `/metrics` 暴露请求延迟、outbox backlog age、index freshness/privacy mismatch 和 deletion propagation 计数，作为容量与事故演练的输入。

## Current status

当前仓库已有 feature flags、worker retry/fencing 和 BM25 fallback。已完成本地单进程内存 BM25 的 1M documents/20 concurrent sanity check（p50 13.20s、p95/p99 24.63s），但它不代表 PostgreSQL/pgvector 的真实资源曲线；因此本报告仍不提供生产容量数字。

已新增显式开关保护的 `npm run benchmark:memory-postgres`：设置 `MEMORY_MODULE_BENCHMARK_DB_ENABLED=true` 后，它会在随机 tenant 前缀下生成可清理的 PostgreSQL benchmark 数据，支持 1M documents、20 concurrent、multi-tenant/user 倾斜、空结果和 lexical/hybrid 模式，并输出真实 p50/p95/p99。未设置该开关或 `DATABASE_URL` 时不会写入数据库。当前环境尚未执行该真实 benchmark，因此本报告不把它当作容量结果。
