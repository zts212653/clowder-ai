---
feature_ids: [F244]
related_features: [F114, F155, F192, F203, F220, F223, F227, F229, F243]
topics: [knowledge-feed, capability-tips, waiting-state, onboarding, capability-discovery, magic-words]
doc_kind: spec
created: 2026-06-18
---

# F244: Capability Tips System — 等待态 Knowledge Feed 投影

> **Status**: done | **Owner**: Maine Coon/Maine Coon | **Priority**: P1 | **Completed**: 2026-06-22

## Architecture Ownership

Architecture cell: hub-action-surface + harness-eval
Map delta: update required
Why: Tips render inside first-party Hub waiting/status surfaces and need adoption/effectiveness tracking; F223 owns capability source registry, F192 owns eval, F244 owns the user-facing waiting-state projection.

## Why

operator 2026-06-18 收敛：

> "我们想要的不止是猫言语"

> "比如有什么 magic words 什么时候可以用 / 家里有什么功能 / 开发新 feature 的时候必须补 1-2 条 tips"

> "猫言语只是最后一层皮，真正的价值是把'家里怎么运转'变成用户在自然等待中持续学会的东西"

> "直接立项吧，反正第一个用户就是我啊！"

等待态不是单纯的 dead time。用户盯着猫猫思考、执行、等待外部条件时，注意力被自然锁住；这几秒最适合把 Cat Cafe 的能力、家规、magic words、工作流边界和新 feature 用法轻量投影出来。目标不是把 loading 文案变可爱，而是把 W7 Knowledge Feed 和 F223 capability registry 变成用户能自然吸收的产品表面。

## Current State / 现状基线

- 现有等待/执行 UI 已有真实状态层：`packages/web/src/components/ThinkingIndicator.tsx` 显示 `启动中` / `思考中` / `回复中` / `静默等待中` / `可能卡住了`，`packages/web/src/components/ThreadExecutionBar.tsx` 显示 `执行中`、计时、停止与 `卡住了？强制重置`。
- 现有能力真相源已分散存在：F223 产出 Capability Surface Registry，`cat-cafe-skills/refs/capability-wakeup-index.md` 维护 L0 §8 能力速查，F114/L0/shared-rules 维护 magic words，F155 guide engine 有场景 tips，F227 Event Memory 索引 magic word 事件。
- 当前没有一个用户可见的等待态 tips 投影层。用户要知道"家里有什么能力 / 什么时候用 / 怎么用"，仍主要靠聊天中被动问、读文档、或猫主动解释。
- F229 猫猫球已经承担"前台猫 / 功能发现 / 常驻入口"职责；它需要 tips 时必须消费 F244 的 tip contract 和 selector，不维护自己的 tips 文案清单。
- 当前风险是把真实状态、tips、猫格文案混在一起：如果 UI 写"正在读取工作区"但没有 runtime signal，就是假精确状态；如果卡死入口被可爱文案盖住，会反噬信任。

## operator Constraints（2026-06-18）

operator补充的三层落地要求是本 feature 的边界，不是实现建议：

| 层 | 硬要求 |
|----|--------|
| Soft | feature PR 模板要求新增 1-2 条 tips；纯内部重构等无用户可感知变化必须写明豁免理由 |
| Hard | 新增 feature manifest / guide / skill 时，CI 检查有没有对应 tips 或明确豁免 |
| Eval | 记录 tips 曝光、点击、被用户追问的频率，反推哪些能力还没被讲清楚 |

单一真相源约束：F244 只做投影和治理，不复制能力定义。Magic words 的含义仍来自 L0/shared-rules/F114；能力 surface 仍来自 F223/capability-wakeup rules / capability-wakeup-index；guide steps 仍来自 F155 guide registry。第一版只能机器验证结构与 source anchor，不能机器验证 `body` 语义完全等同 source；`body` 的语义防漂移靠 `owner` review、stale review、dogfood/eval 闭环兜住。实现不能维护一份平行的"能力大全"。

## Implementation Posture / No Scaffold

