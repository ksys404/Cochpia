# Cochpia

Ai的人生谁来定义？

Cochpia 是一个围绕共同经历、外部记忆、SSE 流式交互和会话级对话设定构建的 AI 陪伴应用骨架。

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

## 主要 HTTP 端点

| 分组 | 端点 |
|---|---|
| 健康与观测 | `GET /api/health`、`/api/ready`、`/api/version`、`/api/metrics` |
| 会话与聊天 | `/api/sessions*`、`POST /api/chat/stream`(SSE)、`/api/chat/{approve,cancel,regenerate,retry,group}` |
| 记忆 | `/api/memories*`、`/api/memory/overview`、`/api/export`、`/api/import`;版本化契约在 `/v1/*` |
| 日历(日程) | `GET/POST/PATCH/DELETE /api/events`、`GET /api/events/upcoming` |
| 账号数据权利 | `GET /api/account/export`、`DELETE /api/account?confirm=erase[&mode=forget]` |
| Agent 工作区 | `/api/workbench/tasks*`、`/api/workflows*` |

日程为当前登录用户所有、可选绑定单个 Agent(不绑定 = 所有 Agent 可见);临近日程会按窗口注入聊天与主动唤醒的上下文。账号擦除必须显式传 `confirm=erase`,先落记忆模块的治理记录再做行级物理擦除。

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
- `server/events.js`: 日程服务(纪念日/生日按年重复推算 + 临近日程窗口)
- `server/routes/account.js`: 账号级数据导出与擦除(数据主体权利)
- `server/memory-importance.js`: 记忆重要性判定(可解释、零模型调用、可复现)
- `server/memory-module-retrieval.js`: 词法/向量/重要性/新近度的加权 RRF 融合
- `scripts/preflight-check.mjs`: 上线前自检(配置、密钥、文档覆盖、数据完整性)
- `.env.example`: **全部环境变量的唯一参照**;`NOTICE`/`LICENSE`: 授权范围

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

工作模式、Pi Agent、Codex App Server 和本地部署教程见：[`docs/工作模式部署与Agent接入教程.md`](docs/工作模式部署与Agent接入教程.md)。

Agent 工作区的服务端控制面合同见：[`docs/agent-control-plane.md`](docs/agent-control-plane.md)。Codex/Pi 任务只能通过 `/api/workbench/tasks` 进入服务端执行，生产 PostgreSQL 必须启用证书校验。

## Production modes

Local development uses `AUTH_MODE=off` and can use `MODEL_PROVIDER=mock`.
Public deployment must use `AUTH_MODE=required`, `STORAGE_PROVIDER=postgres`, a real model provider, and server-only secrets. The browser receives only the Supabase URL, anon key, model catalog, and non-secret connection status.

Supabase Auth users are isolated through request-scoped PostgreSQL state. The first authenticated user can claim the existing `local-user` state once; later users start with an empty state.

The independent Memory Module is in `services/memory-module/` and exposes the canonical versioned `/v1` contract backed by PostgreSQL. Apply `server/memory-module-schema.sql`, then configure its service token and trusted tenant/user/agent context headers behind the API boundary. Cochpia's `/api` compatibility routes are backed by the same Memory Module and do not maintain a second memory store.

Railway deployment templates are in `deploy/`. Use the API service health check at `/api/health` and set `VITE_API_BASE_URL` on the separate web service.

真实供应商测试只有在对应服务端环境变量存在时才执行；本地协议夹具和 Mock 流式链路可在无密钥环境验证。

## Environment

所有环境变量的**唯一参照是 [`.env.example`](.env.example)**（含必填/建议/可选标注与默认值）。上线前先跑自检：

```bash
node scripts/preflight-check.mjs            # 配置 + 仓库卫生 + .env.example 覆盖率 + 数据库与数据完整性
node scripts/preflight-check.mjs --no-db    # 不连数据库
```

它会检查生产守卫依赖的 `NODE_ENV=production`、`CLIENT_ORIGIN` 是否为 HTTPS、TLS 配置、记忆功能开关，也会验证**记忆归属与 tenantId 是否一致**（不一致会导致记忆静默不可见），并报告前端引用了却被 `.gitignore` 排除的静态资源。说明与人工项见 [`deploy/preflight.md`](deploy/preflight.md)。

> 测试提示:`server/isolation.test.js` 与 `server/regenerate.test.js` 需要运行中的 API;在没有 `.env` 的全新克隆里会自动 skip,配了 `RUN_API_INTEGRATION=true` 则必须先起服务。

## License

- **源代码**:[Apache License 2.0](LICENSE)。
- **第三方美术/音频素材**(`client/public/` 下)不受上述许可影响,各自保持原始条款:Kenney 系列为 CC0,Pipoya 允许商用与二次分发但禁止单独转售素材本身。完整来源、核验状态与使用边界见 [`client/public/game-assets/licenses/attribution.md`](client/public/game-assets/licenses/attribution.md);授权范围说明见 [`NOTICE`](NOTICE)。
- **设计参考**:记忆重要性与检索排序借鉴了若干公开项目的公开设计（Generative Agents、MemoryOS、MemoryBank、A-MEM、mem0、Graphiti 等），仅参考思路与权重比例，未复制其代码。

