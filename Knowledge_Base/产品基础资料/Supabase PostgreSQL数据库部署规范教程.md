# Cochpia Supabase PostgreSQL 数据库部署规范教程

## 1. 文档目的

本文用于指导非专业用户为 Cochpia 部署 Supabase PostgreSQL 数据库，并将本地 JSON 数据迁移到云端数据库。

本文适用于当前 Cochpia 单实例部署。完成后，Cochpia 的会话、消息、记忆、人格版本和成长证据可以使用 Supabase PostgreSQL 持久化。

当前项目仍保留 JSON 模式作为本地回退方案，但正式切换前必须完成备份、dry-run 检查和迁移验证。

## 2. 当前实现范围

当前数据库接入包含两层：

1. `cochpia_state` 聚合状态表：保证现有应用可以低改动切换到 PostgreSQL。
2. 规范化表：为后续多用户、权限和数据隔离做准备。

当前规范化表包括：

- `cochpia_users`
- `cochpia_sessions`
- `cochpia_messages`
- `cochpia_memories`
- `cochpia_personality_versions`
- `cochpia_personality_traits`
- `cochpia_growth_evidence`

当前版本仍主要通过 `cochpia_state` 驱动应用。规范化表是后续多用户迁移的基础，不应在本阶段直接手动删除或修改。

## 3. 安全原则

- 数据库连接字符串只放在后端 `.env` 文件。
- API Key 只放在后端 `.env` 文件。
- 不要把 `.env` 上传到 GitHub、网盘或聊天窗口。
- 不要把数据库密码、连接字符串或模型 API Key 截图发送给其他人。
- 使用 Supabase 时启用 SSL：`DATABASE_SSL=true`。
- 如果怀疑密钥泄露，应立即在 Supabase 或模型平台撤销并重新生成。

## 4. 部署前准备

需要准备：

- 已安装 Node.js 和 npm。
- 已能运行 Cochpia。
- 一个 Supabase 账号。
- Cochpia 当前项目目录。
- 当前项目的 `.env` 文件。

项目目录示例：

```text
C:\Users\umi\Documents\ChatGPT\陪伴Cochpia
```

## 5. 创建 Supabase Project

1. 打开 https://supabase.com/ 。
2. 登录或注册账号。
3. 创建一个新的 Project。
4. 设置数据库密码。
5. 等待 Project 状态变为可用。

数据库密码由用户自行保管，不能发送到 Cochpia 对话中。

## 6. 获取 PostgreSQL 连接字符串

1. 打开 Supabase Project。
2. 点击顶部的 `Connect`。
3. 选择 `Session pooler`。
4. 复制 PostgreSQL 连接字符串。

Cochpia 是长期运行的 Node.js 后端，通常使用 Session pooler 更适合普通 IPv4 网络环境。Supabase 官方连接说明：

https://supabase.com/docs/guides/database/connecting-to-postgres

连接字符串格式类似：

```text
postgresql://postgres.PROJECT_REF:PASSWORD@aws-REGION.pooler.supabase.com:5432/postgres
```

不要直接照抄上面的示例，必须使用 Supabase 控制台中当前 Project 的真实连接字符串。

### 密码特殊字符

如果数据库密码中包含 `@`、`#`、`/`、`:` 等特殊字符，需要进行 URL 编码，否则连接字符串可能无法解析。

最简单的做法是在创建数据库密码时使用字母和数字组合，并单独安全保存密码。

## 7. 备份本地数据

在修改配置前，复制文件：

```text
server\data\state.json
```

建议将副本保存为：

```text
server\data\state.backup.json
```

不要直接删除原始 `state.json`。

## 8. 配置后端环境变量

用记事本打开项目根目录的 `.env` 文件：

```text
C:\Users\umi\Documents\ChatGPT\陪伴Cochpia\.env
```

填写以下内容：

```env
STORAGE_PROVIDER=postgres
DATABASE_URL=你的Supabase完整连接字符串
DATABASE_SSL=true
```

保留已有的模型配置，例如：

```env
MODEL_PROVIDER=deepseek
MODEL_DEEPSEEK_API_KEY=你的DeepSeek密钥
MODEL_DEEPSEEK_NAME=deepseek-chat
```

不要在 `DATABASE_URL` 后面增加多余空格，也不要把连接字符串放在引号中，除非连接字符串本身有特殊解析要求。

## 9. 执行迁移预检查

