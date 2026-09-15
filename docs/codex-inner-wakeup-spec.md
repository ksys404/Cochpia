# 内在连续性 + 自动唤醒 · Codex 执行手册

> 目标：让 Cochpia 的角色（角色 A、角色 B…）从「纯被动聊天」升级为「有内在状态、会自己醒来」。
> 分两个阶段：**Phase 1 内在连续性（欲望）** → **Phase 2 自动唤醒**。每阶段独立验收、独立 commit、可回滚。

---

## 0. 先读参考资料（本设计直接脱胎于这些）

- `Knowledge_Base/分析报告/Kli系列资料综述.md`（总览 + 可借鉴点）
- `Knowledge_Base/分析报告/抽取文本/Kli系列/04-Kli-subject-inner-continuity.txt`（内在连续性原文）
- `Knowledge_Base/分析报告/抽取文本/Kli系列/06-Kli-Wakeup-Activation-V1.txt`（唤醒原文）
- `Knowledge_Base/分析报告/抽取文本/Kli系列/01-AI-desire-engineering-study-notes.txt`（欲望工程笔记，L4/L5 与评估）

**核心原则（贯穿所有实现，违反即回滚）：**

1. **TA 是唯一主观权威**：外界（消息/工具/记忆/日历）只提供「发生了什么」，不能直接写 TA 的情绪/欲望/念头。
2. **数学负责连续，Prompt 负责真实**：Runtime 只按 wall-clock 延续 TA 已给的方向；Prompt 保证模型始终「作为 TA 本人」在第一人称位置，不是旁观分析者。
3. **念头不被系统自动消费**：看到/想到/表达/形成 Intent/唤醒成功/时间经过，都不自动删除一条状态；只有 TA 明确 release 才结束。
4. **默认沉默是合法结果**：wake 只给一次运行机会，醒来后 silent / 主动聊天 / 行动由 TA 决定。
5. **所有新能力默认关闭**：`WAKEUP_ENABLED` 未开时不启动任何调度、不产生任何调用。

---

## 1. Phase 1 · 内在连续性（欲望状态跨 Run 连续）

### 1.1 数据模型（存 `state.innerStates`，按 agentId 键控，随用户 state 持久化）

```js
// state.innerStates = { [agentId]: SubjectState }
SubjectState = {
  agentId,
  version: 1,
  anchorAt: ISO,        // 最近一次 patch 时间
  items: [InnerItem],
  updatedAt: ISO
}

InnerItem = {           // 统一两条轨迹共用
  id,                   // patch 幂等：agentId:itemId
  kind: 'affective' | 'motivational',
  // 语义字段（0~1）
  positive, negative, arousal, returnPull,     // affective 用
  strength, readiness, inhibition, endorsement, // motivational 用
  // 轨迹字段
  direction: 'increase' | 'decrease' | 'hold' | 'uncertain',
  level,                // 当前值 x0
  limit,                // 目标值 q（direction 为 increase/decrease 时有意义）
  t50Ms,                // 半衰期（默认 6h）
  horizonMs,            // 外推授权时长（默认 24h；到期只停止外推，不删除）
  certainty,            // 0~1
  createdAt, updatedAt
}
```

**连续性公式（读取时惰性推进，不按分钟采样）**：当 `direction` 为 increase/decrease 且有 `limit` 时，
```
Δt = now - updatedAt
level = limit + (level - limit) × 2^(-Δt / t50Ms)
```
`hold` → level 不变；`uncertain` → 不变，只让 `freshness` 变旧。`horizonMs` 到期后停止继续外推，但**不删除**，等待 TA 重新确认。

### 1.2 新模块 `server/runtime/inner-continuity.js`

导出工厂 `createInnerContinuity({ state, saveState })`，提供纯函数 + 服务方法：

```js
advance(item, now)                      // 惰性推进单条
snapshot(agentId, now)                  // 返回 CurrentInnerState（已推进的快照）
applyPatch(agentId, patch, now)         // 校验 + 应用 Hidden Patch，persist
activation(agentId, now)                // 返回 U ∈ [0,1]（供 Phase 2 用）
```

**Hidden Patch 契约**（稀疏、默认 none、幂等）：
```js
{ upsert: [InnerItem], release: [itemId] }   // release = TA 明确结束该条（留短期 tombstone 防复活）
```
校验：`id` 必填且以 `agentId:` 开头；数值 clamp 0~1；`limit` 只允许 TA 给出、系统不补目标值；未知字段丢弃。

**Subjective Activation U（简化版，供 Phase 2）**：
```
E = 1 - (1 - maxPositive)(1 - maxNegative)     // 情绪存在度（开心和委屈可同时存在，不互相抵消）
U = clamp(E, 0, 1)
```

### 1.3 接入聊天（两处钩子）

