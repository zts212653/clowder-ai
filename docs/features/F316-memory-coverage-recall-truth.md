---
feature_ids: [F316]
related_features: [F200, F209, F221, F231, F260, F276, F282, F287, F296, F312]
topics: [memory, recall, coverage, profile, entity, person, taste, runtime-acceptance]
doc_kind: spec
tips_exempt: "Phase C 2026-09-04 renewal: F316 adds a task-bounded internal Taste cue/drill path, not a new user-invokable action or teaching surface."
created: 2026-09-04
description: "让每类记忆都能说明自己记住了什么、何时该出现、能否精确读回，以及真实任务中是否确实帮助了猫。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-04T12:09:00Z
---

# F316: Memory Coverage & Recall Truth｜记忆内容覆盖与真实召回验收

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon（@codex-sol, GPT-5.6 Sol）+ F316 总控线程责任猫 | **Priority**: P1

## Why

F312 已把 21 个记忆 surface 的 Standing Reflex 结构账结到 `missing=0 / RED=0`，但这只回答
“每条 lane 是否有合规 disposition 与证据”，没有回答operator今天真正追问的产品问题：

> “Taste 里能找到我所有对 UI/UX 的品味吗？也不止 Taste，还有我们的关系、Entity、Person。”

当前若把“合同闭环”说成“所有该记住的内容都能读回并影响行为”，就是跨级推断。反过来，把所有
Taste、人物或关系正文常驻塞入每轮 query，又会把记忆系统退化成越来越长的 prompt 垃圾场。

F316 的价值终态是：**咱们能对每一类记忆给出有边界、可复核的覆盖答案；该出现时只送一个小而准的
source-ref bundle，猫能钻取 canonical revision 并在真实任务中使用；不该出现时保持安静。** operator不再
需要逐条踢屁股追问哪类记忆漏了，owner 猫会沿同一总控持续发现、派工、复验和关账。

## Current State / 现状基线

### 结构账已经完成，但内容账尚未出生

F312 Phase G 在 merged-main Alpha 独立复跑后给出的 authoritative baseline 是：

| 项 | 当前真相 | F316 判读 |
|---|---:|---|
| surface universe | 21 | 可作为本轮 census 的闭世界全集，不能删行变绿 |
| active | 10 | 有合规 consumer contract，不等于内容全集可读 |
| exempt | 10 | 没有合格 proactive pair；不应为整齐而造 cue/receipt/eval |
| sunset | 1 | F152 不再进入 generic delivery；producer/forensic 证据保留 |
| missing surfaces / exact RED | 0 / 0 | 结构 closure 完成，不是内容 coverage 完成 |

21 条 surface 与实时 disposition 继续以
[`memory-architecture-closure.generated.md`](../architecture/memory/memory-architecture-closure.generated.md)
为真相源。F316 不复制第二份运行时 registry，只从该 catalog 生成带 exact revision 的审计快照。

### 已知的三个内容/读模型断点

1. **Taste（F221）**：审批、vignette 与索引链已存在，F312 也证明过一次显式 ELI5→HTML Widget 的
   `presented → drilled → applied`。但这不能证明“所有已批准 UI/UX Taste”在当前 revision 都能被
   Index、Graph 与 search 完整读到，更不能证明任意 UI 任务都会组成相关且不漏项的有界 bundle。
2. **Profile / Relationship（F231）**：F312 已加载 Profile runtime contract，但 Alpha 当时没有合格
   candidate，因此诚实 ceiling 是 `loaded/no-candidate`。You↔cat 的关系 primer、称谓与相处边界仍需
   用真实 canonical capsule 验证 cold/resumed read path，而不是用系统 prompt 或当前聊天冒充记忆。
3. **Entity / Person（F260 / F276）**：Entity 只回答“这个名字指向谁”，Person 才拥有 owner-private
   第三方人物事实、关系和互动。吴浪 vertical slice 已出现过真实 Person drill/application，但历史上也
   实测过精确别名 `not_available`、doc-title 被误当人物线索、不同 consumer cue 不一致等边界。单个成功
   episode 不能替代 alias universe、unknown/ambiguous、correction/forget 与 privacy 的系统验收。

### “所有”必须拆成两个不同命题

