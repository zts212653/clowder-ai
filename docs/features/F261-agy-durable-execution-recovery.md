---
feature_ids: [F261]
related_features: [F210, F201, F211, F048, F167, F118, F061, F194]
topics: [agy, durable-job, long-running-command, restart-recovery, action-plane, observability]
doc_kind: spec
created: 2026-07-10
description: "为 AGY 长任务建立独立于 invocation 与 hold_ball 的持久 job 生命周期、重启恢复、安全治理和现场可见性。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-10T15:10:30Z
---

# F261: AGY Durable Execution & Recovery — 长任务不随回合或重启消失

> **Status**: spec | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **operator 立项 signoff**: 2026-07-10 “我同意，那你立项一下？不过你最好看看现在 F261 有没有被用了！”
>
> **编号核验**: 立项前已查当前文档、Git 历史、远端分支/标签、GitHub PR/Issue、记忆图和近期 thread；未发现真实 F261 占用。唯一 `git log -S F261` 命中来自二进制素材内容，thread 命中来自 SHA 子串，均为假阳性。
>
> **执行顺序铁律**: 立项 → 跨猫 spec review → **Phase A 零代码尸检/能力探针** → Design Gate → 实现。Phase B-E 是 candidate design，Phase A 证据可推翻其细节。

Architecture cell: action-plane

Map delta: update required

Map delta why: F261 计划新增可持久、可恢复、可鉴权的 Managed Job 作为 Action Plane canonical anchor；AGY/MCP 只是消费与暴露层，不能反向拥有执行生命周期。

## Why

斑斑遇到的不是单纯“模型加载慢”：12B 模型加载需 5–10 分钟，嵌套 `run_command` 约两分钟后转入后台，但后台任务仍寄生在当次 AGY service / invocation；下一次调用或服务重启会杀死它。于是猫既拿不到可靠 job handle，也无法回答“还在跑、已失败、被重启杀死、还是其实完成了”，只能在超时、重试和第三方依赖报错之间来回猜。

operator 把价值目标说得很准：**先救斑斑，再帮斑斑完成某一次任务。** 家里要提供的是长任务的稳定承载面：对话可以继续、球权可以变化、runtime 可以重启，但已授权的工作必须有独立身份、持久状态、完整日志、显式取消和可验证终态。任务真正失败时，也必须把原始失败交还给猫，而不是用“服务重启了”抹掉病因。

## Current State / 现状基线

### 事故实证（2026-07-09）

- 12B 权重从 4-bit 反量化到 bf16，纯本地 I/O + 内存操作预计 5–10 分钟。
- AGY 嵌套 `run_command` 约两分钟后转后台；随后新 invocation / AGY service restart 报告：`All your subagents and background tasks have been stopped due to server restart`。
- 下载/加载进度曾停在 `Loading weights: 0/11`；任务本身还先后暴露 `socksio` 缺失依赖、Transformers 5.13 API drift、HF gated model token、SOCKS 慢下载、MLX/PyTorch 不兼容与 segfault。
- 上述“任务真实错误”和“承载进程被重启杀死”混在同一叙事里，无法做可靠归因。

### 代码基线

- F210 已补齐 AGY agent-key 的协作/调度能力，但没有可启动、查询、续接的 Managed Job action；readonly `shell_exec` 也不是任意命令执行面。
- `hold_ball(wakeWhen)` 管的是**猫的球权/唤醒**，不是 job truth；active runner 仍是进程内 `Map`，而且用户新消息会取消 managed runner。把 job 塞进 hold_ball 会把两个生命周期继续绑死。
- F048 的 restart recovery 会终结父 invocation 并重排队列，但没有收养 nested background process 的 job record。
- F201 已证明可复用的可靠性形状：durable supervisor + journal + probe + safe resume；F261 应复用契约，不另造一套“AGY 特例重试”。
- ADR-029 规定 ActionService 是权限、审计、幂等、dry-run、resource handle 和错误归一化的治理边界；MCP 是暴露面，不是执行 backend。

### 回归问题台账

