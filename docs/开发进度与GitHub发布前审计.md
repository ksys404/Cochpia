# Cochpia 开发进度与 GitHub 发布前审计

更新时间：2026-08-22（2026-09-13 补充，见下方“最新一轮更新”）

## 2026-09-13 最新一轮更新

- **测试基线已变**：`npm test` = **306 pass / 3 skipped**。本文档下面“当前验证状态”写的 `60 pass / 0 fail / 5 skipped` 已过期。
  3 个 skip 是需要运行中 API 的集成用例（`isolation` / `regenerate`）；在**没有 `.env` 的全新克隆里会自动 skip（不是 fail）**，对外 `npm test` 是绿的；配了 `RUN_API_INTEGRATION=true` 的机器必须先起服务，否则会看到 3 个红灯。
- **日历已重新接入**：后端 `/api/events`（CRUD + 临近日程）与前端日历面板已接通，临近日程按窗口注入聊天与主动唤醒上下文。下面“已完成”里写的“任务、日历及陪伴设定暂时下线”现在只有“任务 / 陪伴设定”仍成立。
- **授权已补齐**：新增根目录 `LICENSE`（Apache-2.0，覆盖源代码）与 `NOTICE`（说明素材与代码授权范围不同）。素材许可记录原本就有（`client/public/game-assets/licenses/attribution.md`），本次做了根目录汇总指引。
- **审计已自动化**：新增 `scripts/preflight-check.mjs` + `deploy/preflight.md`。原本靠人工逐条核对的项现在可一条命令复跑：密钥模式、`.env` 是否入库、`.env.example` 覆盖率、前端引用的资源是否可分发、数据库连通，以及**记忆归属 / tenantId 一致性**。
- **`.env.example` 已补全**：从 9 个变量补到覆盖全部实际用到的变量（含本轮新增的 `CHAT_PREPARE_TIMEOUT_MS`、`CHAT_TERMINATION_GRACE_MS`、`UPCOMING_EVENT_DAYS`、`MEMORY_IMPORTANCE_RANKING`、`MEMORY_RECENCY_HALF_LIFE_DAYS`）。
- **本轮修掉两个数据级缺陷**（都属于“上线前必须修”的类型）：
  1. 新注册用户会继承上一位用户的画像 / 立绘 / 角色 / 记忆 —— `emptyUserState` 改为 fail-closed；
  2. 76 条记忆因归属仍是 `local-user` 而对用户不可见 —— 已迁移归属，并把它做成自检项防回归。
- **角色名脱敏**：既有文档与测试夹具里的角色名已替换为中性占位。
- **仍然成立的阻断项**：下面第 1 条（开幕视频 `client/public/306155_medium.mp4` 没有授权凭证）未变 —— 自检脚本现在会把这类“被前端引用但被 `.gitignore` 排除”的资源直接报出来。

## 当前开发进度

### 已完成

- React/Vite 前端与 Express API 本地开发链路可运行。
- 聊天工作区已支持会话、消息流式响应、模型目录、设置、记忆和人格；任务及陪伴设定暂时下线，后续重做；**日历已于 2026-09-13 重新接入**。
- 首屏 Cochpia 开幕层已改为用户提供的视频背景，视频使用静音、自动播放和循环播放；视频授权信息仍待确认。
- 首屏品牌标题已改为英文花体字体栈，并增加背景遮罩保证可读性。
- 聊天区和输入区支持统一圆角变量，输入区与输出区有明确间距。
- 音乐、设置和页面导航支持再次点击关闭或返回聊天；任务与日历入口已移除。
- 工作区设置已支持按 Supabase 用户保存到服务端；未登录或离线时使用浏览器本地缓存，首次登录会兼容迁移旧设置。
- 共生人生 MVP 已落地：地点、行动、需求、时间、事件和本地持久化流程可验收。
- 已整理 Pipoya、Kenney City Kit Commercial、Kenney Furniture Kit、Kenney Modular Characters 和 RPG Urban Pack 的素材许可记录；正式素材目录保留许可证文件。
- 视觉预览工作台功能已从应用导航和页面入口移除。

### 当前验证状态

- `npm run build`：通过。
- `npm test`：`60 pass / 0 fail / 5 skipped`；跳过项需要 `AUTH_MODE=required`、可用 PostgreSQL、隔离 API 或其他外部验收环境，不能视为生产验收完成。
- 浏览器自动化验收：当前桌面浏览器连接不可用，首屏视频、移动端点击和视觉层级仍需人工真实浏览器复核。

## GitHub 发布前隐私与密钥审计

### 已检查内容

- 工程 Markdown、TXT、JSON、YAML、HTML 说明文件。
- 源码、测试、部署说明、素材许可记录和前端静态资源索引。
- `.gitignore`、工作区状态、未跟踪文件和敏感字段模式。
- API key、Bearer token、私钥、数据库连接串、Supabase service role 等常见模式。

### 审计结论

- 未发现实际 API key、私钥、Bearer 凭据或完整数据库密码写入源码、说明文档或示例配置。
- `MODEL_*_API_KEY`、`DATABASE_URL`、`MEMORY_MODULE_SERVICE_TOKEN` 等命中均为变量名、占位符或安全说明，不是真实凭据。
- 根目录 `.env` 已被 `.gitignore` 忽略，且不应加入暂存区；发布前仍需再次确认 `git ls-files .env` 无输出。
- `uploads/` 包含用户上传图片，已加入忽略规则，不得发布。
- `.visual-qa-browser/` 是本地浏览器验收缓存，可能包含环境状态，已加入忽略规则，不得发布。
- `client/public/306155_medium.mp4` 来自用户本地下载目录，当前没有项目内授权凭证或来源记录，已加入忽略规则；确认拥有发布权或补充许可证前，不得推送到 GitHub。
- `client/public/game-assets/` 中已登记素材有对应许可记录；发布前仍需逐项确认实际入库文件与许可清单一致。

## 发布阻断项

以下事项完成前，不建议公开推送：

1. 确认 `306155_medium.mp4` 的版权所有权或商业发布许可；若不能确认，应替换为可商用素材并补充许可证记录。
2. 删除或保持忽略 `uploads/`、`.visual-qa-browser/`、本地数据库和任何运行日志。
3. 运行 `git status --short`、`git diff --cached` 和密钥扫描，确认没有私密文件进入暂存区。
4. 在真实浏览器完成桌面端和移动端验收，重点检查视频自动播放失败时的静态背景回退、首屏点击、页面二次点击关闭、输入区遮挡和横向溢出。
5. 在独立环境重跑完整测试；MCP 测试必须使用可用的隔离服务，不得把本地超时当作通过。
6. 生产发布必须使用 `AUTH_MODE=required`、`STORAGE_PROVIDER=postgres`、HTTPS、安全响应头、TLS 数据库连接和服务端密钥注入。

## 推送前命令

```powershell
git status --short
git diff --cached --stat
git ls-files .env
npm test
npm run build
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**' --glob '!.env' 'sk-[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY-----|Bearer [A-Za-z0-9._-]{20,}' .
```

密钥扫描只允许出现占位符、字段名和安全说明；任何疑似真实凭据都必须停止推送并轮换处理。
