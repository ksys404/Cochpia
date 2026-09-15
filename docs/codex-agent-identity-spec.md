# Agent 身份重构 · Codex 执行手册

> 目标：把「Cochpia」从写死的主体 Agent 剥离，回归品牌名；主体 Agent 完全由用户创建、设置「主/子」；聊天页改成社交软件式的「会话列表」入口。

---

## 0. 核心概念（先理解再动手）

1. **Cochpia 只是品牌名**：保留在 Splash、服务器日志、音乐库名、GitHub 仓库、错误边界等「项目/品牌」语境，**不得作为任何 Agent 的身份、名字或默认名**。
2. **主体 Agent 由用户创建**：用户通过「新建角色」创建的 agent（角色 A、角色 B…）才是可对话的主体。
3. **主/子（primary）**：agent 新增布尔字段 `primary`，默认 `false`。用户在编辑表单/资料页可勾选「设为主陪伴」。主陪伴 agent 排序靠前、带「主」徽标，是默认聊天对象的概念来源（但不自动打开会话）。
4. **新用户无 agent**：聊天页显示「去创建一个角色吧」空态 + 按钮打开新建角色弹窗。

---

## 1. 后端改动

### 1.1 `server/store.js`
- `initialState.sessions`：从 `[{ id: 'welcome', title: '第一次相遇', ... }]` 改为 `[]`（新用户不再有写死会话）。
- `initialState.messages`：从 `{ welcome: [{ ... '你好，我是 Cochpia...' }] }` 改为 `{}`。
- **不要删老用户已有的 `welcome` 会话数据**（那是用户数据）；只改「初始状态」，影响新用户。

### 1.2 `server/index.js`
- 第 114 行附近：`state.profile ||= { name: 'Cochpia', gender: 'none', age: null, avatar: '✦' };` 的 `name: 'Cochpia'` 改为 `name: ''`（档案是**用户自己**的名字，默认空，由用户填写）。
- 其余不动（服务器日志里的 "Cochpia server listening" 属品牌名，保留）。

### 1.3 `server/compaction.js`
- 第 8 行 `.map(message => `${message.role === 'user' ? '用户' : 'Cochpia'}：${message.content}`)` 中的 `'Cochpia'` 改为 `'助手'`。

### 1.4 `server/agent-service.js`
- `create`：在 `pinned` 附近加 `primary: Boolean(input.primary)`。
- `update`：加 `if (input.primary !== undefined) agent.primary = Boolean(input.primary);`。
- 保持其它字段不动。

---

## 2. 前端改动

### 2.1 `client/src/profile/ProfileProvider.jsx`
- `DEFAULT_PROFILE = { name: 'Cochpia', ... }` 的 `name` 改为 `''`。

### 2.2 `client/src/profile/CharacterProfile.jsx`
- 名字输入框 `placeholder="Cochpia"` 改为 `placeholder="你的名字"`。
- `恢复默认（Cochpia · 永恒 · 无性别）` 文案改为 `恢复默认（永恒 · 无性别）`（去掉 "Cochpia"）。

### 2.3 `client/src/main.jsx`（聊天入口 + 空态）
- `const [sessionId, setSessionId] = useState('welcome')` 改为 `useState('')`（空 = 未选中会话）。
- 删除/停用登录后自动 `load(availableSessions[0].id)` 的逻辑：改为 `refresh()` 后**不自动打开任何会话**，停在首页；若 `availableSessions` 为空则照旧回 home。
- 聊天页渲染：当 `sessionId === ''`（且 `page === 'chat'`）时，不渲染 ChatPanel，改为渲染一个**空态/会话列表**：
  - 若 `agents.length === 0`：显示「还没有角色。去创建一个吧。」+ 按钮（`setEditingAgent(null); setAgentModalOpen(true)`）。
  - 若 `agents.length > 0`：显示「选择一个会话开始聊天，或回首页给角色发消息。」（现有 sidebar 会话列表保留，用户点会话即可进入）。
- 注意：**不要删掉 sidebar / home 的 Agents 区 / 新建角色按钮**，它们是入口，只是不再自动打开第一个会话。