| ID | 已发生/已证实问题 | F261 必须锁住的回归边界 |
|----|-------------------|--------------------------|
| REG-1 | 嵌套 `run_command` 到阈值后自动后台化，但没有稳定 job handle | 后台化前先创建持久 job；调用方始终拿到 jobId |
| REG-2 | 新 AGY invocation / service restart 杀死旧后台任务 | job 由独立 supervisor/worker 持有；runtime 重启后 reconcile/adopt 或给出可证实终态 |
| REG-3 | nested timeout、AGY print timeout、Clowder AI CLI timeout、hard invocation timeout 语义叠加 | 每层 timeout 独立记录；超时不能冒充底层 job 已终止 |
| REG-4 | 没有 jobId/pid/log/exitCode/result/idempotency/owner 真相对象 | 建立 TTL=0 ManagedJobRecord 和 append-only transition evidence |
| REG-5 | restart recovery 只处理父 invocation/queue，不处理 nested job | 重启探针覆盖 running/orphaned/adopted/terminal 四类裁定 |
| REG-6 | AGY agent-key 能协作/调度，却没有 managed execution action | principal-safe start/status/tail/cancel 能力经 Action Plane 暴露 |
| REG-7 | hold_ball runner 在内存，单槽且会被用户消息取消 | job 生命周期与 ball/invocation 解耦；用户继续聊天不取消 job |
| REG-8 | 第三方依赖/权限/segfault 与 runtime death 混杂 | 原始 stderr、exit/signal、runtime termination reason 分层保存，禁止覆盖根因 |
| REG-9 | 重启/重试没有幂等与 side-effect safety | idempotency key + explicit retry epoch；不得静默重复执行或遗留孤儿 |
| REG-10 | 用户现场只有猫的叙述或 timeout，没有 job 实体 | invocation 原地出现单一 job 状态卡；终态只通知一次并可下钻日志 |

## What

### Phase A: 事故尸检与运行时能力探针（零代码门）

先把 REG-1..10 全部还原成可复现 evidence：AGY 1.1.0 的 service/process 生命周期、nested background ownership、各层 timeout、signal/exit/log 行为，以及新 invocation 是否必然重启 transient service。交付 State Object Census、process tree/time sequence 和 Design Gate 结论；尸检前不写实现。

### Phase B: Durable Managed Job Core（candidate design）

在 Action Plane 建立通用 Managed Job truth：`jobId`、principal/owner、command policy、pid/process identity、状态机、日志与结果引用、idempotency key、retry epoch、created/started/terminal 时间、cancel actor/reason、runtime evidence。worker/supervisor 生命周期独立于 API invocation，API 重启后 reconciler 对每个 non-terminal job 做 probe → adopt / terminalize / mark-lost，禁止“看不到就当完成”。

### Phase C: AGY 安全接入与能力暴露（candidate design）

AGY 通过 typed ActionService 使用 managed execution；MCP/agent-key callback 只暴露 principal-safe 的 start/status/tail/cancel 契约，不直接 spawn 进程。命令 allowlist/sandbox、资源预算、路径边界、secrets、审计、幂等和显式取消均由 host 持有；不开放通用无约束 remote shell。

### Phase D: 终态唤醒与现场可见性（candidate design）

job 创建后在当前 invocation/thread 原地形成单一状态实体；猫可继续对话或交球。job terminal 时通过持久关联唤醒正确 cat/thread，并携带结构化 result/error；用户消息不会取消 job。详细日志与 process/recovery trace 放 deep-dive，聊天现场只显示关键状态。

```yaml
in_context_observability:
  primary_surface: invocation site thread message with one mutable managed-job card
  why_not_dashboard_only: the cat and user need immediate execution truth while continuing the conversation
  deep_dive_surface: job detail view with logs, transitions, process identity, and recovery evidence
  noise_dedup_policy: one entity per job; update in place; emit one terminal notification per terminal epoch
```

### Phase E: 回归套件、dogfood 与 eval 闭环（candidate design）

用确定性长命令覆盖后台阈值、聊天并发、API restart、worker restart、terminal failure、explicit cancel 和 idempotency replay；再用一次真实 12B load/download dogfood 验证端到端。真实大模型任务不进入每次 CI，只保留可重复的小型 fixture 和定期 verdict。

## User Journey

### Primary Journey: 斑斑发起长任务后还能继续活着聊天

- **Scope unit**: thread
- **Actor**: AGY 猫猫 + operator
- **Entry**: AGY 判断本地命令可能超过前台 invocation 预算，调用 managed execution action
- **Flow**:
  1. Action Plane 验证权限/命令策略并返回 jobId；当前消息原地出现 job 状态卡。
  2. 猫结束当前回合、交球或继续回复；job 仍由独立 supervisor 运行。
  3. operator继续发消息，job 不被取消；状态卡原地更新。
  4. API/AGY runtime 若重启，reconciler 找回 job，展示 adopted/failed/lost 的证据状态。
  5. job terminal 后正确的猫被唤醒，拿到 stdout/stderr/exit/signal/result 引用，继续完成任务或如实诊断。
