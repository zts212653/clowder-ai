---
feature_ids: [F293]
related_features: [F051, F083, F127, F153, F154, F167, F190, F192, F203, F208, F216, F220, F233, F246, F248, F254, F264, F280, F284, F298, F299, F300, F307, F310, F311, F312, F313]
topics: [routing, availability, quota, provider-health, capability-profile, custody, cancellation, approval, workspace, settings, l0, freshness]
tips_exempt: "Renewed 2026-09-02 after Phase C merge: automatic F051/F153/durable-terminal evidence changes backend routing behavior without adding a user-invoked capability or discovery moment; AC-E4 still requires a real Workspace tip at product acceptance."
doc_kind: spec
created: 2026-08-08
description: "把能力、偏好与新鲜供给接入发送边界，并贯通可验证接责、失败回弹、用户取消与精确多方确认，使传球不再停在消息已发。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-02T05:08:22Z
---

# F293 — Live Routing Context

> **Status**: Phases A–C merged / Phases D–E and expanded Experience + continuity gate remain open | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

> **Kickoff reviewer**: Ragdoll (@fable5)，一次 consolidated verdict

## Why

operator同时遇到了两种表面不同、实质同源的传球失败：

- Ragdoll临时没有额度时，持球猫仍可能照旧找他 review，而没有改找 Kimi / GLM；
- Terra 与 GPT-5.4 的价格关系、能力判断已经变化，团队仍可能按旧认知默认找 GPT-5.4。

这不是单纯的“猫粮看板”问题，也不是再写一条偏好提示就能解决。我们缺的是一个在**实际路由决策时**组合慢知识、条件偏好与实时供给，并在**真正发送前**重新确认的共享上下文。

operator明确要求：

1. 一个 feature 收住现实供给和长期路由更新，不拆成临时 MVP 与未来大架构；
2. MVP 若不在终态架构上就不要绕路；
3. Sol 背后的私人/公司 ChatGPT 账号来源对猫不可感知，因此 F293 **不建模、不猜测、不展示**本次调用究竟用了哪份猫粮。

## Current State

- [F051](F051-real-quota-dashboard.md) 已定义真实额度池与独立 pool 不合并，但它主要是展示面，不在每次传球的必经决策路径上。
- [F208](F208-capability-profile-routing.md) 提供较慢变化的能力知识，并坚持“给数据，不替猫做判断”；当前 dossier 里的部分价格/模型信息已经会随时间过期。
- 当前 Settings 把“成员管理”和“猫猫画像”拆成两个目的地：前者又混有长期启停、账号、模型和 runtime；后者离实际选猫路径太远。F208 虽已有 observation → distillation proposal → approve/apply 更新链，F293 还没有把已应用 revision 变成路由输入，也没有把待吸收证据显给人看。
- F284 已在 `origin/main@69d5597eb` 落地：Header 只有一个 Workspace 入口，持续能力由 `WORKSPACE_MODES` / `WORKSPACE_MODE_META` 注册并由 `WorkspacePanel` 渲染；首页 `WorkspaceNowSurface` 只表达当前 thread 正在运行什么，后台 activity 不得抢走用户 Focus。F293 必须沿用真实 mode / chrome / back / fold 契约，而不是再造一个孤立状态页或 sibling host。F248 另提供“Workspace 事件面 + Settings 完整账本、共享同一 read model”的边界先例。
- [F154](F154-cat-routing-personalization.md) 的 `preferredCats` / default 是静态偏好，不能表达“本周一恢复”“provider 暂时不可达”等带时间语义的条件。
- [F203](F203-native-system-prompt-l0.md) 会编译并缓存稳定的 native L0 队友名册；Redis-backed 临时状态若硬塞进该缓存会制造 stale truth，当前也没有独立的 per-invocation 动态路由投影。
- 当前 dispatch 能执行传球，却没有一个专门 owner 在发送副作用边界组合 capability、operator policy 与 live availability。
- [F254](F254-side-effect-freshness-gate.md) 已证明：只在 agent 开始思考时给快照不够，长 turn 中状态可能变化；真正有副作用前必须 recheck，且前置证据子系统缺失时不能卡死副作用。
- [F167](F167-a2a-chain-quality.md) / [F233](F233-ball-custody-observability.md) 已有 structured action lease、predecessor 与 dead-ball truth；普通 `@` 失败后仍主要止于 dead，未形成通用责任回弹。
- [F220](F220-a2a-collab-reliability.md) 持有 execution liveness；[F246](F246-approval-hub.md) 持有 exact proposal/stale approval，但尚无通用“人 + 猫针对同一 revision”的 AND-join。
- [F307](F307-composable-workbench.md) 已把个人真实 surface adapters 落到同一个右侧 Workbench kernel；F293 的 Team 产品面可沿 descriptor/owner-state 边界接入，不再等待另一个 Workspace 宿主。
- [F311](F311-capability-evolution-workspace.md) 已冻结完整的 Capability Evolution Program 生命周期，并把“F208 画像写回”与“F293 路由消费验证”拆成两个单变量对象；它需要 F293 提供真实消费证据，但不拥有路由判定，也不阻塞 F293 建设自己的 domain kernel。
- F310、[F312](F312-memory-initiative-closure-command.md) 与 [F313](F313-analysis-to-outcome-closure-command.md) 分别冻结了真实托付、跨 owner release 与 finding→outcome 的持续持球/验收纪律。它们提供 journey/执行方法和 owner refs，不成为 F293 的第二套 custody、command 或 outcome store。
- Phase C 已由 PR #4211 合入：canonical F051 refresh、typed F153 health 与 durable dispatch terminal 统一经 `AutomaticRoutingSignalService` 写同一 immutable signal contract；resolver 用 shared owner revision 复用未变化 timeline、仍按每次 `observedAt` 重算 expiry。dispatch success 只恢复因果匹配的 exact-cat signal，provider-wide health recovery 仍归 F153 authority 或 bounded expiry。
- 底层使用私人还是公司账号，不是猫能可靠观测的事实。把它写成 `ExecutionSlot` 或展示字段只会制造 phantom precision。