### 2.4 `client/src/components/ChatPanel.jsx`（身份修正）
- 消息 meta 里的助手名 fallback：`(item.senderName || profile.name)` 改为 `(item.senderName || '助手')`。
- 头像 fallback：`(item.senderAvatar || (profile.avatarImage ? <img src={profile.avatarImage} /> : profile.avatar))` 改为 `(item.senderAvatar || '助')`（助手不再用用户头像/名字兜底）。
- 顶部标题区 `currentAgent ? ... : '与你共同成长的空间'` 保持不变（无 agent 时不显示人名）。

### 2.5 `client/src/components/panels.jsx`（主/子 三处）
- `AgentFormModal`：在 `pinned`/`muted` 之后（或关系设定区）加一个「主陪伴」开关字段，draft 里加 `primary: agent?.primary || false`，`onSave` 时随 draft 提交。
- `AgentProfileModal`：在「关系设定」区加一行「主陪伴」checkbox，`onPatch({ primary: event.target.checked })`。
- `AgentCard`：显示主陪伴徽标（如 `agent.primary && <span className="agent-badge" title="主陪伴">主</span>`），名字旁与 `pinned` 的 📌 并列。
- 首页 `agents` 排序：`[...agents].sort(...)` 改为 **primary 优先 → pinned 优先 → 其余**（主陪伴排最前）。

### 2.6 `client/src/life/LifeGame.jsx`、`LifeCalendar.jsx`（连带清理）
- `LifeGame.jsx:56`：`{profile.name || 'Cochpia'} 的玻璃城生活` 改为 `{profile.name || '你的'} 的玻璃城生活`。
- `LifeCalendar.jsx:42`：`Cochpia 默认没有年龄，也没有性别` 改为 `这个角色默认没有年龄，也没有性别`。

---

## 3. 数据迁移（老用户）

- **不要删除/改写任何用户已有的会话、消息、agent 数据**。
- 老用户已有的 `welcome`（"第一次相遇"）会话保留在会话列表里，只是不再被自动打开；用户可自行在 UI 删除。
- 老用户已有 agent（角色 A、角色 B）默认 `primary` 缺失 → 视为 `false`；用户可到资料页勾选「主陪伴」。

---

## 4. 验证清单（逐项）

1. `node --check` 所有改动文件通过。
2. `node --test server/*.test.js`：若 `agent-service.test.js` 有精确对象断言需同步补 `primary` 字段；其余测试应保持 259 通过/3 环境失败（若因后端在线导致集成测试挂起，如实说明）。
3. `npm run build` 通过。
4. 重启后端（`node server/index.js`），`/api/health` ready。
5. 手动冒烟（auth-off 或测试账号）：
   - 新用户（空 state）：无默认会话，聊天页显示「去创建一个角色」空态。
   - 创建角色 → 勾选「主陪伴」→ 保存 → 首页该角色排最前、带「主」徽标。
   - 发消息 → 回复名/头像 = 该 agent，不再出现 "Cochpia"。
   - 聊天页不再自动打开会话；点 sidebar 会话或首页 agent 才进入。
6. 确认没有残留的「Cochpia 作为 agent 名/默认名」：`grep -rn "你好，我是 Cochpia\|name: 'Cochpia'\|你是 Cochpia" server client/src` 应无业务命中（品牌语境除外）。

---

## 5. 硬约束

- **不删任何用户数据**（老 welcome 会话、消息、agent 一律保留）。
- 只做身份/入口相关改动，不碰聊天主链、审批、SSE、多用户隔离。
- 分两个独立 commit：`feat(agents): add primary/sub role`（后端 agent 字段 + 前端表单/徽标/排序）和 `refactor(ui): remove hardcoded Cochpia identity`（store/index/compaction/profile/chat 入口/空态）。不要混入其它未提交改动。
- 不重启正在运行的后端，除非验证阶段需要（重启后要确认 health ready）。

---

*执行前先读 `docs/runtime-refactor-audit.md` 了解当前目录结构；如行号有出入以实际代码为准。完成后停在待复核者复查，不要自行扩展范围。*
