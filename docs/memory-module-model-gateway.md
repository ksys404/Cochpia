# Model Gateway Spec

版本：V1 draft（2026-08-22）

## Boundary

所有 extraction、embedding 和可选 reranker 调用必须经过统一 gateway 接口；Memory domain 不直接依赖供应商 SDK。`server/memory-module-model-gateway.js` 提供统一 wrapper，负责 S2/S3 输入门禁、向量 schema 校验、policy version 和不含正文的 telemetry。`server/memory-module-http-gateway.js` 提供 OpenAI-compatible `/embeddings` 和 `/chat/completions` adapter；API key 分别只从 `MEMORY_EMBEDDING_API_KEY`、`MEMORY_EXTRACTION_API_KEY` 读取，adapter 不记录 provider response body。正式 reranker 仍可通过 adapter 注入。

## Required interface

```text
extract(input, { policyVersion, signal }) -> { candidates[] }
embed(text, { purpose, policyVersion, signal }) -> vector
rerank(query, candidates, { signal }) -> ranked candidates   # optional
```

所有返回都必须 schema validate、限制候选数量、过滤 instruction-like fields、再次执行 S3/S2 policy；返回内容只作为 data。Gateway 负责统一 timeout、AbortSignal、可重试错误分类和安全 telemetry 元数据。

## Version and failure policy

- 每次调用记录 request ID、provider/model/prompt/embedding/retention 版本、policy version、token usage、attempts、timeout、latency 和脱敏 error code。
- 不记录 raw prompt/output；S3 内容在 gateway 前被拦截。
- timeout、auth、balance、schema failure 都返回可分类错误；仅临时不可用/超时/限流可按配置 retry，认证和计费失败不 retry，canonical write 不回滚。
- embedding unavailable/timeout 必须回退 BM25；独立服务 native vector/hybrid 也在 pgvector 未启用时回退 PostgreSQL lexical candidate；reranker unavailable 使用原排序。
- 外部模型数据保留、区域和训练使用策略必须在上线前取得供应商证据并纳入 retention review。
- 独立服务 production 启动时，已配置的 extraction/embedding provider 必须显式声明 `MEMORY_*_RETENTION_POLICY`；这只是配置门禁，不替代供应商 retention/region/training 证据审计。

## Current status

统一 gateway 现在会对 extraction 候选限量并剥离未知字段，对 embedding/reranker 输出做 schema 校验，执行统一 timeout/错误分类，并将不含正文的 provider/model/token/latency telemetry 记录为安全事件；独立服务已有可选 HTTP extraction/embedding adapter 与 native lexical/vector/hybrid fallback wiring，但真实 provider 质量、供应商数据保留审计和 pgvector 性能尚未验收。