## Value Statement

当一只猫准备找队友时，他能看到“谁适合、谁此刻可用、哪些偏好仍有效”，并在发送后继续看见“责任是否接住、执行是否还活着、失败或取消后回到谁、所需确认是否都针对最新对象”；异常恢复后不会永久饿死一只猫，责任也不会掉进消息与进程之间。

## What

F293 新增一个 `routing-context` 组合单元和贯穿同一终态架构的六段交付：

1. 定义 availability signal、versioned routing preference、explainable snapshot 与 preflight contract；
2. 把 Workspace「猫猫团队」接入 F284 canonical `WorkspaceMode='team'`，作为日常判断与 routing/profile action surface；Settings 只保留成员/runtime 结构配置，并提供共享 read model 的只读路由账本；
3. 把 F208 最新已应用能力画像 revision 与待吸收证据接进 resolver，确保画像能持续更新并在下一轮真实影响路由；
4. 接入 quota / provider health / dispatch failure 等可观测来源，建立不误报恢复的状态机；
5. 把长期经济性偏好收敛到单一权威来源，并让到期未复核的偏好停止重排候选；清理旧 L0 / dossier / config 的重复权威；
6. 在实际 @ / dispatch 边界重新解析，并把 F167/F220/F233/F246 的 custody、liveness 与 approval truth 组合进同一端到端 journey；不另建临时旁路或第二本账。

## Architecture Ownership

Architecture cell: routing-context

Map delta: existing cell updated

Why: `routing-context` 继续只负责决策时的组合、解释与 preflight；Phase C 为其增加 canonical source translation、owner revision coherence 与 durable-terminal feedback anchors，dispatch 仍执行发送，F051/F153 仍拥有各自源事实。

## Terminal Architecture

契约摘要：

- F293 只拥有 decision-time composition、explanation、active-signal projection 与 per-target preflight；稳定能力仍归 F208，quota/health 分别归 F051/F153，dispatch 仍执行发送。
- owner-global immutable signal events、versioned preferences 与 applied dossier revision 在 resolver 汇合；不可观测的私人/公司账号不建模、不猜测。
- invocation-time cognition 走 ADR-038 staging adjacent projection；实际发送边界重新 resolve，`unavailable` 可拒绝，`scarce/degraded/unknown` 只警告。
- resolver 读取失败 fail-open 为 warned，不伪造 available，也不清除已有 signal。
- degraded owner read 仍携带 canonical catalog bindings，让 Team 保留成员、原 subject 与 owner action；客户端不得据此伪造 availability、能力画像或 alternatives。
- preflight success 只允许尝试发送，不等于 responsibility transfer；handoff 后的接责、terminal evidence 与 predecessor recovery 分别复用 F167/F233/F220。
- Cancel 不自动等于 You 接责或 subject 完成；共同确认必须绑定同一 `subjectRef + revision/freshnessKey + generation`，approval truth 复用 F246。
- Workspace「猫猫团队」是 F293 routing signal/preference 的唯一日常 editor；Settings「成员与运行时」只管结构配置，Settings/Ops「路由账本」是同一 read model 的只读深挖。F208 现有 observation/provenance source workflow 在其 owner 迁出前可保留，但不能编辑 F293 truth，也不能被 F293 冒领。

### 与事实基础设施的关系

[F298](F298-runtime-promise-durability.md) / [F300](F300-self-sensing-home-state-awareness.md) / [F299](F299-workspace-invocation-trajectory.md) 是跨域的纵向事实运输链：保证事实与承诺活着、把事实送到猫的判断点、再让人能下钻看见；F293 是横向的 routing 业务域，拥有 route truth 与 `allowed / warned / rejected` 判定，并把其他 owner 的事实组合成选猫、发送、接责、回弹与确认旅程。

- **F300 组织跨域感知，不替 F293 判定**：F300 M1 是副作用前的通用 authoritative grounding policy；当副作用是选猫/@/dispatch 时，它必须调用或引用 F293 的 canonical snapshot/preflight，而不是另算 routeability。F293 dispatch preflight 仍独占逐目标 `allowed / warned / rejected`、alternatives 与 routing degradation 语义。
- **F299 记录视野，不改写路由**：F293 决策时看见的 snapshot/preflight refs 进入 F299 P3 durable request envelope，供异常确诊“供给 gap vs 猫的判断 bug”；inspector 不重放或覆盖 route decision。
- **F298/ADR-045 约束新状态的出生方式**：F293 新增的 signal、preference、receipt/recovery 等持久状态必须满足“持久性 ≥ 所服务过程生命周期、TTL 只做 GC”；按法设计的新状态不登记进 F298 存量违反项家族表。

### 与 F300 之后新能力的分工

