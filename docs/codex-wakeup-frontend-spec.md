# Phase 3 · 唤醒前端（让主动唤醒可感知、可开关）· Codex 执行手册

> 目标：把 Phase 2 的自动唤醒从「后端隐形能力」变成「用户能开关、能看见」的功能。
> 依赖：Phase 1（内在连续性）+ Phase 2（唤醒引擎）已完成并提交。

---

## 0. 现状

- 唤醒引擎 `server/runtime/wake-engine.js` 已实现，但 `enabled` 由环境变量 `WAKEUP_ENABLED` 全局决定，**没有 per-user 开关**。
- 醒来后 `message` 存成普通 assistant 消息，**前端无法区分「TA 主动发来的」**。
- 前端没有开关、没有频率档位、没有主动消息标记。

---

## 1. 后端改动

### 1.1 唤醒偏好（per-user，随用户 state 持久化）

`state.wakePreferences` 默认：
```js
{ enabled: false, lambda0PerHour: 1.5 }
```
在 `server/index.js` 启动初始化区加 `state.wakePreferences ||= { enabled: false, lambda0PerHour: 1.5 };`。

### 1.2 `server/runtime/wake-engine.js`

1. **per-user 开关**：`reconcileAll` 和 `reconcile` 开头加：
   ```js
   if (!state.wakePreferences?.enabled) return null; // （reconcileAll 则直接 return）
   ```
   这样 `WAKEUP_ENABLED=true` 只是「功能可用」，真正是否唤醒由**当前用户**的偏好决定。

2. **频率来自偏好**：`calculateRate` 里的 `lambda0` 从 `state.wakePreferences?.lambda0PerHour` 读（缺省回退 env `WAKE_LAMBDA0_PER_HOUR` 或默认 1.5）。不要再在 `createWakeEngine` 顶部固化 `lambda0`（那是启动时读的 env，per-user 不生效）。

3. **主动消息打标**：`runWake` 里存的 message 加 `source: 'wake'` 字段，供前端渲染「主动」徽标。

4. `createWakeEngine` 顶部的 `enabled` 逻辑保持：`WAKEUP_ENABLED !== 'true'` 时仍返回 disabled stub（全局兜底、零副作用），否则返回完整 engine。

### 1.3 端点 `GET /api/wake` + `PATCH /api/wake`

新建 `server/routes/wake.js`（`createRouter(deps)`，挂到 `app.use('/', ...)`），或加进 `misc.js`：

- `GET /api/wake` → 返回 `{ wake: state.wakePreferences || { enabled: false, lambda0PerHour: 1.5 } }`。
- `PATCH /api/wake` → 接收 `{ enabled?: boolean, lambda0PerHour?: number }`，clamp `lambda0PerHour` 到 `[0.1, 8]`，写回 `state.wakePreferences`，`saveState`，返回最新值。

`server/index.js` 把 `wakeEngine` 加入 `routeDeps`（若 route 需要）。

---

## 2. 前端改动

### 2.1 设置开关（`client/src/workspace/SettingsWindow.jsx` 或等价处）

在设置窗口加「主动唤醒」区：
- 开关：`enabled`（调用 `PATCH /api/wake`）
- 频率档位：低 / 中 / 高 → `lambda0PerHour` = 0.5 / 1.5 / 3.0
- 加载：进入设置时 `GET /api/wake` 读当前值

### 2.2 主动消息徽标（`client/src/components/ChatPanel.jsx` + `client/src/main.jsx` 的 loadSessionMessages）

- 后端返回的消息带 `source: 'wake'` 时，前端在气泡旁（或消息 meta 里）加一个「TA 主动」小徽标（复用现有 `agent-badge` 风格或新样式）。
- 别改动消息的其它渲染逻辑。

---

## 3. 验证

1. `node --check` 全过；`node --test` 无回归（wake 相关测试补：per-user enabled 开关、lambda0 偏好、source:'wake' 打标）。
2. `npm run build` 通过。
3. 手动冒烟（`WAKEUP_ENABLED=true` + 测试账号）：
   - 默认 `wakePreferences.enabled=false` → 发消息不触发唤醒、无开销。
   - `PATCH /api/wake {enabled:true, lambda0PerHour:8}` → 高频率下能看到「主动」消息出现（或 silent 记录）。
   - 前端设置开关切换 → `GET /api/wake` 反映变化。
4. 确认 `WAKEUP_ENABLED` 未开时，前端开关仍能正常读写偏好（只是引擎不跑）。

---

## 4. 硬约束

- 不破坏 Phase 1/2 的连续性、唤醒、聊天、审批、SSE、多用户隔离。
- `state.wakePreferences` 懒初始化（per-user Proxy 坑，别重蹈）。
- 默认关闭：`enabled=false` 时 `reconcileAll` 零副作用。
- 一个 commit：`feat(wakeup): per-user preference + frontend toggle`。不混入其它未提交改动。
- 完成后停在待复核者复查，未获「继续」不 commit。
