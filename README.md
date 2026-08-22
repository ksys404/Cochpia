# Cochpia

Ai的人生谁来定义？

Cochpia 是一个围绕共同经历、外部记忆、SSE 流式交互和可验证人格成长构建的 AI 陪伴应用骨架。

## Run

```powershell
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8787
- Health: http://localhost:8787/api/health
- Model catalog: http://localhost:8787/api/models
- MCP endpoint: POST http://localhost:8787/mcp

## Model configuration

默认使用 `MODEL_PROVIDER=mock`，不会产生云端费用。服务端通过 `GET /api/models` 提供供应商、协议、推荐模型、生产场景注释和 `ready` 状态；前端设置面板可查看目录、测试真实连接并按会话保存模型选择。

API Key 只放在服务端环境变量中：

```text
MODEL_PROVIDER=mock
STORAGE_PROVIDER=json
MODEL_<PROVIDER>_API_KEY=server-only-secret
MODEL_<PROVIDER>_NAME=provider-model-name
MODEL_<PROVIDER>_API_URL=optional-endpoint-override
MODEL_TIMEOUT_MS=30000
```

`ready=true` 只表示环境变量配置完整，不代表真实云端调用已经成功。没有 API Key 时，连接测试会返回真实的 `MODEL_NOT_CONFIGURED`，不会伪造成功。

本地默认使用 JSON 存储。部署 PostgreSQL 或 Supabase 时，将 `STORAGE_PROVIDER` 改为 `postgres`，并配置 `DATABASE_URL`；可选设置 `DATABASE_SSL=true`。后端会自动创建 `cochpia_state` 表。当前阶段使用 JSONB 聚合状态，后续再按用户、会话、消息和记忆拆分为规范化表。

支持的适配族包括 OpenAI-compatible、Anthropic Claude 和 Google Gemini。当前目录包含 OpenAI、DeepSeek、通义千问、智谱 GLM、Kimi、MiniMax、SiliconFlow、Claude、Gemini 和本地 Mock。

## Structure

- `client/`: React/Vite 聊天工作区、模型选择器和设置面板
- `server/index.js`: 会话 API、模型目录、连接测试、SSE 和 MCP JSON-RPC
- `server/model-provider.js`: 模型注册表与协议适配器
- `server/memory-module-runtime.js`: Memory Module 运行时、对外接口和旧数据一次性迁移边界
- `server/data/state.json`: JSON 本地开发持久化
- `server/schema.sql`: PostgreSQL 初始状态表

## Verification

```powershell
npm test
npm run build
```

Memory Module 验证入口：

```sh
npm run test:memory-postgres
MEMORY_MODULE_ACCEPTANCE_APPLY_SCHEMA=true npm run test:memory-postgres-acceptance
MEMORY_MODULE_BENCHMARK_DB_ENABLED=true MEMORY_BENCHMARK_DOCUMENTS=1000000 MEMORY_BENCHMARK_REQUESTS=20 MEMORY_BENCHMARK_CONCURRENCY=20 npm run benchmark:memory-postgres
MEMORY_MODULE_URL=http://localhost:8791 MEMORY_MODULE_SDK_TENANT_ID=tenant-a MEMORY_MODULE_SDK_USER_ID=user-a npm run test:memory-sdk
MEMORY_RECOVERY_STATE=./artifacts/restored-state.json MEMORY_RECOVERY_LEDGER=./artifacts/deletion-ledger.json npm run check:memory-recovery
MEMORY_MODULE_SMOKE_APPLY_SCHEMA=true npm run test:memory-postgres
MEMORY_MODULE_EMBEDDING_DIMENSIONS=1536 npm run migrate:memory-pgvector -- --dry-run
MEMORY_MODULE_NATIVE_RETRIEVAL=true MEMORY_HYBRID_RETRIEVAL=true MEMORY_MODULE_PGVECTOR_ENABLED=true npm run start:memory-module
npm run benchmark:memory
MEMORY_BENCHMARK_DOCUMENTS=1000000 MEMORY_BENCHMARK_REQUESTS=20 MEMORY_BENCHMARK_CONCURRENCY=20 npm run benchmark:memory
MEMORY_EVAL_RESULTS=./artifacts/memory-results.json npm run evaluate:memory
npm run evaluate:memory-synthetic
```

PostgreSQL smoke 需要 `DATABASE_URL`，缺少时只会安全跳过；设置 `MEMORY_MODULE_SMOKE_APPLY_SCHEMA=true` 会在随机隔离 tenant 上重复应用 canonical schema，并验证主体隔离、租约 fencing 和并发冲突。`migrate:memory-pgvector` 需要明确的 `MEMORY_MODULE_EMBEDDING_DIMENSIONS`，会创建 pgvector 列、回填 JSONB embedding 并建立 HNSW cosine 索引；`--dry-run` 不连接数据库。设置 `MEMORY_MODULE_NATIVE_RETRIEVAL=true` 后，retrieve 使用轻量 metadata + PostgreSQL native candidate 查询，context-bundle 使用 bounded profile/current-state/episode read model，并继续经过内存层的 policy/confirmation finalization。可选 `MEMORY_MODULE_REDIS_URL` 只缓存带 tenant/user、grant/privacy/commit 版本的无 query bounded ContextBundle read model；Redis 不可用时服务继续走 PostgreSQL canonical 路径，治理/写入会推进 subject generation 使旧缓存失效。`npm run evaluate:memory-synthetic` 会用真实 in-memory domain 跑完 600 条 synthetic scaffold 并生成标注为 `synthetic`、不计入 Alpha acceptance 的结果；真实评测仍需 `MEMORY_EVAL_RESULTS=... npm run evaluate:memory`。benchmark 默认和 1M 规模命令都是单进程内存 BM25 sanity check，不替代真实 PostgreSQL/pgvector acceptance run。

发布前进度、隐私/密钥审计和 GitHub 推送阻断项见：[`docs/开发进度与GitHub发布前审计.md`](docs/开发进度与GitHub发布前审计.md)。

## Production modes

Local development uses `AUTH_MODE=off` and can use `MODEL_PROVIDER=mock`.
Public deployment must use `AUTH_MODE=required`, `STORAGE_PROVIDER=postgres`, a real model provider, and server-only secrets. The browser receives only the Supabase URL, anon key, model catalog, and non-secret connection status.

Supabase Auth users are isolated through request-scoped PostgreSQL state. The first authenticated user can claim the existing `local-user` state once; later users start with an empty state.

The independent Memory Module is in `services/memory-module/` and exposes the canonical versioned `/v1` contract backed by PostgreSQL. Apply `server/memory-module-schema.sql`, then configure its service token and trusted tenant/user/agent context headers behind the API boundary. Cochpia's `/api` compatibility routes are backed by the same Memory Module and do not maintain a second memory store.

Railway deployment templates are in `deploy/`. Use the API service health check at `/api/health` and set `VITE_API_BASE_URL` on the separate web service.

真实供应商测试只有在对应服务端环境变量存在时才执行；本地协议夹具和 Mock 流式链路可在无密钥环境验证。