operator 2026-06-18 纠偏：F244 不按"先做临时版、以后再补终态"推进。第一刀必须是终态架构的一次竖切：

- 可以限制 seed tip 数量、telemetry 报告深度、F229 proactive/idle 展示范围。
- 不可以临时造 help drawer、临时 action、临时 tips source、临时 schema，之后再迁移。
- 第一版就使用最终 `CapabilityTip` contract、`open_concierge_draft` action、sourceRef/anchor 校验、review usefulness checklist 和 usage event 形状。
- 后续迭代只能扩展 tip inventory、contexts、eval 消费深度和 F229 展示场景，不重写第一刀的 contract。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "不止是猫言语"：猫格只是表达层，核心是展示家里怎么运转 | AC-A1 / AC-B1 | schema + UI 截图 | [x] |
| R2 | "有什么 magic words 什么时候可以用" | AC-A2 / AC-B3 | seed tips + source anchor 校验 | [x] |
| R3 | "家里有什么功能，如何用" | AC-A3 / AC-B3 | seed tips + action link 演示 | [x] |
| R4 | "开发新 feature 的时候必须补 1-2 条 tips" | AC-C1 / AC-C2 | CI red/green fixture | [x] |
| R5 | "第一个用户就是我"：优先 dogfood 给operator等待态使用 | AC-B4 / AC-D3 | alpha 录屏 + dogfood report | [x] |
| R6 | tips 不得冒充真实进度或覆盖故障/强制重置入口 | AC-B2 | component tests + 截图 | [x] |
| R7 | tips 必须从现有真相源投影，不新造第四套能力清单 | AC-A1 / AC-A4 | `structureSource`/`bodySource` audit + anchor CI | [x] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（5 轮 dogfood report：`F244-capability-tips-dogfood-report.md`）

## What

### Phase A: Tip Contract + Source Projection

建立 tips 的数据契约和种子投影。F244 不拥有能力清单本体，只拥有"把已有真相源投影成等待态 tip"的格式和选择逻辑。

Phase A 必须把 "结构投影" 和 "内容来源" 分开：

| 层 | 第一版来源 | 可机器验证什么 | 不声称能机器验证什么 |
|----|------------|----------------|----------------------|
| Structure | F223/F192 的 `capability-wakeup-rules.ts`、F155 guide registry、feature metadata | `id` / `kind` / `contexts` / `actionRequired` / `sourceRef` 存在且 anchor 可定位 | tip body 是否完整复述了 source 语义 |
| Body | hand-authored seed manifest + `sourceRef` 锚点 | body 不为空、无假进度词、source anchor 没失效 | body 是否"足够有用"或与 source 完全同步 |
| Usefulness | reviewer + dogfood + eval | action outcome、dismiss/follow-up signals | 静态 CI 直接判断"好不好" |

`CapabilityTip` 最小字段：

| 字段 | 说明 |
|------|------|
| `id` | 稳定 ID，例如 `magic-word-scaffold` / `capability-browser-preview` |
| `kind` | `capability` / `magic_word` / `workflow` / `feature` / `status_help` |
| `sourceRef` | 真相源锚点：feature doc、shared-rules、skill、guide registry、ADR；CI 至少验证 anchor 可定位 |
| `contexts` | 可展示上下文：`thinking` / `waiting_external` / `review` / `feature_dev` / `merge_gate` / `long_running` |
| `audience` | `cvo` / `developer` / `maintainer` / `all` |
| `body` | 短文本，不能包含假进度承诺 |
| `action` | typed action；第一版主动作是 `open_concierge_draft`，把"了解更多"提示写入 F229 猫猫球输入框但不自动发送；`capability` / `workflow` / `feature` 类必填，`magic_word` / `status_help` 可豁免 |
| `owner` | 维护 owner，用于 stale/sunset |

首批来源：

- F223/F192 `capability-wakeup-rules.ts`：能力 ID 和触发上下文的机器可读结构来源。
- `capability-wakeup-index.md`：人工撰写 seed body 时的内容参考，不作为程序化投影源。
- F114/L0/shared-rules：magic words 的含义与立即动作。
- F155 guides：可交互引导的入口，不把 guide steps 复制成孤岛。
- F192/F203/ADR-031：harness 三层、eval、运行模式、SOP 边界。
- Feature specs：后续每个 user-visible feature 贡献自己的 1-2 条 tips。