| 命题 | 是否可闭环 | 完成定义 |
|---|---|---|
| 当前 revision 下**所有已批准 canonical item** | 是，闭世界 | authority manifest / index / storage 集合相等；每项有可解析 anchor 与 owner-prescribed read path |
| 历史聊天里**所有可能算品味/人物线索的原话** | 否，开放世界 | 做 source coverage 与候选差异报告；未经 owner/operator 审批绝不自动升级为 canonical truth |

F316 只对第一类作“完整”承诺；第二类只承诺可追踪候选、误差边界与下一 owner action。

## Association Decision / 为什么不是再开一个 F221 Thread

| 候选归属 | 裁决 | 理由 |
|---|---|---|
| 新开 F221 总控 thread | 否 | F221 已有 active owner thread，且只拥有 Taste authority；让它吞下关系、Entity、Person 会越权。 |
| 重开 F312 | 否 | F312 已按 21-surface 结构合同 terminal；内容覆盖是后继产品命题，不应改写历史完成定义。 |
| 各 lane 各自悄悄修 | 否 | 会再次失去跨面 census、优先级、最终真实任务验收与持续持球者。 |
| 新建 F316 薄总控 | 是 | 它只拥有 coverage definition、source map、缺口路由和跨面 runtime acceptance；实现仍回原 owner。 |

F221、F231、F260、F276 等既有 thread 继续是各自 canonical owner。F316 Phase thread 发现问题后只投
exact source ref、失败证据和验收条件，不复制 marker、不替 owner 改 authority。

## Architecture Admission

Architecture cell: memory

- **Map delta**: 新增一个从 21-surface closure catalog 派生的 content/read coverage 审计与 acceptance
  视图；不新增中央 registry、store、index、cue engine、approval authority 或内容副本。
- **Canonical truth**: 各 lane owner 的 manifest/store/file + F209/F287/F296 既有 read/presentation plane。
- **Transport**: query 只携带 bounded cue 与 opaque/exact source coordinates；正文在 authorized drill 后读。
- **Mechanism selection**: 集合完整性、revision、权限与失效用 test/lint/guard；耗时、掉 cue 与稳定性用
  logs/metrics/traces；只有明确 consumer 要做 keep/tune/sunset 时才为 utility eval 建出生证。
- **Privacy**: Profile 与 Person 继续 owner-private；Entity 的共享 identity root 不获得人物事实或关系正文。

## Product Contract

每条 surface 的 Phase A 审计只回答以下问题中**适用于该 claim 的部分**，不是强迫所有 lane 补齐同一清单：

1. 谁拥有 canonical authority，当前可枚举 universe 与 revision 是什么；
2. 已批准内容能否从 owner store/file 到 Index/Graph/search/read path 保持集合与 revision 一致；
3. 什么 typed predicate 才允许它进入当前 invocation，non-match 是否为零 payload；
4. consumer 获准怎样使用，正文是否只在 authenticated/authorized drill 后读取；
5. 真实使用是否有同一 thread/invocation/cat/revision 的 receipt 与 bounded outcome；
6. correction、forget、expiry、scope drift 或 source revision change 后是否 fail closed。

`active` surface 依其已声明合同验收；`exempt` 只核 exemption 与 pull path，不被强行出生 cue/receipt；
`sunset` 只核 generic delivery 已退出且 forensic truth 未被删除。

## What

### Phase A: 21-Surface Content & Read Census｜内容与读模型全景盘点

从 generated closure catalog 机械取得 21 条 universe，在一份 exact-revision audit 中逐项记录 authority、
canonical corpus、枚举能力、parse/index/read path、runtime ceiling、privacy、invalidation、owner thread 与唯一
next action。至少用三种不同入口交叉检查：owner source/manifest、Index/Graph/search、真实或可重放 runtime
evidence。未知保持 unknown；不得用一条成功样本替代集合覆盖。

Phase A 只诊断和路由，不在总控里批量修所有 lane。每个确定缺口回到既有 owner thread；无 owner 才按
F128 提议，不猜投。

#### Phase A truth（2026-09-04）