打开 PowerShell，进入项目目录：

```powershell
cd "C:\Users\umi\Documents\ChatGPT\陪伴Cochpia"
```

执行：

```powershell
npm run migrate:postgres -- --dry-run
```

该命令只读取本地 JSON 数据，不会连接 Supabase，也不会写入数据库。

预检查会显示待迁移数据数量，例如：

```text
Found 2 sessions, 45 messages, 23 memories, 22 evidence records, 23 personality versions.
Dry run only. No database connection or writes were performed.
```

如果数量明显不正确，应停止操作并先检查 `server\data\state.json`。

## 10. 执行真实迁移

确认 dry-run 数量正确后，执行：

```powershell
npm run migrate:postgres
```

迁移脚本会：

1. 创建 PostgreSQL 表。
2. 写入当前聚合状态。
3. 写入用户和会话。
4. 写入消息。
5. 写入记忆。
6. 写入人格版本和人格特征。
7. 写入成长证据。
8. 使用事务提交；发生错误时回滚本次迁移。

成功时会显示：

```text
Migration completed.
```

如果失败，不要反复执行真实迁移。先保存错误信息，检查连接地址、密码、SSL 和数据库权限。

## 11. 重启 Cochpia

如果项目正在运行：

1. 回到运行项目的 PowerShell 窗口。
2. 按 `Ctrl + C` 停止项目。
3. 重新启动：

```powershell
npm run dev
```

不要在旧服务仍运行时启动第二个后端，否则可能出现端口冲突或读取不同配置的问题。

## 12. 验收检查

打开：

```text
http://localhost:8787/api/health
```

正常情况下应看到：

```json
{
  "ok": true,
  "storageProvider": "postgres",
  "modelProvider": "deepseek",
  "modelName": "deepseek-chat",
  "modelReady": true
}
```

然后打开：

```text
http://localhost:5173
```

逐项验证：

- 原有会话仍存在。
- 原有消息仍能打开。
- 最近记忆仍能显示。
- 人格版本仍能显示。
- 发送一条测试消息。
- 刷新网页后测试消息仍然存在。
- 模型设置中的 DeepSeek 连接测试仍然成功。

## 13. 常见错误

### `DATABASE_URL is required`

说明 `.env` 没有填写 `DATABASE_URL`，或者后端启动时没有读取到最新配置。

检查：

- 文件名是否为 `.env`，不是 `.env.txt`。
- 是否在项目根目录。
- 是否重启了后端。
- `STORAGE_PROVIDER` 是否写成 `postgres`。

### `password authentication failed`

说明数据库密码错误，或连接字符串中的密码没有正确编码。请从 Supabase `Connect` 页面重新复制连接字符串。

### `connection timeout`

可能原因：

- 网络无法访问 Supabase。
- 连接字符串复制不完整。
- 选择了当前网络无法访问的 Direct Connection。

普通 IPv4 网络优先重新选择 Session pooler。

### `relation does not exist`

说明数据库表没有成功创建。重新检查迁移输出，或在 Supabase Dashboard 的 SQL Editor 中执行：

```text
server\normalized-schema.sql
```

Supabase SQL Editor 文档：

https://supabase.com/docs/guides/database/overview

## 14. 回退到 JSON

如果 PostgreSQL 暂时不可用，可以停止服务，将 `.env` 改回：

```env
STORAGE_PROVIDER=json
```

然后重新运行：

```powershell
npm run dev
```

回退只影响后续应用读写，不会自动把 PostgreSQL 的新数据同步回 JSON。因此正式环境切换前必须确认数据库连接稳定，并保留备份。

## 15. 当前限制

- 当前应用仍以 `cochpia_state` 聚合状态作为主要运行数据源。
- 规范化表已准备，但还没有完成多用户认证和行级数据隔离。
- 当前项目仍是单实例本地部署，不等于已经完成互联网生产部署。
- 正式上线前还需要 HTTPS、登录权限、数据库备份、限流和日志脱敏。

## 16. 完成标准

满足以下条件，才可以认为数据库部署完成：

- Supabase Project 状态正常。
- `.env` 使用服务端连接字符串。
- dry-run 数量与本地状态一致。
- 真实迁移显示 `Migration completed.`。
- `/api/health` 返回 `storageProvider: postgres`。
- 网页刷新后会话和消息仍存在。
- DeepSeek 实际聊天成功。
- 没有将数据库密码或 API Key 提交到代码仓库。