### F229 Cat Ball Integration Boundary

F229 猫猫球是 F244 的未来展示面，不是第二个 tips 系统：

- F244 owns：`CapabilityTip` schema、seed manifest、`sourceRef`/anchor 校验、selector、usage/eval/stale 语义。
- F229 owns：前台猫何时露出 tips（idle/展开/用户询问"有什么"）、如何以猫猫球/桌宠 UI 呈现、如何和 concierge 状态机共存。
- F244 Phase B 第一版可以把 F229 作为"了解更多"动作面：click tip → 调用现有 concierge draft contract（`setSurfaceState('bubble', prompt)` / `pendingPrompt`）→ 前台猫展开并预填输入框，**不自动发送**。
- F229 独立渲染 tips 时只能引用 F244 选出的 `tipId/sourceRef/action`，不得把 tip body copy 到 F229-local 清单。
- Cat ball / desktop pet 可以用动画、badge、气泡提示"有 tip"，但不能让 pet animation 成为唯一信号；这继承 F229 PetSkinContract 的"pet 是 projection，不是 truth source"边界。
- Phase B 第一版不让 F229 主动/空闲态独立展示 tips；那一类 F229 reuse 放后续 integration PR 或 F229 Phase，新增 context 如 `concierge_idle` / `concierge_open` / `pet_waiting_for_user` 时仍走同一 schema。

### Phase B: Waiting-State Projection UI

在等待/执行 UI 中增加 tips 投影，但与真实状态分层：

- 真实状态仍由 liveness/runtime signal 驱动，`ThreadExecutionBar` / `ThinkingIndicator` 继续放状态、计时、停止与强制重置入口。
- Tip 的第一展示面是 PendingMemberBubble（猫猫等待气泡）：tip strip 本身即为思考态指示器（operator dogfood Round 4 统一），猫猫头像/名字下直接渲染带呼吸光晕动画的 tip 气泡（`firstDelayMs=0`），不再显示独立弹跳点。Dedup bubble（`showCapabilityTip=false`）和 stall 状态降级为极简弹跳点（`· · ·`）。
- Thread/message-list 层只选择一个 eligible pending invocation 承载 tip（`pendingTipInvocationId`，取第一个非 stall 的 pending invocation）；多猫并行等待时不得为每条 pending bubble 各自挂一个 strip，避免重复曝光和重复 action event。
- `ThreadExecutionBar` 不承担 tip presentation；它只保留真实状态和逃生口，避免 tips 与取消/强制重置竞争。
- `suspected_stall` / `alive_but_silent` 时，故障与取消入口优先；tips 不得遮挡或弱化 `卡住了？强制重置`。
- PendingMemberBubble 中 tip 立即展示（`firstDelayMs=0`，思考态指示器无延迟）；其他 surface（如 `assistant_stream_bubble`）保留首次延迟。单条至少停留 30s，避免每几秒闪动制造噪音。
- 上下文选择优先级：当前执行阶段 > thread workflow > feature dev/review mode > 通用 capability/magic word；`ideate`/review 等待仍使用 `review` + `long_running` contexts，而不是退化成通用 `thinking` tips。
- 支持 action：hover 提示"了解更多"；click 拉起 F229 猫猫球并把解释请求预填进输入框，不自动发送。需要直达时可附 source/guide/capability surface secondary action；没有 action 的 tip 不能冒充可执行能力。

### Phase C: Feature Tips Contribution Gate

把 tips 变成 feature lifecycle 的一部分，但做贡献门，不做机械数量门：

