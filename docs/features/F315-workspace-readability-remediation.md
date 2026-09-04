---
feature_ids: [F315]
related_features: [F056, F083, F246, F284, F293, F299, F305, F307, F310, F311]
topics: [workspace, ui, ux, readability, information-architecture, progressive-disclosure, product-language]
tips_exempt: "2026-09-03 review renewal: this refines the audit and owner handoff contract without adding a new user-invokable capability or discovery step; each repaired surface must teach itself in place."
doc_kind: spec
created: 2026-09-03
description: "盘点并迁移现有 Workspace 用户表面，使首屏先回答发生了什么、是否需要行动与下一步是什么，同时保留按需可达的精确证据。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-03T21:40:00-07:00
---

# F315: Workspace Readability Remediation｜存量页面从内部对象回到用户任务

> **Status**: spec | **Owner**: 小太阳·Maine Coon（@codex-sol, GPT-5.6 Sol） | **Priority**: P1
>
> **operator source**: `[thread-id]#0001788492776995-000225-df6cc10c`——Workspace 多数页面仍违背 F305，信息难读、内部概念过多；F305 关闭后应另立 Feature 盘点现状并治理。

Architecture cell: **none（cross-owner presentation remediation）**；相关产品宿主为 `hub-action-surface`。

Map delta: **none**。F315 不取得 Workbench 布局、领域对象、业务 action、store 或 lifecycle 的所有权。

## Why

F305 解决的是“以后怎样不再从 schema 直接长出 UI”：把 F083、ADR-043、F056 与真实页面证据接成一条 Design Gate，并用 Approval / Needs Me 做第一个生产验证点。它明确把“重做整个 Workspace”列为 non-goal，因此 F305 关闭并不等于存量页面已经迁移。

当前真实缺口是：**旧的 Workspace 表面仍以领域对象和工程字段为叙事中心，用户必须自己把 ID、状态、来源与内部术语翻译成任务。** 这不是颜色或圆角问题，而是信息架构债务。ADR-043 §4 已预留正确出口：存量不要求任意 PR 顺手重写；迁移超出当次授权时应另行立项。F315 就是这次被用户明确授权的迁移 owner。

终态只有一句话：

> 用户进入任一 Workspace 页面，首屏先看懂发生了什么、是否需要自己行动、下一步是什么；精确 ID、来源、运行指标与 Raw 不丢失，但只在任务确实需要时出现。

## Current State / 现状基线

### 代码可达面

`WORKSPACE_MODES` 当前有 12 个 mode（含 `dev`）；`WorkspaceLauncher` 在 `dev` 下暴露 5 个具体表面，并额外暴露 Status、Capability Evolution 与 Theater。由现有 canonical registry / launcher 计算，当前用户可达目的地共 **19 个**：

- 5 个开发表面：Files、Changes、Git、Terminal、Browser；
- 11 个领域 mode：Recall、Needs Me、Product Schedule、Schedule、Tasks、Team、Community、Artifacts、Approval、Trajectory、Eval；
- 3 个其他宿主入口：Status、Capability Evolution、Theater。

### 首批五个真实样本

operator 在同一条消息附了 Team、Needs Me、Capability Evolution、Status / Sessions、Approval 五个真实页面。独立读图与源码确认：

1. **Team 猫详情**：每条可读结论后重复展示 `capability_strength`、SHA 与 source refs，工程 provenance 的视觉重量大于“这只猫适合做什么”。
2. **Needs Me 空态**：层级克制，但“原 owner”“不复制审批状态”等实现边界进入了产品说明；空态在解释系统，而不是只回答用户接下来需不需要做事。
3. **Capability Evolution**：整体结构已经明显更好，但真实卡片内容仍可能出现 Feature 标题、英文 harness 名和内部 lifecycle 语言；presentation 改善不能替 owner projection 生成用户语言。
4. **Status / Sessions**：诊断详情本身有价值，但 UUID、token/cache/compression、封存与运行状态同时成为默认阅读层；缺少“现在是否正常、是否要处理”的摘要入口。
5. **Approval**：F305 的共享卡结构仍在，但 producer summary / event provenance 可把内部任务标题、`Verified ... requested ...` 与空的“审批理由”重新送回首屏；说明共享壳正确并不足以保证领域文案正确。

