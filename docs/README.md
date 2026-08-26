# Cochpia 文档入口

这里按“规范、设计、验收、运维、产品说明”区分文档。代码和测试是行为事实源；文档用于说明边界、决策和验证方法，不把一次本地运行结果写成生产承诺。

## 推荐阅读顺序

1. [`companion-core-foundation-plan.md`](./companion-core-foundation-plan.md)：陪伴核心基座的目标架构、事实所有权和建设路线。
2. [`companion-core-event-contract.md`](./companion-core-event-contract.md)：交互事件、Collector、Outbox、Finalizer 和流式恢复的 V1 契约。
3. [`memory-module-v1-contract.md`](./memory-module-v1-contract.md)：Memory Module 的对外边界；再按需阅读数据模型、策略、一致性和治理文档。
4. [`memory-module-evaluation-report.md`](./memory-module-evaluation-report.md) 与 [`memory-module-alpha-gate.md`](./memory-module-alpha-gate.md)：当前验证证据和仍未关闭的 Alpha 门禁。
5. [`memory-module-operations-runbook.md`](./memory-module-operations-runbook.md)：部署、降级、worker、删除和恢复操作。
6. [`记忆与性格机制.md`](./记忆与性格机制.md)：面向产品和非后端读者的记忆、关系与人格成长说明。

## 文档分类与归属

| 类别 | 文档 | 维护边界 |
| --- | --- | --- |
| 基座设计 | `companion-core-foundation-plan.md`、`companion-core-event-contract.md` | Companion Core、Context Assembly、交互事件和事实所有权 |
| Memory 规范 | `memory-module-v1-contract.md`、`memory-module-data-model.md`、`memory-module-policy-spec.md`、`memory-module-context-consistency.md`、`memory-module-governance-state-machine.md`、`memory-module-retention-deletion.md` | Memory Module 的 canonical 数据、权限、生命周期和一致性 |
| Memory 运维与安全 | `memory-module-threat-model.md`、`memory-module-model-gateway.md`、`memory-module-operations-runbook.md`、`memory-module-cost-capacity.md` | 安全边界、模型供应商、容量和故障处理 |
| 验收与发布门禁 | `memory-module-evaluation-report.md`、`memory-module-alpha-gate.md`、`开发进度与GitHub发布前审计.md` | 测试证据、未完成门禁、发布前检查；不替代代码测试 |
| 产品说明 | `记忆与性格机制.md`、根目录 `游戏方案.md` | 产品概念和面向非技术读者的运行链路 |
| 部署说明 | `deploy/README.md`、`deploy/production-readiness.md`、`deploy/国内云部署说明.md` | 环境变量、托管部署和生产前置条件 |

## PR 文档规则

- 功能 PR 只携带该功能的规范、测试说明和运维变更；不要把全量架构快照、无关验收脚本和其他模块文档一起提交。
- `docs/memory-module-openapi.yaml` 是接口契约，与 Memory API 的功能变更同 PR 更新。
- `docs/memory-module-eval-v0.1.json` 和 `docs/memory-module-eval-v0.2.json` 是评测输入 fixture，不是说明文档；生成的结果写入本地 `artifacts/`，不作为 PR 的源码证据提交。
- 验收文档引用可复现的命令和结果类型；如果结果文件没有进入仓库，就使用代码格式路径说明，不创建指向不存在文件的 Markdown 链接。
- 文档中的“代码级通过”“本地真实环境通过”“生产就绪”必须分开描述。当前 Alpha/生产门禁未全部关闭时，统一保留明确的未完成项。

## 按 PR 归属

后续 PR 按以下边界维护文档，便于单独测试和回滚：

1. Memory Module 治理与持久化：Memory 规范、治理、删除、恢复、评测和 Alpha 门禁文档。
2. Companion Core 事件与上下文：基座计划、事件契约和 Context Assembly 说明。
3. Chat Runtime 与 Model Gateway：聊天流、SSE、重试、取消、模型安全边界说明。
4. Personality / Relationship / LifeState：记忆与性格机制、关系状态和 LifeState 领域说明。
5. Desktop / Frontend / Deployment：根 README、桌面入口和部署/发布说明。