| Feature | 它拥有 | F293 现在怎么接 | 是否阻塞 Phase A routing kernel |
|---|---|---|---|
| [F307](F307-composable-workbench.md) | Workspace working-set/layout/restore 宿主 | Team 以后作为 owner-backed surface descriptor 接入；F293 只供 read model 与动作，不写 layout truth | 否；产品激活仍服从 F307 Phase D |
| F310 | 普通来源里的托付识别、Task custody admission、Needs Me/Schedule 旅程 | F293 只在需要选下一只猫时给 route decision；不把“识别到任务”或 Task admission 当 routing custody | 否 |
| [F311](F311-capability-evolution-workspace.md) | Evolution Program、claim/economics、owner refs、keep/tune/rollback/sunset | F208 applied revision 的写回效果由 F293 before/after snapshot + preflight refs 证明；F311 只消费 lineage | 否；F300 缺口只 gate 需要同源读取的 join |
| [F312](F312-memory-initiative-closure-command.md) | 记忆 initiative 的 release 顺序、runtime acceptance 与 vision guard | 复用其 command→execution→acceptance 纪律推进 F293，不复制 memory catalog/state | 否，非 runtime 依赖 |
| [F313](F313-analysis-to-outcome-closure-command.md) | finding→approval→owner mutation→fresh outcome 的单 Feature 闭环 | 若 F293 将来收到真实 repair finding，沿 owner refs/Approval 处理；普通确定性实现仍走 tests/guards | 否，非 runtime 依赖 |

### 2026-08-30 Restart Decision

F293 不再把“F300 runtime 未启动”当成全局停止条件。当前按 claim 拆成两个施工面：

1. **立即开工：Phase A routing kernel**。落最终 schema/store/resolver/preflight identity，完成 state × scope × freshness、过期→`unknown`、preference lifecycle、F208 applied revision 消费、fail-open degradation 与 ownership guards。这个切片已有 `cd1bfc67` 的 selection/preflight Design Gate 连续性，且不需要 F300、F307 UI 激活或新的 custody 机制。
2. **随后开工：owner-backed read/product seam**。让 snapshot/preflight refs 可被 F299 轨迹、F311 consumption verification 与未来 F307 Team descriptor 消费；不为 F300 造临时 adapter、假 snapshot 或本地替代 sensing layer。
3. **保持 gate：expanded continuity/experience slice**。ordinary A2A 的 exact custody fallback、Cancel disposition、multi-party AND-join 与最终 Team 交互仍需消费 F167/F233/F220/F246/F307 的真实 owner contract；这些开放项只 gate 对应切片，不再冻结 Phase A kernel。

两个 `unknown` 语义必须分开：F293 对**可用性建议或 resolver 自身读取失败**保持 `warned` fail-open；F300/原 owner 对**cancellation、permission、custody 等硬副作用事实无法权威回读**必须 fail closed。任何实现都不得用前者绕过后者。

## User Journey

### Discovery Journey — 从 Workspace 找到猫猫团队

**Entry**: Chat header 右上唯一 Workspace 图标 → 可选“正在发生” → 单列“你想打开什么？” →「猫猫团队」。

1. 如果当前 thread 有 invocation，既有 `WorkspaceNowSurface` 仍先显示“正在发生”，但不混入谁可路由。
2. Launcher 在“组织工作”以真实窄栏单列显示「猫猫团队」，副文案是“看谁适合、谁现在能接球”；不再新增「猫猫状态」目的地。
3. 点卡片进入 canonical Team mode；外层 Workspace chrome 与内层 surface header 沿用 F284，团队概览以猫为对象展示稳定画像、当前供给、有效偏好和待吸收证据。
4. 点猫进入同 mode detail；detail back 回 Team list，surface back 回 Launcher，fold 后再开恢复原 focus。
5. 猫详情可以标记/恢复当前状态、编辑条件偏好、提交画像观察；三种动作分别写回各自 canonical owner。
6. “查看完整记录”deep-link Settings / Ops「路由账本」；它只提供全量历史与参数，不复制状态、偏好或画像 editor。

### Primary Journey — 临时标记供给状态，下一次传球立即生效

**Scope unit**: owner-global routing truth 与当前 runtime catalog/candidates 的交集 + 一次具体 handoff；不是底层账号。

**Actors**: You（标记/恢复/处置），持球猫（判断），dispatch（preflight），BallCustody/TurnExecution（接责与活性）。

**Entry**: Chat header 右上唯一 Workspace 图标 →「猫猫团队」；mention picker、preferred-cat selector 与消息 receipt 的异常状态都 deep-link 到对应猫/provider。

1. You 在 Workspace「猫猫团队」点“标记当前情况”，将Ragdoll标为 `scarce`、原因“额度低”、恢复时间“周一”；或将 Anthropic provider 标为 `unavailable` 15 分钟。
2. UI 立即显示影响范围、状态来源和到期语义；不会要求 You 说明私人/公司账号。
3. 若用户正在 Files / Tasks / Eval，保存后的后台更新只改变 Activity badge/read model，不自动把 Workspace 导航到 Team。
4. 下一次 invocation 的 dynamic cognition projection 只增加这条异常，不塞入完整 dashboard，也不污染缓存的 native L0 roster。
5. 持球猫看到 Kimi / GLM 等 eligible alternatives，结合能力自行决定；`scarce` 可以被有理由覆盖，`unavailable` 不能假装能送达。
6. 真正发送前，dispatch 重新读取状态。若期间 provider 已挂，发送被拒并返回 alternatives；若只是 scarce，则给 warning，不静默改派。
7. mention / receipt 只有在用户显式点异常 affordance 时才经 `openTeamSubject` 打开精确 Team detail。
8. 到期后旧负面状态变 `unknown`。系统通过低成本 probe 或 You 明确恢复确认 `available`，不会永久绕开已恢复的猫。
9. child 真实启动并形成 durable custody transition 后，责任才离开 predecessor；消息已发或 child 已建都不单独构成接责。
10. child 失败/失粮/被 Cancel 时，execution 与 custody truth 收口，并把最窄 scope observation 反馈给 F293；predecessor 被唤醒后显式选择 reroute、暂停、接管或关闭。