- **Success evidence**: restart + follow-up-message 自动化回归录屏/测试日志，以及一次真实 12B dogfood trace
- **Non-goals**: F261 不负责修复 `socksio`、HF token、Transformers/MLX/PyTorch 等第三方任务错误；只保证这些错误不再被 runtime death 吞掉。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | job | 猫猫 | 查询/追尾日志 → 看见当前状态与原始错误 → 决定继续或取消 | action contract tests |
| S2 | runtime | operator | 重启 API → reconciler census → adopted/terminal/lost 均有证据 | restart integration test |
| S3 | job | operator | 显式取消 → host 鉴权并终止 process tree → 状态卡显示 actor/reason | cancellation test + UI trace |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “救斑斑比帮他完成任务重要”——先修承载生命周期，不为某次模型加载写特例 | AC-A1, AC-B1, AC-B2 | incident ledger + state model/restart tests | [ ] |
| R2 | “把遇到的问题都列成回归 issue” | AC-A1, AC-E1 | REG-1..10 evidence matrix + automated suite | [ ] |
| R3 | 5–10 分钟模型加载不能因约两分钟后台化或服务重启消失 | AC-B2, AC-E2, AC-E3 | deterministic restart test + 12B dogfood | [ ] |
| R4 | “可能需要 F211？……F211 太长了”——新 feat 独立立项、旧 feat 只挂边不吞 scope | AC-A3 | source boundary review | [ ] |
| R5 | “看看现在 F261 有没有被用了” | AC-A4 | docs/Git/remote/GitHub/memory absence audit | [ ] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（状态卡的 UI evidence 在 Phase D AC）

## Acceptance Criteria

### Phase A（事故尸检与能力探针）

- [ ] AC-A1: REG-1..10 每项都有复现步骤、process/log evidence、现状 verdict 和目标 owner，非作者可按报告复查。
- [ ] AC-A2: 产出 AGY 1.1.0 process tree + timeout timeline，明确新 invocation、service restart、nested background 与 OS process 的真实 ownership。
- [ ] AC-A3: Design Gate 完成 State Object Census 和 architecture ownership 裁定；证明没有把 job truth 塞入 invocation、hold_ball 或 MCP transport。
- [x] AC-A4: F261 编号经 docs、Git、remote、GitHub、memory 多入口核验为空号，假阳性已记录。

### Phase B（Durable Managed Job Core）

- [ ] AC-B1: ManagedJobRecord 持久化 TTL=0，至少覆盖 owner/principal、state、process identity、log/result refs、idempotency、retry/cancel/recovery evidence；schema 与 transition tests 通过。
- [ ] AC-B2: job worker/supervisor 与 API invocation 解耦；API restart integration test 中 running job 可被 adopt 或以带证据的 terminal/lost 状态收敛，不能静默消失。
- [ ] AC-B3: 同一 idempotency key 不重复执行；retry epoch、explicit cancel、process-tree termination 和审计 actor 均有自动化测试。
- [ ] AC-B4: orphan/duplicate census 在故障注入后为 0；无法收养的进程必须隔离并产生 operator-visible evidence。

### Phase C（AGY 安全接入）

- [ ] AC-C1: AGY 经 typed ActionService 获得 start/status/tail/cancel，MCP/callback 只做鉴权暴露且不直接 spawn。
- [ ] AC-C2: agent-key principal、command/path policy、resource budget、secret redaction 和 audit tests 全绿；未经授权的通用 shell 继续 fail-closed。
- [ ] AC-C3: timeout contract 区分 request wait、job runtime deadline 与 cancellation；request timeout 后 job 状态仍可查询。

### Phase D（终态唤醒与现场可见性）

- [ ] AC-D1: 当前 thread 一 job 一状态实体，running/recovering/terminal 原地更新；截图覆盖桌面与窄屏。
- [ ] AC-D2: terminal event 只唤醒正确 thread/cat 一次，并携结构化 exit/signal/result/error refs；重复 callback 不重复发答。
- [ ] AC-D3: 用户在 job 运行时继续发消息不会取消 job；显式授权 cancel 才能进入 cancelling/terminal。
- [ ] AC-D4: deep-dive 可查看完整 transition/recovery/log evidence，聊天现场不铺原始日志噪音。

### Phase E（回归与 eval）

- [ ] AC-E1: deterministic suite 覆盖 REG-1..10，包括后台阈值、follow-up message、API/worker restart、真实失败日志、cancel 和 idempotency replay。
- [ ] AC-E2: 故障注入连续 20 轮中 terminal result delivery=100%、user-message-induced cancel=0、duplicate execution=0、unaccounted orphan=0。
- [ ] AC-E3: 一次真实 12B load/download dogfood 跨过原事故时间窗，产生可下钻 job trace；成功或真实任务失败均可验收，runtime 无证据杀死不可验收。
- [ ] AC-E4: Eval Hub/verdict 可读地展示 restart adoption、terminal delivery、orphan、duplicate、user-message cancel 指标，并定义回退/升级阈值。

