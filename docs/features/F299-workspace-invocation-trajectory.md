---
feature_ids: [F299]
related_features: [F192, F233, F252, F153, F200, F237, F298, F300, F304]
topics: [observability, trajectory, invocation, workspace, ux, drill-down]
doc_kind: spec
created: 2026-08-17
description: "workspace 一等 invocation 轨迹：canonical transcript 直接投影，出事时三步确诊，猫与 eval 共享稳定证据锚点"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-18T13:05:00Z
---

# F299: Workspace Invocation Trajectory — 猫这轮干了什么，亲眼可见

> **Status**: in-progress | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1

- **operator signoff**: 2026-08-16/17 [thread-id]（`0001786845058052`「我感觉我们可以立项了……新建feat」+ `0001786950943499`「新结构：两个 feat，一条愿景，在"猫的视野快照"处交汇」）
- **Reviewer**: spec 细节由 @codex-sol 补齐；@fable5 已对 exact `c22defbd0` 完成唯一一次最终架构审核并 `APPROVE`
Architecture cell: identity-session, bubble-pipeline, hub-action-surface

Map delta: none（2026-08-24，Phase A–D 已完成，Phase E 待接线）——Phase B.2 已把 `thread-access-policy` authority subcell 登记到 `identity-session`；B.1–D 只扩展既有 transcript / projection / read policy，Phase E 复用 `harness-eval` cell 的 registry、trigger、verdict 与 re-eval closure，不新建 Store / Queue / authority

## Why