**Success evidence**: Workspace/operator UI 截图、dynamic cognition projection、dispatch trace、表驱动 resolver 测试和端到端 handoff 记录。

### Supporting Journeys

| ID | Journey | Expected outcome |
|---|---|---|
| S1 | provider 自动探测到故障 | 只有 provider 级证据才影响该 provider 下所有猫；短 validity 后回 unknown |
| S2 | “Terra 同价更聪明”偏好更新 | 改一条 versioned preference，下一次 resolver 生效，旧文案不再有权覆盖 |
| S3 | 长 turn 中状态变化 | L0 仍可用于思考，但发送前 preflight 看到新状态并阻止 stale action |
| S4 | Sol 底层账号来源不可见 | route context 只显示可证明的 cat/provider/pool 状态，绝不猜私人或公司猫粮 |
| S5 | review 证据显示 Terra 能力画像变强 | 证据走 F208 observation/proposal/approve/apply；F293 下一轮读取新 dossier revision，pending 内容不提前影响路由 |
| S6 | Terra 优先规则到复核日仍无人确认 | 规则派生为 `review_due` 并停止重排 alternatives；历史和依据仍可见，避免旧认知永久支配路由 |
| S7 | 从 Settings「能力画像来源」进入 | 页面明确属于 F208 observation/provenance workflow；routing 判断显式 deep-link Workspace Team，且此页没有 F293 signal/preference writer |
| S8 | ordinary `@` 投递后目标未启动或中途失败 | 不产生 phantom custody；exact predecessor 被唤醒并基于新 signal 重新选择 |
| S9 | You 点击 Cancel | 只停止 exact carrier 并暂停/回到既有 predecessor；reroute/take-over/close 需显式 disposition |
| S10 | 新请求要求 You 与 reviewer 共同确认 | 只有两者都确认同一 subject revision/generation 才推进；旧确认不得复用 |

## Non-goals

- 不做自动“最佳猫”总分、全自动调度器或静默改派；判断权留给持球猫。
- 不把 scheduled / cron task 自身的固定 cat 启动纳入 preflight：该路径没有队友选择或传球语义；若 task 内随后产生 ordinary / A2A / callback handoff，仍在对应实际发送边界检查。
- 不合并 F051 中彼此独立的 quota pools，也不伪造统一剩余额度。
- 不做多账号 execution placement，不展示本次 invocation 由私人还是公司账号供给。
- 不因临时 quota / provider failure 改写 F208 的稳定 capability dossier。
- 不把成员增删、长期启停、默认/排序、账号、模型、别名或 session/runtime 参数搬进 Workspace；这些继续由 Settings 结构配置拥有。
- 不长期保留两个 F293 routing/profile 判断工作台；Settings 现有 F208 observation/provenance source workflow 不是 F293 editor，先明确 relabel + 显式 deep-link Team，待 F208 owner 迁出后再退出旧入口，F293 不用 redirect 切断跨 feature writer。
- 不为 Team 新增 Header icon、sibling host 或 Launcher 旁路 registry，也不把 routeability 混入 `WorkspaceNowSurface`。
- 不因后台 quota/provider/profile signal 自动导航 Workspace 或覆盖用户正在看的 Files / Tasks / Eval Focus。
- 不让 F293 直接编辑 capability dossier；能力更新继续走 F208 observation → distillation proposal → approve/apply。
- 不接受只有 dashboard、没有 L0/上下文消费和 dispatch preflight 的实现。
- 不把“所有可选机制都补齐”当交付清单；健康信号走 observations，确定契约走 tests/guards。
- 不在 F293 重建 BallCustody、TurnExecution 或 Approval ledger，也不把 `available`、`running`、`holds responsibility` 合成一个状态。
- 不把 carrier 正常退出当 subject 完成，不因 Cancel/失败默认把责任交给 operator，不静默自动 reroute。

## Acceptance Criteria

### Phase A — Domain Contract & Ownership

- [x] AC-A1: `RoutingSignalEvent`、`RoutingPreference`、snapshot 与 preflight decision 有正式 schema；state × scope × freshness 合成规则有 table-driven tests。
- [x] AC-A2: signal 历史 TTL=0；active window 到期只令状态变 `unknown`，不删除记录、不自动恢复 `available`。
- [x] AC-A3: resolver 支持 cat / provider / 可观测 quota pool 三种 scope；没有稳定 pool identity 时 fail closed 到可证明范围，绝不推断私人/公司账号。
- [x] AC-A4: resolver 输出 explainable reasons、freshness 和 effect，不输出 opaque score，不静默挑选目标。
- [x] AC-A5: 新增 `routing-context` architecture cell 与 map edge；dispatch、identity-session、F208/F051/F153 的 ownership 保持清晰。
- [x] AC-A6: store/resolver read error 与 timeout 有表驱动测试：preflight 只能 `warned` fail-open、保留原目标并写 degradation audit，不得 `rejected`、伪造 available 或改写 signal。

### Phase B — Operator Surface & Decision-path Projection

