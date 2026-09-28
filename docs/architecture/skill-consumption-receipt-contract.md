---
title: Skill Consumption Receipt Contract
doc_kind: architecture
feature_ids: [F100, F131, F188, F200, F223, F228, F314]
related_features: [F287, F299, F311]
topics: [skill, consumption-receipt, outcome, workspace, request-review, local-review, runtime-carrier, revision]
created: 2026-08-28
updated: 2026-09-12
status: active
author: codex-sol
description: "workspace-navigator 与 request-review 纵切的 revision-bound applied/dismissed 收据、consumer-bounded outcome、失效与 runtime carrier 边界。"
description_source: model
description_author: codex-sol
description_updated_at: 2026-09-12T00:00:00Z
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
    toolName: cat_cafe_prepare_skill_consumption
    resourceFamily: skill-consumption-receipt
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
    toolName: cat_cafe_open_with_workspace_navigator
    resourceFamily: skill-consumption-receipt
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
    toolName: cat_cafe_dismiss_skill_consumption
    resourceFamily: skill-consumption-receipt
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
    toolName: cat_cafe_prepare_request_review_consumption
    resourceFamily: skill-consumption-receipt
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
    toolName: cat_cafe_bind_request_review_consumption
    resourceFamily: skill-consumption-receipt
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
    toolName: cat_cafe_record_request_review_consumption
    resourceFamily: skill-consumption-receipt
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/architecture/skill-consumption-receipt-contract.md"
    toolName: cat_cafe_dismiss_request_review_consumption
    resourceFamily: skill-consumption-receipt
    boundaryKind: resource-entry
    decision: accepted
---

# Skill Consumption Receipt Contract

Architecture cell: hub-action-surface

这份合同最初关闭 generated memory architecture catalog 中 `skill.consumptionReceipt` 与
`skill.outcome` 两个 exact RED，现在承载两个已接受的具名 consumer 纵切。它不重做 skill trigger、manifest、
全文读取或 package 分发合同，也不新增中央 cue engine / skill truth store。

## Pilot 与因果上限

首个纵切固定为 `workspace-navigator`，因为它已有明确生产 consumer：
`cat_cafe_open_with_workspace_navigator` → existing `/api/workspace/navigate` consumer → Hub Workspace delivery receipt。

收据能回答的最远问题是：同一个 invocation 是否把当前 skill package revision 应用于这个 Workspace
consumer，或明确判定它不适用；若应用，consumer 得到的 bounded decision 是
`applied | queued | blocked | unconfirmed`。它不生成 skill 总分，不把 task success 当作单个 skill 的因果，
也不把「曾展示 / 曾全文读取」冒充「已应用」。

第二个纵切固定为 F100 `request-review` 的 local-review consumer。其授权边界来自
`[thread-id]#private-source-id` 与
*(internal reference removed)*：
author 预留 exact semantic asset version 与 review HEAD/source tuple，具名非作者 reviewer 的真实 invocation
绑定该 reservation，再以 durable typed local-review message 结算 `applied | unconfirmed`，或显式 dismiss。
`approved` 与 `changes_requested` 都可能证明 skill 被 consumer 使用；它们的 merge 含义不属于本合同。

## 收据路径

### Workspace navigation

```text
prepare（短期加密 handle；无 durable applied receipt）
  → cat_cafe_open_with_workspace_navigator(handle)
    → Workspace consumer 的 deliveryStatus
      → append-only skill_consumption_receipt(consumption=applied)

  ↘ 明确不适用 / 选择原生快捷入口
    → dismiss(consumption=dismissed, outcome=not_applicable)
```

### Request review

```text
prepare（durable reservation；strict author invocation + origin）
  → bind（exact routed reviewer invocation + server-observed mounted semantic revision）
    → record（exact typed local-review message + reserved HEAD/source tuple）
      → F100 use receipt(consumption=applied | unconfirmed)

    ↘ reviewer 确认不适用 / 不可审 / route 被替代
      → dismiss(consumption=dismissed)
```

prepare、bind、typed verdict 与 `record` 是四个互不替代的事实。无法证明 runtime mount、reviewer invocation、
review subject、HEAD 或 accepted source/revision 精确一致时，结果保持 `unconfirmed` 或拒绝，不能从 prose、任务成功、
generic callback 或 Git blob 相等推断 `applied`。

`cat_cafe_record_request_review_owner_fact` 不是 consumption receipt：它记录 F100 owner 的
mutation/load/evidence/no-change/rollback/fresh-outcome refs，并通过 F266/F167 custody 与 exact Program lineage
受权。它的治理 subject 属于 F311 `evolution-program` owner 边界，不在本合同的 receipt resource family 中。

**Receipt itself does not prove that the package was presented or read.** 完整读取仍是 skill 的独立使用义务；
两个纵切都不把 presentation/full-read 事件接成 prepare 前置条件，也不由 receipt 反推 presented/drilled。
Workspace 纵切只有 Workspace consumer 可以写 `applied`；request-review 纵切只有 exact typed review 与 reservation
由服务端匹配后才能写 `applied`。公开工具面都没有“自报 applied”的入口。Workspace `dismissed` 只接受
`alternate_native_shortcut | outside_skill_scope`；request-review 只接受
`outside_local_review_scope | request_not_reviewable | route_replaced`。收据只保存坐标、revision、消费决策和
bounded outcome，不保存 SKILL.md 正文或模型 rationale。既有 trigger/presentation/full-read 合同可以继续记录
「presented / drilled」，但它们不是 consumption receipt，也绝不能自动升级成 applied 或 dismissed。

