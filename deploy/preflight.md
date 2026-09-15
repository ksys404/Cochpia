# 上线前自检(Preflight)

`deploy/production-readiness.md` 说明生产端点与部署要求;这里说明**怎么在上线前把该确认的事跑一遍**。

## 一条命令

```bash
node scripts/preflight-check.mjs            # 全量(含数据库连通与数据完整性)
node scripts/preflight-check.mjs --no-db    # 只做配置与仓库卫生检查
```

退出码:`0` = 没有阻断项;`1` = 存在 ❌。适合直接挂到 CI 或部署脚本的第一道闸。
脚本**不打印任何密钥明文**,数据库地址只显示脱敏后的主机名。

## 它自动检查什么

| 分组 | 内容 |
|---|---|
| 配置 | `NODE_ENV=production`(所有生产守卫都依赖它)、`AUTH_MODE=required`、`CLIENT_ORIGIN` 是否为 HTTPS、`APP_VERSION` |
| 存储 | `STORAGE_PROVIDER=postgres`、`DATABASE_URL` 合法性、`DATABASE_SSL` 是否为 `true/require/verify-full`、`DATABASE_CA` 是否可读 |
| 模型 | 生产不允许 `MODEL_PROVIDER=mock`;真实供应商是否配了密钥 |
| 运行时 | 本轮新增的三个超时是否合理(`CHAT_PREPARE_TIMEOUT_MS < CHAT_RUN_TIMEOUT_MS`,兜底为正数) |
| 记忆 | `MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS` 是否关闭;7 个记忆功能开关若被打开会提醒确认 |
| 仓库 | `.env` 是否被跟踪、`server/data/` 与 `Knowledge_Base/` 是否入库、已跟踪文件中是否有密钥/连接串字面量、`LICENSE`/`NOTICE`/`.env.example` 是否存在、**前端引用的静态资源是否真的在仓库里**(会被 `.gitignore` 排除的单独报出) |
| 文档 | `.env.example` 是否覆盖**全部**实际用到的环境变量(防止将来新增变量忘了写示例) |
| 数据 | 数据库连通与延迟、核心表是否齐备、`MEMORY_TENANT_ID` 与库中数据是否一致、**记忆/事件的归属是否与所属账号一致** |

最后两项是针对已经踩过的坑加的:tenantId 不一致或归属不一致,都会让记忆对用户**静默不可见**——看起来一切正常,实际一条也召不回来。

## 它查不到、必须人工确认的

1. **HTTPS 与域名**:证书、HSTS、真实域名下的 CORS 端到端。
2. **定时备份与恢复演练**:至少做过一次真实恢复(项目文档要求,脚本无法代做)。
3. **日志与指标留存**:`/api/metrics` 是内存计数,重启即清零;需要外部留存策略。
4. **目标环境端到端验收**:在部署环境跑一次真实登录、聊天、日历与账号导出/擦除。
5. **素材分发权**:前端引用了被 `.gitignore` 排除的资源(如开幕视频)时,脚本只报"公开后会缺",是否补授权、替换或移除由你决定。

## 发布与部署顺序

```bash
# 1. 公开仓库前
node scripts/preflight-check.mjs --no-db     # 仓库卫生 + 配置 + 文档覆盖
npm test                                     # 见下:无 .env 的全新克隆会自动跳过集成用例
npm run build

# 2. 部署目标环境(配好 .env)后
node scripts/preflight-check.mjs             # 含数据库与数据完整性
curl -s "$API/api/health" | jq .             # storageReady / modelReady 都应为 true
```

## 关于测试里的 3 个集成用例

`server/isolation.test.js` 与 `server/regenerate.test.js` 需要**正在运行的 API + 真实认证**。
在没有 `.env` 的全新克隆里它们会自动 **skip(不是 fail)**,所以对外 `npm test` 是绿的;
只有在配了 `RUN_API_INTEGRATION=true` 的机器上才会真实执行——此时必须先起服务,否则会看到 3 个红灯。
