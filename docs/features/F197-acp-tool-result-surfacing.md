---
feature_ids: [F197]
related_features: [F188, F102, F149]
topics: [acp, transport, providers, telemetry, recall-sidebar]
doc_kind: spec
created: 2026-05-11
---

# F197: ACP Provider tool_result Event Surfacing — Gemini ACP path 单事件拆成 tool_use+tool_result 双消息

> **Status**: done | **Completed**: 2026-05-12 | **Owner**: Ragdoll/Opus-47 | **Priority**: P1

## Why

F188 Phase F 上线 LIVE Recall sidebar 后operator发现：ACP 路径下的 search_evidence 调用，UI 卡片只显示 query/mode/scope/time，**永远不显示 `[N hits]` 也永远展开不出 results**。其它 provider（catagent 直连 Anthropic / Codex）显示正常。（**初诊误称 "Claude Code CLI via ACP"，Maine Coon 一审 P1-1 校正：repo 里 ACP 当前仅服务 Gemini。详见后文 ACP scope 节。**）

operator experience（2026-05-11 跟 47 dogfooding F188 Phase F 时）：
> "为啥我这里看到的是你啥也没生效？是没搜到吗？"
> "截图里 你看到第一个嘛？有 hit 才能展开！然后剩下的 都不行 你说我没展开是错的我就是展开了啥也没看到才以为你什么都没搜到的"

**ACP scope（Maine Coon 一审 P1-1 校正）**：当前 repo 里 ACP 只服务 **Gemini**（`packages/api/src/index.ts:990` 只在 `clientId: google` 分支 instantiate `GeminiAcpAdapter`）。Opus-47 / Codex 走 Anthropic API 直连 (catagent) 不走 ACP。所以本 fix 影响的是**Siamese/Gemini 在 ACP 路径下**的 Recall sidecar + FM-5 metric，不是 47/Maine Coon。

**根因（Maine Coon 一审 P1-2 校正）**：`packages/api/src/domains/cats/services/agents/providers/acp/acp-event-transformer.ts:83-112` 把 ACP 的两个 sessionUpdate 都转成 `type: 'tool_use'`。但 Gemini CLI v0.36 **实际 production format** 是单事件 `sessionUpdate: 'tool_call'` + `status: 'completed'` + `title` + result `content` 一打包（见 `packages/api/test/acp/acp-event-transformer.test.js:93-110` fixture）。`tool_call_update` 只是部分场景。

```typescript
case 'tool_call': {              // 现状：Gemini 把 completed+content 也走这条
  return { type: 'tool_use', catId, toolName, toolInput, ... };  // ← 漏了 result-side
}
case 'tool_call_update': {       // 现状：部分场景的 progress/final update
  return { type: 'tool_use', catId, toolName, content: content?.text, ... };  // ← 漏了 tool_result emit
}
```

**单事件拆双消息约束（Maine Coon 一审 P1-3）**：UI `useRecallEvents.filterRecallEvents` 的 pairing 模型先靠 `tool_use` 建 pending、再靠 `tool_result` 配对（`useRecallEvents.ts:235`）。ToolEventLog 也先 `append(tool_use)` 再 `updateSummary(tool_result)`（`route-serial.ts:844`、`route-parallel.ts:591/644`）。Gemini 单事件 `tool_call[completed+content]` 必须 transformer 内部拆成 **两条 AgentMessage stream message**（先 `tool_use` 建 pending，再 `tool_result` 配 pair），否则即使转对了 result 类型，前面没 pending → UI 仍不亮 `[N hits]`、ToolEventLog 也 append 不到事件。

**后果**：
- LIVE Recall sidecar：Gemini-on-ACP 路径 cards 显示但永远 unpaired
- F188 Phase F FM-5 nudge-followup metric：Gemini-on-ACP thread 拿不到 result summary，算不出来

不是 F188 Phase F 引入，是 ACP transformer 老 bug，F188 Phase F 把 Recall sidecar / FM-5 推上前台后暴露。F149 (Gemini ACP Adapter) 不是"潜在同病"，是**当前同一 transformer**——本 fix scope 直接覆盖 F149 path。

## What

### Phase A: ACP transformer 单事件 + 双事件路径都正确 emit tool_use+tool_result

**核心约束（Maine Coon 一审 P1-3）**：UI / ToolEventLog 都基于 `tool_use → tool_result` pair 模型。Gemini-on-ACP 路径要让 `[N hits]` 亮 + FM-5 算出来，transformer 必须保证**每个 tool 完整生命周期至少 emit 一对 `tool_use` + `tool_result`**。

