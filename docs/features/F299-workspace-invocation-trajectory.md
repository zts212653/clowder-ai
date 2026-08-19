---
feature_ids: [F299]
related_features: [F233, F252, F153, F200, F237, F298, F300]
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
- **Architecture cell**: `identity-session` + `bubble-pipeline` + `hub-action-surface`
- **Map delta**: none——`identity-session` 继续拥有 session/invocation 与 transcript identity，`bubble-pipeline` 只承载消息旁锚点，`hub-action-surface` 继续拥有 Workspace Launcher、mode 路由与深挖面；本 feat 不新建 Store/Queue，也不改变三者 ownership

## Why

operator experience（2026-08-16）："我们没做好的最重要的是那层可展示层，我们的可观测性丢到了 config 页面，无人发现和注意。" 学 DSH 的三条纪律（不学表面形状）：**账本先于页面**（trajectory 页必须是 canonical log 的确定性投影——F233 feat 轨迹违反此律 failed-close，见 [LL-099](../public-lessons.md#ll-099-给没有-canonical-账本的对象拼轨迹是结构性失败)）、**可见即记录**（猫决策时看见的进账本，事后可确诊）、**入口长在对话现场**（workspace，不是 config 深处）。

体验主线：**P0 证词可信 → P1 亲眼可见 → P2 证据有地图 → P3 上下文可解释**——每步把对猫的信任从"听猫说"推向"亲眼看见"。

## Current State / 现状基线

- Session 证据入口已存在但无"被感知的形状"：SessionChainPanel + AuditExplorerPanel 挂在 `RightStatusPanel.tsx` L489/L515（右侧 workspace），**operator 以为在 config 页面**——命名工程化 + 位置沉底（实测 friction evidence，`0001786842756533`）。
- 实测一条真实 invocation：923 events 中 870 条 status 噪音；Handoff 行停在 session 层点不进 invocation（DSH 审计 §5.2/§5.4）。
- Handoff 分页契约 bug（invocation 被 raw cursor 切碎成矛盾摘要）已修：PR #3747 merged 2026-08-17。
- 猫侧 MCP drill 链（digest → handoff → invocation detail）真实可用且强于 DSH，但无人形入口。

## What

### Phase A: P0 修 handoff 分页契约

先按 invocation 完整归组再分页；cursor 保持 raw eventNo 外部契约不变，内部按 raw-event budget 累加完整 invocation（不拆）。✅ merged [PR #3747](https://github.com/zts212653/clowder-ai/pull/3747)（author opus-46，reviewer gpt52 两轮 + Maine Coon终审 merge-gate）。

### Phase B: P1 入口连通 + 降噪

### Phase C: P2 invocation evidence manifest

每个 invocation 返回 typed references：`transcript / promptCapture / trace / taskTrajectory` 各标 `present` 或缺失原因（`disabled / expired / not_applicable / unavailable`）。只引用 canonical source 不复制 payload；**absent 必须是 typed 事实**而非免责声明，但每种 reference 的 absent reason 由其 canonical owner 提供。F298 #4 auth tombstone 只回答 callback credential 为何不可用（terminal / GC-ed / never-existed），不得用它推断 invocation 的 completed/failed/canceled/interrupted 业务终态；后者来自 canonical transcript/History/execution。

### Phase D: P3 durable request envelope

持久化 Clowder AI 自己组装的模型可见输入：effective system / L0 注入与 injection decision / memory 注入 / provider+config / tool schema hash；**含 F300 视野快照（交汇点）**。retention 从出生遵循 ADR-045 推论 1/2（内存只作 cache、TTL 只做 GC 不做注销），不进 F298 存量家族表（2026-08-17 跨 session 裁定）。前置：隐私/保留/redaction Decision Packet 交 operator。

### Phase E: P4 inspector 效用 eval

consumer =「You 或猫调查一次异常 invocation」；指标：异常调查 time-to-answer / 根因证据成功率 / raw-JSONL grep 回退率 → keep/tune/sunset。

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
  3. inspector 显示：终态与死因、时间轴（status 已折叠）、最后动作、证据条 → 确诊完成
  4. 关闭或返回 → 根据 `originRef` 回到原消息并恢复原滚动位置，不丢失调查现场
- **Non-goals**: 日常浏览（见 Anti-goal）；逐事件重演；健康消息主动曝光锚点

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | thread | 猫猫 | 回复中给 `inv:<id>` 锚点 → 对方一键打开同一 invocation 取证 | 实现后录屏 |
| S2 | workspace | operator | 评估 mode verdict 证据 chip → 点击 → 轨迹 mode 定位该 invocation → 返回原 evidence card | 实现后截图 |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “最重要的是那层可展示层……无人发现和注意”——入口必须长在消息现场并在 Workspace 可召回 | AC-B1、AC-B3 | alpha 截图 + 键盘/触屏交互测试 | [ ] |
| R2 | 出事时能回答“这轮怎么了”，不能被 status 流水淹没 | AC-A1、AC-B2 | 分页回归测试 + 923-event 真实样本实测 | [ ] |
| R3 | 猫与 Eval 能共享同一 invocation 证据锚点，但不合并页面 | AC-B4、AC-C2 | 跨 surface 路由测试 + 录屏 | [ ] |
| R4 | 轨迹只能投影 canonical truth，缺失也不能冒充“没发生” | AC-C1、AC-D1 | contract test + owner/sourceRef fixture | [ ] |
| R5 | F252 Story Player 不能因 legacy TrajectoryPanel 替换而断链 | AC-B5 | `/story/feat:*` 兼容测试 + Workspace Launcher/ThreadSidebar 入口测试 | [ ] |
| R6 | Inspector 是否值得保留由异常调查效用决定，不以打开率代偿 | AC-E1 | Eval Hub keep/tune/sunset verdict | [ ] |
| R7 | 新轨迹面落地后旧常驻审计面必须退役，且不能丢 sealed session、搜索或 Raw 能力 | AC-B6 | 非作者对照实测 + canonical transcript/MCP drill 回归 | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC
- [x] 每个 AC 都有测试、截图、录屏或 verdict 之一作为验证方式
- [x] 前端需求已准备需求→证据映射；实现后补实际截图路径

## Acceptance Criteria

<!-- AC↔Why 同源：A=证词可信 / B=亲眼可见 / C=证据有地图 / D=上下文可解释 / E=效用闭环 -->

### Phase A（P0 分页契约）
- [x] AC-A1: 同一 invocation 不因 raw cursor 出现互相矛盾的 tools/text summary；含 mid-invocation cursor 回归测试（PR #3747 merged，5/5 pass）

### Phase B（P1 入口连通 + 降噪）
- [ ] AC-B1: 从任一猫消息 ≤2 步进入该轮 invocation detail；健康态入口同时支持 hover、keyboard focus 与消息操作，触屏/键盘不依赖 hover
- [ ] AC-B2: status 事件默认折叠，923-event 真实样本首屏有效信息 ≤15 行（非作者实测）
- [ ] AC-B3: 锚点异常优先显形——done 安静且只在 hover/focus/消息操作中亮起，error/cancelled/超时常驻高亮（对照 Design Gate D4）
- [ ] AC-B4: 消息与 Eval 入口都携带 typed `originRef`；关闭/返回恢复准确来源与滚动位置，且 direct-link 无来源时安全退回轨迹列表
- [ ] AC-B5: F252 Story 入口 migration 后不断链：ThreadSidebar 继续打开现有 Theater Overlay，Workspace Launcher 提供“猫猫大剧院/回放”召回，`/story/feat:*` 保持兼容；F299 不再拥有 feature story selector
- [ ] AC-B6: 旧 RightStatusPanel 的 SessionChainPanel/AuditExplorerPanel 常驻面退役；退役前 sealed session 浏览、事件搜索、Raw 视图在 trajectory mode 等价可达（非作者对照实测），canonical transcript 数据与 MCP drill 不受影响

### Phase C（P2 evidence manifest）
- [ ] AC-C1: manifest 四源状态与各自 canonical store 一致，typed absent reason 不跨 owner 推断；credential ref 可用 F298 tombstone/GC-ed/never-existed，业务终态只读 transcript/History/execution，contract test 守护
- [ ] AC-C2: Eval Hub verdict card 证据 refs 可锚点跳转至 invocation inspector（锚点系统第一个外部 consumer，共享锚点不共享页面）

### Phase D（P3 request envelope）
- [ ] AC-D1: envelope 回答"这轮猫看见了什么"精确到 L0 版本与注入决策；scope = Clowder AI-owned assembly，外部 runtime 标 capability label 不冒充 universal truth

### Phase E（P4 eval）
- [ ] AC-E1: 三指标（time-to-answer / 锚点引用率 / grep 回退率）产出 keep/tune/sunset verdict，指标不含打开率

## Dependencies

- **Evolved from**: F233（failed-close 传承：workspace `trajectory` mode 位 + Phase C 代码 rm/migration 决策归本 feat）
- **Blocked by**: 无（Phase D 前置为 operator Decision Packet，属决策门非 feat 依赖）
- **Related**: F300（"猫的视野快照"在 Phase D 交汇）、F252（TrajectoryPanel 现存消费方，AC-B4）、F298（#4 仅供 credential disposition，不供业务终态）、F237（Prompt X-Ray 证据源）、F153（trace 证据源）、F200（taskTrajectory 证据源）

## Risk

| 风险 | 缓解 |
|------|------|
| 重蹈 F233"AC 全绿但 operator 从未消费"（Goal Drift） | 消费者定位 + Anti-goal 写死在 spec；Phase E 指标不含打开率 |
| F252 Story 入口断链 | AC-B5 显式验收；D9 已冻结“ThreadSidebar + Workspace Launcher + legacy URL compatibility”，F299 不接管 Story ownership |
| Phase D 隐私越界 | Decision Packet 未签不动工；retention 出生合规（ADR-045 推论 1/2） |
| 展示层被误当第二真相源 | LL-099 家规：只投影 canonical transcript，不建新表；review 检查项 |
| 入口过度曝光制造噪音税 | D4 异常优先显形；健康消息不打扰 |

## Tips Contribution（F244）

- 计划 1 条 tip（Phase B 落地时提交）：「猫出事了？出事消息旁的高亮锚点一键看轨迹」→ truth source: workspace 轨迹 mode。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 学 DSH 三纪律，不抄对象与承诺（单 agent → 多猫协作体；provider-native truth → assembly exactness + capability labels） | 结构性差异，见 thread 卡片"抄骨不抄皮" | 2026-08-17 |
| KD-2 | 消费者排序：猫 > eval > You（异常时）；Anti-goal 不以打开率为成功 | operator 灵魂拷问；防 F233 Goal Drift 复刻 | 2026-08-17 |
| KD-3 | 共享锚点不共享页面（eval/CWE 是锚点 consumer，不合并面板） | 防超级面板回潮 | 2026-08-17 |
| KD-5 | `originRef` 与多模态可达性是入口契约，不是实现 polish | 否则轨迹会把用户从原调查现场带走，且 hover-only 会让触屏/键盘用户失去入口 | 2026-08-18 |

## Review Gate

- Phase B: ✅ @fable5 已对 exact `c22defbd0` 完成唯一一次最终架构审核并 `APPROVE`；AC-B6 已消费，可进入 F128 执行 thread，标准跨个体 review + merge-gate
- Phase C/D: 按行为/数据风险路由；Phase D 需 operator Decision Packet 先行
