---
feature_ids: [F304]
related_features: [F139, F153, F233, F297, F299]
topics: [runtime-reliability, local-http, request-liveness, sidebar, scheduler]
doc_kind: spec
created: 2026-08-21
description: "让 localhost 重负载下的前台创建操作仍能及时进入 API，并以一个原子事故 PR 和一个独立债务 PR 完成可重启治理。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-23T01:30:00-07:00
cvo_signoff: "2026-08-21 — sourceMessageId 0001787369199918-000107-fe2d35ef：一个 Feature 统一管理；事故只用一个 PR，内部拆 commits，债务另行清理，禁止把 main 留在依赖下一 PR 的中间态。"
tips_exempt: "既有 Thread 创建旅程的可靠性修复与错误诚实化；不新增需要用户发现或学习的操作入口。"
---

# F304: Local Interaction Request Liveness — 后台重负载下前台创建不饿死

> **Status**: done | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1 | **Completed**: 2026-08-23

Architecture cell: `thread-navigation`, `dispatch`, `github-signals`

Map delta: `none`

Why: 本 Feature 只在既有 Sidebar 权威刷新、active-execution 投影、F139 scheduler 与 F153 运行健康边界内修复一次端到端事故；不新增请求队列、优先级通道、scheduler taxonomy 或第二套可观测性控制面。

## Why

operator点击创建 Thread 时，即使浏览器与 API 都在同一台机器，前台写请求也可能被后台读请求和长任务挤在 localhost HTTP 请求队列里，30 秒内从未进入 API 就被前端取消。结果是一个最基本的用户动作失败，却被笼统文案误称为“网络请求没有完成”。

本 Feature 的价值目标只有一句：**后台工作再重，也不能让operator的前台创建动作饿死；事故修复必须作为一个完整部署单元进入 main，重启不能落在半治理状态。**

operator experience：

> “本地写请求被后台读请求/轮询挤压，30 秒内未发出，前端超时取消；错误文案误称为网络失败。”
>
> “事故一个 PR……然后清理债务……新建一个 feat 统一管理。”

## Current State / 现状基线

- 事故时 `OPTIONS /api/threads` 已到 `localhost:3004` 且 0.1ms 返回 204；真正的 `POST /api/threads` 从未进入 API，因此没有半截 Thread，也不是后端 500。
- 前端 `apiFetch` 有统一 30 秒 timeout；同一窗口内存在 5–18 秒、64–80 秒的读取，6 个 refresh-token 请求，以及一次 120 秒 scheduler 执行。
- 页面导航会触发约 15 个并发 GET；周期源包括 4 秒 active execution、5 秒 active pane / vote、15 秒 health/ready 等。服务端延迟超过轮询周期时，在途读取会累积并占用浏览器连接。
- F233 collector 是最大周期脉冲之一：每 15 分钟遍历约 3574 个分支，并为每条分支执行一次 `gh pr list`，稳定撞 120 秒 timeout。F233 已 failed-close，F299 owner 已授权退役 cron、冻结历史 projection、保留 `/story/feat:*` 兼容读取。
- 全天 920 个分钟桶中，collector 运行时 median request p95 为 802ms，未运行时仍为 523ms；没有重后台任务的 12 个分钟为 66ms。70 个慢分钟中 51 个没有 collector，说明退役 collector 必要但不足以单独关闭事故。

## Deployment Contract / 可重启交付边界

| main 所处状态 | 可见行为 | 是否依赖下一 PR |
|---|---|---|
| Phase A 合入前 | F139 持久化 override 禁用 F233 collector；现有代码不变 | 否 |
| Phase A 合入后 | collector 永久退役；浏览器读请求收敛；创建超时诚实对账；已切掉实测最大延迟贡献项 | 否，事故已闭环 |
| Phase B 合入后 | scheduler `timeoutMs` 能真实取消底层 I/O / 子进程 | 否，邻接债已清 |