盘点结果见
该快照从 `memory-architecture-closure.generated.json@b841a5cae0` 机械取得 21 行，以 owner source、
Index/Graph/search、真实或可重放 runtime evidence 三路交叉；当前裁决为 **12 个合同内、3 个确定修复路由、
6 个证据上限**。Relationship vertical 的真实 Profile/Person convenience read 已成立；owner/source 复核进一步
确认 canonical cue/drill 已有 exact revision 绑定。F312 还保存了吴浪 `subject_seen → canonical drill → applied →
410 expired` 的真实 Person episode；Phase B 未闭的是 Profile cold/resumed evidence，以及该 Person episode 到当前
approved revision 的 continuity / independent reuse 证明，而非第二个 read API 或凭空重拍一次 Person journey。
Taste 存在一个明确 dangling index anchor；Episode 的真实 artifact 已领先于 generated index 与 closure 声明。
Phase A 不修改各 lane 实现，owner receipts 与非作者 source-map/absence review 在同一主 PR 内补齐。

### Phase B: Relationship Vertical｜Profile + Entity + Person

先收operator点名的关系链：

- Profile 验证 You↔cat 当前关系、称谓与沟通边界的 canonical revision 能在合格 cold/resumed 场景被读；
- Entity 验证 known / unknown / ambiguous alias 与共享 identity root，不从 doc title 或同名推断人物；
- Person 验证一个 owner-private known person 在独立 consumer 中完成有界 recall，并覆盖
  correction/forget/expiry 至少一种真实 invalidation。吴浪 F312 历史 episode 仅可在 exact current-revision
  equality 与坐标均被独立复核时复用；revision 不同或任一证明无法取得时，重跑一条 current-revision
  episode，或记录明确的 typed blocker；
- 三者保持不同 authority/store/privacy，不能为了“一次搜全”合成中央人物库。

### Phase C: Taste Closed-World Coverage｜UI/UX 品味全集与有界 Bundle

由 F221 owner 修复审计命中的 Index↔file↔Graph/search freshness 或 anchor 完整性，建立当前 revision 下
“全部已批准 UI/UX Taste”的集合守门。随后用一个真实 UI/UX 任务，让 typed predicate 生成**相关 source refs
组成的小 bundle**，消费猫钻取 canonical vignettes 后说明哪些约束实际影响了方案，并记录
`applied | dismissed` 的有界 outcome。

历史聊天 source coverage 作为候选差异报告单列；它不能自动写入 Taste，也不能把全部 Taste 正文塞进 prompt。

### Phase D: Remaining Active Lanes｜其余 active 面按证据收口

按 Phase A 的 breakClass 与用户价值排序，依次路由 cat-owned Seed、Decision、Event、Lessons Learned、
Project Knowledge、Skill 等 remaining active surfaces 的确定 coverage/read gap。一个 Phase 只使用一个 execution
thread 与一个主 PR，多 lane 用语义 commit 纵切；只有 merged-main Alpha 才暴露、且前序主 PR 不可能观察的
独立 production RED，才允许 narrow follow-up PR。

#### Phase D evidence truth（2026-09-05，merged-main Alpha）

当前 main 重放见

- Episode generated index 已由 F243 纳入一条真实 artifact；Phase D 只把 closure 的“仅模板”改为当前 corpus，
  disposition 继续 `exempt`、consumer 继续 pull-only，不从 artifact 反推 proactive cue/receipt/outcome。
- Seed 无 scheduled Present Loop wake；Project Knowledge 的 parent F316 task 虽真实存在，但当前 A2A execution
  carrier 没有 task/workflow binding 或 owner-origin admission。两者都没有 eligible pair，保留 evidence ceiling。
- Skill 在本 managed full invocation 通过唯一支持的 `workspace-navigator.navigate.v1` consumer 写入
  revision-bound `applied / queued` receipt；`queued` 不证明用户已看到，receipt 也不证明全文读取或任务成功。
- Lessons 只选择本 Phase 本来就要求的 merged-main Alpha startup 作为 LL-015 的真实 named consumer；
  `alpha/main-sync@abeb512779` 实际选中 worktree Redis 6398，catalog/lesson 16/16 与 strict closure 通过，
  不将一次 guarded startup 升级成全 Lesson utility。
