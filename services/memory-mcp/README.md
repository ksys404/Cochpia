# Cochpia Memory MCP

独立的记忆 MCP 服务。后端通过 JSON-RPC `initialize`、`tools/list` 和 `tools/call` 调用它，记忆使用 Supabase PostgreSQL 规范化表保存。

Required environment variables:

```text
DATABASE_URL=postgresql://...
DATABASE_SSL=true
MCP_SERVICE_TOKEN=server-only-token
PORT=8790
```

The API requires `Authorization: Bearer <MCP_SERVICE_TOKEN>` when a token is configured. Every tool call must include the authenticated user's `userId`.
