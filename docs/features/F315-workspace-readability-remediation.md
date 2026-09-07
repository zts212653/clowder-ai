---
feature_ids: [F315]
related_features: [F056, F083, F246, F284, F293, F299, F305, F307, F310, F311]
topics: [workspace, ui, ux, readability, information-architecture, progressive-disclosure, product-language]
tips_exempt: "2026-09-04 review renewal: this adds durable three-page visual findings and exact owner bindings without adding a new user-invokable capability or discovery step; each repaired surface must teach itself in place."
doc_kind: spec
created: 2026-09-03
description: "盘点并迁移现有 Workspace 用户表面，使首屏先回答发生了什么、是否需要行动与下一步是什么，同时保留按需可达的精确证据。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-03T21:40:00-07:00
---

# F315: Workspace Readability Remediation｜存量页面从内部对象回到用户任务

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon（@codex-sol, GPT-5.6 Sol） | **Priority**: P1
>
> **operator sources**:
> - `[thread-id]#0001788492776995-000225-df6cc10c`——Workspace 多数页面仍违背 F305，信息难读、内部概念过多；F305 关闭后应另立 Feature 盘点现状并治理。
> - `[thread-id]#0001788494281788-000279-49ac2988`——先回答 Team、Needs Me、能力进化为什么读起来吃力，指出颜色、层级与信息表达的问题，并参考真实产品给出更清楚的方案。
> - `[thread-id]#0001788513469323-000709-a23d8f5f`——operator 明确否定把 F315 的当前主线解释成“先换全局颜色、先规划 19 个房间”；F315 必须先交付点名页面的可见修复。
> - `[thread-id]#0001788515250111-000776-c05f7e0c`——operator 对首版 after 明确要求继续调整：Team 只比 before 好但分组措辞不讲人话；Needs Me 缺少 populated 态；Capability Evolution 横排不自然且缺少图形落点。
> - `[thread-id]#0001788516088680-000807-4144e5b7`、`#0001788516258766-000813-8bef4d8f`、`#0001788520033748-000893-23213efd`——Capability Evolution 的用户旅程不能照抄猫的执行阶段；根节点、首屏、展开层分别回答不同问题，并区分造仪器的准备态与真正开始观察/进化后的状态。
> - `[thread-id]#0001788521646251-000943-bb82ce5d`——operator 退回“愿望 / 愿望名”措辞，并要求先用 F314、Microduck 与路演能力三份真实 Program 讲清前端到底如何表达。

Architecture cell: **none（cross-owner presentation remediation）**；相关产品宿主为 `hub-action-surface`。

Map delta: **none**。F315 不取得 Workbench 布局、领域对象、业务 action、store 或 lifecycle 的所有权。

## Why

F305 解决的是“以后怎样不再从 schema 直接长出 UI”：把 F083、ADR-043、F056 与真实页面证据接成一条 Design Gate，并用 Approval / Needs Me 做第一个生产验证点。它明确把“重做整个 Workspace”列为 non-goal，因此 F305 关闭并不等于存量页面已经迁移。

当前真实缺口是：**旧的 Workspace 表面仍以领域对象和工程字段为叙事中心，用户必须自己把 ID、状态、来源与内部术语翻译成任务。** 它同时表现为文案、信息投影、视觉层级与颜色语义的问题，不能被缩写成“换色”，也不能被转译成一场先于页面修复的 Workspace 房间规划。ADR-043 §4 已预留正确出口：存量不要求任意 PR 顺手重写；迁移超出当次授权时应另行立项。F315 就是这次被用户明确授权的迁移 owner。

**F315 的第一可见结果不是 census 或 fold map，而是 Team、Needs Me、Capability Evolution 三页的逐页诊断、野外参照、改前/改后方案、领域 owner 修复与真实壳验收。** 全量 19 项盘点与目的地出生证审计仍然需要，但作为并行治理线，不得阻塞这三页，也不得成为向 operator 解释“我们正在解决”的替代品。

终态只有一句话：

> 用户进入任一 Workspace 页面，首屏先看懂发生了什么、是否需要自己行动、下一步是什么；精确 ID、来源、运行指标与 Raw 不丢失，但只在任务确实需要时出现。

## Current State / 现状基线

### 代码可达面

