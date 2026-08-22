# Governance State Machine

版本：V1 draft（2026-08-22）

## Assertion lifecycle

```text
candidate ────────────────► active ─► superseded
    │                         │  └──► expired
    ├──► pending_confirmation ─┴──► revoked
    │           │                    └──► forgotten
    └──► rejected                         └──► deleted (physical removal)
```

- `candidate` 只能由安全提取或导入产生，默认不可召回。
- `pending_confirmation` 只有 subject user 能 confirm/reject，并绑定 candidate/version revision。
- `active` 可参与正常召回，但仍受 Scope、时间、grant、mention/direct-query policy 过滤。
- `revoke` 立即不可见但保留受治理历史；恢复必须由新的显式操作产生。
- `forget` 立即不可见，建立 tombstone/epoch，旧 worker/index/snapshot 不能复活。
- `delete` 在 canonical mutation 中物理移除目标范围，保留最小 deletion operation/tombstone。

## Mutation contract

| 操作 | 成功条件 | 失败语义 |
| --- | --- | --- |
| correct/pin/unpin/revoke/forget/delete memory | `resource_revision` 精确匹配 | stale revision 返回 409，不修改状态 |
| confirm/reject | confirmation pending、未过期、revision 匹配 | 已决定/过期返回 409 |
| forget/delete source/session/relationship/account | subject user governance actor | Agent 只能读，不能治理 |
| outbox processing | lease owner/fence token 有效 | fenced worker 不得提交结果 |

## Visibility precedence

`S3/do_not_store` > delete/forget/revoke/tombstone > tenant/user/Scope/ACL > time/TTL > sensitivity/direct-query > mention policy > ranking/truncation。

治理 mutation 成功返回前必须完成 canonical 不可见；索引和缓存可异步清理，但回源校验不能返回旧内容。