**判定矩阵**（基于 ACP sessionUpdate kind + `status` 字段；status 字段名以 ACP protocol 实际为准，已知 `completed`/`failed`/`in_progress`）：

**关键状态机不变量**（Maine Coon 二审 P1-1 + P1-2 校正）：
1. **同 toolCallId `tool_use` 只 emit 一次**——后续 progress 不能再 emit tool_use（否则 `toStoredToolEvent` 会落两个 UI 事件、Recall pending 队列重复入栈）
2. **final 判定仅认 `status ∈ {completed, failed}`**——no-status content fallback 删掉（hotfix 不引入歧义；progress content 不会被提前 pair 成 result）

| ACP 事件形状 | transformer 行为 |
|---|---|
| `tool_call`（无 status，或 status=`in_progress`/`pending`） | emit `tool_use`（首次出现，建 pending）|
| `tool_call` + status=`completed`/`failed` + content（**Gemini v0.36 实际格式**） | emit **两条** AgentMessage：先 `tool_use`（toolName + toolInput），再 `tool_result`（content）|
| `tool_call_update` + status=`in_progress` / 中间 content | **不** emit `tool_use`（同 toolCallId 已建过 pending）；emit `system_info` (progress) 或直接 ignore——见 KD-5 |
| `tool_call_update` + status=`completed`/`failed` + 最终 content | emit `tool_result`（前面已由 `tool_call` 建过 pending，此处补 result 完成 pair）|
| `tool_call_update` + 无 status + content | **不** 视为 final（progress 还在路上）；同 in_progress 处理 |
| 边界：同 toolCallId 第一次出现就是 `tool_call_update[completed]`（没有前置 `tool_call`） | 拆双消息：补一个 `tool_use`（toolName 从 update 字段提取） + `tool_result`（避免 orphan result）|

**实现要点**：
- Transformer 维护 per-session `toolCallId → { emittedToolUse: boolean, finalEmitted: boolean }` Map（session 结束清理）
- "拆双消息"通过 generator 或 `Array<AgentMessage>` 返回——当前 `transformAcpEvent()` 返回单个 AgentMessage / null，需要扩展为可返回 `AgentMessage | AgentMessage[] | null` 或改为 generator
- progress update 的处理方式（system_info vs ignore vs custom progress kind）留到 wktree 实测 UI 现状决定（KD-5）
- 测试 fixture `tool_call with "title" field (Gemini CLI v0.36 actual format)` 当前断言只期望 `result.type === 'tool_use'`，修复后该 fixture 应 emit `[tool_use, tool_result]` 两条

## Acceptance Criteria

### Phase A（ACP transformer 修复 + 测试）
- [x] AC-A1: `acp-event-transformer.ts` 的 `tool_call` case 按 status 分流：无 status / `in_progress` / `pending` → 仅 emit `tool_use`（建 pending）；`completed` / `failed` + content → emit **两条 AgentMessage**（先 `tool_use`，再 `tool_result`）
- [x] AC-A2: `acp-event-transformer.ts` 的 `tool_call_update` case 按 status 分流：`completed`/`failed` + content → emit **仅 `tool_result`**（同 toolCallId 已建 pending tool_use，不重复）；其它（`in_progress` / 无 status / 中间 content） → **不 emit `tool_use`**（同 toolCallId 已建过 pending，重复 emit 会双重入栈 Recall pending 队列）；progress 表达方式见 KD-5
- [x] AC-A3: 边界——同 toolCallId 第一次出现就是 `tool_call_update[completed]` 无前置 `tool_call` → 拆双消息（先补 `tool_use` 再 `tool_result`，避免 orphan result）
- [x] AC-A4: **final 判定仅认 `status ∈ {completed, failed}`**；no-status 含 content 视为 progress，不提前 pair（**no-status fallback 删掉**——Maine Coon 二审 P1-2）
- [x] AC-A5: Transformer 签名扩展：`transformAcpEvent` 返回从 `AgentMessage | null` 改为 `AgentMessage | AgentMessage[] | null`（或改为 generator）；所有 caller 更新处理多 message
- [x] AC-A6: 单元测试覆盖 6 场景：(a) `tool_call`(no status) → 1×tool_use (b) **`tool_call`(completed+content) → 2×message** (Gemini v0.36 实际格式) (c) `tool_call_update`(in_progress) → **0 个 tool_use / 0 个 tool_result**（progress 不重复入栈） (d) `tool_call_update`(completed) → 1×tool_result（前置 pending 已存在） (e) toolCallId 第一次出现就是 `update(completed)` 没前置 `tool_call` → 拆双消息 (f) `failed` status 同 completed 路径走 tool_result
- [x] AC-A7: 更新现有 `acp-event-transformer.test.js:93-110` Gemini v0.36 fixture 断言：从期望单 `tool_use` 改为期望 `[tool_use, tool_result]` 两条
- [x] AC-A8: alpha 端到端验证由Siamese dogfood 间接覆盖：search_evidence 返回 `Found 5 result(s)`，event序列经 transformer 拆双消息正确包装，Siamese现场推断 Recall sidecar `[5 hits]` 亮起（route-helpers + useRecallEvents 未改，依赖 transformer 正确产 stream — Siamese 2026-05-12 13:17 验收报告 PASS）
- [x] AC-A9: alpha 端到端验证由Siamese dogfood 间接覆盖（list_recent 在 ACP 路径连通正常；FM-5 N≥20 metric 累积留给 F188 Phase F close gate）— Siamese 2026-05-12 13:17 验收报告 PASS
- [x] AC-A10: Siamese 2026-05-12 13:17 在 alpha 实测 search_evidence / list_recent，verdict "F197 验收 PASS"，附带反馈"切换入口非常顺滑，耳目一新"