- [x] AC-B1: owner-authorized Workspace「猫猫团队」支持 mark / recover / retract；非 available 状态必填 reason 与 `validUntil`/`resetAt`，并预览影响范围。
- [x] AC-B2: 每轮 dynamic cognition projection 只注入非默认稀疏异常与 active preference，包含状态、时间语义与 freshness；native L0 cache 不承载动态 truth，并有明确 token-budget regression guard。
- [x] AC-B3: 猫在当前上下文可查看候选状态与来源；dashboard 不是唯一消费面。
- [x] AC-B4: 每次实际 @ / dispatch 前重新 resolve：`unavailable` rejected，`scarce` / `degraded` / `unknown` warned，并返回有理由的 alternatives；不得静默 reroute。
- [x] AC-B5: mark / recover / retract / preference API 有 strict user + owner gate、审计事件和契约测试；preflight 是内部 service boundary。
- [x] AC-B6: Workspace「猫猫团队」是 F293 日常 routing/profile action surface；Settings「成员与运行时」只编辑结构配置，Settings / Ops「路由账本」只读全量历史。三者共享 resolver/read model，不存在第二套 F293 状态、偏好或 applied-profile editor；F208 source workflow 仍由 F208 拥有。
- [x] AC-B7: Settings 结构性 `roster.available` 只使用“成员已启用/成员已停用”语义，不复用 F293 live availability badge；Settings 不得写 F293 signal/preference。现有 `?s=profiles` 明确标为 F208 source workflow并显式 deep-link Team；只有 F208 owner 迁出 observation/provenance 写入后才退出导航，F293 不得提前 redirect 切断。
- [x] AC-B8: Team 通过 canonical `WORKSPACE_MODES` / meta / `WorkspacePanel` render switch 接入，只有一个 Header Workspace 入口；无 sibling host、无 `WorkspaceNowSurface` routeability 扩张、无 Launcher 重复 destination truth。
- [x] AC-B9: Team list/detail、surface back、fold/host switch 的状态迁移有 component tests；420/508px panel 单列，780px 才允许 container-driven 双列。
- [x] AC-B10: 后台 signal 更新只刷新 read model / needs-you Activity，不能导航或抢 Focus；显式 Launcher/mention/receipt/Settings click 经共享 `openTeamSubject` 打开 Team list/detail，并有 no-op/explicit-action regression tests。

### Phase C — Source Adapters & Recovery

- [x] AC-C1: F051 adapter 保留独立 pool 语义；不跨 pool 聚合，不把不可观察账号暴露给猫。
- [x] AC-C2: provider-wide 状态只由 provider-wide evidence 产生；429/auth/runtime error 默认落在最窄可证明 scope，避免一次失败饿死整个家族。
- [x] AC-C3: F153 health / provider observations 可生成短 validity 信号；运行健康使用 logs/metrics/traces，不默认挂 Eval Hub。
- [x] AC-C4: 过期负面信号转 unknown；成功 probe 或人工 clear 才确认 recovery；重复错误有 dedupe / noise control。
- [x] AC-C5: dispatch 遭遇真实 quota/provider failure 后写入同一 signal contract，后续 route 立即可见。
- [x] AC-C6: 真实 dispatch 成功只作为因果匹配 route/scope 的 successful probe；failed/queued/silent 不算恢复，并有“不清无关 pool、不猜隐藏账号”的负向测试。

### Phase D — Slow Routing Knowledge Freshness & Migration

- [ ] AC-D1: routing preference 有 provenance、version、`validFrom` 和可选 `reviewAfter`；覆盖“成本相当时优先 Terra 于 GPT-5.4”的当前 policy 示例。
- [ ] AC-D2: resolver 明确 fresh canonical preference 优先于旧 L0/dossier/private memory claim；旧信息只能作非权威历史上下文。
- [ ] AC-D3: 审计并移除 L0、dossier、配置中重复承担的相对价格/优先级真相；guard 确保同一 policy 只有一个 canonical owner。
- [ ] AC-D4: capability 继续由 F208 拥有；F293 snapshot 携带最新 applied dossier revision、intent-relevant signals 和 evidence refs，revision 变化使 resolver cache 失效；临时 availability 不反写稳定能力画像。
- [ ] AC-D5: F208 pending/rejected proposal 只显示 freshness，不参与路由；approved/applied revision 才能影响 dynamic cognition、Workspace 候选解释和 alternatives，并有两版 revision 的 integration test。
- [ ] AC-D6: `reviewAfter` 到期派生 `review_due`；规则及依据继续可见但停止重排 alternatives；renew / supersede 追加 active version，retire 追加带 `retiredAt`、reason 与精确 `supersedes` 的 durable terminal version，完整生命周期有 table-driven tests。

### Phase E — End-to-end UAT & Closure

- [ ] AC-E1: Discovery + Primary Journey 在 Workspace/contextual UI、Settings 边界、dynamic cognition projection、猫的路由解释和 dispatch trace 上全部有证据。
- [ ] AC-E2: adversarial matrix 覆盖：周一恢复、provider outage、expiry→unknown、真实 dispatch 成功的有界 recovery、状态在长 turn 中变化、错误 scope 放大、底层账号来源不可见，以及 routing-context store/resolver unavailable/timeout 时 warned fail-open。
- [ ] AC-E3: 所有 UI、自动 adapter 和 dispatch gate 消费同一 store + resolver；不存在另建 temp-status MVP 的旁路。
- [ ] AC-E4: 至少贡献 1 条 F244 capability tip：如何临时标记状态、为什么 expiry 不是自动恢复，以及猫从哪里看到来源。
- [ ] AC-E5: 真实 Alpha UI UAT 证明 routing 判断不会被拆成成员/画像/状态三个目的地：Workspace Team 以猫为对象，Settings 只留结构配置、完整账本与明确归属 F208 的 source workflow；后者不出现 F293 writer，并有显式 Team affordance。另证明 Team 服从 F284 单入口、单列窄栏、双层 chrome、嵌套返回与 Focus no-steal。
- [ ] AC-E6: preflight allowed、delivery、custody accepted、execution running 与 subject completed 是可区分的 exact transitions；责任只在 durable custody evidence 后离开 predecessor。
- [ ] AC-E7: ordinary A2A 启动失败/中途 terminal 写入最窄 F293 signal，并有界唤醒 exact predecessor；不得静默 reroute或默认升级 You。
- [ ] AC-E8: `canceled_by_user` 必须落入显式 `stop_and_return | reroute | take_over | close_subject` disposition；Cancel 本身不证明接管或完成。
- [ ] AC-E9: 多方确认按同一 `subjectRef + revision/freshnessKey + generation` 做 AND-join；stale approval 无法满足新请求。

