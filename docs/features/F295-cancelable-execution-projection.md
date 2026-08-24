---
feature_ids: [F295]
related_features: [F167, F173, F194, F277, F280, F299]
topics: [execution, liveness, cancel, managed-command, hydration, workspace, frontend, authorization]
doc_kind: spec
created: 2026-08-13
updated: 2026-08-22
description: "以具体 execution 为单位统一运行展示、thread 归属、可取消性与精确 Stop，让跨 thread 模型回合和托管命令共享一个可重建读投影。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-13T01:30:00Z
---

# F295: Cancelable Execution Projection — 运行态与精确 Stop 单一投影

> **Status**: done | **Completed**: 2026-08-13 | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

## Why

operator在看到 Kimi 仍在运行时却没有 Cancel，原话是：“kimi在运行但是没有检测到他在运行？所以没有cancel的按钮？”随后明确选择“开 F128 统一收口（推荐）”。用户不该知道模型 invocation、跨 thread 投影和 `wakeWhen` 托管命令分别藏在哪套状态里；只要界面说一件工作仍在进行，同处就必须诚实说明它属于哪个 thread、是什么工作、能否停止，以及精确停止哪一个 execution。

## Current State / 现状基线

- 现场样本：Kimi current-thread invocation `4d6b6ee9-b976-40ac-8e72-a42d07928182` 已在浏览器进入 thread 前结束；full-sync invocation `3f9dc6ba-dc48-49c4-bad2-55eb575edf82` 结束后，managed task `hold-ball-1786666521353-7rnnf7` 仍在执行。
- `ThreadExecutionBar` 从当前 thread 的 `activeInvocations` 派生，并调用 `/api/threads/:threadId/cancel/:catId`；projection identity 与 cancel target 没有同一类型约束。
- `WorkspaceNowSurface` 只收到当前 ChatContainer 的 invocation map，能说“正在发生”，但没有 thread、execution kind 或 cancel target。
- `ConnectorBubble` 通过 hold task status/DELETE 单独维护 command cancel affordance；模型回合与 managed command 因而是两套展示/取消口径。
- F173/F194 已分别收口前端 thread runtime 和后端 invocation liveness；PR #3582 只修复 terminal → idle 的反向投影。本项承接剩余的 active → exact-cancelability 缺口，不 reopen 已完成 Feature。
- 2026-08-13 preflight：相关关键词无 open PR；main 与 `origin/main` 双向同步。

## What

Architecture cell: dispatch
Map delta: update required
Why: F295 adds the canonical live/managed-command execution read-and-cancel projection to dispatch; ball-custody and bubble-pipeline remain lifecycle/render consumers.

### Phase A: Canonical cancelable execution read projection ✅

- 在 shared contract 定义 execution-scoped projection：`executionId + threadId + threadTitle + catId + kind + startedAt + cancelability + cancelTarget?`。
- 服务端组合既有 InvocationRecord/Tracker 与 managed-command DynamicTask/runner truth；不新增 durable lifecycle ledger。
- live invocation cancel target 必须同时 fence `threadId + catId + executionId`；managed command 继续按 taskId，但杀进程也必须核对同一 taskId。
- canonical read 支持 current-thread 与 project/workspace scope，供 F5、导航与 reconnect 冷启动恢复。

### Phase B: Existing surfaces consume one projection ✅

- `ThreadExecutionBar`、`ThinkingIndicator`、Workspace“正在发生”和 hold bubble 读取同一 projection/store。
- current thread 保持原入口；Workspace 展示 project 内跨 thread execution；不增加 L1 导航入口。
- loading / error 不伪装 idle；不可取消 execution 显示明确原因；terminal identity 精确退休，unread 保持独立。
- 完成四条确定性 journey 回归、Web/API gate 与真实浏览器验收。

### Post-close: Canonical thread admission ✅

- active-execution GET 与 exact live cancel 共用 canonical thread visibility basis：owner、shared
  default、当前用户 durable index、当前用户 external-runtime anchor。
- 未索引或 foreign thread 在读取 liveness 前返回 typed 403；`system-created` 本身不是授权。
- 合法 shared/indexed thread 继续显示 foreign scheduler/system masked occupancy；session record 的
  per-user filter 不适用于 occupancy，精确取消仍由 execution/principal fence 决定。

## User Journey

### Primary Journey: 从“猫在运行”到精确停止
- **Scope unit**: execution
- **Actor**: operator
- **Entry**: 当前 thread 执行条、单猫 ThinkingIndicator、Workspace“正在发生”或 hold bubble
- **Flow**:
  1. 用户看到 Kimi 正在工作，同时看到 thread 标题与“模型回合 / 托管命令”。
  2. 可取消时，用户点击同处 Stop；系统只取消投影中那个 exact target。
  3. 不可取消时，同处显示原因；用户不会面对无解释的按钮消失。
  4. 导航、F5 或 socket reconnect 后，页面从 server projection 恢复同一判断。
  5. execution 终态后，运行提示与 Stop 一起退休；unread 不受影响。
- **Success evidence**: focused tests + 浏览器 DOM/截图，覆盖 live Cancel、command Cancel、F5/reconnect 与同猫跨 thread。
- **Non-goals**: stale Queue/A2A replay；F254/F280 既有生命周期；catId 全局 kill；第二套 durable lifecycle ledger；Redis 6399。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | managed command | operator | 模型回合结束 → command 仍显示 → 按 taskId 停止 → command 终态退休 | API + component test + screenshot |
| S2 | execution | operator | 同一 cat 在两个 thread 同时执行 → 停一个 → 另一个保持 running | API regression + browser DOM |
| S3 | workspace | operator | 本地漏掉 background start → F5/reconnect → canonical hydration 发现并展示 | hydration test + screenshot |

