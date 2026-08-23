---
feature_ids: [F305]
related_features: [F056, F083, F246, F284, F287, F292, F299, F303]
topics: [ui, ux, design-gate, frontend-design, workspace, approval, design-language]
doc_kind: spec
created: 2026-08-22
description: "把现有 F083、ADR-043 与 F056 接成一条可执行的 UI Design Gate，并以 Approval / Needs Me 卡验证共享默认设计能在 Workspace 模块间复利。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-22T15:01:32Z
cvo_signoff: "2026-08-22 — sourceMessageId 0001787410376908-000078-52aceda2：由Maine Coon负责闭环当前问题，并给出未来可一句话触发的纠偏入口。"
tips_exempt: "内部 UI 设计治理与既有审批体验修正；没有新增用户可发现的产品能力。"
---

# F305: UI Design Gate Closure — 先看真页面

> **Status**: spec / Experience Design Gate | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cell: `harness-eval`

Map delta: `none`

Why: F305 只连接已有 owner：F083 负责 Design Gate 的触发时机，ADR-043 负责结构判据，F056 负责视觉语言与共享 pattern，F246 `approval-index` 继续拥有首个产品落点。F305 不创建新的设计体系、生命周期 stage、registry 或第二份规则语言。

## Why

Workspace 当前的共同问题不是“颜色不好看”，而是**系统内部对象和字段未经任务建模就直接长成了页面**：首屏同时平铺输入框、URI、revision、绝对路径与内部语法；主决定沉到滚动区域之后；机器已有的判断没有先成为默认值；详情和 Raw 没有渐进披露。

这类问题在 F284 重构之后仍于 F292 审批卡复发，而 F299 因为先在真实产品壳中做了交互 mock、再做真实页 parity，呈现出了更清晰的“语义摘要 → 折叠细节 → Raw”秩序。历史重复说明它不能只靠下一只猫临场审美。

三猫核验后，现有资产的语义分工基本正确：

- F083：何时停下来确认设计；
- ADR-043：首屏、判断转移、渐进披露等结构原则；
- F056：视觉 token、primitive 与 pattern；
- design-in-context checklist：设计与 review 共用的操作投影；
- console-dev / browser-preview：正式实现和真实页面验证。

断点是一条连续因果链：

```text
Design Gate 按功能类型单选
→ 用户可见表面可能逃逸
→ ADR-043 没投影到实际检查
→ F056 没有共享 pattern 提供默认形状
→ 数据 schema 直接变成 UI
→ review 才第一次看见真实问题
```

因此本 Feature 的最简目标是：

> **正确 UI = 正确触发 × 正确判据 × 正确默认。**

## Product Contract

### 权威关系不变

| 问题 | 唯一权威 | F305 只做什么 |
|---|---|---|
| 何时欠体验确认 | F083 `feat-lifecycle` Design Gate | 把“用户可见表面”改成叠加触发条件 |
| 什么是正确的信息结构 | ADR-043 | 投影到现有 checklist，不复制条文 |
| 什么是 Clowder AI 视觉语言和默认组件形状 | F056 | 补一个已经反复需要的 Approval / Needs Me pattern |
| 审批业务与数据 | F246 `approval-index` + 各 producer owner | 只替换呈现，不复制 store/schema/decision authority |
| 如何实现和看真页面 | console-dev + browser-preview | Design Gate 与 review 消费同一份真实页面证据 |
| 已验证的好设计如何回流 | F056/checklist | Taste 仅作候选证据，不取得规范权威 |

### 一句话纠偏：先看真页面

operator说 **“先看真页面”** 时，它是现有 F083 Design Gate 的快捷纠偏，不是新的 Magic Word 或质量体系。当前猫必须：

1. 停止继续用 schema、文档或抽象布局证明体验已经成立；
2. 在真实 Clowder AI 产品壳中呈现当前方案的主旅程、默认状态和窄屏状态；
3. 用同一份 design-in-context checklist 对照 ADR-043/F056；
4. 实质 UI 未获operator确认前，不进入正式实现或合入。

小型文字、间距、颜色修正若不改变任务、布局或交互，仍可按 trivial 路径处理。

### 唯一操作检查单

现有 design-in-context checklist 是唯一操作投影。每项必须带 ADR-043 或 F056 source anchor；不能映射的内容不得直接成为新规则。F305 补齐以下已有原则的场景化问题：