## Requirements Mapping

| ID | Requirement | Source | Acceptance criteria |
|---|---|---|---|
| R1 | Ragdoll没粮时，传球决策能看到并改找 Kimi / GLM | operator 2026-08-08 | AC-B1, AC-B2, AC-B4, AC-C1, AC-E1 |
| R2 | 临时稀缺恢复后不能被永久绕开 | operator 2026-08-08 + failure-mode audit | AC-A2, AC-C4, AC-C6, AC-E2 |
| R3 | provider 临时不可达可手动或自动标记 | operator 2026-08-08 | AC-A1, AC-B1, AC-C2, AC-C3 |
| R4 | Terra / GPT-5.4 等长期经济性认知可单点更新且不会永久过期不复核 | operator 2026-08-08/09 | AC-D1, AC-D2, AC-D3, AC-D6 |
| R5 | 一个 feature 面向终态，不拆临时 MVP 与未来架构 | operator 2026-08-08 | AC-A5, AC-E3 |
| R6 | 不建模或展示 Sol 背后的私人/公司账号来源 | operator correction 2026-08-08 | AC-A3, AC-C1, AC-E2, S4 |
| R7 | 猫保留判断权，不变成算法路由器 | F208 + operator collaboration model | AC-A4, AC-B4 |
| R8 | 成员、画像、状态不再拆成三个日常入口；Workspace 与 Settings 分工明确且不复制 editor | operator 2026-08-09 | AC-B6, AC-B7, AC-B8, AC-E1, AC-E5 |
| R9 | 猫猫画像能从新证据持续更新并真实参与下一轮路由，而不是停在某一版 | operator 2026-08-09 | AC-D4, AC-D5, AC-E1 |
| R10 | F293 必须长在已合入 F284 的真实 Workspace 行为上，不另画壳、不抢 Focus | operator 2026-08-10 + F284 landed contract | AC-B8, AC-B9, AC-B10, AC-E5 |
| R11 | 发出传球后能证明接责，失败后回到 exact predecessor，而非人肉发现 | You + 吴浪 ASR 2026-08-12 | AC-E6, AC-E7 |
| R12 | Cancel、改派、接管、关闭是不同责任迁移 | You + 吴浪 ASR 2026-08-12 | AC-E8 |
| R13 | 人猫共同确认必须针对同一最新对象，旧确认不可复用 | You + 吴浪 ASR 2026-08-12 | AC-E9 |

### Coverage Check

- [x] 每个 R 都映射到至少一个 AC
- [x] 每个 Phase 都有可验证的完成证据
- [x] 所有用户可见行为都有对应 journey
- [x] 账号来源不可见这一纠正同时进入 architecture、journey、non-goal 与 adversarial UAT
- [x] Workspace / Settings 分工与画像更新链同时进入 architecture、journey、non-goal、AC 与 UAT
- [x] F284 单入口、mode registry、NowSurface 边界、嵌套返回与 Focus no-steal 同时进入 architecture、journey、non-goal、AC 与 UAT
- [x] routing → custody 扩展同时进入 journey、non-goal、AC、requirements 与 design gate

## Dependencies

- **Evolved from**: F051（真实 quota pool）、F208（稳定 capability knowledge）、F254（side-effect freshness）。
- **Can start now**: Phase A routing kernel、F208 applied-revision consumption、F299/F311 refs-only consumption seam；先确认各 provider 可观测的最窄 scope。
- **Slice-gated only**: F300 runtime 只 gate M1/M2/M3 cross-owner sensing join；F307 Phase D 只 gate 普通产品激活；F167/F233/F220/F246 的 open contract 只 gate expanded continuity/approval slice。没有一项阻塞 Phase A kernel。
- **Related**: F127/F153/F154/F203、ADR-038、F244/F264/F284/F307；post-dispatch continuity 复用 F167/F233（custody）、F220（liveness）、F246（approval）与 F280（wait contract）；F310/F312/F313 提供相邻 journey/closure 纪律，F311 消费 F293 route-effect lineage。

## Risk Register

| Risk | Consequence | Mitigation / proof |
|---|---|---|
| 过期负面状态仍被当不可用 | 已恢复的猫被静默永久绕开 | expiry→unknown + probe/manual recovery tests |
| 单猫错误被放大到 provider | 整个家族无辜饿死 | narrowest provable scope + provider-evidence tests |
| 状态只存在 dashboard | 决策时依然看不见 | dynamic cognition projection + contextual badges + dispatch preflight UAT |
| 全量数据塞进 cognition prompt | token 膨胀、重要规则被挤压 | exception-only projection + budget guard；native L0 不承载动态 truth |
| 变成不透明算法路由 | 猫的判断权和可解释性消失 | no score / no silent reroute contract |
| 猜测私人/公司账号 | 隐私泄漏与错误精度 | account source non-goal + schema/serialization negative tests |
| 价格/能力真相多份复制 | 更新后继续滞后 | one owner per fact class + provenance + duplicate-truth guard |
| 用 TTL 删除用户状态 | 审计与恢复证据丢失 | durable event TTL=0; validity only affects projection |
| routing-context store/resolver 自身不可达 | advisory 子系统变成全家 dispatch SPOF | warned fail-open + degradation audit + timeout/error contract tests |
| Workspace 与 Settings 各保留完整页面 | 同一只猫被拆开、编辑结果互相不清楚 | Team daily projection + Settings structural config/read-only ledger + single-editor navigation tests |
| Team 绕过 F284 mode registry 或复制 host | 再造一套 Workspace 壳，返回/fold/activity 行为漂移 | canonical mode/meta/render contract + inventory tests |
| 后台状态变化自动打开 Team | 用户正在看的 Files/Tasks/Eval 被打断 | Focus no-steal contract + navigation no-op regression |
| F208 画像有更新流程但 resolver 不消费 revision | 画像“更新了”却不影响实际找猫 | applied revision ref + cache-key invalidation + two-revision integration test |
| preference 到期仍永久重排 | GPT-5.4/Terra 类旧经济性认知静默固化 | `review_due` stops ordering + renewal/supersede/retire tests |
| delivery 被误当 responsibility transfer | 目标未启动却留下 phantom owner | durable custody transition + predecessor contract tests |
| Cancel/旧 approval 被误解释 | 责任错归 You或旧确认推进新请求 | explicit disposition + exact-revision AND-join tests |

