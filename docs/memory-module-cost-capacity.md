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

当前仓库已有 feature flags、worker retry/fencing/backoff 和 BM25 fallback。最新真实本地 PostgreSQL lexical benchmark 已完成 1M documents/20 concurrent：p50 39.49ms、p95/p99 368.29ms、20/20 请求成功、orphan reference=0。另有真实 pgvector/HNSW hybrid benchmark：100k documents/20 concurrent，p50 138.05ms、p95/p99 142.18ms、HNSW 重建后 20/20 成功；本轮新增 lean 1M pgvector/HNSW hybrid：1,000,000 index documents、10,000 canonical assertions/versions、20/20 成功，p50 916.14ms、p95/p99 1173.35ms。另有虚拟时钟 outage/backlog acceptance：500 条事件、两轮 outage、退避增长且恢复后 500/500 完成。原始 benchmark/acceptance JSON 只保存在本地 `artifacts/`，由对应命令重新生成。上述结果只能作为查询路径、尾延迟和恢复逻辑基线，不能直接作为生产容量/RPO/RTO 承诺；完整 canonical 1M assertion/version run 仍需更大受控 PostgreSQL volume。

已新增显式开关保护的 `npm run benchmark:memory-postgres`：设置 `MEMORY_MODULE_BENCHMARK_DB_ENABLED=true` 后，它会在随机 tenant 前缀下生成可清理的 PostgreSQL benchmark 数据，支持 lexical/hybrid 模式、multi-tenant/user 倾斜、空结果和 p50/p95/p99 输出。1M lexical 已完成；100k pgvector/HNSW 已完成；lean 1M pgvector/HNSW 已完成；完整 canonical 1M pgvector 仍需要更大的受控 PostgreSQL volume。`MEMORY_MODULE_BENCHMARK_FAST_SEED=true` 只适用于合成装载加速，`MEMORY_MODULE_BENCHMARK_LEAN_INDEX=true` 会明确降低 canonical assertion/version 数量，结果必须标注为 lean；未设置 DB 开关或 `DATABASE_URL` 时不会写入数据库。