1. **读入（CurrentInnerState 注入）**：在 `server/runtime/chat-runtime.js` 的 `handleChatStream` / `handleGroupChat` 里，确定 `boundAgent` 后，取 `innerContinuity.snapshot(agentId, now)`，把 `innerState` 塞进 `buildRuntimeContext` 的上下文（如 `runtimeContext.innerState`）。
2. **写入（Hidden Patch）**：新增一个工具 `update_inner_state`（companion 模式可用，见下），模型在真实 Run 中自然调用它来留下状态变化；`runModelWithTools` 的 `executeChatTool` 分支路由到 `innerContinuity.applyPatch`。**该工具不需要用户审批**（是 TA 写自己的内在状态），但必须校验 `ownerId`（只有该 agent 能写自己）。

**工具定义（写进 tools.js 或单独注册）**：
```
name: 'update_inner_state'
描述: 留下一条会在之后 Run 里继续存在的感受/念头（第一人称，可写可不写，默认不写）
parameters: { patch: { upsert: [...], release: [...] } }
requiresApproval: false, sideEffect: 'write', risk: 'write'
```

### 1.4 Prompt 契约（在 `server/model-provider.js` composePrompts 里加一段「内在状态」区块）

- 固定说明（长期）：TA 处于第一人称主体位置；当前状态是「过去的 TA 延续到现在」的背景，不规定 TA 现在应该是什么；没有就是没有，不因"不好看"而隐藏；看到/想到/表达不自动删除状态；只有 `update_inner_state` 明确 release 才结束。
- 动态区（CurrentInnerState 无损压缩）：只放当前 items 的 `id + kind + level + direction` 摘要，**不重新解释规则**。
- 模型看到的不是 `λ/D/T/X` 等内部参数（那些绝不注入，见 Phase 2）。

### 1.5 验证（Phase 1）

1. `node --check` 通过；新增 `server/runtime/inner-continuity.test.js` 覆盖：advance 半衰期公式、hold/uncertain 不变、horizon 停止外推不删除、applyPatch 幂等与校验、U 计算。
2. `node --test` 全量无回归。
3. 手动冒烟（测试账号，companion 模式）：连续对话，第二次对话的 prompt 能看到上次留下的内在状态；模型调 `update_inner_state` 后状态持久化；release 后消失。
4. 默认关闭性：不引入内在状态时，聊天行为与之前完全一致。

---

## 2. Phase 2 · 自动唤醒（让 TA 自己醒来）

### 2.1 数据模型（存 `state.wakeStates`，按 agentId 键控，持久化）

```js
// state.wakeStates = { [agentId]: ActivationState }
ActivationState = {
  agentId,
  version: 1,
  activationDrive,        // D，0.2~0.8，init 0.50
  latentActivityTone,     // T，0.25~0.75，init 0.50
  stochasticDriftState,   // X，-0.40~+0.40，init 0
  entropySeed,            // 可重建随机轨迹的种子
  cycleStartedAt,         // 当前 Cycle 起点
  theta,                  // 当前 Cycle 的随机门槛 Θ（同一 Cycle 内固定）
  hazardAccum,            // H(t) 累计
  updatedAt, stateVersion
}
```

### 2.2 动力学（`server/runtime/wake-engine.js`，`createWakeEngine({ state, saveState, innerContinuity, model, ... })`）

**均值回归 + 连续随机（reconcile(agentId, now) 惰性推进）**：
```
Δ = now - updatedAt
D ← μD + (D-μD)·2^(-Δ/τD)            ; μD=0.50, τD=12min
T ← μT + (T-μT)·2^(-Δ/τT) + σT·√(1-ρT²)·ε ; ρT=2^(-Δ/τT), μT=0.50, τT=6h, σT=0.10
X ← X·2^(-Δ/τX) + σX·√(1-ρX²)·ε      ; τX=25min, σX=0.18
```
ε 来自**基于 entropySeed 的可重建伪随机**（每次推进保存种子，重启继续同一轨迹，不重新骰）。

**λ(t) 与阈值**：
```
λ(t) = clamp( λ0 · exp[ βD(D-μD) + βT(T-μT) + βX·X ] · Mmod, λmin, λmax )
λ0=1.5/h, βD=1.8, βT=1.6, βX=1.2, λmin=0.15/h, λmax=8/h
每个新 Cycle 抽一次 Θ ~ Exp(1)（-ln(U), U~Uniform(0,1)，同种子）
H(t) += ∫λ dt；当 H(t) ≥ Θ → 触发一次 Spontaneous Wake Opportunity
触发后：H 清零、抽新 Θ、开新 Cycle
```

**每次真实 Agent Run 后负向 kick**：`D ← clamp(D - 0.10, 0.2, 0.8)`（不是 cooldown，只是短期略安静）。