- 用户此刻唯一要完成的任务是什么？
- 首屏完成该任务只需要哪些事实？
- 主操作是否无需滚动即可到达？
- 系统能否先给出建议或默认判断，让人只纠偏？
- 内部元数据、工程语法与 Raw 是否默认折叠？
- 每个元素的视觉重量是否与其决策价值相称？

Design Gate、实现自检和非作者 review 都引用这一份，不另建 review checklist。

### 第一个共享默认：Approval / Needs Me

F056 AC-A3 下先形成一个窄 pattern，不启动全 Workspace 组件扫荡：

1. 标题与“为什么需要我”；
2. 系统建议或默认值；
3. 一个清晰的当前决定；
4. 作决定必需的上下文；
5. 工程细节与 Raw 默认折叠。

`GenericApprovalItemCard` 与 F292 `MeetingIntakeCard` 共同消费该 pattern；F246/F292 的业务状态、持久化和决定契约保持不变。

## User Journeys

### Primary — 新增或实质改变用户可见表面

1. 猫在 feature/spec/diff 中识别到新增或实质改变的布局或交互。
2. 即使同一改动还命中架构或后端 lane，也叠加进入现有 F083 Design Gate。
3. 猫把方案放入真实产品壳，展示主旅程、系统默认、桌面与窄屏状态。
4. 设计和 review 共用一份 checklist；operator确认后才正式实现。
5. browser-preview 对真实实现复验；review 对照同一组画面和 source anchors。

### Supporting — operator一句话拉回

1. operator说“先看真页面”。
2. 当前猫停止在抽象层继续收敛，回到当前产品页面和主任务。
3. 猫展示真实壳中的当前提案与关键状态，说明它如何满足唯一 checklist。
4. 若页面仍跑偏，继续改设计；不拿“架构已签字”或“字段都能填”代替体验确认。

### First product proof — F292 Needs Me

1. 用户打开 Workspace → 审批 → F292 会议 intake。
2. 首屏先看到会议是什么、为什么需要我、系统已给出的建议和唯一当前决定。
3. 用户可直接接受建议或只修正必要信息；主操作无需先穿过全部字段。
4. URI、revision、绝对路径、内部映射语法和 Raw 位于按需详情。
5. 桌面与窄屏都保持决定可达、文本不溢出、详情可恢复。

## Scope

### Phase A — 真相与 Design Gate 接线

- 把 `DESIGN.md` 收缩为 ADR-043、F056 与运行 token 的指针，不再复制 token 值。
- 核实并修正 F056 AC-E9 的无效 commit receipt 与未实际存在的 console-dev 声明。
- 把 F083 Design Gate 从“功能类型单选”改为“用户可见表面叠加”；加入“先看真页面”触发入口。
- 让现有 checklist 成为 ADR-043/F056 的 source-mapped 投影，并由 Design Gate/review 共用。
- 在 Clowder AI 项目路由中排除通用 `frontend-design` 的极端风格，不改动或卸载用户级技能。

### Phase B — 一个 pattern 与真实页面证明

- 在 F056 现有 primitive/pattern 方向下实现 Approval / Needs Me 共享默认。
- 迁移 `GenericApprovalItemCard` 与 F292 `MeetingIntakeCard`，不改变审批业务契约。
- 先提供真实壳 mock 给operator确认，再正式实现。
- 用 browser-preview 对桌面、窄屏和关键状态截图；非作者 review 复用同一 checklist。

## Mechanism Selection

| Claim | 选中机制 | 证据 |
|---|---|---|
| 用户可见表面不能因同时命中架构 lane 而逃逸 | test/guard | feat-lifecycle 路由 fixture：architecture + visible surface 仍要求体验证据 |
| checklist 不能成为第二份宪法 | lint/guard | 每个新增结构问题必须带 ADR-043/F056 source anchor；surfaces/manifest 同步测试 |
| 项目内不能误用冲突的通用视觉技能 | deterministic routing guard | Clowder AI scope fixture 命中项目级排除 |
| Approval / Needs Me 默认结构被两个 consumer 共用 | component contract test | Generic + F292 同时渲染共享 pattern，业务 action 保持原契约 |
| 页面在真实使用中清晰、可达、不过载 | real-shell evidence + operator signoff | desktop/narrow screenshots + journey 映射 + sourceMessageId |

这些都是确定契约和已知缺陷，不挂 Eval Hub。运行性能与稳定性也不是本 Feature 的 claim。