Phase A 的代码只能通过**一个 PR / 一个 squash merge**进入 main。PR 内按模块拆 commits，每个 commit 保持构建与既有行为可验证；不得把“先合退役、下个 PR 再补前端或性能”作为交付路径。

## What

### Phase A: 原子事故闭环（一个 PR）

Phase A 在同一 PR 内完成四个相互依赖的修复面：

1. 永久退役 F233 feat-trajectory collector 的 cron 与启动 wiring；历史 store、route、Phase B custody 账本和 `/story/feat:*` 兼容读取保留。
2. 把 Sidebar 已有的 `refreshInFlight / dirtyWhileFlight` 语义上移到 `apiFetch` 的 exact-GET 协调点：同 key 一次物理读取、每个调用方独立 abort、`Response.clone()` 分发，因果 invalidation 在当前 generation 后恰好补一次读取；等价测试通过后删除 Sidebar 私有副本。
3. Thread 创建遇到 `TimeoutError` 时刷新 canonical Sidebar snapshot，显示“请求超时，正在核对结果”，且绝不自动重发 POST。
4. 用 F153 证据在合入前选出剩余延迟贡献最大的一个端点或后台任务，并在同一 PR 内切掉它；候选顺序是 `/api/threads` 逐 Thread migration、`executions/active`、`/invocations` transcript 读取及持续超时的 GitHub scheduler task，最终目标服从实测而不是候选顺序。

建议的绿色 commit 边界：

1. `fix(F304): retire the failed F233 collector`（含 schedule / compatibility 回归）
2. `fix(F304): converge exact-GET refresh generations`（含状态机红绿测试并删除私有副本）
3. `fix(F304): reconcile timed-out thread creation`（含不重试与权威刷新测试）
4. `perf(F304): remove the measured latency leader`（含 F153 前后证据与端到端回归）

### Phase B: 邻接债务清理（一个独立 PR）

把 scheduler 已有 `timeoutMs` 语义落实到底层执行：

- `ExecuteContext` 携带 `AbortSignal`，fetch、git/gh 子进程和循环响应取消；
- timeout 后不得继续产生 GitHub / Redis / 网络 I/O；
- 取消点只放在新的外部工作之前；一旦持久化“已投递 / 已 append / 已提交”事实，必须先完成与该事实绑定的 wake、projection 或派生更新，再落 timeout terminal；
- 保留现有 overlap lock，不再发明第二套“超时锁”概念；
- restart 测试证明没有遗留 zombie execution，下一 tick 只在真实执行结束或取消完成后获得运行权。

取舍：execute pipeline 按 work item 串行等待取消清理。若某个 item 不响应 `AbortSignal`，本 tick 会停在该 item，后续 work item 不启动、也不会提前写 ledger；task-level overlap lock 同时保持。这样牺牲本轮剩余吞吐，换取“不在真实 I/O 尚未结束时伪造 terminal 或叠加下一 tick”的单一真相。

CI 的 tick 级批量读取为避免被任一 work item 的取消放大成整批失败，运行在既有 `admission.gate`；该 gate 当前没有共享 `AbortSignal` 或 gate-level timeout。每个 `gh` 子进程仍有 15 秒硬超时，但 gate 整体过长时只能由下一 tick 的 `SKIP_OVERLAP` 间接观测，且返回 work items 前没有逐项 ledger。本 PR 不重定义 admission timeout 语义，AC-B1 约束的是 admission 之后的 execute 工作。

Phase B 是独立增强，不是 Phase A 的运行前提。Phase A 合入后，即使 Phase B 尚未开始，main 也必须已经满足本次创建事故的全部验收条件。

## User Journey

### Primary Journey: 重后台负载下创建 Thread