operator experience（2026-08-16）："我们没做好的最重要的是那层可展示层，我们的可观测性丢到了 config 页面，无人发现和注意。" 学 DSH 的四条纪律（不学表面形状）：**账本先于页面**（trajectory 页必须是 canonical log 的确定性投影——F233 feat 轨迹违反此律 failed-close，见 [LL-099](../public-lessons.md#ll-099-给没有-canonical-账本的对象拼轨迹是结构性失败)）、**可见即记录**（猫决策时看见的进账本，事后可确诊）、**入口长在对话现场**（workspace，不是 config 深处）、**语义先于原始事件**（人看的轨迹必须一眼分清谁说了什么、为何调用、经什么通道；Raw 才承担逐事件保真）。

体验主线：**P0 证词可信 → P1 亲眼可见 → P2 证据有地图 → P3 上下文可解释**——每步把对猫的信任从"听猫说"推向"亲眼看见"。

## Current State / 现状基线

- Session 证据入口已存在但无"被感知的形状"：SessionChainPanel + AuditExplorerPanel 挂在 `RightStatusPanel.tsx` L489/L515（右侧 workspace），**operator 以为在 config 页面**——命名工程化 + 位置沉底（实测 friction evidence，`0001786842756533`）。Phase B 初版把两者一起退役，后续现场验收证明这误伤了 F284 “状态与会话”的持久 Session 追账能力；最终只退役 Audit Explorer 的重复常驻宿主，Session Chain 保留为状态摘要。
- 实测一条真实 invocation：923 events 中 870 条 status 噪音；Handoff 行停在 session 层点不进 invocation（DSH 审计 §5.2/§5.4）。
- Handoff 分页契约 bug（invocation 被 raw cursor 切碎成矛盾摘要）已修：PR #3747 merged 2026-08-17。
- 猫侧 MCP drill 链（digest → handoff → invocation detail）真实可用且强于 DSH，但无人形入口。
- 2026-08-20 Phase B 合入后，operator 用 DSH 实机截图对照当前 trajectory，确认四项语义缺口：用户触发输入未进入轨迹；`USER / ASSISTANT / SYSTEM / CONTEXT` 虽有部分 role 数据却统一显示为 `MESSAGE`；流式文本按 raw event 拆成多张卡；工具卡不区分 MCP / host CLI / plugin 等来源。另有顶部 `工具 0` 与详情已出现 `command_execution` 的现场矛盾。代码证据分别落在 `invocation-trajectory-model.ts` 的逐 event 投影、`InvocationTrajectoryDetail.tsx` 的统一 message renderer，以及 `TrajectoryPanel.tsx` 对 list summary 优先于 detail summary 的选择。

## What

### Phase A: P0 修 handoff 分页契约

先按 invocation 完整归组再分页；cursor 保持 raw eventNo 外部契约不变，内部按 raw-event budget 累加完整 invocation（不拆）。✅ merged [PR #3747](https://github.com/zts212653/clowder-ai/pull/3747)（author opus-46，reviewer gpt52 两轮 + Maine Coon终审 merge-gate）。

### Phase B: P1 入口连通 + 降噪

### Phase B.1: P1 语义阅读层纠偏

保留 Phase B 已完成的入口、降噪、导航和 canonical projection，只修正“事件存在但人读不懂”的投影契约：

- 轨迹以 canonical `promptMessageIds` 引用的**触发输入**开场，显示用户消息摘要并可返回原消息；不向 transcript 复制第二份正文，缺失时显示 typed absent reason。
- 人类时间线以标签 + 图标 + 辅助色共同区分 `USER / ASSISTANT / SYSTEM / CONTEXT / TOOL / ERROR`；颜色不能成为唯一语义载体。`SYSTEM` 只表示确有该类型的 canonical event，不把 `mcp server status` 冒充 initial system prompt。
- 连续 assistant 流式片段按 invocation 内的语义消息合并，尊重 `append / replace` 与 tool/error 边界；`Raw` 保留原始 event 粒度，避免可读性和证据保真互相污染。
- 工具卡同时显示动作名与 typed source/channel（如 `MCP / host CLI / plugin or connector / unknown`）；已知 provenance 不靠字符串猜，canonical 缺失时诚实显示 `unknown`。
- list summary 与 invocation detail 使用同一或单调更新的快照；详情已有 tool 时，顶部不得继续显示 `工具 0`。

机制按 claim 选择：角色/触发输入/工具 provenance 属于 typed schema + contract test；流式合并与 summary/detail 一致性属于 projection regression test；颜色、标签、键盘与触屏辨识属于 UX 对照验收。上述均为确定契约，不另造 eval；Phase E 只评估 inspector 的异常调查效用。

### Phase B.2: thread access policy repair（P1，B.1 实现前 merge）

**事故**（2026-08-21 dogfood，[thread-id] `0001787195510517`）：user-indexed 的非 default system thread（如 `thread_eval_friction`）在侧栏可见，但 Sessions / Transcript / Invocations / 猫猫大剧院被旧 guard 拒绝 403——"用户索引可见权限"（F192 #1913）与"thread.createdBy 必须等于当前用户、system 只特判 default"的读取权限（`session-chain.ts:244` / `session-transcript.ts:102` 借用 `guides/guide-state-access.ts:19` 的 `isSharedDefaultThread`）两套规则分叉。直接触发者 #3787（本 feat 新增 `/invocations` 沿用旧模型）；同族前科 #2605（F252 Theater 复用 Sessions）、#1913（F192 索引给用户却未扩读权限）。

**归属裁定**（owner fable-5，2026-08-21）：本 feat 作为直接触发者承担 repair slice 的立案、排期与验收；但**修复层不在 F299 route**——三次同族事故证明 thread access policy 是无主 authority（ownership cells 无归属，guard 散落在 guides 域 helper 与各 route 手写 403），再在 `session-transcript.ts` 放宽一次 = 第四次补锅。修复落在 `identity-session` cell 新增 **`thread-access-policy` authority**（identity × resource × action 单一判定），Sessions / Transcript / Invocations / Theater 四个 consumer 改为共用；user-indexed system thread 下只返回按当前用户过滤的 session/transcript 子集，**不把"侧栏可见"扩大为"可读该 thread 下所有用户 session"**。前端不再把 403 吞成 `0 total`（`SessionChainPanel.tsx:196`）。F303 只管 Design Gate 归一性，不接本 repair。

### Phase C: P2 精确 invocation 证据投影

Phase C 不建设 evidence manifest、通用 evidence-ref 协议或新的跨域 registry。它只把现有坐标接通：

- **共享锚点只有已有的 `inv:<invocationId>`**。这里的 `invocationId` 是 transcript/F192 使用的 exact `TurnExecution` child id；resolver 先读取该 durable child ledger，再经 `parentInvocationId` 对照 canonical `InvocationRecord`，最后以 child 的 `threadId/catId` 在可见 SessionChain / transcript 中定位 `sessionId`。对外不要求 evidence 重复携带派生坐标，也不把当前页面 thread 当真相；child、parent 或 session 缺失、identity 不一致、访问策略拒绝时均 typed fail-closed。
- evidence 自带的 `threadId / sessionId` 只能作为 lookup hint，使用前必须与 canonical record/session 对照；hint 冲突 fail-closed。解析与读取继续复用 Phase B.2 的 `thread-access-policy`，不因拿到 invocationId 绕过用户过滤。
- transcript 是 inspector 已有主证据；Prompt X-Ray（F237）、trace（F153）、task trajectory（F200）等只在各自 owner 能解析时显示 source-owned link。集合开放、按需出现，不要求四源齐全；F299 不复制 payload、不持久化 availability、不统一发明 absent reason。
- F192 只为**确实能归因到单个 invocation** 的新 verdict evidence 追加同一个 `inv:<id>`；metric / snapshot / session / trace 等非 invocation evidence 保持原生引用。ref 卫生债在 F192 producer 侧收敛，F299/Hub 不学习 `session:.../invocation:...`、`attribution:...` 等多套语法。既有 verdict artifact 不回写。

因此边界保持不变：F192 管判断与 evidence producer hygiene，F153/F237/F200 管各自证据，F299 只管可读投影、精确导航与返回现场。

### Phase D: P3 durable request envelope

持久化 Clowder AI 自己组装的模型可见输入：effective system prompt / runtime context snapshot / L0 版本与 injection decision / skills 与 memory 注入 / provider+model config / tool schema hash / compaction 与 retry/error 边界；**含 F300 视野快照（交汇点）**。retention 从出生遵循 ADR-045 推论 1/2（内存只作 cache、TTL 只做 GC 不做注销），不进 F298 存量家族表（2026-08-17 跨 session 裁定）。

Gate 0 经 operator 与 @fable5 以奥卡姆剃刀收敛（`0001787500223746-000067-a890cf02`、`0001787500358068-000071-bd47674c`、`0001787503434011-000116-f8a9a068`）：**request envelope 是 Session transcript 的组成部分，不是拥有独立隐私/访问/删除规则的新实体。**唯一规则是：

> 证据默认持久；You 界面默认摘要、按需展开；猫不被自动灌入完整输入，而是沿现有 user/thread 与各 source owner 的读取规则顺藤摸瓜；源数据被 hard-delete/forget 时，transcript 内的 exact 副本同步失去可读正文。soft-delete 仍继承现有可恢复语义。

因此不新增 originating-cat / reviewer lease 权限、不新增 assignment ledger、不新增“删除模型输入”动作。知道 `inv:<id>` 不能绕过 Phase B.2 的 `thread-access-policy`；段级内容按 `sourceRef` 继承既有 owner scope，persona-private / memory / external tool 等来源不会因进入 envelope 而扩权。You 与猫的差异是消费方式（页面 reveal vs bounded drill），不是两套授权体系。exact bytes、generation、keyed digest / 去重 blob 只属于 transcript 内部存储机制，不成为第二本 context ledger 或第二套生命周期真相。

### Phase E: P4 inspector 效用 eval

作为 F192 既有控制面的 `eval:trajectory-inspector` domain 注册，不在 F299 自建 scheduler、verdict store 或第二套 Eval Hub。consumer =「F299 owner 与 operator 对 You/猫调查异常 invocation 的体验作 keep/tune/sunset」；以异常调查 time-to-evidence、根因证据闭合结果、Raw/JSONL grep 回退为多维向量，不合成总分、不以打开率衡量价值。

**当前进度（2026-08-24）**：Phase A–D 已全部 merge，并完成 merged-main Alpha；Phase E 是 F299 唯一剩余阶段。F192 Phase I 的共享 time/threshold trigger dispatcher 已落地，但仓库中尚无 `eval:trajectory-inspector` registry entry、source adapter、publish adapter 或 system thread，不能把“出生证已冻结”冒充“domain 已接线”。下一步只做 F192 domain onboarding + 可重放 episode/reducer + verdict/re-eval 闭环，不扩 F299 页面、不再设计第二套指标或调度。

## 消费者与时刻（防 Goal Drift · operator 灵魂拷问 `0001786985975123` 后修正）

operator 原话："我到底要看什么捏？……这好像有点在看 debug mode 了？"——**对，这就是正确定位**：

| 消费者 | 频率 | 时刻 |
|--------|------|------|
| **猫**（主力） | 日常高频 | 跨猫 review 取证 / 责任判定 / 压缩后自查 / 回复中给证据锚点（PR #3747 链上猫们已在用文本 ID + grep 互相取证） |
| **You** | 低频高价值 | **异常时刻确诊**（debug-mode）；日常应感知的是 F300 效果（猫变聪明），不是猫的内脏 |
| **eval / CWE** | 中频 | verdict 证据样本下钻（AC-C2） |

**Anti-goal**：不以 You 打开率 / inspector PV 为成功指标——operator 不日常消费是设计预期。若只有"You 看猫"一个消费者，本 feat 不成立。

## 三层栈定位（operator 2026-08-17 定调，`0001786971350592`）

> 展示层 **F299**（You 看猫）· 送达层 F300（猫看家）· 持久层 F298（承诺活得够久）——每层终态，不被谁推翻。

F298 保证事实**活着** → F300 保证事实**到达**猫的判断点 → 本 feat 保证事实**被人看见**。依赖单向向下。

## User Journey

### Primary Journey: 出事确诊三步
- **Scope unit**: message
- **Actor**: operator
- **Entry**: 出事消息旁的常驻高亮锚点（如"⛔ 这轮被取消 · 看轨迹"）
- **Flow**:
  1. 某轮猫出事（error / cancelled / 行为怪异）→ 该消息旁自动出现高亮锚点
  2. 点击 → workspace 切到"轨迹"mode 并定位到该 invocation
  3. inspector 从“You 当时问了什么”开始，按 `USER / ASSISTANT / SYSTEM / CONTEXT / TOOL / ERROR` 显示语义时间线；流式碎片已合并、status 已折叠、工具动作与来源可辨，再给终态与死因、最后动作、证据条 → 确诊完成
  4. 关闭或返回 → 根据 `originRef` 回到原消息并恢复原滚动位置，不丢失调查现场
- **Non-goals**: 日常浏览（见 Anti-goal）；逐事件重演；健康消息主动曝光锚点

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | thread | 猫猫 | 回复中给 `inv:<id>` 锚点 → F299 从 canonical child execution / parent record / session 解析位置 → 对方一键打开同一 invocation 取证 | 实现后录屏 |
| S2 | workspace | operator | Eval verdict 中精确归因的 `inv:<id>` chip → 点击 → 轨迹 mode 定位该 invocation → 返回原 evidence card | 实现后截图 |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “最重要的是那层可展示层……无人发现和注意”——入口必须长在消息现场并在 Workspace 可召回 | AC-B1、AC-B3 | alpha 截图 + 键盘/触屏交互测试 | [x] |
| R2 | 出事时能回答“这轮怎么了”，不能被 status 流水淹没 | AC-A1、AC-B2 | 分页回归测试 + 923-event 真实样本实测 | [x] |
| R3 | 猫与 Eval 能共享同一 `inv:<id>` 锚点，但不合并页面、不复制派生坐标 | AC-B4、AC-C1、AC-C3 | 跨 surface 路由测试 + 录屏 | [x] |
| R4 | 轨迹只能投影 canonical truth；来源不可解析时不猜、不冒充“没发生” | AC-C1、AC-C2、AC-D1 | contract test + owner/sourceRef fixture | [x] |
| R5 | F252 Story Player 不能因 legacy TrajectoryPanel 替换而断链 | AC-B5 | `/story/feat:*` 兼容测试 + Workspace Launcher/ThreadSidebar 入口测试 | [x] |
| R6 | Inspector 是否值得保留由异常调查效用决定，不以打开率代偿 | AC-E1 | Eval Hub keep/tune/sunset verdict | [ ] |
| R7 | 新轨迹面落地后 Audit Explorer 的重复常驻宿主必须退役；“状态与会话”仍保留 Session Chain / ID 摘要，sealed session、搜索与 Raw 在 trajectory 深挖面等价可达 | AC-B6 | 非作者对照实测 + canonical transcript/MCP drill 回归 | [x] |
| R8 | “用户到底发了什么？”——invocation 轨迹必须从触发输入开始，并能回到原消息 | AC-B7 | MessageStore ref contract test + direct-link/返回现场实测 | [x] |
| R9 | “到底是 sys、msg 还是什么？”——角色/类型不能统一压成 `MESSAGE`，颜色也不能独自承载语义 | AC-B8 | component test + 键盘/触屏/非颜色辨识截图 | [x] |
| R10 | “一条消息拆分成那么多”——人类轨迹合并流式片段，Raw 仍逐 event 保真 | AC-B9 | append/replace/tool-boundary regression fixtures | [x] |
| R11 | “具体调用 tool 还是 MCP 也没有区分”——工具动作、来源与结果必须分别可辨 | AC-B10、AC-B11 | typed provenance contract + active/sealed summary/detail 对照 | [x] |
| R12 | 侧栏能看见的 system thread，其轨迹/Sessions/大剧院不能 403；修在统一 access policy，不扩权也不各修各的 | AC-B12、AC-B13 | identity×resource×action contract 矩阵 + `thread_eval_friction` 红绿实测 | [x] |
| R13 | “Design Gate 和真实页不能卖家秀/买家秀”——保留真实页更好的紧凑密度、单标签与内联工具详情，恢复设计稿更好的角色渐变与错误强调 | AC-B14 | 真实组件浏览器回归：light / dark / 390px + computed style 对照 | [x] |
| R14 | F192/F153/F299 接线不能制造第四套 manifest/ref/availability 权威 | AC-C1、AC-C2、AC-C3 | ownership + negative contract tests | [x] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC
- [x] 每个 AC 都有测试、截图、录屏或 verdict 之一作为验证方式
- [x] 前端需求已完成需求→证据映射；304-event 浏览器真链验证了语义标签、工具 inspector、Raw 顺序与保头尾折叠，component fixtures 覆盖六类角色和 typed provenance；真实 `InvocationTrajectoryDetail` 浏览器 fixture 继续守住六类渐变、错误强调、light/dark token 适配与 390px 无横向溢出

## Acceptance Criteria

<!-- AC↔Why 同源：A=证词可信 / B=亲眼可见 / C=证据有地图 / D=上下文可解释 / E=效用闭环 -->

### Phase A（P0 分页契约）
- [x] AC-A1: 同一 invocation 不因 raw cursor 出现互相矛盾的 tools/text summary；含 mid-invocation cursor 回归测试（PR #3747 merged，5/5 pass）

### Phase B（P1 入口连通 + 降噪）
- [x] AC-B1: 从任一猫消息 ≤2 步进入该轮 invocation detail；健康态入口同时支持 hover、keyboard focus 与消息操作，触屏/键盘不依赖 hover
- [x] AC-B2: status 事件默认折叠，923-event 真实样本首屏有效信息 ≤15 行（非作者实测）
- [x] AC-B3: 锚点异常优先显形——done 安静且只在 hover/focus/消息操作中亮起，error/cancelled/超时常驻高亮（对照 Design Gate D4）
- [x] AC-B4: 消息与 Eval 入口都携带 typed `originRef`；关闭/返回恢复准确来源与滚动位置，且 direct-link 无来源时安全退回轨迹列表
- [x] AC-B5: F252 Story 入口 migration 后不断链：ThreadSidebar 继续打开现有 Theater Overlay，Workspace Launcher 提供“猫猫大剧院/回放”召回，`/story/feat:*` 保持兼容；F299 不再拥有 feature story selector。F304 仅退役 F233 production collector cron，历史 projection 与该兼容入口继续可读
- [x] AC-B6: 旧 RightStatusPanel 的 AuditExplorerPanel 重复常驻面退役；F284 “状态与会话”保留持久 SessionChainPanel / ID 摘要，并区分正在工作、未封存可续接、封存中与已封存；sealed session 浏览、事件搜索、Raw 视图在 trajectory mode 等价可达（非作者对照实测），canonical transcript 数据与 MCP drill 不受影响

### Phase B.1（P1 语义阅读层纠偏）
- [x] AC-B7: 每条可归因 invocation 从 canonical `promptMessageIds` 投影“触发输入”摘要与原消息链接；不复制正文，缺失/不可见/已删除均以 typed 状态呈现（TurnExecution late-bind CAS + MessageStore projection contract；未覆盖 trigger / execution scope mismatch fail-closed；Redis late-bind 不改 legacy `causal / immutableIdentity`，混跑旧 reader 仍可读）
- [x] AC-B8: 人类时间线以非颜色单一依赖的标签/图标/辅助色区分 `USER / ASSISTANT / SYSTEM / CONTEXT / TOOL / ERROR`；测试证明 role 不再统一渲染为 `MESSAGE`（component test 覆盖六类文字标签、SVG 图标与 token-based accent；无重复 legend/filter）
- [x] AC-B9: 同一语义 assistant 消息的连续 stream events 按 `append / replace` 合并，tool/error/turn 边界不跨越；Raw tab 的 event 顺序和 payload 不变（projection regression 覆盖三片段 replace/append、三种边界与逐 event Raw）
- [x] AC-B10: 每张工具卡分别显示 canonical 动作名、typed source/channel 与结果状态；无法确定来源时显示 `unknown`，不得伪分类（Codex host CLI / MCP producer contract + invalid/legacy provenance negative controls）
- [x] AC-B11: list/header summary 与 detail 对同一 invocation 的 tool/message count 一致或单调更新；回归测试覆盖“顶部工具 0、详情已有 command_execution”现场（detail snapshot patch 回 list；数字取单调 max、名称取 union）
- [x] AC-B14: Design Gate ↔ 真实页面 parity audit 明确保留真实实现的紧凑单列、单一语义标签、内联工具详情、无伪时间戳与无重复图例；六类语义卡恢复从各自 `--conn-*-bubble-bg` 向 `--cafe-surface-canvas` 过渡的低饱和渐变，ERROR 另有非颜色 inset 强调。回归必须渲染真实 `InvocationTrajectoryDetail`，验证 light / dark / 390px 下六类 computed gradient 互异、错误强调存在且页面无横向溢出，不能只断言 class 字符串

### Phase B.2（thread access policy repair）
- [x] AC-B12: Sessions / Transcript / Invocations / Theater 四个 consumer 共用 `identity-session` 下单一 `thread-access-policy` authority，各 route 不再手写 owner/default-thread 判定；contract test 覆盖 identity（owner / 非 owner 用户 / system-indexed 用户）× resource（default thread / user thread / user-indexed system thread / 未索引 system thread）× action（list sessions / read transcript / read invocations / theater replay）全矩阵，每格期望 200/403 显式
- [x] AC-B13: user-indexed 非 default system thread 下，当前用户可读的 session/transcript/invocation/theater 为按用户过滤子集（非全部用户）；`thread_eval_friction` 现场红→绿；前端 403 以 typed 拒绝原因呈现，不再吞为 `0 total`

### Phase C（P2 精确 invocation 证据投影）
- [x] AC-C1: `inv:<id>` 先解析 exact child `TurnExecution`，再经其 `parentInvocationId` 对照 canonical InvocationRecord，并在可见 SessionChain/transcript 中定位真实 `threadId/sessionId` 后才打开 inspector；child/parent identity 与 source hint 必须对照、冲突 fail-closed，当前页面 thread 不得兜底猜投。权限回归证明单键入口仍经过 `thread-access-policy` 与当前用户 record 过滤
- [x] AC-C2: Inspector 只展示 source owner 在读取时可解析且可消费的 evidence links；Prompt X-Ray 必须以同一 `apiFetch` / `API_URL` / session transport 预读 detail 成功后才显示，并复用第一方人类可读 Prompt Inspector，禁止相对 raw API 导航。source owner 403/404 时不渲染该 chip；transcript / prompt capture / trace / task trajectory 不构成必齐清单。F299 无 manifest/store/新 registry，不复制 payload、不持久化 availability、不跨 owner 推断 absent reason
- [x] AC-C3: F192 producer 对精确 invocation evidence 输出已有 `inv:<id>`，Hub verdict card 可打开 F299 并用既有 `TrajectoryOriginRef` 返回原 card；非 invocation evidence 保留原生链接，F299 不解析其他 ref grammar，历史 verdict 不回写

### Phase D（P3 request envelope）
- [x] AC-D1: envelope 回答"这轮猫看见了什么"，覆盖 effective system prompt、runtime context snapshot、skills/memory 注入、model/provider config、tool schema hash、compaction 与 retry/error 边界，并精确到 L0 版本与注入决策；scope = Clowder AI-owned assembly，外部 runtime 标 capability label，不冒充 universal truth，也不把 Phase B.1 的展示标签冒充完整模型输入。每代必须把实际 launch 的同一不可变 bytes 在 provider 调用前 durable append 到当时 active Session transcript，失败则 fail-closed 不 launch；retry/seal 跨 Session 仍由同一 TurnExecution child 保序串联。读取继续经过 `thread-access-policy` 与段级 `sourceRef` owner scope：You 默认摘要后按需展开，猫按需 bounded drill 而非自动注入；不得新建 originating-cat / reviewer-lease 权限。source hard-delete/forget 必须让 envelope 副本正文同步不可读，soft-delete 维持现有可恢复语义

### Phase E（P4 eval）
- [ ] AC-E1: `eval:trajectory-inspector` 经 F192 registry / verdict / re-eval closure 产出 keep/tune/sunset；使用 time-to-evidence、根因证据闭合结果、Raw/JSONL grep 回退三维向量，沉默 episode 不从分母消失，不合成总分、不含打开率

## Eval / Tracking Contract（Phase E）

### E0 资格

- **GT domain**: 产品效用——Inspector 是否让真实异常调查更快得到可复核的 canonical evidence；不是“页面是否符合 spec”（后者由 Phase C contract test 判定）。
- **新鲜 bit**: F299/F192 可观察入口、时间戳、evidence ref 与 fallback；“根因证据是否足以支持处置”由抽样 episode 的实际调查者/非作者复核提供。外部 bit 缺失时只能 `keep_observe`，不得自动宣称效用成立。
- **付薪方**: verifier 成本由 F299 contract tests 承担；效用校准使用 F192 周期 eval 与少量随机盲抽/风险定向人工复核，不使用付费 judge。

```yaml
metric_birth_certificate:
  utility_claim: "异常 invocation 的调查者更快拿到可复核的 canonical evidence，且更少退回 Raw/JSONL grep；不增加错 invocation 或错 thread 归因。"
  estimator:
    episode: "error/cancelled/timeout 或 F192 finding 明确指向 invocation 的调查机会；未打开/未闭合保留为 not_taken/unresolved，不静默丢弃"
    vector: [time_to_first_accepted_evidence, evidence_outcome, raw_or_jsonl_fallback]
    baseline: "匹配 Phase C 前同类异常调查；无可比历史样本时首个窗口只作校准，不作 keep/tune/sunset"
    exclusions: [passive_daily_browsing, synthetic_component_fixture, investigation_not_about_an_invocation]
  validity_bounds: "样本少于 10 个 eligible episodes、canonical record/session 覆盖退化、异常类型或模型/runtime 版本显著漂移、人工复核分歧率超过 20% 时只报分布与 gap，不给效用 verdict"
  consumer: "F299 owner + operator，经 F192 eval:trajectory-inspector 决定 keep / tune / sunset"
  calibration_plan: "首批 10 个 episode 后抽查：随机 3 个 + 全部 wrong/unresolved；以后每个 verdict window 同样校准。出现任一 wrong-invocation/thread 立即停止效用结论，先修观测面"
  repeatability_contract: "冻结 episode ids、F299/F192 revision、source snapshots 与人工 outcome；deterministic reducer 重跑必须完全一致，人工分歧单列，不用平均总分掩盖"
```

### Regression fixtures 与退役判据

- **Fixtures**: PR #3747 同一 invocation 被分页切碎；304-event / 923-event 长轨迹；user-indexed system thread 403；F192 evidence 指向另一 thread；canonical record 缺失或 hint 冲突。
- **Tune**: 任一 wrong-invocation/thread，或两个校准窗口中 Raw/JSONL fallback 不降且 unresolved 不改善——先简化导航/证据呈现，不扩指标。
- **Sunset**: 连续两个各 ≥10 episode 的校准窗口相对基线在 time-to-evidence、evidence outcome、fallback 三维均无改善，且维护成本持续高于调查收益，则 sunset Phase C 的跨域 evidence projection；canonical transcript、Raw 与 MCP drill 保留。

## Dependencies

- **Evolved from**: F233（failed-close 传承：workspace `trajectory` mode 位 + Phase C 代码 rm/migration 决策归本 feat）
- **Blocked by**: 无。Phase D Gate 0 已于 2026-08-23 经 operator 裁决关闭；实现继续受既有 transcript / source owner / thread access 合同约束
- **Cross-feature boundary**: Phase C 的 `inv:<id>` producer hygiene 与 Phase E domain 注册归 F192；F299 只拥有 resolver/inspector/navigation。两边在各自 ownership cell 实现，不新立共同层
- **Related**: F192（eval verdict/evidence producer + Phase E control plane）、F252（#2605 Theater 复用 Sessions——B.2 共同受益方）、F300（"猫的视野快照"在 Phase D 交汇）、F252（TrajectoryPanel 现存消费方，AC-B4）、F298（#4 仅供 credential disposition，不供业务终态）、F237（Prompt X-Ray 证据源）、F153（trace 证据源）、F200（taskTrajectory 证据源）

## Risk

| 风险 | 缓解 |
|------|------|
| 重蹈 F233"AC 全绿但 operator 从未消费"（Goal Drift） | 消费者定位 + Anti-goal 写死在 spec；Phase E 指标不含打开率 |
| F252 Story 入口断链 | AC-B5 显式验收；D9 已冻结“ThreadSidebar + Workspace Launcher + legacy URL compatibility”，F299 不接管 Story ownership |
| Phase D 隐私越界 | envelope 归 Session transcript；读取复用 `thread-access-policy` 并按段继承 source owner scope，不新建猫角色/权限/删除语义；retention 出生合规（ADR-045 推论 1/2） |
| 展示层被误当第二真相源 | LL-099 家规：只投影 canonical transcript，不建新表；review 检查项 |
| 入口过度曝光制造噪音税 | D4 异常优先显形；健康消息不打扰 |
| 只靠颜色区分角色造成无障碍退化 | 类型文字与图标为主、颜色为辅；键盘/触屏/非颜色辨识纳入 AC-B8 |
| access policy 第四次各修各的（#1913→#2605→#3787 同族复发） | B.2 修在 `identity-session` 单一 authority，四 consumer 共用；review 检查项：route 内不得新增手写 owner/default 判定 |
| 为可读性合并后损伤证据保真 | 人类时间线合并，Raw 永远保留原始 event；两者由同一 canonical source 投影 |
| 工具来源靠名字猜导致误标 | provenance 由 canonical typed field 承担；缺失显式 `unknown`，不推断成 MCP |
| `inv:<id>` 入口被实现成绕过 thread 权限的全局后门 | TurnExecution child 与 parent InvocationRecord 只负责 canonical 定位及 identity 对照；读取仍经 `thread-access-policy` + 当前用户 record 过滤，hint 冲突 fail-closed |
| Hub 为兼容历史债学习越来越多 ref grammar | 格式卫生在 F192 producer 侧收敛；F299 只认 `inv:<id>`，历史 artifact 不回写、不猜解析 |
| F299 固化四源 manifest 后与 F153/F237/F200 状态漂移 | 来源集合开放、读取时由 owner 解析；F299 不持久化 availability/absent reason |
| Phase E 因只采“主动打开”形成幸存者偏差 | eligible anomaly opportunity 是 episode；not_taken/unresolved 留在向量中，人工校准后才出 verdict |

## Tips Contribution（F244）

- 已更新既有 tip `feature-f299-invocation-trajectory`：从出事消息进入 Workspace 轨迹后，先看 canonical 触发输入，再按六类语义卡与工具来源/结果确诊；Raw 保留逐事件证据。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 学 DSH 三纪律，不抄对象与承诺（单 agent → 多猫协作体；provider-native truth → assembly exactness + capability labels） | 结构性差异，见 thread 卡片"抄骨不抄皮" | 2026-08-17 |
| KD-2 | 消费者排序：猫 > eval > You（异常时）；Anti-goal 不以打开率为成功 | operator 灵魂拷问；防 F233 Goal Drift 复刻 | 2026-08-17 |
| KD-3 | 共享锚点不共享页面（eval/CWE 是锚点 consumer，不合并面板） | 防超级面板回潮 | 2026-08-17 |
| KD-5 | `originRef` 与多模态可达性是入口契约，不是实现 polish | 否则轨迹会把用户从原调查现场带走，且 hover-only 会让触屏/键盘用户失去入口 | 2026-08-18 |
| KD-6 | Phase B.1 学 DSH 的 typed event language，不照抄 palette：人类时间线语义合并，Raw 保持逐事件 | DSH 对照暴露的根因是 taxonomy 没显形，不是少一套颜色；可读性与证据保真应分层承担 | 2026-08-20 |
| KD-7 | “触发输入”引用 MessageStore，完整模型可见输入留在 Phase D envelope | 前者回答“这轮因何开始”且可返回现场；后者涉及 system/context/skills/config/retention，不能混成一张 USER 卡 | 2026-08-20 |
| KD-8 | Phase B.1 不新增角色 Filter；删除重复图例，长轨迹采用保头、保尾、保异常的原位折叠 | 10 天 776 invocation 样本中 TOOL p50/p90=20/147，而 SYSTEM+CONTEXT p50/p90=1/3；旧前 N 行截断会隐藏后段 error 与失败工具，角色 Filter 不解决主要拥挤源 | 2026-08-21 |
| KD-9 | Phase C 不建 evidence manifest / universal ref；跨 surface 只共享既有 `inv:<id>`，位置由 canonical child execution → parent record → session 解析 | 坐标维度应等于真实自由度；派生 thread/session 不应成为 evidence producer 的重复负担，也不能用当前页面值猜投 | 2026-08-22 |
| KD-10 | Phase E 是 F192 `eval:trajectory-inspector` domain，不是 F299 自建 eval | 复用既有 registry、verdict、handoff 与 re-eval closure，避免第二套控制面 | 2026-08-22 |
| KD-11 | Phase D envelope 是 Session transcript 的组成部分，段级按 `sourceRef` 继承既有 owner scope；You reveal 与猫 bounded drill 只是两种消费方式，不构成两套权限 | operator 指出 originating-cat/reviewer 限制会与记忆读取及 B.2 `thread-access-policy` 冲突；奥卡姆剃刀要求删除独立 privacy/access/delete 层，同时保留 actual-bytes-before-launch 的证据合同 | 2026-08-23 |

## Review Gate

- Phase B: ✅ @fable5 已对 exact `c22defbd0` 完成唯一一次最终架构审核并 `APPROVE`；AC-B6 已消费，可进入 F128 执行 thread，标准跨个体 review + merge-gate
- Phase B.1: 语义范围由 operator 2026-08-20 DSH 对照反馈冻结；实现前只补一版在地视觉稿确认 OQ-4，不重开 Phase B 架构评审
- Phase B.1 / B.2 implementation: ✅ @codex-sol author；@kimi 已完成非作者 exact-HEAD review；Phase B.2 PR #3833 与 Phase B.1 PR #3834 均已合入
- Phase C: ✅ 方向经 operator 2026-08-22 收敛；实现按 F299 resolver/UX 与 F192 producer hygiene 分属 ownership且不新建共同层；@opus47 exact-HEAD review `APPROVE` 后 PR #3871 合入，真实 ID-space P1 再由 PR #3877 修复（@luna 窄范围 `APPROVE`，P1/P2/P3=0；merge `528de1026`）
- Phase D: ✅ PR #3905 已合入；`@opus5` 对 exact `ceccd78b3` `APPROVE`，full gate 与 merged-main Alpha 的真实聊天→trajectory→source-authorized reveal 链均通过，AC-D1 已关闭
- Phase E: 🟡 唯一剩余阶段；出生证已落盘，F192 Phase I 控制面可复用，但 domain 尚未注册/接线。下一步按 F192 domain onboarding/review gate 实现，AC-E1 只在真实 keep/tune/sunset verdict + re-eval closure 后关闭