## Architecture Ownership

Architecture cell: `cats/services/agents/providers/acp` (F149 Phase B 之前确立的 cell)
Map delta: **none** — 只修 cell 内的 transformer 逻辑，不改 ownership / boundary / extension point
Why: 这是 cell 内部行为修复（ACP sessionUpdate kind → AgentMessage type 映射），不引入新概念，不改 cell 跟下游 (route-serial / route-parallel / useRecallEvents) 的契约

## Eval / Tracking Contract

> 触发条件：修改了 provider 行为，间接影响 F188 Phase F FM-5 / FM-2 metric 路径，**且涉及猫的 UI 可观察性**——所以填。

### 1. Primary Users + Activation Signal

- **Users**：
  - Siamese/Gemini（当前唯一跑在 ACP path 的猫——`index.ts:990` 只在 `clientId: google` 分支 instantiate `GeminiAcpAdapter`）
  - operator（Recall sidebar 用户）
  - F188 Phase F FM-5 / FM-2 metric 消费者（Memory Health Dashboard）
- **Activation signal**：
  - AS-1：Gemini-on-ACP 路径下 search_evidence 调用，UI Recall sidecar 卡片显示 `[N hits]`（>0）
  - AS-2：Gemini-on-ACP 路径下 ToolEventLog 接到的 search_evidence event 在 `updateSummary()` 后含 `resultCount` / `nudgeEmitted` 字段（之前一直 undefined）

### 2. Friction Metric

- **FM-1**：Gemini-on-ACP 路径下 Recall sidecar paired ratio — 期望 ≥ 95%（denominator 限定到**含 final content** 的 memory-class tool 调用，不把 hang/timeout 兜进去）
- **FM-2**：ToolEventLog 中 ACP 路径 search_evidence event 的 `_resultMerged === true` 比例 — 期望 ≥ 95%（denominator 同 FM-1）
- **FM-3**：F188 Phase F FM-5 nudge-failure-rate 在 ACP-only thread 上算出 non-NaN 值（之前 ACP-only thread 永远 NaN；denominator 同 FM-1）

### 3. Regression Fixture

- `acp-tool-call-update-only-tool-use` → 修复前 fixture：transformer 把 `tool_call_update` 转成 `tool_use`；修复后 `tool_result`
- `acp-multi-update-final-wins` → 同一 toolCallId 多个 update，只最后一个 status=completed 的转 tool_result
- `recall-feed-acp-fixture` → useRecallEvents 接 transformer 输出，能 pair 出 resultCount
- `fm5-acp-thread-end-to-end` → 用 ACP-only thread 跑 ToolUsageMetricsAggregator，FM-5 出 non-NaN

### 4. Sunset Signal

- 当 ACP protocol 演进出 explicit `tool_result` sessionUpdate kind 时（如 ACP 1.x），transformer 可以从"按 status 分流"简化为"按 kind 直接映射"
- 当 cat-cafe 内部统一 AgentMessage schema 把 `tool_use`/`tool_result` 合并为单一 lifecycle event（如带 phase: 'started'/'completed'）时，本 fix 的分流逻辑可整体下线

## In-context Observability Decision

- **primary_surface**: ACP path 的 Recall sidebar `[N hits]` badge + ToolEventLog 写入 Dashboard panel
- **why_not_dashboard_only**: Dashboard 是事后审计 (~30min latency)；猫现场决定下一步是否要换入口、要不要 follow nudge，必须现场知道刚才搜了多少东西 → primary 是 sidebar
- **deep_dive_surface**: Memory Health Dashboard ToolUsageMetricsPanel（聚合 N>20 thread 的 FM 数据）
- **noise_dedup_policy**: progress `tool_call_update` 不触发 sidecar 重渲染（保留现有 streaming UI），只 final 触发 pair