## Open Questions for Design Gate

1. ✅ Reality-grounded design candidate：在已合入 F284 的 canonical mode registry 新增 `team`，把能力、当前供给、偏好和待更新认知放回具体猫；不新增 host/Header 入口、不扩张 NowSurface、后台 signal 不抢 Focus。mention/preferred-cat/receipt 只作显式 affordance 并经共享 action deep-link。Settings 保留成员/runtime 结构配置和只读路由账本；现有 F208 source workflow 明确 relabel 且不写 F293 truth，待 F208 owner 迁出后再退出导航。F051 quota surface 保持 evidence source，不复制 editor。
2. ✅ Design contract：`quota_pool` 只有在 provider 暴露稳定 pool identity 且 runtime catalog 能证明 cat→pool binding 时才启用；否则只支持 cat/provider scope，不造账号或额度池抽象，也不阻塞 Phase A。
3. ✅ Design contract：provider adapter 明示 `recoveryStrategy: cheap_probe | dispatch_success | manual`；未知 provider 默认只接受真实 dispatch success 或人工恢复，禁止凭空发明 recovery probe。
4. ✅ Design candidate：global preference 使用 owner-scoped versioned Redis store；runtime catalog 是 binding input，thread F042 policy 是局部 override，二者都不是 global preference 真相源。
5. ✅ Design candidate：preflight budget 120ms；连续 5 次失败开 circuit 30s；half-open 单 probe；degradation audit 按 owner+failure class 30s 去重。运行健康由 F153 metrics 调参。
6. ✅ Revised design contract：F293 只消费 F208 applied dossier revision；pending/rejected proposal 只显示 freshness。`reviewAfter` 到期的偏好变 `review_due` 并停止重排，避免旧认知无限期主导候选。
7. ⏳ Continuity slice gate：ordinary A2A 如何复用 F167/F233 形成 durable custody acceptance 与 exact predecessor fallback；不阻塞 Phase A routing kernel。
8. ⏳ Continuity/experience slice gate：Cancel disposition 与 F246-compatible exact multi-party AND-join 的最终交互/contract；不阻塞 Phase A routing kernel。

## Key Decisions

- **KD-1**: F293 是一个终态 feature；不另建 temp-status MVP。
- **KD-2**: 不引入 Sol 私人/公司 `ExecutionSlot`；不可感知就不建模、不展示、不猜。
- **KD-3**: 负面状态到期变 `unknown`，绝不自动 `available`。
- **KD-4**: `scarce` / `degraded` 是 advisory；已知物理 `unavailable` 是 dispatch hard gate。
- **KD-5**: L0 只投影稀疏异常；实际发送前必须基于同一 resolver 重检。
- **KD-6**: 给证据和 alternatives，不给 opaque score，不静默改派。
- **KD-7**: signal 历史 TTL=0；时间字段只控制 active projection。
- **KD-8**: 每类事实一个 canonical owner；F293 负责组合，不复制所有真相。
- **KD-9**: routing-context preflight 自身故障时 warned fail-open，并记录 degradation；advisory 子系统不得成为 dispatch SPOF。
- **KD-10**: 真实 dispatch 成功只对因果匹配且可证明的 route/scope 构成 recovery evidence，不外推账号或无关 pool。
- **KD-11 (Design candidate)**: signal / global preference 是 owner-scoped truth；projectPath 只作 provenance，resolver 与当前 catalog/candidates 取交集。
- **KD-12 (Design candidate)**: 动态状态不写进缓存的 native L0 roster；每轮 cognition projection 走 `invoke-single-cat` staging-adjacent prompt path。
- **KD-13 (Design candidate)**: signal 使用 TTL=0 immutable event log；recover/retract 以 causal signal refs 收口，不做 last-write-wins 状态覆盖。
- **KD-14 (Reality-grounded design candidate)**: F284 canonical `WorkspaceMode='team'` 是 F293 routing/profile 日常 action surface；由 mode/meta registry 和 `WorkspacePanel` 渲染，不新增 Header icon、sibling host 或 NowSurface 语义。Team detail 在 mode 内嵌套；Settings 只拥有成员/runtime 结构配置与 F293 只读路由账本。F208 observation/provenance source workflow 保留 owner 边界，不得变成第二个 F293 editor。
- **KD-15 (Design candidate)**: preflight 逐 target 决策；用户消息保留，rejected child 不创建，结果进入原消息 receipt 或 typed callback result。
- **KD-16 (Design candidate)**: long-term preference 用 typed `appliesWhen` + subject refs，不以自由文本 condition 驱动运行时。
- **KD-17 (Design candidate)**: resolver timeout/circuit/audit dedupe 初始参数为 120ms / 5 failures / 30s / 30s，并由 F153 telemetry 调参。
- **KD-18 (Revised design candidate)**: F293 以 applied dossier revision + relevant evidence refs 消费 F208；pending proposal 无路由权威，revision/hash 参与 cache invalidation。
- **KD-19 (Revised design candidate)**: preference `reviewAfter` 到期派生 `review_due`，记录保留但停止重排 alternatives，直到 renew / supersede / retire。
- **KD-20 (Reality-grounded design candidate)**: 后台 routing signal 只更新 Team read model 与 needs-you Activity，绝不导航或抢 Focus；Launcher、mention、receipt、Settings migration 仅在显式用户动作时经共享 `openTeamSubject(subjectRef?)` 进入 Team list/detail。
- **KD-21 (Revised scope)**: F293 拥有 routing assurance 用户旅程，不拥有 custody/liveness/approval 的第二套状态机。
- **KD-22 (Design candidate)**: delivery、custody acceptance、carrier terminal 与 subject completion 是四个独立事实；失败有界唤醒 exact predecessor。
- **KD-23 (Design candidate)**: Cancel 默认停止 exact carrier 并暂停/回到既有 predecessor；reroute/take-over/close 必须显式。

