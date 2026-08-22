# Memory Module Alpha Gate

状态：**NOT READY FOR REAL USER DATA**（2026-08-22）

| Gate | 当前状态 | 证据 | 结论 |
| --- | --- | --- | --- |
| tenant/user/relationship/session 隔离 | code+unit green | `npm test` domain/API/negative tests | 通过代码基线；需真实 auth+Postgres 复验 |
| canonical subject-bound DB constraints | schema+repository wiring green | `memory-module-schema.test.js` + repository source-column test | 已加入同用户 session/source 复合外键与 current-version guard；真实 PostgreSQL 约束执行仍未运行 |
| S3 不落库/不进 outbox/model | code+unit green | ingress/extraction/model tests、fixture scan | 通过已知模式；需生产日志/WAL/proxy sampling |
| read-your-write / S2 confirmation / TTL | code+unit green | domain/API tests | 通过代码基线 |
| correct/pin/revoke/forget/delete | code+unit green | governance tests、delete API test | 通过代码基线；需真实传播计时 |
| worker lease/retry/dead-letter/fencing | code+unit green | worker/recovery/service-worker tests + PostgreSQL fenced save query | 已加入事务级 `lease_owner/status` fence；真实 PostgreSQL 多进程故障注入仍未运行 |
| profile/index/episode flags | code+unit green | service worker tests | 通过 wiring；需真实 backlog/freshness |
| proactive mention flag/cooldown | code+unit+API green | `memory-module.test.js` + `memory-module-api.test.js` + `memory-module-schema.test.js` | disabled 时 fail-closed；仅对已授权 Agent 记录 content-free cooldown；真实部署行为仍需验证 |
| versioned ContextBundle cache | code+unit green; optional Redis wiring | `memory-module-cache.test.js` + PostgreSQL repository cache test | 默认关闭；只缓存无 query 的 bounded read model，tenant/user 与 commit/grant/privacy generation 绑定；Redis 故障回退 canonical PostgreSQL |
| hybrid/vector/RRF fallback | code+unit green; optional HTTP embedding adapter + native lexical/vector/hybrid fallback wired | retrieval/domain/native retriever/HTTP adapter tests + async index embedding test + migration/helper/native SQL/native hook/read-model tests | 独立服务只在显式配置 embedding URL、feature flag 和 pgvector 后生成服务端 query vector；provider/pgvector 不可用会回退 lexical；真实 pgvector/HNSW/vector-hybrid 性能仍未验收 |
| 600-case evaluation | synthetic baseline green; real evaluation missing | v0.2 synthetic JSON + in-memory runner + metrics harness + `npm run evaluate:memory-synthetic` / `npm run evaluate:memory` | synthetic seeded baseline 全部 1.0，但真实/脱敏结果 JSON、抽取/晋升/主动提及质量指标仍未提供 |
| PostgreSQL schema/repository | smoke + acceptance ready, not run | `MEMORY_MODULE_SMOKE_APPLY_SCHEMA=true npm run test:memory-postgres`；`MEMORY_MODULE_ACCEPTANCE_APPLY_SCHEMA=true npm run test:memory-postgres-acceptance`；覆盖重复 schema、主体隔离、native lexical/vector/hybrid、Scope 和查询计划证据 | 当前无 `DATABASE_URL`；上述真实 SQL 证据未运行 |
| PITR/tombstone replay/RPO/RTO | implementation/test only | recovery replay tests | 真实 backup restore 未运行 |
| 1M-doc/20-concurrent p50/p95/p99 | local synthetic sanity complete; real PostgreSQL benchmark harness ready, not run | `MEMORY_MODULE_BENCHMARK_DB_ENABLED=true ... npm run benchmark:memory-postgres` + local synthetic benchmark | 单进程内存 BM25 结果不计入 acceptance；真实 PostgreSQL/pgvector、强 Scope、积压与降级场景仍未执行 |
| Model Gateway retention/quality | wrapper+HTTP extraction/embedding adapters+unit green, provider audit missing | gateway wrapper/HTTP adapter/native fallback tests + Model Gateway spec | 真实 structured extraction 质量、S2/S3 假阴性率和供应商审计未完成 |
| Cochpia/API SDK first external chain | SDK smoke ready, not run | `MEMORY_MODULE_URL=... MEMORY_MODULE_SDK_TENANT_ID=... MEMORY_MODULE_SDK_USER_ID=... npm run test:memory-sdk` | 当前未连接真实独立服务；本地 API/SDK contract unit tests 通过 |
| production TLS/security headers | guard implemented | independent service startup guard + headers | 需部署环境验证证书/HTTPS |

## Required final evidence before completion

1. 配置真实 PostgreSQL，执行 schema、repository smoke、并发冲突和 leased worker test。
2. 恢复删除前 PITR/backup，重放 deletion ledger，验证 retrieve、snapshot、index、outbox 不复活。
3. 执行真实分布的 600-case 脱敏评测，生成 Recall@5/10、MRR、nDCG、no-answer、conflict、Scope、S2/S3 和 mention 报告。
4. 执行 1M index documents、20 concurrent、强 Scope 过滤和积压场景压测，记录 p50/p95/p99 和降级率。
5. 接入正式结构化 Model Gateway，完成模型输入/输出脱敏、保留策略和质量审计。
6. 所有 P0/P1 安全与治理问题关闭或由明确负责人签署风险接受。
