# 一键导入角色设定（自动识别）· Codex 执行手册

> 目标：用户粘贴一段自由格式的「角色设定」文本，系统用 LLM 自动解析成结构化字段，一键回填到「新建/编辑角色」表单，用户确认后保存。
> 复用现有 agent 模型（deepseek）与 `AgentFormModal`。

---

## 0. 现有基础

- `server/routes/agents.js`：`createRouter(deps)`，已有 agents CRUD，deps 里有 `agents`、`model`（provider 实例，含 `generate`）。
- `client/src/components/panels.jsx`：`AgentFormModal`，draft 字段为 `name/remark/avatarImage/role/tone/signature/persona/provider/model/memoryNotes/primary`。
- agent 字段（`server/agent-service.js`）：`name/remark/role/relationship/tone/signature/persona/memoryNotes/tags/provider/model/...`。

---

## 1. 后端

### 1.1 新端点 `POST /api/agents/parse`（加进 `server/routes/agents.js`）

- 请求：`{ text: string }`（用户粘贴的角色设定原文，≤ 10000 字符，非空）。
- 校验：`text` 非空且为字符串，超长截断，否则 `400 INVALID_AGENT_TEXT`。
- 逻辑：
  1. 用 `model.generate({ message: 原文, runtimeContext: null })`（或直接拼一个解析 system prompt）调用 LLM，要求只输出 JSON。
  2. 解析返回 JSON（**先剥掉 ```json 代码围栏**，参考 `server/runtime/wake-engine.js` 里 `parseWakeDecision` 的写法；解析失败则 `502 AGENT_PARSE_FAILED`）。
  3. 归一化字段（全部转字符串/数组，超长截断，非法丢弃），输出 `{ draft }`。

**解析 prompt（建议固定 system）**：
```
你是角色设定解析器。把用户提供的角色设定文本解析成严格 JSON，字段：
name（名字）、remark（备注名）、role（角色定位）、relationship（关系）、tone（说话语气）、signature（个性签名）、persona（人格设定全文）、memoryNotes（记忆备注）、tags（标签数组）。
规则：只输出 JSON 对象，不要任何解释或代码围栏；字段缺失时 name 给空字符串、tags 给空数组；保留人格设定的原始语气与细节，不擅自扩写。
```

**输出 draft 结构**（前端直接回填用）：
```json
{ "draft": { "name":"", "remark":"", "role":"", "relationship":"", "tone":"", "signature":"", "persona":"", "memoryNotes":"", "tags":[] } }
```

`server/index.js` 的 `routeDeps` 需已含 `model`（已含）。

---

## 2. 前端（`client/src/components/panels.jsx` 的 `AgentFormModal`）

在 `AgentFormModal` 内加一个可折叠的「导入角色设定」区（放表单最顶部）：

- 一个 `<textarea>`（占位符：粘贴角色设定原文，例如一段描述角色的文字…）
- 一个「自动识别并填入」按钮 + 解析中状态
- 点击后 `POST /api/agents/parse`（用现有 `api()` helper），成功则把返回的 `draft` **合并进当前 draft**（只覆盖非空字段，不覆盖用户已填的值；tags 直接替换），并展开/保持表单让用户检查
- 失败用现有 `setError`/toast 提示

注意：`AgentFormModal` 目前用内部 `draft` state 和 `set(key, value)`；解析成功后对每个非空字段调用 `set` 即可。avatarImage/provider/model/primary 不在解析范围内，保持原值。

---

## 3. 验证

1. `node --check` 通过；`server/agent-service.test.js` 无回归（parse 端点若不写单测，至少补一个「JSON 围栏剥离 + 字段归一化」的纯函数单测）。
2. `npm run build` 通过。
3. 手动冒烟（测试账号 + 真实 deepseek）：
   - 粘贴一段中文角色设定 → 点「自动识别并填入」→ 表单各字段被正确回填。
   - 原文缺某些字段 → 对应字段为空/空数组，不崩。
   - LLM 返回带 ```json 围栏 → 也能正常解析。
4. 确认不影响原有新建/编辑角色流程。

---

## 4. 硬约束

- 只新增 `POST /api/agents/parse` + 前端导入区，不改动 agents 的 create/update 语义、不改其它路由。
- LLM 解析是「辅助回填」，最终以用户确认的表单为准，不自动保存。
- prompt 里要求「只输出 JSON」，并做围栏剥离兜底；解析失败要给明确错误，不静默。
- 一个 commit：`feat(agents): one-click persona import with auto-parse`。完成后停在待复核者复查，未获「继续」不 commit。