`WORKSPACE_MODES` 当前有 12 个 mode（含 `dev`）；`WorkspaceLauncher` 在 `dev` 下暴露 5 个具体表面，并额外暴露 Status、Capability Evolution 与 Theater。由现有 canonical registry / launcher 计算，当前用户可达目的地共 **19 个**：

- 5 个开发表面：Files、Changes、Git、Terminal、Browser；
- 11 个领域 mode：Recall、Needs Me、Product Schedule、Schedule、Tasks、Team、Community、Artifacts、Approval、Trajectory、Eval；
- 3 个其他宿主入口：Status、Capability Evolution、Theater。

### operator 点名的三页与两个伴随样本

operator 附了 Team、Needs Me、Capability Evolution、Status / Sessions、Approval 五个真实页面，并进一步明确先回答前三页“为什么看起来吃力、前端设计犯了什么错、别人怎样用颜色和层级表达”。因此前三页是第一交付批次；Status / Sessions 与 Approval 是紧随其后的第二批，不把五页捆成一道前置大门。

1. **Team 猫详情**：每条可读结论后重复展示 `capability_strength`、SHA 与 source refs，工程 provenance 的视觉重量大于“这只猫适合做什么”。
2. **Needs Me 空态**：层级克制，但“原 owner”“不复制审批状态”等实现边界进入了产品说明；空态在解释系统，而不是只回答用户接下来需不需要做事。
3. **Capability Evolution**：整体结构已经明显更好，但真实卡片内容仍可能出现 Feature 标题、英文 harness 名和内部 lifecycle 语言；presentation 改善不能替 owner projection 生成用户语言。
4. **Status / Sessions**：诊断详情本身有价值，但 UUID、token/cache/compression、封存与运行状态同时成为默认阅读层；缺少“现在是否正常、是否要处理”的摘要入口。
5. **Approval**：F305 的共享卡结构仍在，但 producer summary / event provenance 可把内部任务标题、`Verified ... requested ...` 与空的“审批理由”重新送回首屏；说明共享壳正确并不足以保证领域文案正确。

这五个样本足以证明问题存在，不足以代表另外 14 个目的地已经审完。F315 不把抽样冒充全量结论，也不让全量结论的缺席推迟前三页修复。

### 第一批 owner 收件状态（2026-09-04）

- **Team / F293**：owner 已收到 L1 文案 finding，并提交 PR #4293（exact HEAD `fa0accbe805187541f0a1c11c37f8fc9c6dabc47`，当前 OPEN）；T1–T4 已绑定到 F293 主线程消息 `0001788514405609-000745-e877281f`。Owner receipt `0001788514594985-000756-c69a8a4d` 确认没有硬契约冲突，同时要求身份信息只做现有 `/api/cats` presentation join、exact provenance 只下沉不删除、nested back 与 F208 来源入口只降视觉权重不删行为。
- **Needs Me / F310**：L1 用户处境文案已由 PR #4309 合入 main（merge `ec15b86c483997639e537f2af4cd4b448271893e`）；N1–N4 已绑定到 F310 主线程消息 `0001788514405649-000746-807db5fe`。Owner receipt `0001788514594355-000755-93c158ff` 确认 N2 已满足且没有领域契约冲突，同时要求 loading/error 不显示缓存计数或伪造 `0`、错误态保留可见重试、空态不声称 Schedule 必然存在任务并复用既有目的地。
- **Capability Evolution / F311**：输入机制说明已由 PR #4292 合入 main（merge `f3abdd5f07bb149585f85183ec3f78b45f8c4c22`）；C1–C4 已绑定到 F311 主线程消息 `0001788514405784-000747-cdfc65ab`。Owner receipt `0001788515395998-000780-bd92d471` 确认没有 Program/action/revision 契约冲突，同时要求 `StartEvolution.submit` 继续绑定 exact `targetThreadId`、只写 `setPendingChatInsert` 且不自动发送；quiet conversation chip 保持未知 thread fail-closed；人类化标题与状态不删除 raw owner/lifecycle/stage truth 或 `onOpenProgram(programId)`；颜色与字体不得暗示不存在的业务 actionability。该回执工具响应误继承的 T2 coordination id/subject 不属于 F315 真相，F315 只引用这条持久消息正文。operator 后续思辨形成的 C5–C9 已随 `39003a6a58` 落地，并沿同一 carrier 以 `0001788520611809-000916-1f172264` 增量绑定 F311 owner；owner receipt `0001788520876264-000931-ad6a463a` 确认 after-v2 没有架构阻塞，并冻结下列实现条件。

  - Program 标题使用该能力的实际产品名，只从 owner/claim display metadata 或可逆 ref-humanization 投影取得，不新增 free-text Program 字段或复制 owner payload；内部 token 留在 Raw。
  - `已采纳` 只对应 fresh outcome 后的 `keep → terminalDisposition=kept`；`已回滚` 只作为历史回执，根节点显示新 Cycle 的当前状态；`writing_back`、`revalidating`、`deciding` 必须有诚实的非终态表达。
  - pause/withdraw 可降入 `···`，但仍走 canonical lifecycle/sequence guard；只有当前用户确实拥有可执行 canonical action 时才显示实心主按钮，解释性的 `nextAction` 不构成授权。
  - setup checklist 必须动态覆盖 canonical constitution/observation 要求和全部当前 blocking gaps，责任从 owner refs / `ownerFeatureId` 得出；不得硬编码“6”。`nextEvaluationAt` 是评估触发时间，不是准备完成 ETA；无 owner ETA 时省略或诚实标 unknown。
  - 四层树只重排 canonical claim/object refs、observation、lineage、lifecycle/stage 与真实 action availability；缺 display/action binding 时 quiet/fail-closed。setup face 只是 `constituting | instrumenting` 的视图分类，journey 从 `observing` 起；不得新增 persisted `setup` enum 或第二状态机。

