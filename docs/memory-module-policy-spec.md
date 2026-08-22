# Memory Policy Spec

版本：V1 draft（2026-08-22）

## Sensitivity

| 等级 | 默认处理 |
| --- | --- |
| S0 | 可按显式策略 active；可进入结构化/BM25/可选 hybrid |
| S1 | 仅允许 TTL-bound current state；不自动成为长期事实 |
| S2 | pending confirmation；默认 `do_not_mention`、direct query 需确认 |
| S3 | 入口拒绝；不入 raw/outbox/index/vector/model/log |

检测采用入口同步规则和下游再次校验；模型不得挽回已经落库的 S3 错误。

## Retrieval versus mention

- `retrievable`：符合权限、Scope、时间、状态和 sensitivity 规则，可作为候选。
- `contextualizable`：有 `contextualize` grant、不是 direct-query deny，且允许放入 Bundle。
- `mentionable`：额外满足 `mention_policy=mentionable`、主动提及策略和 cooldown；可检索不等于可主动说出。
- `direct_query_policy=deny`：用户直接问也不返回内容。
- `require_confirmation`：创建一次性、session/agent/purpose 绑定 access token。

## Promotion

- user explicit：可直接 active，但仍执行 S3/S2/Scope 校验。
- user observed：可进入 candidate/active，保留 raw source。
- agent/model inferred：默认 candidate；S2 只能 pending_confirmation，不能自动 active。
- tool/imported：默认低信任，必须保留来源和 promotion policy version。

## Degradation

模型不可用时保存安全 raw event；embedding 超时回退 BM25/结构化查询；Memory Module 超时、空结果或降级不得阻塞正常对话，也不得伪造治理 mutation 成功。
