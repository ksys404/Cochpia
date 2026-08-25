# Independent Memory Module

This service exposes the Memory Module contract under the versioned `/v1` API and uses PostgreSQL as its canonical store. Cochpia's compatibility routes delegate to this same module and do not maintain a second memory store.

Required configuration:

```text
DATABASE_URL=postgresql://...
DATABASE_SSL=true
MEMORY_MODULE_SERVICE_TOKEN=server-only-token
MEMORY_MODULE_PORT=8791
MEMORY_MODULE_SERVICE_AUTH_MODE=signed
MEMORY_MODULE_SERVICE_AUDIENCE=cochpia-memory-module
MEMORY_MODULE_SERVICE_ISSUER=cochpia-api
```

Lexical native retrieval works without an embedding provider. To enable native vector or hybrid retrieval, run the pgvector migration, set `MEMORY_MODULE_PGVECTOR_ENABLED=true`, enable `MEMORY_VECTOR_RETRIEVAL=true` or `MEMORY_HYBRID_RETRIEVAL=true`, and configure `MEMORY_EMBEDDING_URL` plus the server-only `MEMORY_EMBEDDING_API_KEY`. The service generates query vectors server-side through the Model Gateway; provider errors, timeouts, and an unavailable pgvector extension fall back to lexical candidates.

Apply `server/memory-module-schema.sql` before serving traffic, or set `MEMORY_MODULE_AUTO_MIGRATE=true` for a controlled development environment. Production migrations should be reviewed and run separately.

The trusted API caller must provide `x-memory-tenant-id`, `x-memory-user-id`, and `x-memory-agent-id` after authenticating the end user. In production the caller signs those headers with service-auth v1, including method/path, audience, issuer, timestamp and nonce; the service verifies the signature and consumes the nonce in PostgreSQL. Static bearer-token compatibility is development-only. The public Cochpia API must derive these fields from its own authentication context and never forward client-controlled tenant/user fields.

The service does not expose PostgreSQL credentials or tables to callers. Retrieval, governance, and context-building all pass through the same policy checks as the in-process `/v1` adapter.

User export is a three-step, subject-bound flow: `POST /v1/export-operations`, `GET /v1/export-operations/{id}`, then `GET /v1/export-operations/{id}/data`. The operation stores only commit-sequence metadata; if canonical data changes, status becomes `stale` and the download fails closed. This is the Memory Module portion of export, not the product-level `/api/export` composition.

During an expand/contract rollout, `MEMORY_MODULE_SUPPORTED_OUTBOX_SCHEMA_VERSIONS=1,2` can keep a worker compatible with the current and previous event schemas. Any other explicit schema version is dead-lettered before business processing with `UNSUPPORTED_OUTBOX_SCHEMA`.