因此“owner 知道了”已覆盖 L1、首版逐页视觉 finding 与 Capability Evolution C5–C9 增量，T1–T4、N1–N4、C1–C9 的 owner receipt 均已完成。这里不冒充 owner 已接受首版 after 或三页已经完成；既有回执只证明 finding 可在原领域契约内实现。生产实现仍以 operator 接受修订后的页面方案与后续 exact implementation carrier 为准。

### Phase A 已接受的视觉证据（2026-09-04）

operator 已在 `[thread-id]#0001788507425448-000448-484d78d7` 选择全家视觉基线 **Anthropic + Linear**，但没有接受首版三页 after。其 `[thread-id]#0001788515250111-000776-c05f7e0c` 明确指出：Team 仅是“比之前好”，分组措辞仍不讲人话；Needs Me 只画空态，无法判断有内容时的样子；Capability Evolution 横排别扭、缺少图标与视觉落点。首版 after 因此是有效诊断证据而不是 Design Gate 签字，下一次比较必须补 Team 对称用户语言、Needs Me populated 态、Capability Evolution 竖向节奏与图形锚点，并继续用真实同类产品 anatomy 校准。

operator 又在 `[thread-id]#0001788521646251-000943-bb82ce5d` 明确退回“愿望 / 愿望名”及常驻“是否需要你”表达。Capability Evolution after-v2 必须以能力的实际产品名作标题，以稳定的产品状态 pill 表达进度，并且只有 canonical action 对当前用户真实可执行时才出现 attention / 主动作。方案必须把 F314-backed 开发流程改进、Microduck 行走稳定性、投资人路演表达能力三份真实 Program 并排代入同一 anatomy；三者是同一 Workspace 里的三个能力对象，不得假设为三个阶段、相互替代的方案或相同 lifecycle。

### 三层诊断，不把所有问题叫“换皮”

| 层 | 要回答的问题 | 典型失败 | 责任与机制 |
|---|---|---|---|
| 文案 | 页面是在说用户的处境，还是解释系统设计？ | “不复制审批状态”“只加入输入框” | 领域 renderer owner 修文案；确定词表可由现有 copy guard 守。 |
| 投影 | 信息是否挂在正确层级、状态是否统一、内部名是否已翻成用户语言？ | Team 卡级来源逐条重复；能力进化同时展示两套状态 | 领域 projection/schema owner 设计修法并加 targeted test；F083 叠加触发真实页确认。 |
| 出生证 | 这个页面或独立目的地是否应该存在？其折叠态是什么？ | 诊断详情被升成与用户任务同权的房间 | F284/F307 host owner 提供结构选项，由 operator 在 Design Gate 裁决保留或折入既有目的地。 |