- 新增或修改 user-visible feature / capability / guide / harness 行为时，必须贡献 1-2 条 tips，或写明确 `tips_exempt` 理由。
- 纯内部重构、typo、无用户可感知变化可豁免。
- CI 是结构完整性门，不是内容质量评审：它检查 `sourceRef`、`contexts`、`audience`、`owner`、action-required kind、无假进度词和 anchor 可定位。
- 内容有用性必须由 PR reviewer 判断：tip 是否教会用户一个可执行动作、一个明确时机，或一个可追溯的家规含义；字段齐全但只是复述标题的 tip 必须退回。
- PR/feature 模板增加 `Tips Contribution` 小节，和 requirements checklist 一起在 kickoff/quality-gate 阶段复核。
- 新 tip 不得新造能力定义；必须引用 F223/F155/F114/F192/feature doc 等真相源。

### Phase D: Eval + Staleness Loop

tips system 是 harness 改动，必须有闭环：

- 记录 privacy-minimal usage：展示次数、action 点击、dismiss、source 打开失败。
- F192 侧跟踪：tip 是否降低 capability-wakeup miss / guide 入口迷路 / magic word 不知道怎么用的追问。
- 支持 stale/sunset：sourceRef 失效、feature done/sunset、连续低价值或被用户 dismiss 的 tip 进入 review。
- dogfood 报告：第一个用户为operator，Phase B 后用 alpha 录屏 + 使用反馈判断是否继续上 C/D hard layer。

#### Phase D implementation split（2026-06-22 收敛）

operator directive: #997、tips 长度、dogfood 报告、eval/stale 全部做；PR 不拆太碎。Phase D 拆成两个内聚 PR：

**PR-D1 — tips 体验 + 本地数据基础**

- 曝光均匀性（clowder-ai#997）：选择器优先展示当前 scope 下未曝光 tips；当前 eligible 集合全部曝光过后，只清空该 scope 的已曝光集合并开启新一轮，不清空其他 context/surface 的历史。
- 已曝光状态用普通 `Set`/`Map` 持久化到 `localStorage`，按 `surface + audience + normalized contexts` 分 scope；state 记录当前 inventory fingerprint，但 fingerprint 变化时做 tipId diff 迁移，不把整轮已读状态清空。
- 新 tip 优先：已有本地状态时，新出现在 inventory 的 tip 记录 `firstSeenAt` 并在短窗口内 boost；删除的 tipId 从 Set/Map 移除；保留的 tipId 继续保留曝光状态。首次安装/首次打开时不把全量 inventory 都当"新 tip"无限抢占。
- 同优先级内用 deterministic seeded shuffle 打散排序；seed 由日期 bucket（`YYYY-MM-DD`）+ scope + inventory fingerprint 组成，不使用用户正文、外部身份、session id 或随机数。刷新/同日保持稳定，跨日自然换序。
- 记录 privacy-minimal selection state 与既有 `capability_tip_exposed` / `capability_tip_action` 事件兼容；D1 不做跨设备同步，不引入后端 per-user storage。
- 多 tab localStorage 并发写不加锁：exposure 写入低频，偶发 race 最坏只是某条 tip 多曝光一次，不值得为 D1 引入锁或 broadcast 协议。
- tips 长度治理同 PR 处理：优先把 >50 字的长 tip 压到约 45 字以内；无法压缩而仍需保留两层信息的 tip 拆成多条 sourceRef-backed tips。

**PR-D2 — eval + 治理闭环**

- F192 注册/接入 `capability-tips` eval 域，消费 D1 产生的 privacy-minimal usage/friction 信号。
- 产出 dogfood report：覆盖 R1-R5 dogfood 发现、#997 曝光均匀性修复前后、action click / dismiss / follow-up signals。
- 落 stale/sunset owner queue：sourceRef 失效、feature sunset、连续低价值或高 dismiss tip 进入 owner 可处理清单。
- OQ-3 在 D2 定稿：复用 `eval:capability-wakeup` 还是新增 `eval:capability-tips` domain，以 F192 integration cost 和 report 可读性为准。

**Rejected option: Bloom filter**

Bloom filter 不用于 D1。原因：当前 inventory 量级是几十到几百条，普通 Set 内存成本只有 KB 级；Bloom filter 有假阳性，会把未看过的 tip 误判成已看过，造成长期漏展示；且 Bloom 不适合"eligible 集合看完一轮后按 scope 清空/重置"和单条 tip stale/sunset 删除。#997 的问题是小集合公平轮转，不是百万级去重省内存。

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal

- **Users**: operator（等待时学习家里能力）、猫猫/feature owner（贡献和维护 tips）、维护猫（观察 tips 是否改善能力发现）。
- **Activation**: thread 等待/执行状态持续超过阈值；或 feature dev/review/merge-gate 等上下文命中。

### 2. Friction Metric

- 用户仍频繁问"这个功能怎么用 / 家里有没有 X 能力"且已有相关 tip。
- Tip 展示但 action 点击后失败或打开错误 source。
- 新 user-visible feature 合入但没有 tip 或豁免。
- Tip 被高频 dismiss，或 sourceRef stale。

### 3. Regression Fixture

- 等待态 `thinking` 展示 capability tip，但主状态仍只显示真实 `思考中/回复中`。
- `suspected_stall` 状态下故障文案、取消和强制重置入口可见且优先，tips 不遮挡。
- Magic word tip 带 shared-rules/L0 sourceRef，CI 验证 anchor 可定位；body 语义由 owner/reviewer/stale review 维护，不声称静态 CI 可证明语义一致。
- 新 feature PR fixture 缺 tips 且无 `tips_exempt` 时 hard check red；补 sourceRef + context 后 green。

### 4. Sunset Signal

- 某 tip 连续 N 周零点击且无后续追问改善证据 → 降级或删除。
- sourceRef 指向的 feature/skill/guide sunset → tip 自动进入 stale review。
- 若模型/产品原生 capability discovery 足够稳定，等待态 tips 可降级为按需 help，不再常驻轮播。

## Harness 三层（软+硬+eval）

| 层 | F244 落点 |
|----|-----------|
| Soft | 等待态 UI + feature/PR template 要求新增 1-2 条 tips 或豁免，让用户和猫自然想起能力/tips |
| Hard | feature manifest / guide / skill 新增时检查 tips 或 `tips_exempt`；tip schema/sourceRef/context/action-required/anchor CI；真实状态与 tips 分层的 component tests |
| Eval | 记录 tip 曝光、点击、被用户追问的频率；F192 usage/friction metrics + dogfood report + stale/sunset review |

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。重构/降复杂度类须实测可量，不是"提了可测性就算"。 -->

### Phase A（Tip Contract + Source Projection）

- [x] AC-A1: 定义 `CapabilityTip` schema，包含 `id/kind/sourceRef/contexts/audience/body/action/owner`，并有 parser/schema 测试。
- [x] AC-A2: magic word tips 带 shared-rules/L0/F114 sourceRef；CI 能发现 sourceRef 缺失或 anchor 不可定位，但不声称能静态证明 body 语义一致。
- [x] AC-A3: capability tips 至少覆盖 L0 §8 Tier 1 能力和 3 个高频 workflow tips（memory recall、alpha 验收、merge-gate）；`capability` / `workflow` / `feature` 类 tip 必须有 typed action 或 source-open action。
- [x] AC-A4: 产出 seed tips inventory，逐条标注 `structureSource` 与 `bodySource`：能力 ID/contexts 来自 F223/F192 机器可读规则，body 来自 hand-authored seed + sourceRef；不得把 seed manifest 描述成完整能力真相源。

### Phase B（Waiting-State Projection UI）

- [x] AC-B1: 等待态 surface 能展示上下文 tip；component tests 覆盖。Surface 经多轮 dogfood 迭代定位：PR #2406 `ThreadExecutionBar`（位置错）→ PR #2424 `assistant_stream_bubble` → PR #2433/#2448 最终落在 `PendingMemberBubble`（"分析处理中"等待气泡，tip strip 即思考态指示器）；parallel/ideate 锁定同一线程只展示一个 strip，并保留 `review` context。
- [x] AC-B2: tips 与真实状态分层；`alive_but_silent` / `suspected_stall` 下取消、故障说明、`卡住了？强制重置` 入口不被遮挡，component tests 覆盖。
- [x] AC-B3: Tip primary action hover 显示"了解更多"，click 拉起 F229 猫猫球并预填 tip 解释请求到输入框，默认不发送；若有 secondary source/guide/capability action，坏链接或 stale source 有可见错误，不静默失败。
- [x] AC-B4: operator dogfood 路径可演示：等待一次猫执行时看到至少一条 capability/magic-word/workflow tip，并能点开了解来源。（5 轮 dogfood 证据见 `docs/features/F244-capability-tips-dogfood-report.md`；Round 5 operator 点击"了解更多"确认 action path 可达；Vision Guard 核实后补勾 2026-06-22）

