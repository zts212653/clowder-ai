---
feature_ids: [F118]
related_features: [F089]
topics: [observability, cli, reliability, codex, claude-cli]
doc_kind: spec
created: 2026-03-14
---

# F118: CLI Liveness Watchdog & Session Recovery — CLI 进程活性守卫 + 会话恢复

> **Status**: done (Phase D closed) | **Owner**: Ragdoll + Maine Coon | **Priority**: P0 | **Completed**: 2026-03-14 | **Follow-up Hardening**: closed (PR #492, 2026-03-16) | **GAP-2**: Phase D closed — D1 merged (PR #1105), D2 merged (PR #1108), D3+D4 merged (PR #1109), all 2026-04-12

## Why

### team experience

> "这两天 Codex 的 CLI 经常会出现这种情况……反正不知道为什么跑着跑着 @它没反应……我们这里的问题可观测性不足，不知道到底是我们的问题还是 Codex CLI 的问题"
>
> "本质是我们的 CLI 都没有心跳！！我们只是看人家有没有吐东西！不过哦万一有进程但是假死咋办？"

### 观察到的现象

**现象 1 — Maine Coon 1800s 静默超时（Cat Café 内部）**

- Thread: `thread_mmq8de3e0o4p1407` / session `019cec11-32cf-74b2-af27-469c43644c37`
- 表现：Codex CLI 吐出 `thread.started` 后 30 分钟完全静默，被 watchdog 杀掉
- Raw archive 只有两行：`thread.started` → `__cliTimeout`（零中间事件）
- **硬证据**：同一 `cliSessionId` 在挂住期间被另一颗 invocation 成功 resume 使用（审计日志 04:46:16–04:48:02 PDT）
- Invocation: `6c521978-b5ea-439d-b03b-52444ac4f1e5`（04:41:55 → 05:11:57 PDT / 11:41:55 → 12:11:57 UTC）

**现象 2 — Maine Coon半初始化失败（Cat Café 内部）** ⚠️ 高度一致，非独立证明并发 resume

- Thread: `thread_mmq9wjiiht3k5vb3` / session `019cec37-8def-75e3-951e-bbc04c1febf9`
- 表现：session chain 登记了 `cliSessionId`，raw archive 收到 `thread.started`，但 Codex 本地 `~/.codex/sessions/` 无 rollout 文件
- team lead执行 `codex resume` 发现 session 不存在
- 与现象 1 的故障模式一致（只有 `thread.started` + `__cliTimeout`），但未独立证明存在并发 resume
- Invocation: `dfe13a22-aa7a-4fd4-863d-962f52e0002e`（04:59:49 → 05:29:50 PDT / 11:59:49 → 12:29:50 UTC）

**现象 3 — Claude CLI stdout 静默窗口（社区反馈）**

- Claude CLI 在 tool 执行中和 API 等待期 stdout/stderr 均无输出
- 当前 watchdog 无法区分"CLI 挂死"、"正在执行长工具"、"API thinking 中"
- 增大超时不是正解，缺的是真正的活性检测

### 根因链

```
已证实（现象 1 硬证据）：
  同一 cliSessionId 无 mutex → 并发 resume → 一颗成功一颗静默挂死

高度一致（现象 2）：
  半初始化失败 + 无本地 rollout → 故障模式与并发 resume 一致

共性问题（现象 1+2+3）：
  watchdog 只看 stdout/stderr → 30 分钟才发现 → 无法区分死/假死/忙
```

即使修了 session mutex，现有 watchdog 仍然是单维信号——无法区分"死了/假死/忙着"。

## What

### Phase A: Session Mutex + 超时诊断增强 ✅

**A1 — cliSessionId Mutex**

在 `invoke-single-cat.ts` 拿到 `activeRec.cliSessionId` 之后、进入 `service.invoke()` 之前，加 session 级别串行锁：

- 同一进程内，同一个 `cliSessionId` 任一时刻最多允许一颗 in-flight `resume`
- 默认策略：**queue / fail-fast**（第二颗排队等旧的结束，或直接报错），不默认抢占旧请求
- 允许抢占的例外（需显式触发）：① 用户手动 cancel ② 同 thread 重试接管 ③ 旧请求已进入 `suspected_stall` 状态
- 实现为独立的 `SessionMutex` 类，不修改现有 `InvocationTracker`

**A2 — 超时诊断增强**

`__cliTimeout` 事件中补充字段：

- `firstEventAt`: 第一条 NDJSON 事件的时间戳（区分"从未输出" vs "中途停了"）
- `lastEventAt`: 最后一条 NDJSON 事件的时间戳
- `lastEventType`: 最后一条事件的 type（如 `thread.started`、`item.completed`）
- `silenceDurationMs`: `now - lastEventAt`
- `processAlive`: timeout 触发当刻的进程存活快照（在 kill 之前采样）
- `cliSessionId`: 关联的 CLI session ID
- `invocationId`: 关联的 invocation ID
- `rawArchivePath`（可选，provider-scoped）: 对应的 raw archive 文件路径。当前仅 Codex 有 raw archive 机制，defer 到 Phase B 在 provider 层注入

### Phase B: 进程活性检测 + 分级超时 ✅

**B1 — 进程活性探针**

在 `cli-spawn.ts` 中加入 periodic health check：

- 每 60s 采样进程 CPU 时间（macOS: `ps -o cputime= -p <pid>`）
- CPU 时间变化只影响 **状态判定和 kill 决策**，不无限重置超时计时器
- 三层超时机制：
  - **soft warning**：静默 > 2min 发预警（不管 CPU 状态）
  - **bounded extension**：`busy-silent` 状态下超时阈值可延长，但有上限（如 2x 原超时）
  - **hard cap**：无论 CPU 是否在涨，达到 hard cap 一律进入 kill 决策（防 busy-loop/livelock 永不超时）

活性状态分类：

| stdout/stderr | CPU 变化 | PID 存在 | 判定 | 动作 |
|---------------|---------|---------|------|------|
| 有输出 | — | — | `active` | 正常重置 timer |
| 无 | 在涨 | ✓ | `busy-silent` | 不重置 timer，但延长至 bounded extension 上限；记录 warning |
| 无 | 没涨 | ✓ | `idle-silent` | 不重置 timer，正常走超时流程 |
| 无 | — | ✗ | `dead` | 立即清理 |

**B2 — 分级预警**

静默期间向前端发送中间状态事件（不等 30 分钟才报错）：

- 静默 > 2min: `cat_status: alive_but_silent`（前端显示"等待中…"）
- 静默 > 5min: `cat_status: suspected_stall`（前端显示警告，提供手动 cancel 按钮）
- 达到超时阈值: 根据活性探针结果决定 kill 或继续等待

### Phase C: 前端预警 UI

**C1 — 沉默状态指示器**

在猫猫消息气泡区域显示当前 CLI 进程状态：

- 正常工作：现有的 thinking/typing 动画（不变）
- `alive_but_silent`：显示"工具执行中，静默等待…"+ 经过时间
- `suspected_stall`：显示警告色 + "可能卡住了" + 手动 Cancel 按钮
- `dead` / timeout：现有的错误展示（增强诊断信息）

**⚠️ 前端 UI 设计需要 Design Gate 确认后再实现。**

## Acceptance Criteria

### Phase A（Session Mutex + 诊断增强）✅
- [x] AC-A1: 同一 `cliSessionId` 并发 resume 时，第二颗排队等待或 fail-fast（不默认抢占旧请求），不再出现两个进程同时 resume 同一 session 的情况
- [x] AC-A2: `SessionMutex` 有独立单元测试，覆盖：正常串行、并发竞争（queue/fail-fast）、显式抢占分支、grace period 超时
- [x] AC-A3: `__cliTimeout` 事件包含 `firstEventAt`/`lastEventAt`/`lastEventType`/`silenceDurationMs`/`processAlive`/`cliSessionId`/`invocationId`（`rawArchivePath` 为 provider-scoped 可选字段，Phase B 已实现）
- [x] AC-A4: 回归测试：复现"同 session 双 resume"场景，验证 mutex 生效
- [x] AC-A5: 回归测试：timeout 只有 `thread.started` 时，诊断日志能完整输出所有增强字段

### Phase B（进程活性检测 + 分级超时）✅
- [x] AC-B1: 进程活性探针每 60s 采样 CPU 时间，`busy-silent` 状态延长超时至 bounded extension 上限（不无限续命），达到 hard cap 一律进入 kill 决策
- [x] AC-B2: `idle-silent`（CPU 不涨 + 无输出）不重置计时器，正常走超时流程
- [x] AC-B3: 进程已死（PID 不存在）时立即清理，不等超时
- [x] AC-B4: 分级预警：静默 2min 发 `alive_but_silent`，5min 发 `suspected_stall`
- [x] AC-B5: 后端产出可被前端消费的 `__livenessWarning` 事件（`alive_but_silent` / `suspected_stall`），前端展示待 Phase C Design Gate

### Phase C（前端预警 UI + Session Recovery）✅
- [x] AC-C1: 消息气泡区域显示 CLI 进程当前状态（正常/静默等待/疑似卡住）
- [x] AC-C2: `suspected_stall` 状态下有手动 Cancel 按钮
- [x] AC-C3: 超时错误展示增强诊断信息（不只是"1800s 超时"）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "跑着跑着@它没反应" — 并发 resume 导致静默 | AC-A1, AC-A4 | test | [x] |
| R2 | "不知道到底是我们的问题还是 Codex CLI 的问题" — 可观测性不足 | AC-A3, AC-A5 | test | [x] |
| R3 | "本质是我们的 CLI 都没有心跳" — 无进程活性检测 | AC-B1, AC-B2, AC-B3 | test | [x] |
| R4 | "万一有进程但是假死咋办" — 假死检测 | AC-B1, AC-B2 | test | [x] |
| R5 | 社区反馈：tool 执行中 stdout 静默窗口导致误杀 | AC-B1 | test | [x] |
| R6 | team lead不想等 30 分钟才知道出问题了 | AC-B4, AC-B5, AC-C1, AC-C2 | screenshot | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（Phase C Design Gate 通过，Pencil Scene 4 设计稿 100% 匹配）

## Community Issue Coverage (Scope Extension 2026-03-14)

> **决策**：三猫 + team lead共识，社区 issue #86/#98/#99 统一归入 F118，扩展 scope 为 liveness + recovery + audit closure 完整链路，不新开 F121。
> **Triage 报告**：`docs/ops/2026-03-14-community-issue-triage-tokenfelix.md`
> **贡献者**：TokenFelix (whutzefengxie-ops)

| clowder-ai Issue | 问题 | 与 F118 的关系 | 社区已有修复 |
|------------------|------|---------------|-------------|
| [#86](https://github.com/zts212653/clowder-ai/issues/86) | Session 上下文溢出死循环 — resume 无熔断器 | **主线**：直接对应 liveness + overflow circuit breaker | — |
| [#98](https://github.com/zts212653/clowder-ai/issues/98) | 有毒 session 绑定无自愈 — active record 无健康检查 | **主线**：resume health check + auto-seal | — |
| [#99](https://github.com/zts212653/clowder-ai/issues/99) | `finally` 块审计缺失 — generator `.return()` 不写 `CAT_ERROR` | **伴生**：liveness 链的审计闭环 | fork commit `465f64d` |

### 扩展后的因果链

```
CLI 挂了 (liveness, Phase A+B ✅)
  → session 不知道该放手 (no self-heal, #98 — Phase C ✅ AC-C4)
  → 审计链断了 (no audit, #99 — Phase C ✅ AC-C5)
  → 下次 resume 进死循环 (no circuit breaker, #86 — Phase C ✅ AC-C6)
```

### 新增 AC（Phase C 扩展）

- [x] AC-C4: resume 前对 activeRec 做健康检查，session 不可用时 auto-seal + 走 fresh session fallback (#98)
- [x] AC-C5: `finally` 块补 fallback 审计写入，确保 generator `.return()` 路径也有 `CAT_ERROR` (#99)
- [x] AC-C6: session resume 加 overflow circuit breaker，连续 N 次 restore 无有效命令时熔断 (#86)

## Dependencies

- **Evolved from**: 无（新发现的架构缺陷）
- **Blocked by**: 无
- **Related**: F089（Hub Terminal Tmux — 同样涉及 CLI 进程管理）

## Risk

| 风险 | 缓解 |
|------|------|
| CPU 时间采样在 macOS 和 Linux 上行为不同 | Phase B 实现时抽象为 `ProcessProbe` 接口，按平台实现 |
| 分级预警事件增加前端复杂度 | Phase C 有独立 Design Gate |
| session mutex 可能导致排队延迟 | 默认 queue/fail-fast；排队有上限，超时直接 fail-fast 报错 |

## Follow-up Hardening

### 已定位并已落地的问题（2026-03-14）

- `88084b54`：移除 `isStale` / `auto_health_check` 时间判定。闲置 session 不再因为超过 30 分钟被误判成 toxic。
- `66b20e0f`：overflow auto-seal 在 `requestSeal()` 之后补 `finalize()`，避免 transcript / digest 不落盘导致 recall 404。
- `60cdd082` / `168fcf97` / `19e54ad9` / `d28d5177`：统一 seal 语义到 `requestSeal()` → `accepted` 检查 → `finalize()`，补齐 `messageCount`、CAS guard、route runtime wiring、unseal displacement 竞态保护。
- `d288fa4c`：修掉 API package 的预存 TS 错误，让 `dist/` 能重新 build，F118 路径的测试不再依赖陈旧产物。
- `d18bd771`：给 `finalize()` 补 30s timeout、失败审计 `seal_finalize_failed`、以及 `reconcileStuck()` 兜底，避免 session 永久卡在 `sealing`。

### 剩余非阻塞 hardening（避免遗忘）

- [x] 把 `reconcileStuck()` 从"invoke 前按当前 `catId/threadId` best-effort 扫描"升级成启动时 / 定时的全局 reaper。当前实现只能在同一 thread 再次被 invoke 时自愈，长期无人触碰的旧 thread 仍可能保留 `sealing` 终态垃圾。 → `reconcileAllStuck()` + `listSealingSessions()` + startup sweep + 5min periodic timer (feat/f118-hardening)
- [x] 把 `reconcileStuck()` 正式纳入 `ISessionSealer` 契约，移除调用侧的 `'reconcileStuck' in deps.sessionSealer` + type cast，收干净类型层和运行时能力的漂移。 → `ISessionSealer` 接口扩展 + invoke-single-cat.ts 类型安全调用 (feat/f118-hardening)

## Known Gaps

### GAP-1: 跨猫交接时的初始上下文注入溢出（2026-03-16）✅ Fixed

**现象**：在 F118 hardening review 过程中，Maine Coon因为首次被 @mention 加入讨论时注入了过多上下文（完整 thread 历史 + 审计报告 + 代码 diff），导致 Codex CLI context window 溢出崩溃。

**根因**：`assembleIncrementalContext()` 在 `route-helpers.ts` 中没有总消息数或 token 预算守卫。当 `cursor=undefined`（首次参与的猫）或 cursor 过期时，`fetchAfterCursor()` 返回全部 thread 消息，无截断地注入。

**修复（PR #498, squash `7621d25b`）**：
- **第一刀**：无条件 `maxMessages` 尾截（`relevant.slice(-budget.maxMessages)`）
- **第二刀**：Aggregate token budget guard — 逐行 token 预计算 + 线性扫描从最旧开始丢弃，至少保留 1 条消息
- **第三刀**：`IncrementalContextResult.degradation` 字段 + route-serial/route-parallel 的 `system_info` yield

**测试覆盖**：14 个测试（10 count-cap + 4 token-budget），覆盖 cursor=undefined、stale cursor 大批量、fallback 注入不回归、极端 token 压力（200 条长消息 ~500K tokens >> 160K budget）

### GAP-2: Circuit Breaker failure count 在 `cli_session_replaced` 时被洗掉（2026-04-11）

**现象**：两个线程的 `@gpt52` mention 5+ 分钟无响应。session chain 显示 `seq0` sealed（`cli_session_replaced`），`seq1` active 但 `messageCount=0`。

**根因**：AC-C6 的 overflow circuit breaker 实现有 loophole。`invoke-single-cat.ts:1109` 在收到新 `session_init`（CLI 换了 session）时，通过 `sessionChainStore.create()` 创建新 active record，但**不继承** `consecutiveRestoreFailures`。新 record 从 0 开始 → 熔断阈值（3）永远达不到 → 循环卡死无限重复。

**发现者**：Maine Coon(GPT-5.4) 在侦探猫猫调查中定位，Ragdoll(Opus) 代码验证确认。

**D1 已合入**（PR #1105, 2026-04-12）：`create()` + immediate `update()` 继承 `consecutiveRestoreFailures`，熔断器现在能正确触发。

**D2 已合入**（PR #1108, 2026-04-12）：`spawn_started` socket event + per-cat spawning UI + D1 P3 多轮替换回归测试。填补 intent_mode 盲区（0-2min），ThinkingIndicator 显示"启动中..."。

**D3+D4 已合入**（PR #1109, 2026-04-12）：纵深防御层。D3: InvocationTracker TTL guard — `has()` 对超过 75min（2.5× CLI timeout）的 slot 自动清理返回 false。D4: QueueProcessor zombie defense — `processingSlots` 从 `Set` 改为 `Map<string, number>`（记录 startedAt），三入口加 `sweepZombieSlots()`，双重确认（TTL 超时 + tracker.has() 为 false）防误杀。Phase D 全部完成。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Bug + Enhancement 合并为一个 Feature | team lead："拆的越复杂，实现出来距离愿景越远" | 2026-03-14 |
| KD-2 | Session mutex 放在会话复用层，不修改 InvocationTracker | InvocationTracker 是 threadId:catId slot guard，不是 session 级串行化 | 2026-03-14 |
| KD-3 | 进程活性用 CPU 时间采样而不是单纯 kill -0 | kill -0 只能检测 PID 存在，不能检测假死 | 2026-03-14 |
| KD-4 | SessionMutex 默认 queue/fail-fast，不默认抢占旧请求 | 防止后来的 thread 杀掉健康请求（Maine Coon review P1） | 2026-03-14 |
| KD-5 | CPU 增长只影响状态判定，不无限重置 timer；需 bounded extension + hard cap | 防 busy-loop/livelock 永不超时（Maine Coon review P1） | 2026-03-14 |
| KD-6 | 社区 #86/#98/#99 归入 F118，扩展 scope 为 liveness + recovery + audit closure，不开 F121 | 一条因果链不拆两个 feature，管理成本 > 边界清晰收益（三猫 + team lead共识） | 2026-03-14 |

## Review Gate

- Phase A: 跨家族 review（session mutex 是关键修复，需严格 review）
- Phase B: 跨家族 review（活性检测涉及 cli-spawn.ts 核心路径）
- Phase C: 前端 Design Gate → review
