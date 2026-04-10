---
feature_ids: [F139, F102, F104, F085]
related_features: [F118, F032, F129]
topics: [schedule, heartbeat, cron, task-runner, autonomy, openclaw-compat]
doc_kind: decision
created: 2026-03-25
decision_id: ADR-022
---

# ADR-022: 统一调度抽象 — 从 setInterval 到值守台

> **Status**: accepted
> **Deciders**: 铲屎官 + Ragdoll(opus) + Maine Coon(gpt52)
> **Date**: 2026-03-25
> **Consult**: GPT Pro (云端审阅), 金渐层(opencode)
> **Research**: *(internal reference removed)*
> **Architecture Diagram**: `designs/F-schedule-abstraction.pen`

## Context

Cat Café 有多个分散的定时/周期性任务需求，但没有统一的调度抽象：

| 现有场景 | 当前实现 | 问题 |
|----------|----------|------|
| 记忆摘要调度（F102） | `setInterval` 每 30 分钟 | 硬编码、重启丢状态、无静默 |
| 健康提醒（F085） | Claude Code `/loop 90m` | 会话级、3 天过期 |
| PR/CI 轮询 | 各自 `setInterval` | 各自为战 |
| 未来：猫猫巡检 | 未实现 | 需要多猫调度 + 静默协议 |
| 未来：精确定时 | 未实现 | "每天 9:00 生成日报" |

当前调度器是一个 `setInterval` 壳（`packages/api/src/infrastructure/scheduler/`）：

```typescript
interface ScheduledTask {
  name: string;
  intervalMs: number;
  enabled: () => boolean;
  execute: () => Promise<void>;
}
```

### 外部调研：OpenClaw（龙虾）Heartbeat

三猫独立调研了 OpenClaw 的 heartbeat + cron 体系（详见 research 文档）。核心发现：

**值得借鉴的模式**：
- `HEARTBEAT_OK` 静默协议 — 无事则闭嘴（协议级，非 prompt hack）
- Cheap Checks First — 确定性 gate 过滤 90%+ 空轮，零 LLM 成本
- HEARTBEAT.md checklist — 声明式任务清单，可版本管理
- activeHours / isolatedSession — 运行策略一等公民

**不借鉴的**：
- 当前 heartbeat 实现有 6+ 个公开 bug（#45772 setTimeout 死掉等）
- 纯 polling 架构（我们需要事件驱动 + 定时兜底）
- Gateway 硬耦合（我们需要可插拔 backend）
- 单 agent 模型（龙虾没有"谁来干"的问题）

### 铲屎官原话

> "有点像定时任务，但定时任务太机械了，我不想要机械的东西。"

> "不建议可配置是编辑到什么 Markdown 文档里……能让人类跟你直接说自然语言，你帮别人去编辑，或者你有个 UI 去把东西呈现出来。"

## Decision

### 1. 六维度 TaskSpec + 五步流水线

Maine Coon提出的正交模型，经 GPT Pro 审阅 + Maine Coon review 后微调（原 5 维度，恢复 Context）：

```
TaskSpec（任务语义）
  ├─ Trigger     何时触发（interval / cron / event / hybrid）
  ├─ Admission   准入判断（activeHours + gate → typed signal）
  ├─ Context     执行上下文（session × materialization，Phase 2）
  ├─ Run         执行策略（overlap / timeout / retry）
  ├─ State       状态持久（cursor + run ledger + registration）
  └─ Outcome     结果契约（whenNoSignal: drop/record + sink）

  + Actor（可选）  谁来干（role + strategy + cost tier）
  + Governance（横切面，Phase 3）  谁能改
```

> **Context（Phase 2）**：GPT Pro 提出的执行上下文维度，拆为两轴：`session`（`new-thread` / `same-thread`，对应龙虾 `isolatedSession`）和 `materialization`（`light` / `full`，gate 前用 light，execute 按需升级）。Phase 1a 默认 `same-thread` + `light`，不暴露此维度。

五步流水线：