- Decision/Event 的 F312 evidence messageId 仍存在且合同代码未漂移；旧文档把 main-thread cross-post 错绑到
  Phase G execution thread，本 Phase 只修正 source coordinate，不重复制造 runtime episode。

以上均为确定合同或运行健康 claim；没有匹配的 utility consumer + `keep | tune | sunset` 决策 + 指标出生证，
所以 Phase D 不创建 Eval。

### Phase E: Independent Runtime Acceptance & Vision Guard｜终验

在 merged-main Alpha 上由非作者复验至少四种不同 authority：Relationship vertical、Taste、一个时效型面、
一个项目/决策型面。验收同时包含 non-match=0、match=bounded refs、authorized drill、revision binding、
applied/dismissed 与 invalidation negative。最后重新生成 21-surface coverage truth，逐项标清 evidence ceiling；
没有真实 candidate 的 lane 绝不伪造 receipt。

## User Journey

### Primary Journey: 猫在需要时真的记得，而且说得清记忆边界

- **Scope unit**: invocation
- **Actor**: operator + 当前消费猫
- **Entry**: operator自然提到一个人物、关系、UI/UX 设计判断、事件或当前项目问题。
- **Flow**:
  1. 系统只在 typed predicate 命中时给消费猫一条小型 cue；未命中时不注入 21 条 surface 内容。
  2. 猫沿 source coordinates 钻取 owner canonical revision，区分 `resolved / not_available / ambiguous`。
  3. 猫只在授权范围内使用该记忆，并在回答中自然体现相关约束；不把同名、标题或旧聊天猜成事实。
  4. 系统记录同一 invocation 的 `applied | dismissed | unconfirmed` bounded outcome。
  5. 来源被更正、遗忘、过期或越权后，旧 handle/cue fail closed，下一轮不再沿用旧正文。
- **Success evidence**: 21-surface exact-revision audit；Profile cold/resumed journey；Entity 三态矩阵；Person
  current-revision episode 或经独立复核的 F312 exact-revision continuity；Taste
  Index↔file set-equality guard 与真实 UI 任务；Alpha trace/receipt/outcome/invalidation；非作者 vision guard。
- **Non-goals**: 把所有历史聊天都自动变成记忆；把所有 memory 正文常驻注入 query；合并 Profile、Entity、
  Person、Taste 等 owner authority；为没有 keep/tune/sunset 问题的确定合同滥挂 Eval Hub。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “排查一下每个记忆系统的部分吧，也不止有 Taste” | AC-A1, AC-A2, AC-E1 | 21-surface exact-revision audit + independent acceptance | [ ] |
| R2 | “比如我们的关系” | AC-B1, AC-B4 | Profile cold/resumed drill + revision/invalidation evidence | [ ] |
| R3 | “那些的 Entity？Person？” | AC-B2, AC-B3, AC-B4 | known/unknown/ambiguous + private Person lifecycle | [ ] |
| R4 | “Taste 里能找到我所有对 UI/UX 的品味吗？” | AC-C1, AC-C2, AC-C3 | set-equality guard + real UI task + bounded outcome | [x] |
| R5 | 不把所有记忆硬塞进每轮 query | AC-E2 | match/non-match prompt-shape traces | [ ] |
| R6 | owner 猫自己驱动闭环，不让operator做人肉路由器 | AC-A3, AC-D1, AC-E4 | owner receipts + durable task + terminal packet | [ ] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（本 Feature 不新增 UI；真实 UI 任务证据归 AC-C2）

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：覆盖真相、关系/人物/Taste 读回、bounded prompt、自驱闭环。 -->

### Phase A（21-Surface Content & Read Census）

- [x] AC-A1: 审计 universe 与 generated catalog set-equal 为 21；每行均含 exact ownerRef、canonical corpus/
  query contract、revision、read path、evidence ceiling、privacy/invalidation 与唯一 nextAction；未知不得省略。
- [x] AC-A2: active / exempt / sunset 分别按自身 disposition 核验，不把未选机制记作缺口；至少三路独立证据后，
  所有确定 break 均有可重放 source ref 与 breakClass。
- [x] AC-A3: 每个需修缺口已投递到可查证的既有 owner thread，并获得 durable receipt；无 owner 才走 F128。
- [x] AC-A4: 非作者架构审阅确认 F316 未新增中央 registry/store/index/cue engine/authority 或内容副本。