## Acceptance Criteria

### Phase A（contract + server projection）
- [x] AC-A1: 凡 UI 显示 active/running，均消费同一结构的 `executionId + threadId + kind + cancelability + cancelTarget?`；展示与取消不再各读一套真相。
- [x] AC-A2: live invocation Stop 以 exact `threadId + catId + executionId` 为 fence；旧 target 不得取消 replacement，同猫其他 thread 不受影响。
- [x] AC-A3: `wakeWhen` managed command 在模型 invocation 完成后仍投影为运行中，并以 exact taskId 取消；旧 task 不得杀新 runner；普通用户消息只能退役冗余 wake carrier，不能 SIGTERM、隐藏或剥夺该 command 的精确 Stop。
- [x] AC-A4: 不可取消 execution 返回稳定 reason，UI 同处解释，不静默吞按钮。
- [x] AC-A5: project/workspace scope 能发现客户端完全漏掉 start 的 background execution，不依赖本地先有 active 状态。
- [x] AC-A6: terminal identity 精确收敛；旧 terminal 不清新 execution，完成后不残留 Stop。

### Phase B（surface + journey verification）
- [x] AC-B1: ThreadExecutionBar、ThinkingIndicator、Workspace Now 与 hold bubble 的 kind/thread/cancel 文案和行为由同一 projection 驱动。
- [x] AC-B2: unread 与 liveness/cancelability 正交；execution hydrate/terminal 不改 unread。
- [x] AC-B3: RED→GREEN 覆盖 managed command、background cold discovery、same-cat multi-thread、terminal cleanup 四条 journey。
- [x] AC-B4: Web build/typecheck、API contract tests 与风险相称 gate 全绿。
- [x] AC-B5: 真实浏览器验收逐项覆盖 live Cancel、command Cancel、F5/reconnect、跨 thread 精确性，并留 DOM/截图证据。
- [x] AC-B6: 非作者 Kimi 对 exact HEAD review，P1/P2=0 后才进入 merge-gate。

### Post-close（thread admission）

- [x] AC-C1: execution read/cancel 只接受 canonical thread visibility basis；未索引 system thread 不能因已知 ID 获得入口授权。
- [x] AC-C2: thread 拒绝发生在 project scan、liveness resolution 与 exact termination 之前，并返回 typed 403。
- [x] AC-C3: indexed/default/anchor/owner 的合法访问不削弱 masked occupancy 与 exact-control fence。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “kimi在运行…所以没有cancel的按钮？” | AC-A1, AC-A4, AC-B1 | component/API tests + screenshot | [x] |
| R2 | “开 F128 统一收口” | AC-A1, AC-A5, AC-B3 | projection schema + cold hydration test | [x] |
| R3 | live invocation 精确停止，不误杀同猫其他工作 | AC-A2, AC-A6 | API race regression | [x] |
| R4 | managed command 仍在跑时继续可见可停 | AC-A3, AC-B5 | runner regression + browser journey | [x] |
| R5 | F5/reconnect 与 unread 独立 | AC-A5, AC-B2 | hydration/unread regression | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表

## Tips Contribution（F244）

- 新增或更新 1 条“运行中的工作可按 execution 精确停止”的 tip，sourceRef 指向本 spec/对应 UI anchor；不把架构术语暴露给用户。

## Dependencies

- **Evolved from**: F194（后端 invocation liveness canonical read model；本项扩到 cancelability 与 managed command）
- **Blocked by**: none
- **Related**: F167（hold/managed command）、F173（thread runtime）、F277（attention/navigation）、F280（wait cancel lifecycle）

## Risk

| 风险 | 缓解 |
|------|------|
| stale UI Stop 取消 replacement | cancel route exact execution fence + 409 regression |
| project-wide hydration 成为昂贵扫描 | 当前按已有 user/project threads 线性组合 running record/task projection；不新建轮询账本，接受本地单用户规模下的 4s 轮询成本，并以实际 poll 耗时判断是否需要收紧 |
| managed task 与 runner 身份漂移 | taskId 同时参与 display、cancel 和 runner match |
| terminal 事件清掉新 execution | reducer/store 以 executionId 做单调替换与 terminal match |
| 新 UI 加剧密度 | 原入口、两层文案、窄宽度折叠 thread 标题但保留可访问详情 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | execution 是唯一 scope unit，catId 只是属性 | 避免跨 thread/新旧回合误杀 | 2026-08-13 |
| KD-2 | read projection 组合现有 owner truth，不拥有生命周期 | 解决展示/取消分裂而不造第二账本 | 2026-08-13 |
| KD-3 | 确定行为契约用 schema/tests/guards；只补必要 conflict log，不挂 Eval Hub | 问题是正确性，不是不确定效用 | 2026-08-13 |
| KD-4 | liveness 复用 canonical thread admission basis，但不复用 session record filter | thread 可见性是一致边界；occupancy 与 record 内容有不同授权语义 | 2026-08-22 |

## Review Gate

- 实现作者：Sol；exact HEAD reviewer：Kimi；行为/API 契约跨包，走 PR + full gate。
- 浏览器证据覆盖原始用户旅程；review P1/P2=0 后进入 merge-gate。