```
Wakeup → Lease → Gate → Execute → Outcome
  │        │       │        │         │
  │        │       │        │         └─ 静默/投递/记录
  │        │       │        └─ 本地执行 or MCP dispatch
  │        │       └─ Cheap checks first → typed signal
  │        └─ subjectKey 防并发
  └─ Trigger fire（interval/cron/event）
```

### 2. 关键设计决策

#### D-1: gate 返回 typed signal，不是 boolean

```typescript
// 旧：F102 isEligible() → boolean → execute() 再读一遍数据
gate: () => boolean

// 新：gate 返回结构化 signal，executor 直接使用
gate: (ctx: GateCtx) => Promise<
  | { run: false; reason: string }
  | { run: true; signal: Signal; subjectKey?: string; dedupeKey?: string }
>
```

**Why**：消除二次扫描。F102 的 `isEligible()` 返回 boolean 后 `execute()` 又重新读 `pendingMessageCount`/`signal_flags`。

**硬规则**：`subjectKey` 是所有有状态操作的统一锚点 — lease / cursor / dedupe / dispatch-receipt / run-ledger 共用此主键。gate 返回的 `subjectKey` 直接贯穿下游全链路，不允许下游另起 key。

#### D-2: 调度到 role，不是 model

```typescript
actor: {
  kind: 'role',
  role: 'memory-curator',     // 调度能力，不是具体猫
  strategy: 'singleton',       // singleton / sharded / broadcast
  costTier: 'cheap'            // cheap → Sonnet，deep → Opus
}
```

**Why**：多猫场景下，`opus` 是 runtime binding 不是真相源。resolver 根据 roster/availability/thread affinity/cost hint 选猫。

**注**：`role` 是**能力命名空间**（`memory-curator` / `repo-watcher` / `health-monitor`），不是 roster 身份角色（`architect` / `peer-reviewer`）。resolver 路径：能力角色 → cat-config.json roster 匹配 → 可用性 + 亲和 + 成本 → 选猫。

#### D-3: MCP dispatch = 异步 handoff，不是同步执行

唤醒猫 ≠ 调函数。唤醒猫 = 通过 MCP `post_message` 发消息 → 等异步回执。

```typescript
interface DispatchReceipt {
  assignedCatId: string;
  leaseKey: string;
  invocationId: string;
  dispatchedAt: number;
  completionState: 'pending' | 'completed' | 'timeout' | 'failed';
}
```

**Why**：这是 Cat Café 与龙虾（OpenClaw）最根本的架构差异。龙虾是单 agent 同步 turn；我们是多猫独立进程通过 MCP 通信。

#### D-4: 电闸 vs 备忘录分离

| 层 | 内容 | 谁能改 | 格式 |
|----|------|--------|------|
| **电闸**（TaskSpec） | trigger、run policy、actor、outcome | 仅铲屎官审批 | TypeScript / YAML |
| **备忘录**（Checklist） | "醒来检查什么" | 猫可以改 | 自然语言 |

**Why**：龙虾的 HEARTBEAT.md 把电闸和备忘录混在一起，agent 可以把自己的触发频率改成每 5 分钟。我们分离两层：猫可以改"检查什么"，不能改"多久检查一次"。

#### D-5: run ledger 从第一天就有

```
SKIP_NO_SIGNAL | SKIP_OVERLAP | SKIP_GATE_CLOSED |
RUN_DISPATCHED | RUN_COMPLETED | RUN_TIMEOUT | RUN_FAILED
```

所有运行记录写入 SQLite run ledger。`silent-if-ok` 对用户静默，不能对系统失忆。

**Why**：GPT Pro 原话 — "沉默机制不能变成沉默故障"。

#### D-6: 用户配置 = UI + 自然语言，不是编辑 markdown

**铲屎官明确否决了"编辑 markdown 文件"的配置方式。** 用户交互三层：