这五个样本足以证明问题存在，不足以代表另外 14 个目的地已经审完。F315 不把抽样冒充全量结论。

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

### Phase A: 全量现状盘点与首批排序

从 canonical Workspace registry、launcher 与 F307 owner adapters 生成 19 个目的地的 census。逐个打开真实产品壳，采集可获得的 empty / populated / error / narrow 状态，并用现有 design-in-context checklist 记录出生证、任务、最小事实、主操作与折叠详情。若一个目的地的 C1 出生证不成立，Phase A 不把它美化后默认保留，而是把 `fold-into:<existing destination>` 方案投给 F284/F307 host owner 与 operator Design Gate。

五个 operator 截图表面是第一批，不用“最丑页面”或主观打分重新排序；其余表面未看之前保持 unknown。

### Phase B: 真实壳 Design Gate 与迁移批次冻结

先为第一批表面做同壳 before / after，而不是独立 `/dev` 拼图。**五个页面进入同一场批次 Design Gate**：每页独立回答任务与修法，同时整批回答“跨 surface 如何保持一致”。一致的是语义节奏与视觉纪律，不是万能卡——标签保持中性，F056 单一强调色优先留给当前状态、真正差异、唯一决定或主操作，不用大面积强调眉题；每页带一个与自身任务相符的野外参照和至少一个备选形态。只有两个以上表面反复需要同一 disclosure primitive，才把它回流 F056。

“遮住旁白后能否回答发生了什么、要不要我行动、下一步是什么”不得由本页 owner 自评。每页至少由一只非 owner 猫或 operator 在真实页面上作答，并把答案作为 disposition 证据；operator 确认整批用户旅程与信息层级后，才进入生产迁移。

### Phase C: 第一批生产迁移

优先处理 Team、Needs Me、Capability Evolution、Status / Sessions 与 Approval。F315 固定 finding、验收标准与批次一致性；F293/F310/F311/F246 及 Status / Sessions owner 各自修改命中问题的 renderer、projection 或必要 schema，并继续拥有数据、状态、action、权限与 recovery。内部信息不是删除，而是移到命名清楚、可恢复的详情入口。

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
- **Success evidence**: 19 项 exact-revision census；首批五个表面的 real-shell before / after；每页非 owner 猫或 operator 的三问答案；陌生 sentinel 可重放旅程；desktop / narrow 截图或录屏；operator sign-off；非作者 vision review。
- **Non-goals**: 由 F315 接管 F307 working-set 拓扑、F284 Shell 或领域 store/schema/action；删除诊断能力；造统一万能卡；批量换皮。领域 owner 为修正已证实的投影错误而调整自身 schema，不等于 F315 接管 schema。

### Supporting Journey: 专业诊断仍然精确

状态、轨迹、评估等专业表面的目标用户确实需要 Session ID、token、cache、revision 或 raw provenance 时，首屏先给健康/异常/行动结论；展开详情后必须保留完整值、复制或精确跳转能力，不用模糊摘要冒充原文。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “Workspace 的各个页面大多数做得违背了 F305” | AC-A1, AC-D1 | code-derived census + exact revision | [ ] |
| R2 | “新建一个 feat 盘点一下我们的现状” | AC-A2, AC-A3 | audit snapshot + real-shell evidence | [ ] |
| R3 | “页面太难让人读懂、获取信息量；颜色没有表达和突出真正语义” | AC-B1, AC-B2, AC-C1, AC-D2 | before/after journey + F056 visual review + operator sign-off | [ ] |
| R4 | 不重复制造冲突规则和概念 | AC-A4, AC-D3 | diff + architecture/content review | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有可执行验证方式。
- [x] 前端需求已定义需求→真实壳证据映射。

## Acceptance Criteria

### Phase A（全量现状盘点）

- [ ] AC-A1: 从 canonical registry / launcher / owner adapters 生成并锁定 exact revision 的 19 项 Workspace 目的地 census；新增或移除目的地会使 guard 失败，而不是让手写清单静默腐烂。
- [ ] AC-A2: 每个目的地都有 canonical 入口、renderer/owner anchor、ADR-043 C1 出生证、用户任务、首屏最小事实、主操作、详情恢复与当前 disposition；出生证不成立时给出折入既有目的地的方案，未验证项明确标 unknown。
- [ ] AC-A3: 第一批五个 operator 截图表面各有真实 empty / populated / error / narrow 中适用状态的复现证据，不以单张截图或 fixture 旁白代替交互。
- [ ] AC-A4: 审计只引用 ADR-043、F056 与唯一 design-in-context checklist；仓内没有新增 Design Gate、评分体系、规则清单或 Workspace registry。