## Acceptance Criteria

- [ ] **AC-A1**：新增或实质改变用户可见布局/交互会叠加触发 F083 体验确认；架构 lane 不会豁免，trivial 样式修正不误报。
- [ ] **AC-A2**：“先看真页面”可从 Clowder AI skill manifest 进入现有 `feat-lifecycle`，并在该 skill 内恢复真实壳 Design Gate 语义；未新增 skill/stage/registry。
- [ ] **AC-A3**：design-in-context checklist 的结构问题逐项映射 ADR-043/F056，Design Gate 与 review 不复制第二份清单。
- [ ] **AC-A4**：`DESIGN.md` 不再持有运行 token 字面值；F056 AC-E9 的无效 SHA/错误完成声明已按仓内事实修正。
- [ ] **AC-A5**：Clowder AI 产品表面不会路由到冲突的通用 `frontend-design` 风格指令，且不修改用户在其他项目中的全局技能。
- [ ] **AC-B1**：Approval / Needs Me 共享 pattern 同时被 generic approval 与 F292 meeting intake 消费；F246/F292 业务契约无变化。
- [ ] **AC-B2**：F292 真实壳首屏只突出一个当前决定、系统建议和必要上下文；主操作不滚动可达，工程细节/Raw 默认折叠。
- [ ] **AC-B3**：桌面与窄屏的 mock 在正式 UI 实现前获得 operator sourceMessageId 签字；实现后有 browser-preview 对照截图和需求映射。
- [ ] **AC-B4**：非作者 reviewer 使用同一 checklist 验证 exact HEAD，且 targeted component/route/skill guards 全绿。

## Non-goals

- 不新增 ADR、skill、Design Gate stage、Experience Contract、registry 或永久 consumer matrix。
- 不把 ADR-043 或 F056 全文塞入 L0；不把 Taste 变成规范权威。
- 不给所有 kickoff 粗暴注入 visual-quality Taste cue；没有可靠 UI surface signal 前不扩大 F287 路由。
- 不扩 F303 到 UI 审美；F303 继续负责 consumer/contract integrity。
- 不重做整个 Workspace，不一次建完整 design system；本 Feature 只用审批卡证明一个共享 pattern 能复利。
- 不修改 F246/F292 的 store、schema、审批权限、持久化或业务状态机。

## Dependencies

- **Evolved from**: F083 Design Gate、ADR-043 Frontend Design Constitution、F056 Clowder AI Design Language。
- **First consumer**: F246 Approval Index / F292 Meeting Intake。
- **Positive reference**: F299 P1 Design Gate 的真实壳交互 mock 与 parity 检查。
- **Related but unchanged**: F284 Workspace shell、F287 Taste、F303 Design Gate integrity。

## Risks

| 风险 | 缓解 |
|---|---|
| 又造一套 UI 规则 | checklist 每项只做 ADR-043/F056 投影；无 source anchor 不进入规则 |
| 所有小前端改动被重型化 | 触发条件限定为新增或实质改变布局/交互；trivial 明确豁免 |
| 用 pattern 名义吞并业务 owner | 共享层只拥有呈现顺序和 disclosure slots；决定/action 仍由 producer owner 提供 |
| 只修 F292，未来继续复发 | 先修 Design Gate/checklist/路由 guard，再迁移首个 consumer |
| 只改文档，没有真实体验证据 | Phase B 以真实壳 mock、双尺寸截图、operator signoff 和非作者 review 闭合 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 新建窄 F305，而不扩 F056/F083/F292/F303 | 问题跨“触发、判据、默认”三个既有 owner；任一原 Feature 单独吞并都会改变其边界 | 2026-08-22 |
| KD-2 | “先看真页面”是 F083 快捷入口，不是新 Magic Word | 用户需要一句话纠偏，但不需要第五套设计语言 | 2026-08-22 |
| KD-3 | checklist 是 ADR-043/F056 的唯一操作投影 | 防止 Design Gate 和 review 各维护一份腐烂清单 | 2026-08-22 |
| KD-4 | 先做一个 Approval / Needs Me pattern | 用最小可验证样本建立默认，不以完整 design system 代偿未知 | 2026-08-22 |
| KD-5 | Taste 只提供候选证据 | 规范权威继续属于 ADR-043/F056；避免 vignette 噪声覆盖明确契约 | 2026-08-22 |