### Phase C（Feature Tips Contribution Gate）

- [x] AC-C1: Feature kickoff/PR 模板新增 `Tips Contribution` 小节：新增 user-visible feature/capability/guide/harness 行为需 1-2 条 tips 或 `tips_exempt`。
- [x] AC-C2: CI hard check 有 red/green fixture：缺 tips 且无豁免失败；补合法 tip 或合法豁免通过。
- [x] AC-C3: hard check 明确只保证结构完整性：tip 必须有 `sourceRef` + `contexts` + `audience` + `owner`，action-required kind 必须有 action，body 不得包含无信号支撑的进度承诺（例如"快好了"）；内容是否有操作价值由 reviewer checklist 退回废话 tip。
- [x] AC-C4: `feat-lifecycle` / `quality-gate` 文档同步，feature owner 能在收尾前复核 tips 是否仍匹配交付物。

### Phase D（Eval + Staleness Loop）

- [x] AC-D1: usage telemetry privacy-minimal：记录 tip id、context、action outcome，不记录用户私密正文。
- [x] AC-D1.1: #997 曝光均匀性修复：localStorage Set/Map 记录当前 scope 已曝光 tip；未曝光优先、eligible 全看完后按 scope 重置、inventory diff 迁移、新 tip boost、date-seeded shuffle、localStorage-denied fallback 均有测试覆盖。
- [x] AC-D1.2: tips 长度治理完成：超长 tips 压缩或拆条，保留 trigger-action 与 sourceRef，不用省略关键行为边界换短。
- [x] AC-D2: F192 eval path — `eval:capability-tips` domain registered (YAML + Zod schema test, enabled: false pending usage data)。
- [x] AC-D3: operator dogfood report from 5 rounds (2026-06-18 to 2026-06-21) → `docs/features/F244-capability-tips-dogfood-report.md`。
- [x] AC-D4: stale/sunset detection script (`check-capability-tips-stale.mjs`, 14 tests) — detects path_missing / anchor_missing / feature_sunset。

## Dependencies

- **Evolved from**: W7 Knowledge Feed（等待态投影）
- **Related**: F223（Capability Surface Registry — 能力与 typed surface 真相源）
- **Related**: F114 / F227（Magic Words / Event Memory — 拉闸词与使用场景）
- **Related**: F155（Guide Engine — 需要更完整操作时跳转到 guide）
- **Related**: F192（Harness Eval — tips effectiveness 与 stale/sunset）
- **Related**: F203（L0 §8 — capability wakeup 触发层）
- **Related**: F220（A2A 等待/卡死 UI — 不覆盖故障与强制重置）
- **Related**: F229（猫猫球/桌宠 — 作为未来 presentation consumer 复用 F244 tips，不另造 tips source）
- **Related**: F243（Docs Discovery Profile — sourceRef/doc profile 可复用）

## Risk