| 方式 | 面向谁 | 例子 |
|------|--------|------|
| **自然语言** | 所有用户 | "帮我设一个每天 9 点的日报巡检" → 猫生成 checklist + 提议 spec |
| **Hub UI 面板** | 所有用户 | "定时任务"面板：查看活跃任务、运行历史、暂停/恢复、编辑 checklist |
| **TaskSpec 代码** | 开发者 | TypeScript/YAML 注册新的 task（内部开发或社区插件） |

用户**永远不需要直接编辑 markdown**。checklist 的 backing store 可以是 markdown 或 DB，但用户通过自然语言告诉猫或通过 Hub UI 操作。

### 3. 与龙虾（OpenClaw）生态的兼容性

#### 兼容层

| 龙虾概念 | Cat Café 对应 | 兼容程度 |
|---------|--------------|---------|
| `HEARTBEAT.md` | checklist（备忘录层） | **格式互认** — 自然语言 checklist 可直接导入 |
| `HEARTBEAT_OK` | `outcome.whenNoSignal: 'drop'` | **语义一致** — 我们建模为 spec 字段 |
| `every: "30m"` | `trigger: { type: 'interval', ms }` | **直接映射** |
| `activeHours` | `admission.activeHours` | **直接映射** |
| `isolatedSession` | `context.session: 'new-thread'` | **语义对等** — 我们拆两轴 |
| `cron jobs` | `trigger: { type: 'cron' }` | **Phase 2 支持** |

#### 差异层（我们多出来的）

| 维度 | 龙虾没有 | Cat Café 有 | 根因 |
|------|---------|-------------|------|
| Actor/Placement | 单 agent | role + resolver + lease + MCP dispatch | 多猫 |
| typed signal gate | 字符串 OK/alert | 结构化 signal | 消除二次扫描 |
| 电闸/备忘录分离 | 无 | task.spec vs checklist | 安全边界 |
| dispatch receipt | 同步 turn | 异步 handoff 追踪 | MCP 架构 |
| 成本感知 | 无 | costTier hint | 多模型差异 |
| run ledger | 无 | SQLite 全记录 | 可观测性 |
| UI 配置 | 编辑 md 文件 | Hub 面板 + 自然语言 | 用户体验 |

#### 接入方式

**龙虾用户迁移**：导入 HEARTBEAT.md → 自动解析为 checklist + 推荐 TaskSpec 模板 → 用户通过 UI 确认。

**开发者扩展**：

```typescript
// 方式 1：代码注册（内部开发者/猫猫）
const myTask: TaskSpec = { id, profile, trigger, admission, run, state, outcome };
taskRunner.register(myTask);

// 方式 2：声明式目录（社区 / Pack 生态）
// 映射到 F129 Pack System 的 task slot
my-pack/
  tasks/
    daily-report/
      task.spec.yaml      # 电闸
      checklist.md         # 备忘录
      gate.ts              # 可选：自定义 gate
```

### 4. Task Profile 预设（防组合爆炸）

| Profile | trigger | admission | run | state | outcome | actor |
|---------|---------|-----------|-----|-------|---------|-------|
| **awareness** | interval 30m+ | gate + activeHours | overlap:skip, retry:0 | cursor:memory, ledger:sqlite | noSignal:drop | role:巡检猫 |
| **poller** | interval 1-30m | gate only | overlap:skip, retry:1 | cursor:sqlite, ledger:sqlite | noSignal:record | local |
| **precise** | cron | activeHours | overlap:configurable, retry:configurable | registration:persistent, cursor:sqlite, catchup:configurable | always:emit | role:configurable |

开发者选 profile 后只需覆盖需要改的字段，其余用默认值。

### 5. 约束规则（非正交维度的硬约束）

