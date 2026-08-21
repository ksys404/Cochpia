# Cochpia 开发进度与 GitHub 发布前审计

更新时间：2026-08-22

## 当前开发进度

### 已完成

- React/Vite 前端与 Express API 本地开发链路可运行。
- 聊天工作区已支持会话、消息流式响应、模型目录、设置、记忆、人格和任务/日历入口。
- 首屏 Cochpia 开幕层已改为用户提供的视频背景，视频使用静音、自动播放和循环播放；视频授权信息仍待确认。
- 首屏品牌标题已改为英文花体字体栈，并增加背景遮罩保证可读性。
- 聊天区和输入区支持统一圆角变量，输入区与输出区有明确间距。
- 音乐、设置、日历、任务和页面导航支持再次点击关闭或返回聊天。
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
- `MODEL_*_API_KEY`、`DATABASE_URL`、`MEMORY_MCP_TOKEN` 等命中均为变量名、占位符或安全说明，不是真实凭据。
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