## Revision 与同一次消费

`SkillConsumptionReceiptService` 对 skill package 内所有文件路径与字节做确定性 SHA-256。prepare handle
通过进程级 AES-GCM key 绑定：

- `skillId + skillRevision`
- 固定 consumer `workspace-navigator.navigate.v1`
- `userId + threadId + invocationId + catId`
- expiry

Workspace consumer 在副作用前验证一次、写收据前再验证一次。跨 invocation / cat / thread / consumer
重放、过期、重复消费与 package revision 变化全部 fail closed。已写收据的
`applicabilityAtWrite: current` 只是写入时事实，不冒充当前状态；任何后续 consumer 都必须用当前 package hash
重新分类。修订或纠正包内容后，旧收据分类为
`stale`，不能继续支撑 closure 或 utility claim。

Workspace prepare handle 是无持久状态的加密坐标；真正收据复用现有 `EventAuditLog` append-only ledger。这里没有
新增 skill truth store，lane-owned `assets/memory-surfaces/skill/closure.yaml` 与 strict closure gate 仍是终态账。

带 handle 的 Workspace 请求若显式指定 `threadId`，它必须等于 invocation principal 的 thread；即便另一个
thread 属于同一 user scope，也会在导航副作用前以 `409 scope_mismatch` 拒绝，避免投递坐标与收据坐标分裂。

request-review reservation 使用 F100 TTL=0 exact-ref ledger，而不是 Workspace 纵切的进程内 encrypted handle。
它绑定 exact `AssetVersionRef`、author/reviewer invocation、review subject、reviewed HEAD、accepted source/revision
与 named local-review consumer；跨 crash 可恢复，但同一 reservation 只能结算一个 terminal use fact。

## Runtime carrier capability

能力按「full MCP 工具实际出现 + invocation callback credential 存在 + consumer 返回 receipt」判，不按
provider 名字猜。`invoke-single-cat.ts` 为正常 child invocation 生成 exact invocation/callback credential；
各 provider carrier 是否把 managed MCP 挂进该 child 则分别查代码。MCP canonical registry 把 Workspace
三个 receipt/consumer 工具与 request-review 四个 receipt/consumer 工具都限定为 `full` profile。当前边界如下：

| Runtime / carrier | 状态 | 边界 |
|---|---|---|
| Codex `exec_json`, `app_server` | supported on managed non-readonly invocation | carrier 显式物化 per-invocation MCP credential；prepare 与 consumer 共用 callback principal |
| Claude `print_sdk`, `interactive_pty` | supported on managed non-readonly invocation | carrier 显式注入 managed MCP；`api_key` 只是 auth mode，不另算 carrier |
| Claude `bg_daemon` | supported after native MCP approval | 同一 invocation credential；新 project 尚未通过 daemon MCP approval 时不假绿 |
| Kimi `stream_json` | supported when its per-invocation MCP config materializes | 工具出现且 consumer 回 receipt 才算绿 |
| OpenCode `run_json` / ACP | supported when runtime config/session accepts full MCP | ACP capability filter 若丢弃 MCP，状态就是 unsupported |
| Gemini `gemini_cli` | conditional, not provider-wide green | child 有 invocation env，但 carrier 不自行注入 managed MCP config；仅已配置 full MCP 且收到 receipt 时 supported |
| AGY CLI / Antigravity adapter / CDP bridge | unsupported on current shared readonly/agent-key surface | receipt tools不在 profile；instruction/curl fallback 不等价于同一次 consumer carrier |
| GPT-Pro cloud desktop / shared persistent agent-key | unsupported | 无 same-invocation receipt custody；API 对带 handle 的 agent-key 返回 `carrier_unsupported` |
| direct interactive REST, CatAgent direct API, remote A2A | unsupported | 没有已证明的 full-MCP + invocation carrier pair |

两组共七个 receipt/consumer 工具都是 `full` only；`cat_cafe_workspace_navigate` 保持原有公共合同并可在 agent-key
下做普通导航，但不能携带 receipt handle。API 对任何非 invocation principal 携带 handle 都明确拒绝。
工具不可见、prepare 未发生或普通任务成功，都不能 heuristic 假绿。

## 可执行证据

- `packages/api/test/skill-consumption-receipt.test.js`：prepared ≠ receipt、真实 consumer applied、dismissed、
  exact scope、revision correction、重放与 unsupported carrier。
- `packages/mcp-server/test/skill-consumption-tools.test.js`：工具 schema/路由，且只有真实 consumer 路由能 applied。
- `packages/api/test/request-review-use-receipt.test.js` 与
  `packages/api/test/request-review-consumption-routes.test.js`：strict author、具名 reviewer、mounted revision、
  exact HEAD/source、dismiss 与 crash replay。
- `pnpm check:mcp-surface-governance`：每个公开工具的 admission ref 必须与本合同或 F311 owner contract 的
  exact `toolName + resourceFamily + boundaryKind` claim 一致。
- `packages/mcp-server/test/hub-action-tools.test.js`：既有 Workspace 工具公共合同没有为试点扩张。
- `scripts/memory-architecture-closure.test.mjs`：missing keys 从 55 精确降到 53，`skill` 不再占 B2/B3。

证据级别为 `main` 合同与生产代码；Alpha/UAT 只有在隔离 Alpha runtime 真实调用返回 receipt 后才能升级，
不能用单测或 task completion 冒充。
