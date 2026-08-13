# PostgreSQL / Supabase 部署准备

当前 Cochpia 支持两种存储模式：

- `json`：本地默认模式，数据写入 `server/data/state.json`。
- `postgres`：从 `DATABASE_URL` 连接 PostgreSQL 或 Supabase，数据写入 `cochpia_state` 表。

## 本地继续使用 JSON

```text
STORAGE_PROVIDER=json
```

## 使用 PostgreSQL / Supabase

在服务端 `.env` 中填写：

```text
STORAGE_PROVIDER=postgres
DATABASE_URL=你的数据库连接地址
DATABASE_SSL=true
```

`DATABASE_URL` 是敏感信息，只放在后端，不要写入前端或发送给其他人。服务启动时会自动创建 `cochpia_state` 表，也可以在数据库控制台执行 `server/schema.sql`。

## 当前边界

当前 PostgreSQL 模式采用一行 JSONB 聚合状态，目的是让现有聊天、记忆和人格功能可以低改动迁移。它还不是最终的多用户数据库结构。

规范化迁移已经准备在 `server/normalized-schema.sql` 和 `server/migrate-json-to-postgres.js`。先执行 `npm run migrate:postgres -- --dry-run` 检查本地 JSON 数量；只有配置真实数据库后，才去掉 `--dry-run` 执行写入。

正式多用户部署前，还需要继续完成：

1. 用户、设备和权限表。
2. 会话、消息、记忆和人格证据的独立表。
3. 用户级数据隔离和数据库行级安全策略。
4. JSON 状态迁移脚本和备份恢复流程。
5. 数据库连接池、重试和生产监控。

如果没有有效的 `DATABASE_URL`，不要设置 `STORAGE_PROVIDER=postgres`；后端会明确启动失败，不会悄悄退回 JSON，避免误以为数据已写入云端。