### Phase B（真实壳 Design Gate）

- [ ] AC-B1: 第一批五个表面在**同一场批次 Design Gate**提供真实 Clowder AI 壳同入口 before / after；遮住设计说明后，每页由非 owner 猫或 operator 回答“发生了什么、要不要我行动、下一步是什么”，owner 自答不算证据。
- [ ] AC-B2: desktop 与 narrow 状态都保留主任务、主操作和精确详情恢复；整批遵守 F056 single-accent discipline，颜色优先表达当前状态、真正差异、唯一决定或主操作；operator 在生产实现前给出 keep / tune / sunset。
- [ ] AC-B3: 共享 primitive 只有在两个以上真实表面证明同型需求后才进入 F056；不同领域任务不被强迫共用同一张卡。

### Phase C（第一批生产迁移）

- [ ] AC-C1: Team、Needs Me、Capability Evolution、Status / Sessions、Approval 的首屏不再用 Feature/Gate/owner、hash/URI/revision、raw status token 或 provider event prose 承担主叙事；目标用户真正需要的技术术语除外。
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
- **First batch domain owners**: F293 Team、F310 Needs Me、F311 Capability Evolution、F246 Approval；Status / Sessions 继续由现有运行与 session owner 提供 truth。

## Risk

| 风险 | 缓解 |
|---|---|
| 变成 19 页统一换皮 | 每页先写用户任务；不同任务不共卡，只复用已证明的 primitive。 |
| 为了简洁删掉关键证据 | 首屏最小化与详情完整恢复成对验收；专业诊断面保留精确值。 |
| F315 变成第二套设计规则 | 所有判断逐项锚到 ADR-043/F056/checklist；无 source 的规则不进入 spec。 |
| 和 F284/F307 或领域 owner 抢所有权 | F315 只持 audit + migration closure；宿主拓扑、数据、action、store 与 lifecycle 原 owner 不变。 |
| 19 个房间都被默认保留，只是变漂亮 | 每项必须回答 ADR-043 C1 出生证；不成立则进入折入既有目的地的 host/operator 裁决。 |
| owner 自己证明自己的页面易懂 | 三问必须由非 owner 猫或 operator 在真实页面回答。 |
| 全量盘点再次变成人工腐烂清单 | 身份从 canonical code 生成；文档矩阵只保存 exact-revision audit evidence。 |
| 一次铺开导致长期半成品 | 五个用户已指出的表面先过同壳 Design Gate，再按可验收批次迁移；最终仍以全 19 项 disposition 才可关闭。 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 新建 F315，不重开 F305 | 预防机制与存量迁移是两个可独立完成的终态。 | 2026-09-03 |
| KD-2 | 先 census，再按用户已给出的五个样本开第一批 | 已知问题先行动，未知页面不靠猜测排序。 | 2026-09-03 |
| KD-3 | 不创建可读性评分或新检查单 | 正确判据已经存在；缺口是覆盖和迁移，不是概念。 | 2026-09-03 |
| KD-4 | 技术信息渐进披露，不做删除 | “易读”和“可核验”必须同时成立。 | 2026-09-03 |
| KD-5 | 三层诊断：文案 / 投影 / 出生证 | 三层由不同 owner 与机制解决；把它们统称换皮会漏掉 schema 形状与页面存在性。 | 2026-09-03 |
| KD-6 | 第一批五页进入同一场 Design Gate | 各页修法归领域 owner，跨页语义节奏与 F056 单强调色由 F315 批次验收，避免三家三审美。 | 2026-09-03 |

## Review Gate

- Phase A census 是确定契约：静态/组件 guard + real-shell evidence。
- Phase B 是用户可见设计：operator Design Gate，不用工程 review 代替体验裁决。
- Phase C–D 依真实改动风险走 targeted tests、exact-HEAD 非作者 review 与 Alpha vision guard。

## Tips Contribution

F315 不增加新能力或新入口。它修复现有页面的自解释性，因此不应再用主动 tip 教用户如何穿过坏的信息架构；frontmatter `tips_exempt` 记录这一边界。