## ADR-031 Harness 三层契约

| 层 | F261 落点 |
|----|-----------|
| 软 | AGY prompt/skill/convention：预计超前台预算的本地命令必须走 Managed Job，不得伪后台后遗忘 |
| 硬 | ActionService + TTL=0 job truth + external supervisor/reconciler + auth/sandbox/idempotency/schema/tests |
| Eval | terminal delivery、restart adoption、orphan、duplicate、user-message cancel 进入 telemetry/verdict 闭环 |

### Eval Contract

1. **Primary users / activation**: AGY 猫执行预计超过前台 invocation 预算的本地命令时。
2. **Friction metrics**: terminal result delivery rate、restart recovery/adoption rate、unaccounted orphan count、duplicate execution count、user-message-induced cancellation count。
3. **Regression fixtures**: 长命令跨后台阈值、运行中 follow-up、API/worker restart、terminal failure、explicit cancel、idempotency replay。
4. **Sunset**: 若 AGY upstream 提供有文档、跨 restart 稳定的 structured persistent-job API（handle/status/log/cancel/result），可 sunset 本地 AGY process adapter；Action Plane 的权限、幂等、审计和现场可见性契约不 sunset。

## Tips Contribution

- **Planned tip**: “长时间本地命令会启动 Managed Job；对话可继续，任务终态会唤醒猫。”
- **Source ref**: F261 Primary Journey。
- **Gate**: Phase D 实现并有截图/行为证据后才发布，不在 spec 阶段写成已可用能力。

## Dependencies

- **Evolved from**: F210（AGY headless carrier 与 agent-key 能力面）
- **Reuses**: F201（durable supervisor / journal / probe / safe resume 可靠性契约）
- **Related**: F211（跨 runtime session transparency；已 done，Desktop/session scope 不重开）
- **Related**: F048（父 invocation restart recovery；nested job recovery 缺口）
- **Related**: F167（hold_ball/wakeWhen；只消费 terminal wake，不拥有 job）
- **Related**: F118 / F061（CLI liveness 与 `run_command` 历史）
- **Related**: F194（Action Plane / tool execution boundary）

## Risk

| 风险 | 缓解 |
|------|------|
| 把 Managed Job 做成任意远程 shell，扩大权限面 | host-owned typed action、allowlist/sandbox/resource budget、principal auth、fail-closed |
| API 重启后 PID 复用导致误收养/误杀 | process start identity + nonce/lease + probe evidence；不凭 PID 单字段裁定 |
| TTL=0 日志无限增长 | job truth 永久，原始日志采用有界 chunk/artifact retention；终态摘要与 hash/provenance 永久 |
| retry 重复 side effect | idempotency key + retry epoch + explicit operator/cat action；默认不自动重放未知副作用 |
| F261 吞并所有 AGY/ML 环境问题 | REG-8 明确只保真并归因；第三方依赖问题另行归属，不偷进本 F |
| 新状态卡制造 thread 噪音 | 一 job 一实体原地更新；terminal 一次；详细日志下钻 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新立 F261，不 reopen F211、不继续膨胀 F210 | F211 已 done 且主目标是 Desktop/session transparency；F210 是 carrier/capability migration，job lifecycle 是独立价值轴 | 2026-07-10 |
| KD-2 | Job ≠ invocation ≠ hold_ball | 三者生命周期、取消语义和真相对象不同；继续绑定会复现事故 | 2026-07-10 |
| KD-3 | Action Plane owns execution；MCP only exposes | 继承 ADR-029 的权限/审计/幂等治理边界 | 2026-07-10 |
| KD-4 | 先 Phase A 尸检，后 Design Gate/实现 | 当前仍未知 AGY service 的真实 process ownership；不能靠猜搭 supervisor | 2026-07-10 |
| KD-5 | 第三方任务错误是需要保真的 terminal outcome，不是 F261 的修复 scope | 防止用 scope 膨胀掩盖 runtime lifecycle 根因 | 2026-07-10 |

## Review Gate

- Spec：跨个体 reviewer 重点审 Job/invocation/ball 三界、Action Plane ownership 与 REG-1..10 完整性。
- Phase A：尸检报告必须给出复现证据与 State Object Census，review 放行后才进 Design Gate。
- Implementation：TDD + worktree；跨个体代码 review；按 merge-gate 合入；alpha 验收真实重启/对话并发旅程。