## Review Gate

- **Kickoff spec gate: PASS** — Ragdoll完成终态边界、failure modes、账号不可感知纠正与 AC 可验证性审阅；2×P1 + 1×P2 已在 `986b7412b52bb38ad003b74ed0e34e07b72f31fa` 闭合，final verdict 无 open items（`0001786252263358-000838-6961a286`）。
- **Phase A Design Gate v1: PASS at `cd1bfc67`** — 独立 reviewer 已确认 owner scope、dynamic prompt boundary、event semantics、preflight 与当时的 F284 journey，无 open blocker。
- **2026-08-30 scoped restart** — 核完 F300–F313 canonical contracts 后，冻结范围从“整个 F293 不得实现”收窄为“expanded continuity/experience slice 继续 gate”。`cd1bfc67` 已通过的 selection/preflight 连续性允许 Phase A routing kernel 开工；F300 runtime、F307 activation 与 F311 Program 均不是该 kernel 的前置条件。
- **2026-08-30 Phase A implementation gate: PASS** — PR #4109 在 exact HEAD `7492b6f640` 获非作者独立 review APPROVE（0 P1/P2），full `pnpm gate` 通过；随后以 squash commit `b6a7518518` 合入 main。Phase A 只落 domain kernel，未激活 API/UI/dispatch consumer；Phases B–E 与 expanded continuity/experience gate 继续开放。
- **2026-08-30 Phase B Design Gate: PASS (scoped)** — operator 要求基于最新 F284/F307 真实代码更新 Gate/plan 后直接 TDD 接线。Phase B 冻结为同一 resolver/read model 的 owner API、双宿主 Team surface、稀疏 cognition projection 与 actual-send per-target preflight；expanded custody/Cancel/AND-join 仍属于后续开放 gate，不能由本轮 selection/product wiring 冒领。
- **2026-08-31 F208 seam clarification** — operator source `0001788169054634-000079-0a2e5a3b` 明确外部 #1379 属于 F208 dossier field/observation/provenance/distillation lifecycle。F293 只消费 applied revision、pending evidence projection 与 Team routing UX；因此 Phase B 不删除或 redirect 掉仍承载 F208 writer 的 Settings route，而是把它 relabel 为 source workflow，并保证其中没有 F293 signal/preference editor。
- **2026-08-31 Phase B implementation candidate** — owner API/read model、F153 resolver telemetry、每轮 sparse cognition、ordinary/A2A/callback exact-target preflight、F284/F307 共享 Team surface 与 Settings 只读账本已完成 TDD 接线。直接 Playwright 在隔离 Web 5112/API 3112/Redis 6388 验证 single Workspace entry、Team list/detail/back 与 degraded `glm52` 局部告警；Hub preview delivery 因 client inactive 仅为 queued，未记作已打开。真实 degraded case 促成 `b8f310210d`：Team 保留 canonical catalog membership 和 owner action，但不伪造路由/画像。
- **2026-08-31 Phase B merged (PR #4156)** — owner API、同一 read model 的 Team/Settings、每轮 sparse cognition、ordinary/A2A/callback exact-target preflight 与 F153 health telemetry 已经 exact-HEAD review 后 squash merge。`main=landed:61c234245e31bea73f624f3884393c9d4cd62a36`。
- **2026-09-01 Phase B live evidence** — live runtime 已加载 Phase B。production snapshot 显示 catalog 28 只猫中 18 只拥有 F208 applied dossier revision；其余 10 只的候选级画像缺口曾被错误放大为全局 `built_in_profile_missing`，导致已有画像的目标也收到 warned receipt。终态契约改为：候选级缺口显式投影 `profile.state='absent'`，不拖垮 resolver；只有 dossier 整体不可用/不可读或其他真实 source failure 才进入全局 degraded；无 applied profile 的候选不得作为自动 alternatives。内部 failure class 只进入 source refs / telemetry，owner receipt 由稳定 reason code 映射成人话。
- **2026-09-02 Phase C merged (PR #4211)** — strict automatic observation contract、owner revision/timeline cache、F051 quota adapter、F153 typed health adapter 与 durable dispatch terminal feedback 已合入。Fable 完成主体架构校准；其 provider-wide recovery P2 经 Red→Green 修复后，由 Terra 对最终行为增量独立放行。canonical full gate 与最终基线 continuity checks 全绿，AC-C1–C6 完成。
- 后续实现按实际风险逐 phase 选择 reviewer；不因默认习惯持续消耗同一只猫的额度。