- **Scope unit**: thread
- **Actor**: operator
- **Entry**: Sidebar 的“创建 Thread”入口
- **Flow**:
  1. operator在后台轮询与 scheduler 工作同时存在时提交创建。
  2. 浏览器不再因重复 GET generation 把写请求长期挡在 localhost 队列；POST 及时进入 API。
  3. 正常响应时新 Thread 出现在 canonical Sidebar snapshot；若响应在客户端超时，Sidebar 先核对服务端真相，再诚实显示“已创建”或“结果仍未确认”，绝不盲重试。
  4. 重启 Clowder AI 后，系统仍处于上表定义的完整状态之一，不需要等待另一个 PR 才恢复正确行为。
- **Success evidence**: Alpha 浏览器 Network 时间线 + API ingress 日志 + F153 前后延迟证据 + restart rehearsal
- **Non-goals**: 不增加 30 秒 timeout；不创建写请求专用队列或优先级通道；不把浏览器连接数常量写成契约；不将 raw latency 挂入 Eval Hub。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “新建一个 feat 统一管理” | AC-A1 | Feature truth check + BACKLOG / links | [x] |
| R2 | “事故一个 PR，内部拆 commit” | AC-A2、AC-A3、AC-A4、AC-A5 | PR commit map + exact-HEAD review + merge receipt | [x] |
| R3 | “我重启了，状态不能卡中间” | AC-A1、AC-A5、AC-B2 | persistent override + restart rehearsal | [x] |
| R4 | “然后清理债务” | AC-B1、AC-B2 | scheduler cancellation contract tests | [x] |
| R5 | 不制造冲突规则和概念 | AC-A2、AC-B1 | source census + deleted duplicate implementation + architecture review | [x] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已有需求→Network / API 日志证据映射

## Acceptance Criteria

<!-- 每条 AC 都 trace 回 Why：前台创建不饿死、错误诚实、重启无中间态、概念只收敛不扩散。 -->

### Phase A（原子事故闭环）

- [x] AC-A1: 合入前 F139 override 在一次完整 runtime restart 后仍禁用 F233 collector；合入后 scheduler 注册中不存在该 task，F233 Phase B custody 与 `/story/feat:*` 兼容 fixture 仍通过。
- [x] AC-A2: exact GET key 同时最多一个物理 generation；普通 caller 共享 clone，单 caller abort 不杀共享读取，in-flight invalidation 恰好触发一个有限 trailing generation；不同 method/query/auth-sensitive headers 不误合并。
- [x] AC-A3: Thread 创建 `TimeoutError` 不自动重发 POST；客户端刷新 canonical Sidebar snapshot，并区分“已创建”“结果未确认”，不再笼统宣称外网失败。
- [x] AC-A4: F153 前置测量指名剩余最大延迟贡献项；同一 PR 给出修复前后对照。在确定性事故 fixture 中 POST ingress 不超过 2 秒；live runtime 修正 production wiring 后，36 个原始并发 GET、POST 发出时 28 个读取仍在途的压力下，POST 以 2.85 秒返回 201，未接近 30 秒客户端 timeout。稳态 `cicd-check` 从修前 99–117 秒降至 median 14.7 秒，per-item 从 2006ms 降至约 5ms。
- [x] AC-A5: Phase A 的四个修复面由一个 exact-HEAD review、一个 PR 和一次 squash merge 原子进入 main；两次 live restart rehearsal 均进入完整可运行状态。第二次 rehearsal 发现 Phase A 的 batch reader 在 production composition root 被 legacy single-reader seam 遮蔽，PR #3887 删除错误注入后完成 live 复验；这不是 Phase A 正确性依赖的兼容窗口，而是已完整 main 中一段未生效优化的 production wiring 缺口。

### Phase B（邻接债务清理）

- [x] AC-B1: scheduler timeout 会 abort 底层 fetch、git/gh 子进程与循环；contract test 证明 timeout terminal 后不再产生外部 I/O，同时沿用既有 overlap lock。
- [x] AC-B2: scheduler restart rehearsal 不恢复已取消执行、不产生 zombie runner，也不在旧执行仍活着时叠加下一 tick。