这三层只是对 ADR-043 C1/C4/C5 与现有 owner 边界的诊断坐标，不是新的检查单、stage 或设计语言。

## Association Decision / 为什么不重开 F305

| 候选归属 | 裁决 | 理由 |
|---|---|---|
| 重开 F305 | 否 | F305 是预防机制与首个 pattern 证明；让它长期吞下所有页面会把 Design Gate 变成产品迁移项目。 |
| 并入 F284 | 否 | F284 拥有稳定入口、Focus、Activity 与 Launcher，不拥有各 mode 的业务内容重写。 |
| 并入 F307 | 否 | F307 拥有 Workbench working set、tab / split / restore；它明确不接管领域 renderer 内容。 |
| 新建 F315 | 是 | 存量审计、跨 owner 批次迁移、真实壳验收与最终覆盖结算有独立终态；同时只消费既有设计权威。 |

## Product Contract

F315 **不新增** ADR、skill、Magic Word、Design Gate stage、检查单、评分体系、design system、Workspace registry 或万能卡。唯一设计链仍是：

```text
F083 用户可见表面触发
→ design-in-context checklist
   ├─ ADR-043：任务、判断转移、折叠态与投影纪律
   └─ F056：在地视觉语言与现有 primitives
→ 真实 Clowder AI 壳（默认 / 有内容 / 错误 / 窄屏）
→ operator Design Gate
→ 领域 owner 的生产实现与非作者验证
```

“先看真页面”继续只是这条既有链的纠偏入口，不因 F315 再出生一个口令。

### 每个表面的交付单位

每个表面只提交同一组既有事实，不引入新 UX 分数：

- canonical 用户入口与领域 owner；
- ADR-043 C1 出生证：它为何应作为独立目的地存在；若不成立，应折入哪个**既有**目的地；
- 用户此刻唯一任务，以及首屏完成它所需的最小事实；
- 系统已知、应先给出的建议或状态结论；
- 唯一主操作和无需用户行动时的安静状态；
- 默认折叠但可恢复的精确证据；
- empty / populated / error / narrow 的真实壳证据；
- `verified-compliant / migrate / fold-into:<existing destination> / operator-excluded` 四种终态 disposition。

审计矩阵是带 exact revision 的版本化证据，不是第二份产品 registry；表面身份始终由代码中的 canonical registry / adapters 生成。

F315 拥有分层 finding、整批一致性与验收闭环，**不拥有各领域的具体修法**。Finding 可以并且必须指向真正出错的 owner 层，包括 renderer、projection 或 schema；领域 owner 决定如何在不破坏 canonical truth / action 的前提下修复并返回证据。不能用“schema 不属于呈现”把错误层级留在页面上，也不能让 F315 因指出 schema finding 而接管该 schema。

## What

### Phase A: 三个点名页面的逐页 finding 与可选方案

先处理 Team、Needs Me、Capability Evolution。对每页在真实产品壳中指明：哪块颜色没有表达语义、哪块层级是平的、哪块重复或泄露内部术语、用户第一眼因此错过了什么。每页至少带一个与该任务相符的真实产品参照，以及一个同壳改后方案；输出是可指认的 before / annotated-after 证据，不是抽象方法论或全局换色截图。

三页进入同一场批次 Design Gate：每页独立回答任务与修法，整批只统一语义节奏与 F056 视觉纪律，不创造万能卡。operator 用并排方案作判别；猫负责把问题和选择做成看得见的页面，而不是要求 operator生成设计。

### Phase B: 领域 owner 修复与三页真实壳验收

F293、F310、F311 各自修复本页命中的 renderer、projection 或必要 schema，并继续拥有数据、状态、action、权限与 recovery。F315 固定 finding、验收标准与跨页一致性，消费每个 owner 的 exact receipt 后，在 production entry 上验收 desktop / narrow 与适用状态。

“遮住旁白后能否回答发生了什么、要不要我行动、下一步是什么”不得由本页 owner 自评。每页至少由一只非 owner 猫或 operator 在真实页面上作答；内部证据不是删除，而是移到命名清楚、可恢复的详情入口。

### Parallel Track P: 19 项 census 与目的地出生证审计（不阻塞 Phase A–B）