### Phase B（Relationship Vertical）

- [ ] AC-B1: 合格 cold 与 resumed consumer 能从 canonical Profile revision 读出当前 You↔cat 关系范围；无
  candidate 时返回诚实 no-candidate，不从系统 prompt/current chat 冒充 receipt。**2026-09-04 Phase B ceiling**：
  当前 carrier 是 A2A、非 strict owner-auth interactive invocation，故 Profile predicate 合法未运行；typed
  blocker=`ineligible_invocation`，无 cue/drill/receipt，详见 Phase B evidence。
- [x] AC-B2: Entity 对 known / unknown / ambiguous alias 有确定测试与真实调用，且 doc-title/同名不能升级人物事实。
  **Merged-main evidence（PR #4327，squash `99c9b40a55`）**：真实 SQLite registry replay 5/5；三态绑定
  visible-registry `sha256:` revision，resolved
  candidate 另带 exact projection revision；correction 换 revision、retirement → `not_available`，doc-title-only
  → zero Person seed。exact projection revision 继续进入 `subject_seen`，Person cue resolver 在 owner-private read
  前后重验 active + viewer-visible revision；seed 创建后的 correction / retirement 均为 zero cue。非 owner 的
  empty/not_available revision 在 private create/correction/retirement 间字节不变，而 owner revision 改变。
- [ ] AC-B3: 一个已批准 Person revision 在 owner-private 边界内完成 `presented → drilled → applied|dismissed`
  与至少一种 correction/forget/expiry invalidation；坐标绑定 source/thread/invocation/cat/revision。**2026-09-04
  Phase B ceiling**：当前 revision 与 F312 吴浪 exact hash 相等，source/response message 可独立复核，但历史
  session 未 sealed，无法取得 invocation/cue 坐标；typed blocker=`historical_coordinates_unavailable`，不复用
  历史 receipt、不写新 Person truth。
- [x] AC-B4: 非作者复核 Profile、Entity、Person 的 authority/store/privacy 未被合并或越权。Terra 在 exact
  HEAD `ee8c9915656e214f2ba57cb5f6cd327235288002` 独立重放并批准；typed verdict：
  `[thread-id]#0001788555692984-001546-dfb3b77c`。

### Phase C（Taste Closed-World Coverage）

- [x] AC-C1: 当前 revision 下 F221 所有已批准 canonical Taste 在 authority files、Index 与 owner-prescribed
  read path 上集合相等；新增、重命名、删除或 stale anchor 均有 fail-closed guard。PR #4336 merge
  `0381fb8f0ec645e118d9fbaec0e95affa6d411ff` 证明 `62 = 62 = 62`。
- [x] AC-C2: 一个真实 UI/UX 任务只收到 bounded Taste source-ref bundle；消费猫钻取后记录哪些 canonical
  constraints 实际 `applied | dismissed`，并由非作者从结果反查同一 revisions。F315 bundle 为 4 refs、
  1,042 tokens，Terra 在 exact HEAD `6c6b80aed70d6e117c97b785dd8c18984b5ef2c9` 独立反查并批准。
- [x] AC-C3: 历史 source coverage 与 canonical closed-world count 分栏展示；未审批候选不会被自动写入或
  被计入“已完整记住”。Phase C evidence 保留 4 个 candidate-only themes，与 62 个 approved items 分栏。

### Phase D（Remaining Active Lanes）

- [x] AC-D1: Phase A 发现的其余 active-surface blocking breaks 已由各 canonical owner 修复、明确 exempt/
  sunset，或携 Decision Packet 交 operator；F316 不替 owner 造绿。PR #4342 merge `f2e28714ac` 纠正 Episode
  corpus 与 Decision/Event 坐标、保留 Seed/Project Knowledge no-eligible-pair ceiling，并绑定 Skill bounded
  receipt；merged-main Alpha `abeb512779` 只证明 LL-015 guarded 6398 startup，不制造全 Lesson utility。