| 规则 | 理由 |
|------|------|
| gate 必须先于 heavy context 加载 | 先装 session 再做 cheap check = 省的钱被猫一爪拍飞 |
| `profile: precise` 不允许 `registration: ephemeral` | 对外承诺精确时间但绑在进程 timer 上 = 玻璃腿 |
| retry + overlap 打开时必须有 idempotency/dedupe | 参考 Temporal/Trigger.dev |
| `silent-if-ok` 必须写 run ledger | 对用户静默 ≠ 对系统失忆 |
| `broadcast` 只适合只读任务 | 有 side effect 的必须 singleton/sharded |
| awareness 任务默认加 jitter | 避免整点全猫齐醒 |
| 猫改 checklist（备忘录），不改 spec（电闸） | 安全边界 |
| `subjectKey` 贯穿 lease/cursor/dedupe/dispatch/ledger | 统一锚点，防主键分裂 |

### 6. anti-feedback-loop

事件 + 定时同时存在时，防止回音室：

- 每条 task-triggered 消息携带 `originTaskId`
- MCP `post_message` 的 metadata 承载
- gate 检查 suppressionTTL：自己上一轮 outcome 间接触发的 → skip

## Phase Path

### Phase 1a — 统一内部 poller（最小可用）

保留 `setInterval`，加管道语义。覆盖 F102 摘要、PR/CI 轮询、MediaCleanup。

```typescript
interface TaskSpec_P1<Signal = unknown> {
  id: string;
  profile: 'awareness' | 'poller';
  trigger: { type: 'interval'; ms: number };
  admission: {
    activeHours?: { start: string; end: string; timezone: string };
    gate: (ctx: GateCtx) => Promise<
      | { run: false; reason: string }
      | { run: true; signal: Signal; subjectKey?: string; dedupeKey?: string }
    >;
  };
  run: { overlap: 'skip'; timeoutMs: number };
  state: { cursorStore: 'memory' | 'sqlite'; runLedger: 'sqlite' };
  outcome: { whenNoSignal: 'drop' | 'record'; onSignal: 'log-only' | 'post-message' };
}
```

交付物：5 步流水线 + SQLite run ledger + F102 gate 升级为 typed signal。

### Phase 1b — Actor + "唤醒猫"

加 actor 维度 + dispatch receipt + MCP 异步追踪。

### Phase 2 — Cron + 持久化 + UI

- `trigger` 扩展 cron
- `state.registration: 'persistent'`
- Hub "定时任务" 面板（查看/暂停/历史）
- 自然语言配置（"帮我加一个每天 9 点的巡检"）
- 如规模需要，引入 BullMQ 或 Inngest

### Phase 3 — 制度级自主 + Governance

- pause/resume/list/history API
- agent 自编辑 checklist（非 spec）+ human approval
- Pack 生态 task slot（映射 F129）
- GitHub Actions 制度级 lane
- budget/quota/frequency floor

## 业界参考

| 需求 | 参考 | 抄什么 |
|------|------|--------|
| Run policy 语义 | Temporal | overlap/catchup/backfill |
| event-first + timer fallback TS 语法 | Inngest | 多 trigger + concurrency |
| AI 背景任务 + queue lane | Trigger.dev | idempotency + waitpoint |
| Agent context/session | LangSmith | thread-specific cron + stateless cron |
| 多 Agent actor | AutoGen | runtime + topic/subscription |
| 自托管持久化 | BullMQ | Job Scheduler + dedup |

## Consequences

**Positive**：
- F102/PR poller/MediaCleanup 统一进同一个调度壳
- 静默协议 + run ledger 让系统可观测但不吵
- 多猫调度有了正式模型（role + lease + dispatch receipt）
- 用户通过 UI/自然语言配置，不需要编辑文件

**Negative**：
- Phase 1 需要重构 TaskRunner（~2 周工作量估计）
- F102 SummaryCompactionTask 需要适配新 gate 接口
- 需要设计 Hub "定时任务"面板（Phase 2）

**Risks**：
- 过度设计风险 — 靠 profile 预设 + 分 Phase 渐进控制
- 和 F129 Pack System 的 task slot 集成需要协调

---

*起草：Ragdoll/Opus-46 | 审阅：Maine Coon/GPT-5.4 | 外部咨询：GPT Pro | 2026-03-25*
*rev-1：采纳Maine Coon review — 恢复 Context 维度 + subjectKey 统一锚点 + actor.role 能力命名空间*