从 canonical Workspace registry、launcher 与 F307 owner adapters 生成 19 个目的地的 census，并逐项记录 canonical 入口、owner anchor、用户任务与当前 disposition。C1 出生证不成立时，提出 `fold-into:<existing destination>` 给 F284/F307 host owner 与 operator Design Gate；未看真实壳的项目保持 unknown。

这条并行线回答“哪些能力应是独立目的地”，不替代前三页的可见修复，也不设置“fold map 完成后才能修三页”的门槛。已合入的 census guard 继续守 identity 完整性；real-shell 证据按可获得的 empty / populated / error / narrow 状态补齐。

### Phase C: 第二批生产迁移

处理 Status / Sessions 与 Approval，并消费 Parallel Track P 已确认的 owner / destination disposition。F246 及 Status / Sessions owner 各自修改命中问题的 renderer、projection 或必要 schema；F315 继续只持 finding、批次一致性与验收。

### Phase D: 剩余表面结算与回归守护

继续处理其余 census 项，直至 19 个目的地都有终态 disposition。确定契约用组件/静态 guard 守住；真实可读性以 real-shell desktop / narrow 旅程、operator sign-off 与非作者 vision review 验收。F315 不为已知缺陷另建 Eval；若未来要判断某种呈现是否有效，必须另有明确 consumer 与 keep / tune / sunset 决策才进入 eval。

## User Journey

### Primary Journey: 打开一个 Workspace 页面就知道下一步

- **Scope unit**: workspace surface
- **Actor**: operator
- **Entry**: 从现有 Workspace Launcher、当前 working set 或精确回跳进入任一表面。
- **Flow**:
  1. 页面首屏用用户语言说明发生了什么，并优先显示当前对象或状态结论。
  2. 如果需要用户行动，页面只突出一个当前决定或下一步；如果无需行动，安静说明即可。
  3. 用户无需阅读 Feature ID、hash、URI、revision、raw status token 或运行指标就能完成主任务。
  4. 用户需要核验时，展开明确命名的详情，仍能看到 canonical ID、来源、原文与运行证据。
  5. 在窄屏上，同一任务、主操作与详情恢复路径仍可达。
- **Success evidence**: Team、Needs Me、Capability Evolution 的逐页标注 finding、野外参照与真实壳 before / after；每页非 owner 猫或 operator 的三问答案；19 项 exact-revision census 与后续 disposition；陌生 sentinel 可重放旅程；desktop / narrow 截图或录屏；operator sign-off；非作者 vision review。
- **Non-goals**: 由 F315 接管 F307 working-set 拓扑、F284 Shell 或领域 store/schema/action；删除诊断能力；造统一万能卡；批量换皮。领域 owner 为修正已证实的投影错误而调整自身 schema，不等于 F315 接管 schema。

### Supporting Journey: 专业诊断仍然精确

状态、轨迹、评估等专业表面的目标用户确实需要 Session ID、token、cache、revision 或 raw provenance 时，首屏先给健康/异常/行动结论；展开详情后必须保留完整值、复制或精确跳转能力，不用模糊摘要冒充原文。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “Workspace 的各个页面大多数做得违背了 F305” | AC-P1, AC-P2, AC-D1 | code-derived census + exact revision | [ ] |
| R2 | “新建一个 feat 盘点一下我们的现状” | AC-P1, AC-P2, AC-D1 | audit snapshot + real-shell evidence | [ ] |
| R3 | “页面太难让人读懂、获取信息量；颜色没有表达和突出真正语义” | AC-A1, AC-A2, AC-B1, AC-B2, AC-C1, AC-D2 | annotated before/after + F056 visual review + operator sign-off | [ ] |
| R4 | 不重复制造冲突规则和概念 | AC-A4, AC-D3 | diff + architecture/content review | [ ] |
| R5 | “Team、Needs Me、能力进化为什么看起来那么吃力？前端设计犯了什么错误？别人如何设计？” | AC-A1, AC-A2, AC-B1 | annotated comparison + wild reference + real-shell answer | [ ] |
| R6 | “我想要的完全不是你们在干的这个”——不以换色或房间规划替代三页修复 | AC-A3, AC-P3 | phase order + owner receipts + operator comparison | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有可执行验证方式。
- [x] 前端需求已定义需求→真实壳证据映射。