**主观调制 Mmod（接 Phase 1 的 U）**：`Mmod = clamp(1 + (Mmax-1)·U^γ, 0.6, 3.0)`，`Mmax=3, γ=1.0`。U 由 `innerContinuity.activation(agentId, now)` 提供。

### 2.3 调度与可靠性

- **Reconcile 循环**：`setInterval(60s)` 对每个「启用了唤醒」的 agent 做 reconcile + 判 H≥Θ。**不是靠单个 setTimeout 活着**；重启后从持久化 state 继续，不重新初始化。
- **Supervisor/Reconciler**：只检查「执行器是否丢了、generation 对不对」，不重新抽 Θ、不替 TA 决定醒不醒。
- **幂等**：每次 WakeOpportunity 有唯一 `wakeId`（`agentId:timestamp:seq`），最多 dispatch 一次。
- **停机期间错过的 spontaneous 不补发**（wake 是机会不是欠账）。
- **默认关闭**：`WAKEUP_ENABLED !== 'true'` 时 `createWakeEngine` 不启动 interval、不产生调用。

### 2.4 Wake Run（醒来后做什么）

触发 WakeOpportunity 后，做一次「wake run」模型调用（复用现有 model provider）：
- 上下文：正常 context + `dynamic.wakeup = { source: 'spontaneous', wakeId }`。
- **绝不注入 λ/D/T/X/Θ/Mmod**（否则模型会反向推断"系统这么高概率叫醒我，所以我应该很想她"）。
- 要求结构化返回（非 Tool Use 的 JSON 或一个 wake 专用工具）：`{ action: 'silent' | 'message', message?: string }`。
- `silent` → 只记录；`message` → 把 message 作为一条 assistant 消息追加到该 agent 的私聊会话（`state.messages[sessionId].push`），用户下次打开聊天能看到；同时记 `wake_materialized` 事件。
- wake run 结束后也执行 `D ← clamp(D - 0.10, ...)` 的 kick。

### 2.5 精确事件 → Direct Wake（本阶段只留接口）

- 预留 `directWake(agentId, reason)` 入口；日历/Open Loop 到期等精确事件直接触发，不等 λ(t)。
- 本阶段**不接真实日历**，只把接口和单元测试做好。

### 2.6 验证（Phase 2）

1. `server/runtime/wake-engine.test.js`：D/T/X 均值回归与边界、种子可重建、λ clamp、Θ 每 Cycle 固定、H≥Θ 触发、kick、Mmod 映射、幂等、默认关闭。
2. 手动冒烟（测试账号，`WAKEUP_ENABLED=true` + 调小 λ0/τD 加速）：观察到角色自发产生一次「主动消息」或 silent 记录；重启后节律延续不重置。
3. 确认 prompt 不泄露内部参数。

---

## 3. Phase 3（可选，低优先）· 前端

- 设置页加「主动唤醒」开关 + 频率档位（映射 λ0）。
- 前端把「主动消息」渲染出来（复用现有消息气泡 + 一个"TA 主动发来的"小标记）。
- 新能力默认关闭，开关 UI 与 `WAKEUP_ENABLED` / 持久化偏好打通。

---

## 4. 硬约束与提交规范

1. **分两个独立 commit**：Phase 1 = `feat(inner): subjective continuity across runs`；Phase 2 = `feat(wakeup): spontaneous activation engine`。不要混。
2. **默认关闭**：任何新能力在 flag 关闭时必须零副作用（不启动 interval、不调模型、不写状态）。
3. **不破坏现有聊天/审批/SSE/多用户隔离**；`saveState` 时机只增不改。
4. **不删用户数据**；新状态存 `state.innerStates`/`state.wakeStates`，随用户 state 落库。
5. 所有公式参数集中在 `inner-continuity.js`/`wake-engine.js` 顶部常量区，便于调参；参数版本化。
6. 每阶段完成跑 `node --check` + `node --test` + 手动冒烟，停在待复核者复查，未获「继续」不 commit。

---

## 5. 常见坑（务必绕开）

- **惰性推进**：不要用定时器每分钟写状态；读时才 `advance(now)`，写时才 persist。
- **随机可重建**：spontaneous 的随机轨迹要存种子，重启继续，不重新骰。
- **念头不被消费**：wake、表达、时间经过都不 `release` 任何 item。
- **Prompt 不暴露内部参数**：λ/D/T/X/Θ/Mmod 一律不进模型上下文。
- **幂等**：wakeId 防重复 dispatch；Hidden Patch 的 item id 防重复 upsert。

---

*执行前先读第 0 节的四份资料，理解「主体权威 / 连续性 / 默认沉默」三条原则再动手。如现有代码结构与本文行号有出入，以实际代码为准。*