## Mechanism Selection（ADR-031）

| Claim | 选中机制 | 验证 / consumer |
|---|---|---|
| exact-GET generation、TimeoutError 对账、scheduler cancellation 是确定契约 | test / structural guard | targeted unit、route、browser 与 restart tests；merge gate 消费 |
| 后台负载、端点耗时与 API ingress 是运行健康 | logs / metrics / traces | F153 负责归因与前后对照 |
| 本 Feature 是否完成 | Alpha 用户旅程 + exact-HEAD review | 非作者 reviewer 与愿景守护消费 |

不创建 Eval domain：这里没有“效用不确定 + keep/tune/sunset”问题。

## In-context Observability

```yaml
in_context_observability:
  primary_surface: "ThreadSidebar 创建动作自身的 pending / 核对中 / 已创建 / 未确认状态"
  why_not_dashboard_only: "用户正在创建 Thread 时就需要知道结果是否确认；事后统计不能指导是否安全重试。"
  deep_dive_surface: "F153 logs / metrics / browser Network 证据，仅用于事故归因与验收"
  noise_dedup_policy: "不新增主动告警消息；同一次创建只呈现一个动作内状态，轮询健康数据留在 F153 聚合"
```

## Dependencies

- **Evolved from**: F233（failed-close Phase C collector 退役决定）与 F297（Sidebar 权威刷新 / dirty-while-flight 契约）
- **Blocked by**: none
- **Related**: F139（持久 schedule override）、F153（运行健康证据）、F299（legacy TrajectoryPanel / story compatibility owner）

## Risk

| 风险 | 缓解 |
|------|------|
| generic GET 合并吞掉 mutation 后 freshness | generation + causal invalidation 红测；不把普通 refresh 与 invalidation 混成无状态 Promise cache |
| 一个事故 PR 过大而难审 | 内部按四个绿色 commits 拆分；每个 commit 有独立 contract test，PR exact HEAD 再走一次非作者 review |
| Phase A 为等 Phase B 留下隐式依赖 | AC-A5 restart rehearsal；Phase B 不得提供 Phase A 正确性所需的任何代码 |
| 只退役 F233 后误判事故完成 | AC-A4 强制在同一 PR 切掉测得的最大剩余 L 来源并重放事故 fixture |
| 把本次事故扩成通用流量控制框架 | Map delta none；禁止新增 request queue / priority channel / scheduler taxonomy |
| 不响应取消的 item 阻塞本 tick 后续 work item | 明确串行清理取舍并保持 overlap lock；contract test 守住 terminal 必须晚于真实执行结束，运行健康由既有 scheduler 日志观测 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 建 F304 家内 Feature，不建开源社区 issue | 事故发生在家内 runtime、F139 scheduler 与本地 Sidebar 组合；外部 issue 会形成第二真相源 | 2026-08-21 |
| KD-2 | Phase A 只有一个事故 PR，内部拆四个绿色 commits | main 只接收完整闭环，重启不落入跨 PR 中间态 | 2026-08-21 |
| KD-3 | Phase B 只有一个独立 scheduler 债务 PR | 债务不阻塞事故闭环，也不反向成为 Phase A 依赖 | 2026-08-21 |
| KD-4 | ThreadStore create 原子化不进入 F304 | 本次 POST 从未进入 API；把无因果关系的契约迁移塞入本 Feature 会重新扩大补锅面 | 2026-08-21 |

## Review Gate

- Phase A：一个非作者 reviewer 审 exact HEAD，重点验证四个 commits 在同一 PR 内形成完整 restart-safe 终态；不对每个 commit 重复召 reviewer。
- Phase B：按 scheduler cancellation 的行为与运行风险选择一个非作者 reviewer；不复入 Phase A 已关闭的浏览器请求讨论。