| 风险 | 缓解 |
|------|------|
| 退化成随机可爱文案库 | schema 强制 `sourceRef`；猫格文案只是 presentation variant，不是知识本体 |
| 假进度 / 假精确状态 | 真实状态与 tips 分层；无 runtime signal 禁止写状态性动词；AC-B2 测试锁住 |
| 每 feature 强制 1-2 条导致废话 | 做结构门 + reviewer usefulness checklist：sourceRef/context/action/owner 必填；纯内部重构可豁免 |
| tips 过多造成噪音 | 展示阈值、慢轮播、dismiss/stale metric；Phase D sunset |
| 能力清单漂移 | 结构从 F223/F155/F114 等 sourceRef 投影；body 是 seed 内容，靠 owner/reviewer/stale review/eval 维护，不谎称 CI 能验证语义一致 |
| F229 猫猫球另起一套 tips 文案 | F229 只能消费 F244 `tipId/sourceRef/action`；猫猫球负责 presentation/timing，不负责 tips truth source |
| 覆盖故障逃生口 | suspected_stall/alive_but_silent 下故障与强制重置优先，tips 降级或隐藏 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新开 F244，不挂 F223/F155 | F223 owns capability execution registry；F155 owns step-by-step guides；F244 owns waiting-state projection and contribution lifecycle | 2026-06-18 |
| KD-2 | Tips 是投影，不是第四套能力清单 | 防止 source drift，符合 P4 单一真相源 | 2026-06-18 |
| KD-3 | 真实状态、tips、猫格表达三层分离 | 诚实红线；避免假进度与故障粉饰 | 2026-06-18 |
| KD-4 | Feature tips gate 是结构门 + reviewer usefulness checklist，不是数量门 | 强制数量会催生废话 tips；机器只守 sourceRef/context/action/owner 或豁免，语义价值由 reviewer/eval 守 | 2026-06-18 |
| KD-5 | 第一个用户是operator，优先 dogfood | operator 明确 signoff；先在真实等待态验证是否有用 | 2026-06-18 |
| KD-6 | 不维护平行能力大全 | F244 只消费 F223/L0/F114/F155/F192 等 sourceRef；tips 是投影，不是新真相源 | 2026-06-18 |
| KD-7 | 区分 structure source 与 body source | F223 机器 registry 只有 id/capability/predicate，不含 tip body；Phase A 必须诚实承认 body seed 是人工内容，语义一致靠 review/eval/stale loop 维护 | 2026-06-18 |
| KD-8 | F229 猫猫球是 presentation consumer，不是 tips source | F229 已拥有前台猫/功能发现职责；若猫猫球展示 tips，必须消费 F244 的 `tipId/sourceRef/action`，不能维护本地 tips 清单 | 2026-06-18 |
| KD-9 | "了解更多"用 F229 draft，不做 help drawer 脚手架 | F229 已有 `setSurfaceState('bubble', prompt)` / `pendingPrompt` 终态 contract；F244 click 只预填输入框不自动发送，保留用户控制权 | 2026-06-18 |
| KD-10 | 第一版是终态竖切，不叫临时版 | operator 指出临时版 framing 会诱导绕路；scope 只能减内容数量/展示范围，不能减 contract 终态性 | 2026-06-18 |
| KD-11 | Tips 第一展示面在 assistant streaming bubble，不在 execution bar | Dogfood 截图确认执行条位置离用户注视点太远；等待态学习应贴近猫猫正在说话的气泡，同时 execution bar 保持真实状态和逃生口职责 | 2026-06-19 |
| KD-12 | Seed inventory 保持 JSON 数据文件，不额外建 md 同步层 | `capability-tips.seed.json` 是独立数据文件（非组件内硬编码），有 `check-capability-tips.mjs` CI 校验；维护者是猫猫（开发者），不需要非技术编辑界面；额外 md↔JSON 同步层增加漂移风险，ROI 不足。operator 确认格式由猫猫自决 | 2026-06-21 |
| KD-13 | #997 曝光均匀性用 Set/Map 轮转，不用 Bloom filter | tips inventory 是小集合，Set/Map 简单、可删除、可按 scope 清轮且无假阳性；Bloom filter 为百万级省内存去重设计，假阳性会漏 tip，不适合本场景 | 2026-06-22 |

## Review Gate

- Design Gate: 前端 UI/UX，必须给operator看 wireframe；重点确认 tip 在等待条里的位置、节奏、动作入口和故障优先级。
- Harness review: 需要跨个体 review `Tips Contribution` hard check 和 Eval Contract，避免数量门/废话门。
- Vision guard: 结束时必须用operator experience对照，证明交付物不是"可爱 loading 文案"，而是真的让用户学会家里能力。