## Acceptance Criteria

### Phase A（三页 finding 与方案）

- [x] AC-A1: Team、Needs Me、Capability Evolution 各有逐块标注的真实壳诊断，明确颜色语义、视觉层级、重复信息、内部术语及其对用户理解的影响。
- [x] AC-A2: 三页各有至少一个任务相符的野外参照和一个同壳改后方案；参照说明借用的表达原则，不照抄品牌外观。
- [x] AC-A3: 三页 finding 分别绑定 F293/F310/F311 的 renderer / projection / schema anchor 与 owner receipt，不等待 census 或 fold map 才行动。（T1–T4、N1–N4、C1–C9 均已完成 owner receipt；C5–C9 条件见 `0001788520876264-000931-ad6a463a`。）
- [x] AC-A4: 审计只引用 ADR-043、F056、`DESIGN.md` 与唯一 design-in-context checklist；仓内没有新增 Design Gate、评分体系、规则清单或 Workspace registry。

### Phase B（三页 owner 修复与真实壳验收）

- [ ] AC-B1: 三个表面在**同一场批次 Design Gate**提供真实 Clowder AI 壳同入口 before / after；遮住设计说明后，每页由非 owner 猫或 operator 回答“发生了什么、要不要我行动、下一步是什么”，owner 自答不算证据。Capability Evolution 还须以 F314-backed 开发流程改进、Microduck 行走稳定性、投资人路演表达能力三份真实 Program 并排证明同一 anatomy 能表达不同对象与当前状态。
- [ ] AC-B2: desktop 与 narrow 状态都保留主任务、唯一主操作和精确详情恢复；颜色优先表达当前状态、真正差异、唯一决定或主操作；operator 在生产实现前给出方向裁决。
- [ ] AC-B3: F293/F310/F311 的生产修复均有 exact receipt 与 targeted tests，且 typed action、权限、canonical store、revision/CAS 与 F307 working-set 行为保持不变。
- [ ] AC-B4: 共享 primitive 只有在两个以上真实表面证明同型需求后才进入 F056；不同领域任务不被强迫共用同一张卡。

### Parallel Track P（全量现状盘点，不阻塞 Phase A–B）

- [ ] AC-P1: 从 canonical registry / launcher / owner adapters 生成并锁定 exact revision 的 19 项 Workspace 目的地 census；新增或移除目的地会使 guard 失败，而不是让手写清单静默腐烂。
- [ ] AC-P2: 每个目的地都有 canonical 入口、renderer/owner anchor、ADR-043 C1 出生证、用户任务、首屏最小事实、主操作、详情恢复与当前 disposition；出生证不成立时给出折入既有目的地的方案，未验证项明确标 unknown。
- [ ] AC-P3: census / fold map 独立推进，但不是前三页 finding、owner 修复或真实壳验收的前置条件；没有以全局换色或 IA 讨论替代点名页面交付。

### Phase C（第二批生产迁移）

- [ ] AC-C1: Status / Sessions 与 Approval 的首屏不再用 Feature/Gate/owner、hash/URI/revision、raw status token 或 provider event prose 承担主叙事；目标用户真正需要的技术术语除外。
- [ ] AC-C2: 每个内部字段仍可从明确详情入口恢复；原文、ID、复制/跳转与领域 recovery 不丢失。
- [ ] AC-C3: 各领域的 typed action、权限、canonical store、revision/CAS 与 F307 working-set 行为保持不变，并由 targeted tests 覆盖。
- [ ] AC-C4: 每条 migration finding 都落到真实 owner 的 renderer / projection / schema 修复与 receipt；F315 不复制领域 schema，也没有 finding 因“超出呈现层”被静默关闭。

### Phase D（全量结算）

- [ ] AC-D1: 19 个目的地全部结算为 `verified-compliant / migrated / folded-into:<existing destination> / operator-excluded`，没有未归属的 unknown；折入结论有 host owner 与 operator Design Gate 证据。
- [ ] AC-D2: 每个 migrated 表面都有 exact production entry 的 desktop / narrow evidence；最终 Alpha 用户旅程与非作者 vision review 无 P1/P2。
- [ ] AC-D3: 最终 diff 没有新 ADR、skill、Magic Word、stage、design system、registry，且没有 F315-owned store/schema；领域 owner 若调整自己的 projection/schema，必须保持 canonical ownership 并附 targeted contract evidence。F305/F284/F307/F246 等 owner 边界保持。