- [x] AC-D2: 每个 Phase 维持一个 execution thread + 一个主 PR；仅 merged-main Alpha 才可观察的独立
  production RED 可开 narrow follow-up，并有 exact continuity/review evidence。Phase D 使用
  `[thread-id]` + PR #4342；Terra APPROVED exact HEAD `c3bc21acb1`，Alpha 未发现独立 RED，故无
  follow-up PR。

### Phase E（Independent Runtime Acceptance & Vision Guard）

- [ ] AC-E1: merged-main Alpha 独立复验至少 Relationship、Taste、时效型、项目/决策型四种 authority，
  逐条保留 candidate/no-candidate、receipt、outcome 与 invalidation 的真实 ceiling。
- [ ] AC-E2: runtime traces 证明 non-match lane payload=0，match 只送 bounded source refs，prompt 大小不随
  21 surfaces 或 canonical item 总量线性增长。
- [ ] AC-E3: 确定合同与 runtime health 分别由 guards/tests 与 traces/metrics 验收；utility eval 只有在明确
  named consumer、keep/tune/sunset 决策与 metric birth certificate 同时存在时才出生。
- [ ] AC-E4: durable task、feature truth、owner receipts 与 terminal packet 全部同步；非作者 Vision Guard
  明确确认无中央 authority、无伪 receipt、无隐私越权、无 prompt dump 后才可关闭 F316。

## Dependencies

- **Evolved from**: F312（继承 21-surface universe、Standing Reflex 与三线程/单 Phase 主 PR 的闭环方法）
- **Related**: F221（Taste canonical authority 与 Capture Loop）
- **Related**: F231（Profile capsule 与 You↔cat relationship primer）
- **Related**: F260（Entity identity root / alias）
- **Related**: F276（owner-private Person / Relationship / Interaction）
- **Related**: F200（receipt/outcome 与 eval 资格）
- **Related**: F209, F287, F296（Index/navigation、cue plane、presentation/read transport）

## Risk

| 风险 | 缓解 |
|------|------|
| “所有历史原话”是开放世界，永远无法证明穷尽 | closed-world canonical completeness 与 open-world source coverage 分栏，不混报 |
| 为了表格整齐给 exempt lane 造 cue/receipt/eval | 每个 claim 先做 E0；exempt 只核 exemption/pull path |
| 跨面总控变成第二个 memory owner | F316 只持 audit/route/acceptance；实现、存储与失效回原 owner |
| 人物与关系内容泄露到共享索引或 prompt | Entity 只存 identity root；Profile/Person owner-private；drill 前不送正文 |
| 全量记忆使 prompt 线性膨胀 | typed predicate + bounded source refs；non-match=0；trace 守门 |
| 单个成功 episode 被包装成内容完整 | set-equality/absence probes 与独立 consumer 复验，evidence ceiling 逐 lane 保存 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新建 F316，不重开 F312、不复制 F221 thread | 结构 closure 与内容 coverage 是不同完成命题，且各 lane authority 已存在 | 2026-09-04 |
| KD-2 | 先全景审计，再优先 Relationship、Taste | 既覆盖“每个记忆系统”，又先解决operator点名的用户价值断点 | 2026-09-04 |
| KD-3 | “所有”只对 approved canonical revision 作闭世界承诺 | 历史自然语言是开放世界，自动升级会制造错误记忆 | 2026-09-04 |
| KD-4 | 一个 Phase 一个 execution thread + 一个主 PR | 继承 F312 已验证的收口拓扑，避免按 lane 拆出 PR 风暴 | 2026-09-04 |
| KD-5 | Entity exact-alias outcome 同时携 visible-registry revision；resolved candidate 再携 current projection revision，所有延迟 Person consumer 在私密读取前后重验该 revision | unknown/ambiguous 也必须绑定可重放快照；correction/retirement 后的排队结果必须 fail closed，不能继续冒充 current truth 或打开 Person cue | 2026-09-04 |

## Review Gate

- Phase A：非作者 source-map/absence 审阅，确认 universe、owner、break 与 unknown 没有被样本替代。
- Phase B–D：每 Phase 一个主 PR；行为、权限、隐私、契约变更走非作者 exact-HEAD review 与风险匹配 gate。
- Phase E：独立 merged-main Alpha runtime acceptance + 非作者 Vision Guard；生产 3003/3004 不冒充 Alpha。