## Dependencies

- **Related**: F188（Phase F 暴露了这个 bug；fix 后 FM-5 在 Gemini-on-ACP 路径下能算）
- **Related**: F149（Gemini ACP Adapter — **当前 ACP path 唯一使用者**，本 fix 直接修这个 path 的 transformer，**不是潜在同病而是同一份代码**——Maine Coon 一审 OQ-2 校正）
- **Related**: F102（Recall sidebar 是 F102 Phase J 产物，本 fix 修它的 pairing 数据源）

## Risk

| 风险 | 缓解 |
|------|------|
| Gemini CLI v0.36 `tool_call(completed+content)` 单事件拆双消息，下游 caller 处理多 message 的 backpressure / 顺序 | `transformAcpEvent` 改为返回数组或 generator；caller 按顺序 yield；测试覆盖"先 tool_use 后 tool_result"消费者 invariant |
| **progress UI 表达**——in_progress 不再 emit `tool_use` 后，现有 streaming progress UI 是否依赖原行为？ | KD-5 定方案：探查现有 UI 用 progress content 哪里 → 选 system_info/进度自定义 type/纯 ignore，wktree 实测决定 |
| `status` 字段命名 ACP 多版本差异（已知 Gemini v0.36 用 `status`） | 测试覆盖 v0.36 真实 fixture；**不留 no-status content fallback**（Maine Coon 二审 P1-2）；其它 ACP 版本若改字段名走 follow-up |
| 同 toolCallId 重复 emit 引起 Recall pending 双入栈 | transformer 维护 per-session `toolCallId → { emittedToolUse, finalEmitted }` Map；同 toolCallId 仅一次 `tool_use` + 仅一次 final `tool_result` |
| ACP 服务端漏发 final / tool 永久 in_progress（hang） | FM denominator 限定 "含 final content (status=completed/failed)" 调用，hang 不影响指标；监控 hang ratio 作为单独 quality signal（非本 fix scope）|

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 走完整 spec + Design Gate 流程，不当 quick hotfix 偷渡 | operator experience「按家规先把 spec 写好 commit push 然后和Maine Coon确定清楚之后再开 wktree」；这个 bug 影响 F188/F102/F149 的 telemetry / observability path，必须 reviewer 把关 | 2026-05-11 |
| KD-2 | scope = Gemini-on-ACP path（当前 ACP 唯一使用者） | Maine Coon 一审 P1-1 校正：repo 里 ACP 只在 `clientId: google` 分支 instantiate `GeminiAcpAdapter`；不是 Claude Code ACP（不存在）。本 fix 直接覆盖 F149 path，不拆 Phase B | 2026-05-11 |
| KD-3 | 单事件拆双消息（先 `tool_use` 后 `tool_result`） | Maine Coon 一审 P1-3：UI / ToolEventLog 都基于 pending+pair 模型；Gemini v0.36 实际 format 把 completed+content 打包到 `tool_call`，transformer 必须在内部拆成两条 stream message 保证 pair 模型成立 | 2026-05-11 |
| KD-4 | `transformAcpEvent` 返回值从 `AgentMessage \| null` 扩展为 `AgentMessage \| AgentMessage[] \| null` | 拆双消息的实现必需；array vs generator 的 caller 改动量评估留到 wktree 时实测（OQ-4） | 2026-05-11 |
| KD-5 | 同 toolCallId `tool_use` 只 emit 一次；progress update（in_progress / 中间 content）**不再** emit `tool_use`；progress 表达方式（system_info / 自定义 / ignore）wktree 时定 | Maine Coon 二审 P1-1：AC-A2 旧版要求 in_progress emit tool_use 跟 Risk 要求"不重复 emit tool_use"冲突；二选一选去重，否则 Recall pending 双入栈 + UI/telemetry 重复事件 | 2026-05-11 |
| KD-6 | final 判定**仅认 `status ∈ {completed, failed}`**；no-status content 不视为 final | Maine Coon 二审 P1-2：OQ-3 已收敛"仅靠 status"，但旧 Risk/Matrix 还留 "no-status content 非空视为 final" 兜底，会把 progress content 提前 pair 成 result。本 hotfix 不引入歧义；其它 ACP 版本若变字段名走 follow-up | 2026-05-11 |

## Review Gate

- 后端类（provider event transformer）— 走 `collaborative-thinking` + @ Maine Coon review spec → wktree → 实现 → 跨猫 review
