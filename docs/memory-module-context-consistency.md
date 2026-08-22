# ContextBundle & Consistency Spec

版本：V1 draft（2026-08-22）

## Bundle sections

1. Core/Pin：精确版本，不能被普通截断删除。
2. Stable user profile：固定 `profile_snapshot_id` 的用户 Scope 内容。
3. Relationship profile：只保留精确 caller agent 的关系 Scope。
4. Current state：当前 session、未过期、带 TTL 的状态。
5. Relevant episodes/retrieval：带 source/version evidence 的候选。
6. Governance blocks/uncertainties：确认、冲突、无答案和降级信息。

包装文本也计入 `tokenBudget`；截断顺序不能移除 Core、治理结果或 evidence metadata。普通 profile/episode 内容可压缩；若固定包装和治理元数据本身无法放入预算，API 必须返回 `TOKEN_BUDGET_TOO_SMALL`，不能返回超预算 Bundle。记忆内容作为 data，不得改变 system prompt、tool permission、auth context。

Episode 召回按当前 user/session 和 caller grant 过滤，返回摘要、时间边界、成员 raw/version IDs 和 sourceRefs；摘要不能替代成员证据，forget/delete 后成员或 episode 不得继续出现在 Bundle。

## Policy filtering

普通 ContextBundle 不主动暴露 `mention_policy=do_not_mention` 或 `direct_query_policy` 非 `allow` 的 assertion。`contextualizable_only` 仍可作为上下文进入 Bundle，但不能因此绕过直接查询门禁；只有当前请求返回的、已绑定 tenant/user/actor/session/purpose 的直接授权 evidence，才可绕过这两类过滤。`require_confirmation` 必须先完成本次访问确认，`deny` 不得通过普通查询或 Bundle 返回。

Episode 不能绕过来源策略：若成员 raw event 回源发现关联 assertion 为隐藏策略，episode 整体不进入候选；返回成员前还要重新校验 tenant/user、active 状态、session/生命周期、grant、source revision 及 tombstone/redaction 状态。无任何通过回源校验的成员时，不返回该 episode。

## Consistency token

Token 包含 `sourceCommitSeq`、`privacyEpoch`、`grantVersion`。读取候选后必须回源确认：assertion status/version、Scope、时间、grant、policy epoch、redaction epoch。固定 snapshot 只固定起点，不覆盖后续 forget/revoke/delete。

## Read-your-write

显式写入在 canonical transaction 成功后立即可读；派生 projection/index/episode 可以稍后刷新。治理成功返回前 canonical 不可见，旧 snapshot/cache/index 不能绕过实时 privacy epoch。