## Dependencies

- **Evolved from**: F305（Design Gate closure 与首个生产 pattern 证明）。
- **Design authority**: ADR-043、F056、F083 与现有 design-in-context checklist。
- **Host boundary**: F284（Contextual Shell）与 F307（Composable Workbench）。
- **First batch domain owners**: F293 Team、F310 Needs Me、F311 Capability Evolution。
- **Second batch domain owners**: F246 Approval；Status / Sessions 继续由现有运行与 session owner 提供 truth。

## Risk

| 风险 | 缓解 |
|---|---|
| 变成 19 页统一换皮 | 每页先写用户任务；不同任务不共卡，只复用已证明的 primitive。 |
| 为了简洁删掉关键证据 | 首屏最小化与详情完整恢复成对验收；专业诊断面保留精确值。 |
| F315 变成第二套设计规则 | 所有判断逐项锚到 ADR-043/F056/checklist；无 source 的规则不进入 spec。 |
| 和 F284/F307 或领域 owner 抢所有权 | F315 只持 audit + migration closure；宿主拓扑、数据、action、store 与 lifecycle 原 owner 不变。 |
| 19 个房间都被默认保留，只是变漂亮 | 并行 census 每项回答 ADR-043 C1；不成立则进入折入既有目的地的 host/operator 裁决。 |
| census、fold map 或全局换色再次取代 operator 点名页面 | Phase A–B 先交付三页 finding、owner 修复与真实壳验收；Parallel Track P 不构成前置门。 |
| owner 自己证明自己的页面易懂 | 三问必须由非 owner 猫或 operator 在真实页面回答。 |
| 全量盘点再次变成人工腐烂清单 | 身份从 canonical code 生成；文档矩阵只保存 exact-revision audit evidence。 |
| 一次铺开导致长期半成品 | 三个用户点名表面先过同壳 Design Gate，再处理第二批与其余表面；最终仍以全 19 项 disposition 才可关闭。 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 新建 F315，不重开 F305 | 预防机制与存量迁移是两个可独立完成的终态。 | 2026-09-03 |
| KD-2 | 先交付 Team、Needs Me、Capability Evolution 三页的 finding→owner 修复→验收；census/fold map 并行且不阻塞 | operator 要的是点名页面看得见的修复，不是先完成房间规划。 | 2026-09-04 |
| KD-3 | 不创建可读性评分或新检查单 | 正确判据已经存在；缺口是覆盖和迁移，不是概念。 | 2026-09-03 |
| KD-4 | 技术信息渐进披露，不做删除 | “易读”和“可核验”必须同时成立。 | 2026-09-03 |
| KD-5 | 三层诊断：文案 / 投影 / 出生证 | 三层由不同 owner 与机制解决；把它们统称换皮会漏掉 schema 形状与页面存在性。 | 2026-09-03 |
| KD-6 | 第一批三页进入同一场 Design Gate | 各页修法归领域 owner，跨页语义节奏与 F056 视觉纪律由 F315 批次验收，避免三家三审美。 | 2026-09-04 |
| KD-7 | 全局换色与目的地出生证审计都不能冒充点名页面交付 | 它们解决不同问题；按 claim 选机制，并行推进但不设错误前置门。 | 2026-09-04 |

## Review Gate

- Phase A 是用户可见设计 finding：真实壳标注对比 + 野外参照 + operator Design Gate，不用工程语言代替体验裁决。
- Phase B 是三页 production 修复与验收：依各 owner 的真实改动风险走 targeted tests、exact-HEAD 非作者 review 与 Alpha vision guard。
- Parallel Track P 的 census 是确定契约：静态/组件 guard + real-shell evidence，但不阻塞 Phase A–B。
- Phase C–D 按第二批与剩余表面的真实风险继续迁移和结算。

## Tips Contribution

F315 不增加新能力或新入口。它修复现有页面的自解释性，因此不应再用主动 tip 教用户如何穿过坏的信息架构；frontmatter `tips_exempt` 记录这一边界。
