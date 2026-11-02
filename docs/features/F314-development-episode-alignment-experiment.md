---
feature_ids: [F314]
related_features: [F100, F153, F167, F192, F267, F281, F298, F303, F310, F311, F321, F322, F323]
topics: [development-process, intent-alignment, review, merge-gate, process-cost, main-health, soft-surface-convergence, experiment, self-evolution]
tips_exempt: "Renewed 2026-10-15: this delta records the internal F314-to-F311 coordination and evidence handoff. It adds no shipped user entry or runtime capability and establishes no efficacy verdict; future user-facing F311 delivery retains its own discovery requirement."
doc_kind: spec
created: 2026-09-02
updated: 2026-10-23
description: "让一项托付跨阶段持续做对，尽早交付真实可用结果，以充分且相称的验证减少等待，并让猫自主续办、少占用人的协调注意力。现有 anchor 实验是其中一个有界机制。"
description_source: human
description_author: codex-astra
description_updated_at: 2026-10-03T06:16:00-07:00
---

# F314: Development Episode Alignment Experiment｜开发交付对齐自进化实验

> **Status**: in-progress / Phase B accepted with recorded exceptions; operator B accepts insufficient anchor evidence; method #5788 and published history v10 delivered, content/map design accepted; overall acceptance open, 18-cluster code refactor deferred | **Owner**: 小星星·Maine Coon（@codex-astra, GPT-6 Astra；方向与整体结果） | **Execution**: 小太阳·Maine Coon（@codex-sol, GPT-5.6 Sol；Task197；Task143 已完成） | **Priority**: P0
>
> **operator kickoff**: `[thread-id]#private-source-id`——“这个项目可能可以特殊点实验项目；这个出生是我们建立的，但是后续优化迭代我们接入 F311 的自进化。”
>
>
> **Existing Evolution Program**: `evolution-program:ba0f4524e49cc879279164d5b272cf8c`。其被进化对象仍是 F100 拥有的 `capability:development-process-harness-effectiveness`；F314 链接并验收这个 Program，不复制或改写其 canonical lifecycle。

Architecture cell: **none（integration-only Feature）**。

Map delta: **none**。F314 不出生新 control plane；`request-review` 资产归 F100/规则 owner，gate 与 review guard 归各自执行面，运行耗时归 F153，长期 eval 归 F192/F267，Program 编排归 F311。

## Why

**一项托付经过多只猫、多个 PR、等待与会话后，仍围绕原目标和后来已接受的变化工作；尽早交出可判断实物，按真实影响取得充分证据，猫自己定位并处理失败与依赖变化，在约定范围内把结果交到人能使用的地方。人不必维持执行上下文、追猫和调度；方向、取舍、必要授权与停止仍由人掌握。**

You 认定的痛点（本轮 449 引 1483；速度与结果原话见 1352）：

1. **太慢**：一小时能做完的事，猫之间来回传、再排门禁，拖成一天。
2. **慢完还不对**：合入后打开一看，不是他要的。
3. **照章办事，不会变通**：卡在机器默认、无关红灯或已选流程上原地等，要他亲口说“直接合”才往前走。
4. **被迫当调度员**：发现卡点、开 thread、派猫、追责任、做首轮 QA，都落回他身上。

“一小时拖成一天”保留为用户体验描述，不当作全仓实测平均。

认真完成局部步骤、审查可追溯和状态合法，都不能替代整件事的正确交付。

1. **做对并持续同向**：原始诉求与后来接受的变化共同约束实物、拆分和下一步；局部通过不扩大成整体兑现。
2. **尽早得到结果，成本与风险相称**：先用真实入口校准，再选择充分的定向检查和必要审查；验证数量与 full gate 次数不是认真程度。
3. **猫内自主闭环，省下人的操心**：条件变化后原负责人实际续做；人在价值冲突、真实权限与不可逆边界参与，不充当默认调度员或恢复按钮。
4. **允许反例改变做法**：方法是否值得保留，用真实工作的方向、时间和人类协调负担判断；F311 对具体不确定机制作有界实验，不把测量变成日常交付前置。

## Current State / 现状基线

**2026-10-23 当前核对**（来源：operator 总览 `[thread-id]#private-source-id`）：本次更新文档与索引，不改变已接受的实验取舍或工程授权。

- **已交付**：Phase B 按记录验收、AC-C1 真实绑定、有界自然工作对照、F311 准备材料对接；#5788 共同规则责任方法已发布。谱系当前为第10稿 `publication:10:4704d3160e28ce387067196216b91967635f63f1`，12步/27道错题；正文更稿不重启已在正式环境验证，地图设计验收亦已通过，见下方10-20/10-21记录。
- **仍未证明**：方法的自然采用与稳定效用、原整合工作的整体验收。此次只读 owner 回读 Program 为 `active / instrumenting / cycle 1 / sequence 134`，`currentAssetVersionRefs=[]`、`observation=insufficient`、`connectedEyes=[]`，六项缺口仍在；这不等于现实中没有采用，也不以内容发布推进实验状态。
- **已获准停止或暂缓**：operator B 已接受本期锚点证据不足，AC-C2–C5 未达按签字处置，成熟 `keep/sunset` 不再是本期关闭前置；不得为凑成熟重开窗口。18簇原代码重构按10-20决定暂缓，等待开源 intake 与组织仓迁移后再确认，方法发布不解除该边界。
- **责任与出口**：本次回读 Task197 仍为doing、Task613为revision77/doing，未关闭Feature。原整合与整体结果判断继续；自然效用未知不能写成已验，也不能反过来恢复已取消的成熟实验前置。F311 的 AC-UX6 及真实采用旅程由其原owner验收，不由这次谱系读面交付代签。

**2026-10-04 PDT / 2026-10-05 UTC 验收取舍**：You 已选择决策卡 B，接受本期锚点效果证据不足，解除成熟效用结论对 F314 收口的阻塞，见[逐项处置与签字](#phase-c-本期验收处置--2026-10-05)。Task143 已由部署回流实际完成一次 governed rebind；本现场独立读到 Program `sequence=71`、measurement certificate/四角色均为 v3，consumer=`F100/cat:opus55`，其余仍为 `active/instrumenting/cycle1`、human value owner、空 assets/connectedEyes 与六项 `insufficient` 缺口。没有新 observation、轮次或效用结论。Task197/Task613 与 F314 均未关闭。

本现场 **2026-10-03** 15:15 UTC 回读 Program 为 `active / instrumenting / cycle 1 / sequence 66 / observation insufficient / currentAssetVersionRefs=[]`；这是当时切面，当前回读见本节顶部。Sol 的两次明确加载现行法动作观察已完成；measurement `ae21a2bb…`、baseline `6a3ff9e7…` 均 submitted、无 stale dependency（原报告 `private-source-id`）。两例都保留了局部批准边界，只支持这两个有界观察；自然发现/加载/消费、历史误判根因与正式效果仍未证明。

下列条目是原立项及 Phase C 已记录的历史基线；其中 Program 字段不代表本次重新读取了实时状态。当前运行状态须由其 canonical owner 读取，不能由新的愿景文字推进。

- 本 thread 已确认六类重复失败：小事被流程吃掉、实现与 review 同漂、旧设计被兼容层封存、概念与球权增生、质量仪式无质量增益、闭环税回到operator。证据索引见蓝图 §0。
- 两猫已冻结完整的软 / 硬 / observability / eval 机制选择与负向契约，蓝图已在 `c72b89139c` 进入 main；本次 operator 消息授权正式立项并采用“人工出生、F311 后续进化”的实验生命周期。
- F311 Program 已真实存在；2026-09-05 留存的权威投影为 `lifecycle=active / stage=instrumenting / cycle=1 / sequence=2`，goal、measurement、economic、value owner 与四测量角色均已绑定且 `blockers=[]`。它仍有 `currentAssetVersionRefs=[]`、`observation.status=insufficient`、`connectedEyes=[]` 与六项 observation gaps；F314 不把 constitution 完成冒充 Cycle 1 已可评估。
- Ragdoll曾有本地、未 commit、未 push 的实现草稿，并明确同意对齐前不算数；F314 不把该草稿当作既成实现或 scope 锚点。
- **Baseline window 冻结为 2026-09-02 F314 kickoff 至 accepted-source anchor PR 合入前**；该 PR 合入即 treatment 开始。窗口内复用既有 F153、feat-close 与自然纠正记录，缺失部分保持 typed `insufficient`，不补造样本。

## Association Decision / 为什么是新 Feature

| 候选归属 | 裁决 | 理由 |
|---|---|---|
| F100 子任务 | 否 | F100 拥有 Process Evolution 方法与被调节的 `request-review` 资产，但不负责 gate、main-health 与整条开发交付验收。 |
| F311 新 Phase | 否 | F311 只拥有 Program identity/lifecycle 与 owner refs；把领域干预塞进 F311 会违反“引用不是所有权”和单变量约束。 |
| F314 独立实验 Feature | 是 | 它有独立用户旅程、初始交付、跨 owner 验收、回滚边界与首次实验闭环；完成后长期迭代回到 F311，不让 Feature 永久充当手工追踪器。 |

## What

### 当前交付方向与既有实施范围

用户结果按整项托付判断；实现继续落在已有 owner：产品作者/feature 负责人负责实物与下一刀，Gate/Task512 负责验证成本和机器出口，F310/F167/F298 负责各自续办链，F153/F281 提供既有证据，F100/F267/F311 保持资产、测量与 Program 权威。F314 集成这些证据、校准交付方法，不复制它们的控制面。

下面 Phase A–C 保留原已接受实施与实验设计；2026-10-05 的本期验收变更只按 operator 选择 B 记录于逐项处置，不改 Program 或出生证。锚点效果与整体交付结果分别判断，均不扩成“全家长期效果都通过后才能关闭”。原范围完成、取消或依法改约后有终点，后续问题不自动复活终态 Task。

### Phase A: 人工出生与边界冻结

我们先把真实痛点、accepted source、逐项机制选择、owner matrix、负向契约和实验出生证共同冻结。这个阶段由人猫共创完成，F311 不反向生成自己的初始愿景、样本或成功标准。

### Phase B: 一次完整的初始干预交付

以下保留 2026-09-02 接受的初始方案及后来验收事实；不是当前所有改动的流程指令。当前风险与审查选择以 `docs/SOP.md` 及 #5036 后的产品快车道为准。

默认用**一个可回滚 implementation PR**交付蓝图中的六项能力；只有真实代码 ownership 或回滚边界证明必须拆分时，才允许至多两个 PR，禁止按“软 / 硬 / eval”拆票：

1. `request-review` durable artifact 增加 accepted-source anchor 模板；
2. gate-time 比较 accepted revision，source 移动时要求 author 显式 re-ack；
3. targeted/full classifier 内嵌现有 `pnpm gate`，机器推导可推导信息，只留一个只能加严的 `--risk <axis>`；
4. 同一 PR 正式 `CHANGES_REQUESTED >= 4` 时暂停一次自动 re-request，回读 accepted source 并写 Finding Pattern Summary；
5. 通用、项目 opt-in 的 main-health schedule template + guardian skill；Clowder AI 在能力落地时明确 opt in；
6. F153 接入 stage duration、full-gate 次数、失败相关性与重跑观测。
7. 对 L0、SOP、shared rules、review/merge/feature/intake skills 与模板做一次存量 soft-surface convergence：逐项给出 keep / rewrite / retire 及证据，删除已被 canonical guard、owner source 或新契约替代的旧教法，只保留唯一权威入口。

Soft / hard / eval 按 claim 分工：anchor 模板先作为低成本软干预；revision、gate route 与 R4 brake 是确定契约 guard；耗时与 main 红灯是运行健康；只有“anchor 是否真的减少 intent drift”进入 F311。

Soft-surface convergence 是 Phase B 的交付范围，不是 Cycle 1 的 eval 变量，也不以删行数作为成功信号。真实安全、授权、不可逆与 owner/custody 边界必须保留；未改项必须记录 keep 理由，不得再次静默缩 scope。operator scope confirmation：`[thread-id]#private-source-id`；执行指令：`[thread-id]#private-source-id`。

### Phase C: F311 接管后续效用迭代

以下是原实验设计；本期不再追求其成熟窗口与效用结论，依据 operator B 处置。Program 保持原 owner 与真实状态，未来是否续测按原治理决定，不因本文开新窗口或自动滚动投入。

Phase B 的 exact version、证据与 owner receipts 进入既有 Evolution Program。F311 在出生证齐全后运行真实 baseline、live holdout、归因与 keep/tune/sunset：

- Cycle 1 唯一干预变量是 accepted-source anchor 模板；
- 每一轮只改一个 owner-owned 变量，先有 intervention card，再由资产 owner 修改并返回 receipt；
- deterministic guard 的 bug/契约修复仍走原 owner 的 test/guard，不因存在 Program 而等待 eval；
- F311 Phase 3 已足以在成熟证据上形成 `keep | sunset | insufficient`；只有结论为 `tune`、需要受治理写回 owner 资产时，才依赖 Phase 4 的 mutation + fresh outcome 闭环；
- 未来若要评估另一个不确定机制，必须另立 E0 合格 claim/Program，但仍可挂在 F314 的产品边界下；不得把多个变量塞进本 Program；
- **历史关闭设计，已由 operator B 替代**：原设计等待首次可行动 verdict；本期现接受 insufficient，不再以成熟 verdict 为关闭前置。原整合交付与正常整体验收仍须结算，后续 Program 由 F311 与具名 consumer 持有，不据本段自动开轮或关闭Feature。

### F311 v2 接入：事故档案成为进化谱系的数据（2026-10-14）

**来源**：operator `[thread-id]#private-source-id`。事故档案和错题本在累计 RSI 的进化数据；要把每次改过的开发流程版本放进 F311 的探索进化，开始建立进化谱系。F311 侧计划见 [F311 v2 用户旅程开发计划](F311-capability-evolution-workspace.md#v2-用户旅程开发计划2026-10-14-起)（切片 S4）。

**对 F314 意味着什么**
- **对象和边界不变**：仍是同一个 Program（`ba0f4524`）、同一个被进化对象（F100 的开发流程 harness 有效性）。不新开 Program，不改本期验收边界，也不改 operator B 处置。
- **和上面「不得把多个变量塞进本 Program」怎么分开**：谱系只是这个对象真实历史的只读投影，回答「改过什么、之后发生了什么」，不形成 keep / tune / sunset，也不当作哪一版有效的证明。要评估某个具体机制，仍按上面那条另立 E0 合格的 claim / Program。
- **版本**：这一个月真实改过的开发流程成员，包括：
  - SOP；
  - merge-gate、request-review、receive-review、quality-gate、worktree、feat-lifecycle 这几个 skill；
  - 交接、共享规则、L0 提示词；
  - DESIGN.md 里的交付与验收规则。

  10-14 方案沿 F100 适配器从 git 历史读取（#4517 在当时只覆盖 request-review 一个文件）；后续已实现整组历史投影与独立内容发布。发布写清改了哪些成员；能追到事故的写出处，追不到的写「未关联」。F311 只投影，不复制资产。
- **案例与历史版本**：事故档案和「16 张 PR 有界对照」按已核来源挂接；仅凭日期或引用不能认定当时实际使用版本。每个案例写清偏离、人的代价、同类是否复发；未知保留未知。档案不是全量普查，也不是正式实验分母，不能算成翻车率。

**2026-10-21 地图设计验收通过**：原地图重叠、相邻连线与末卡备注裁切由F311原现场经#5777/#5822/#5839修复。#5839 merge `9cd14a392ec25f10e1633f1c2e7d5e47fde9ca69` 在正式boot43 / `56a0e1ad7b124e5f034ec563c33a21f3ac3b8d14`加载后复验，12步/27题/11条作者关系、末卡完整、受保护写入与pageErrors均为0；Opus55独立验图并将全貌图放入图册第八章，验收文档状态为 `content-passed-map-passed`。该读面/设计切片已交，不再等待地图修复；F311的AC-UX6、真实采用与效用仍在其原责任内开放。

### F314 主线对接 F311 指挥现场（2026-10-15）

**直接授权**：operator `[thread-id]#private-source-id` 要求“拉上……对接到你们这……按照你们这的来”。这项当前对接替代上一版“都不急，手头工作做完再做”的协作安排；主线按 [F311 新版旅程与北极星计划](F311-capability-evolution-workspace.md#v2-用户旅程开发计划2026-10-14-起)组织下一份整合交付。

- **F314 原现场** `[thread-id]` 的 Astra 继续持有整体方向与 Task `private-source-id`；原执行 Task `private-source-id` 与其 owner 保留。由该现场续接原任务并安排已有执行责任，不把它们搬成另一套任务或让 You 再次路由。
- **F311 指挥现场** `[thread-id]` 接收整合结果，对齐准备四块 → 探索中的版本/案例/原件 → 具体判断 → 后续实际使用与结果。界面及 adapter 的已有执行现场为 `[thread-id]`；精确接线缺口仍由对应 owner 处理。
- **10-15 对接约定，已交付**：已回读原 Program/任务，给出材料修订、证据缺口、具名执行者及前后端落点，并从正式入口核页面与来源；实际结果见下段及 F311 指挥回执 `[thread-id]#private-source-id`。不再把这份已返回的整合包列作“下一份交付”；后续独立内容发布与读面验收见10-17至10-21记录。
- **问题处理随整体结果归位**：确定的 bug 在原实现 owner 处修复，修复与后续自然使用证据回到同一项目；F314 主线程继续承担整合与方法判断。公开同步、CI 或其他 feature 的日常修复沿各自已有责任完成，不再用其局部完成代替 F314 的下一份整合交付。
- **记录与权限边界**：新案例分别记录可核的实际使用版本、处置成员与提交；未知就写未确认，不从日期或引用补因果。复用 `ba0f4524` Program，保留 operator B 的本期不足结论、旧样本与关闭边界；本次对接不自动开新 anchor 窗口、改变量/分母、批准候选或扩大资产写权。需要新的效用实验时先提交具体对象、问题与证据边界，按既有授权另行判断。

## User Journey

### Primary Journey: 一项托付跨阶段持续做对

- **Scope unit**: 用户的一项托付，可横跨多个 Phase/PR；development episode 是其中一次交付切片。下方 Cycle 1 的测量单位仍是原定义的 eligible episode，二者不混用。
- **Actor**: operator、原 feature/工作负责人、author，以及按实际风险选择的 reviewer/愿景守护猫。
- **Entry**: 用户提出目标或调整优先级；复用原 source 和已接受范围，不要求重新填写需求。
- **Flow**:
  1. 原负责人理解当前目标、最新优先级和仍欠的体验；选择最能推进结果的下一刀，已确认方向内自主执行。
  2. 作者先查既有能力并识别范围/权限风险，实施中尽早把完整的小结果挂到真实入口，亲自操作并对照原约定。局部产品以第一小时出现可判断实物为目标，不以超时赶工或未挂组件充数。方案阶段交可判断设计，不为文档小改强造 demo。
  3. 作者按实际影响选择足够的验证与必要的独立审查。当前政策以 `docs/SOP.md` 产品快车道和 `merge-gate` 为准；已选择的 review 才消费 exact HEAD/accepted-source 证据，未选择时不制造 reviewer 或 APPROVE。
  4. 卡点由原负责人查明：真实相关失败先修，证实无关的红回原 owner，自己的充分验证继续；权限和不可逆边界照旧。等待挂到已有可恢复条件，条件变化后实际续做，不以送达或状态记录代替行动。
  5. 合入后作者在正确环境核对并展示结果；阶段实物、依赖或方向变化时，原负责人把已得到/仍没得到带回整项托付，决定下一步。明确偏差自行修正，真实价值冲突才带具体结果与推荐请用户判断。
  6. 终态按原始诉求及后续接受的范围作整体判断，区分局部修复、体验成立与整项完成；用户不承担首轮 QA。
  7. F314 从自然工作核对“做对、省时、省心”是否同时成立；具体不确定机制由原 F311 Program/measurement owner 按各自有效定义评估。
- **Success evidence**: 有来源的真实交付；必要风险证据；没有 operator 新提示也能继续的实际行动；整体方向与剩余差距诚实可见。若要声称稳定改善，还需可比自然样本，不能只凭一张 PR 或一次批准。
- **Non-goals**: 新总控/UI/store/task/incident/verdict/registry；每 PR 新增方向审批；让用户打标签、巡夜或当测试员；用更少审查次数本身冒充更好交付。

## Roadmap

**当前责任**：Astra（`codex-astra`）通过原 Task613 持方向、推进顺序、跨线整合和整体结果；Sol5.6（`codex-sol`）继续原 Task197，F267 原 Task143 已完成，不复活。Task 身份、原执行归属保留；本期实验验收要求仅按下述 operator B 变更，执行 Task 的 owner 不被误读成另一个产品指挥。路线图来源为 operator `private-source-id`、`private-source-id`，以及 Opus55 一次性内容审阅 `private-source-id`。

主线：**理解整件事 → 尽早交出实物 → 按真实风险验证 → 新事实改变下一步 → 自主续办 → 交回可用结果。** 本轮复用原现场；整包完成回报，普通 review、修复与验证留在执行现场。产品方向变化或真正需要人的选择才中途上提。

| 顺序与现场 | 具名责任 | 下一份可判断交付与出口 |
|---|---|---|
| **已交：自然判断链诊断**，原 F314 / Task197 | Sol5.6 执行，Astra 核整体方向 | source1037 已交 #5050/#5027/#5015 与合法局部参照 #5045；保留现行方法、不追加提醒。exact semantic version 加载仍未知，不从缺记录推断未加载；formal eligible=0 只属于这四个焦点样本。 |
| **已完成：真实 owner binding**，原 F267 / Task143 | Sol5.6；Task143 done | 曾误等的 F221 #4560 早已合入；原 Task 续办后经 #5071/#5075/#5077 发布 v3，部署回流完成一次 rebind、Program 70→71，终态原件 `private-source-id`。这是 AC-C1 接线证据，不是效用证明。 |
| **查到断点后：只改有依据的一步**，沿该资产或机器原现场 | 原 owner 持实现；Astra 明确该刀执行猫与结果，按风险选非作者验证 | 未找到方法就修发现入口；已读仍错才改教法；机器错拦或回流断裂就修对应路径。若未发现内容缺陷，明确保留现行方法。每次交可验证改动及新的自然任务结果，不把所有候选改法一起铺开。 |
| **贯穿当前交付：验证成本与自主续办**，复用 Gate 等原现场 | Gate Astra / Task512；各产品原 owner | 继续原 A–E 与消费者总反馈时间验收；失败后的重验、等待和清理计入成本。F314 消费方法效果，不接管 Gate 实现或重新排整包测试。 |
| **已交：材料对接、独立更稿与读面**，原 F314 / F311 | Astra / Task613 持内容与整合；F311原执行现场持reader，Opus55持设计验收 | 10-15对接包已返回；正式第10稿12步/27题，Markdown更稿同进程可见；10-21地图Design Gate通过。当前不再等待这几项交付，F311 AC-UX6与真实采用保持其原边界。 |
| **已接受：本期锚点效果证据不足**，原 F311 Program 保持 | operator B 取舍；Astra 落盘，Sol5.6 消费原 Task197 验收边界 | 本期不新开窗口或为凑成熟追加接线/试跑，AC-C2–C5 按下述 cvo_signoff 处置。Program 继续诚实 insufficient；其余原交付、反例挑战及正常整体验收未被免除，不能立即关闭 F314/Task197/Task613。 |

**成熟机会与退出已作价值取舍。** 第一包核到四个焦点样本均不合格、精确加载窗口与自然对照未建立，无法给可信成熟时间；这不证明永远没有合格样本。Astra 交付含信息价值、成本上限、停止条件与逐项验收变更的决策卡后，You 明确选择 B。未被选择的 A 预算不是获准新实验，不执行；原证书分母与历史 outcome 均不改。

**两个结果分别交。** anchor 本期结果是证据不足，不回答机制有效或无效；Astra 的自然工作前后对照回答四个用户痛点当前得到什么、还欠什么。两者不能互相代签，广义比较也不被包装成新的 anchor 因果结论。

**F310 / F309 是样本来源。** 原 F310 Astra 持 Task386 真实业务旅程，原 F309 Astra 与已有 Sonnet / Sol6.1 执行单元持作品交付；它们的整项 Feature 完成不是 F314 的交付项或关闭前置。F314 只承担已接下的消费连接与交付方法判断，不因选作样本接管其实现、替其验收或无限延长本期。Task613 原有责任也不靠本表自动关闭。

第一包的**自然判断链诊断 + Task143 真实绑定 + 成熟机会核对**及后续有界对照修订已交，当前出口是剩余原整合交付与正常验收。Opus55 曾申明其平行现场参与 #5050 所在线设计，因此不承担该样本独立诊断；同 catId 的平行现场也不计独立个体审查。

## Eval Birth Certificate / F311 出生证

### E0 资格

**适用性边界（2026-10-03）**：本节仍是 accepted-source anchor 的单变量实验；未发生正式 review 的快车道 episode 不在现有分母内。因此这份出生证不能证明快车道或整段长期协作有效。本次不改分母、角色、变量、历史 outcome 或 Program 关闭条件；更广方法需要测量时，先由原 owner 判断问题与可用证据，再沿既有版本化契约处理，不能将愿景更新伪装成新实验已获准运行。

- **Primary utility claim**: 在 `request-review` artifact 中加入 accepted-source anchor，是否减少 author/reviewer 的 intent drift？
- **Fresh bit / GT 域**: drift 需要愿景守护对照 + 价值主人自然纠正；机器只能确认 source、artifact、HEAD 与时间/次数，不能替代开放价值裁判。
- **谁付薪**: F153 维护成本观测；F267/F192 维护测量与 verdict；愿景守护猫在既有 close/review 动作中校准；operator只贡献自然发生的纠正，不承担新标注任务。

```yaml
metric_birth_certificate:
  utility_claim: >-
    intent_drift_escape 下降，代表 accepted-source anchor 让作者和 reviewer
    更早发现实现偏离原始意图，而不是把偏航留到愿景守护或 operator 才纠正。
  estimator: >-
    numerator = eligible development episodes 中发生 intent_drift_escape 的数量；
    denominator = 实际使用 request-review durable artifact 且存在 accepted source 的 eligible episodes；
    formal-review 未发生、干预未暴露或 source 无法解析的 episode 不进入效果分母，并单列 insufficient。
  validity_bounds: >-
    accepted source 未冻结或移动后未 re-ack、review artifact 不可读、judge/rubric 换版未复判、
    样本被 intervention selection 暴露、owner evidence 缺失时，不允许跨窗口比较或形成行动 verdict。
  roles:
    observer: F267/F192 measurement owner，消费 owner refs，不复制原始 truth
    domain_owner: F100 Process Evolution / request-review rule owner
    consumer: F100 Process Evolution owner / request-review rule owner，运行时必须解析为具名猫
    calibrator: 非 intervention author 的愿景守护猫
  role_overlap_justification: >-
    domain owner 与 consumer 可为同一稳定 owner seat，因为其负责资产去留；
    calibrator 必须独立于干预作者，开放价值冲突最终仍由 operator 持有。
  calibration_plan: >-
    每个成熟窗口对冻结 replay 与 live holdout 做风险定向抽样；复用既有愿景守护和 operator 自然纠正，
    不要求新打标。窗口不可比或量尺分歧越界时回到 insufficient 并重开 rubric。
  repeatability_contract: >-
    固定 eligibility、accepted-source schema、artifact version、rubric/judge version 与 episode join key；
    baseline/replay 与 promotion holdout 分离，同一批数据不得既选择干预又验收干预。
  calibration_runway: >-
    分别记录决策级人-judge 分歧、optimizer exposure 与分布覆盖；只使用既有抽样责任和自然反馈预算。
  exhaustion_action: >-
    runway 不足或分歧越界时降为 keep_observe/insufficient；禁止用未经校准的 judge 继续推动 tune。
  longitudinal_trigger_contract:
    trigger_policy: event_plus_time
    evidence_ingestion: owner-backed episode/source/head/verdict refs；ingested 不等于 evaluated
    early_trigger: eligible episode 或 guardrail breach 到达时由既有 F192 trigger 提前唤醒
    time_fallback: 复用当前 Program 的最长 168h 唤醒；成熟条件未达时只报告 insufficient
    dedupe_key: programId + cycle + evidence-window
    overlap_policy: 同一 cycle coalesce，不并行开第二轮
    maturity_predicate: F267 certificate 冻结的最小 episode 数 + 至少 14 天 live window；未冻结 N 前不可行动
    actionability_gate: 四角色、三张证、F299 trajectory、异质 owner surfaces、consumption/exposure/holdout proof 齐全
```

### 一项主信号，两条不可抵消护栏

| 类型 | 信号 | Canonical source | 决策含义 |
|---|---|---|---|
| Primary | `intent_drift_escape` | feat-close / 愿景守护对照 + 自然纠正 refs | 只回答 anchor 是否减少方向偏离 |
| Guardrail | `avoidable_process_cost` | F153 stage duration / full-gate / rerun telemetry | 成本恶化即否决 keep，不能被 drift 改善抵消 |
| Guardrail | `human_coordination_rescue` | F281 disposition/episode + operator在任何 thread 的自然路由/催促 | 保姆税恶化即否决 keep；不新建 collector、不让用户打标 |

若 consumer seat 解析不到具名猫，Program 保持 `consumer_missing`，不把operator补成默认 consumer。

## Acceptance Criteria

### Phase A（人工出生与边界冻结）

- [x] AC-A1: operator kickoff、两猫零分歧蓝图、F314 spec 与 existing Program ID 形成互链；非作者可从 source ref 复核为何立项→Why①④
- [x] AC-A2: F100 asset owner、F314 integration/acceptance owner、F311 Program owner 三者边界写入 spec，且 ownership map 无新 cell→Why④
- [x] AC-A3: User Journey、负向契约、需求点 Checklist 与 F311 出生证同源落盘；不把“实验”当作缺少完成条件的豁免→Why①②③④

### Phase B（初始干预交付）

- [ ] AC-B1: 一次实现交付覆盖蓝图六项能力与 soft-surface convergence；默认一个 PR、至多两个且每次拆分有真实 ownership/rollback 证据；changed files 与 PR/commit 可复核→Why②。**Typed exception**：实际为 PR #4245、operator 授权的严格两文件 corrective PR #4257、PR #4268；三张均可复核，但不把授权例外改写成“至多两张”的字面合规。授权 source：`[thread-id]#private-source-id`。
- [x] AC-B2: request-review durable artifact 在 #1371 退役 lease 后仍能保存 accepted-source anchor；至少一个 source-moved fixture 要求 re-ack、一个 unchanged fixture 零提示→Why①
- [x] AC-B3: `pnpm gate` 在不增加第二命令/文件/receipt 的前提下推导 targeted/full；`--risk <axis>` 只能加严；targeted/full 正反 fixture 均通过→Why②
- [x] AC-B4: 同一 PR 的正式 changes-requested 达到 4 次时仅暂停一次自动 re-request；外部 GitHub 路径不等 #1371，家里路径只接退役后 durable review fact；history 不可得时 warn-open；回归证明没有 Round/Reset/lease/verdict 新状态→Why①②
- [x] AC-B5: 通用 main-health template 可由任意项目显式注册；Clowder AI 真实 opt in 后以覆盖 main HEAD 的既有 exact-tree receipt + 便宜 `pnpm check` 为 health source，由 guardian 收到 red/green/unknown + bisect candidates；命令 admission 只接受 canonical bare executable 与不改变 `repo` cwd 的正向语法，且仅在 clean checkout 的 HEAD/tree 同 receipt 完全一致时执行；不得为 main 另排 full gate，且没有新 task/incident/store/UI→Why③。**Accepted-then-retired lifecycle truth**：preview 与真实 green/red/unknown 路径已通过；PR #4279（`38c2e9adc60ddd4a99056f7b645e221c90425501`）修复生产 bootstrap 后，Clowder AI governed opt-in 注册了动态任务 `dyn-1788492690475-qy42i1`，累计 36 次真实 guardian wake 均如实报告 `unknown / check=not_run`，因为没有覆盖当时 HEAD 的 exact-tree green receipt。operator 随后明确要求取消这条低价值临时每小时订阅，删除后调度列表已无该任务；验收 Task `[thread-id]#task:private-source-id` 已 `done`。此 AC 验收的是 opt-in → register → deliver → retire 的完整生命周期，不声称当前 main green、存在 live guardian，亦不授权恢复旧任务。
- [x] AC-B6: F153 可从真实 run 读取 stage duration、full-gate 次数、失败相关性与 rerun；失败路径与 diff 无关时在原执行面就地可见→Why②
- [x] AC-B7: exact-HEAD targeted tests、非作者 review 与 landed Alpha/真实运行验收共同证明最终内容；不得以 full gate 次数或旧 review SHA 冒充完成→Why①②
- [x] AC-B8: `assets/system-prompts/system-prompt-l0.md`、`docs/SOP.md`、`cat-cafe-skills/refs/shared-rules.md`、`merge-gate`、`request-review`、`receive-review`、`feat-lifecycle`、`opensource-ops` 与相关模板均有 keep / rewrite / retire 结论；已被 canonical guard/owner source/新契约替代的旧教法被删除，保留项有理由，且 L0 不复制详细 SOP→Why②③

### Phase C（F311 后续自进化）

- [x] AC-C1: existing Program 完成 constitution，goal/measurement/economic/value-owner/四角色均为 canonical owner refs，consumer 为具名猫→Why③④。2026-10-05 原 Task143 发布 v3 并真实 rebind；独立 owner read 为 sequence71，measurement certificate/四角色 v3，consumer=`F100/cat:opus55`，value owner 保持 `F311/user:default-user`。证据：#5071/#5075/#5077 与终态原件 `private-source-id`；旧 consumer 绑定阻塞已解除，observation 六项缺口仍在。
- [ ] AC-C2: Program 连接 F299 trajectory、至少两个异质 owner surfaces、F267 decision proof、consumption/exposure/holdout proof；缺任一项只报告 typed `insufficient`→Why④。**未达 → cvo_signoff(B)**：接受本期不再追求缺失的效果证据链，保留真实 insufficient，见下节。
- [ ] AC-C3: Cycle 1 只改变 accepted-source anchor 模板；intervention card 含竞争归因、单一 lever、预期 delta、双 falsifier、cost/rollback、replay 与独立 holdout→Why④。**原实验要求未达 → cvo_signoff(B)**：本期不追加干预、试跑或独立 holdout，不补写成已完成。
- [ ] AC-C4: 首个成熟窗口输出 keep/tune/sunset/insufficient 之一；primary 与两条 guardrail 不相加，任何 guardrail 恶化都不能被 primary 抵消→Why②③④。**成熟窗口未达 → cvo_signoff(B)**：保留已存在的 typed insufficient，它不是成熟效用结论。
- [ ] AC-C5: **原要求未达 → cvo_signoff(B)，已解除本期关闭前置**。原要求为首次成熟 `keep | sunset` 回链；若 `tune` 则需 owner mutation receipt + fresh outcome，`insufficient` 继续收证据。operator 现接受本期停止追成熟；原 Program 由 F311 持有，其余原交付与整体验收仍须完成，不能据此立即关闭 F314/Task197/Task613→Why③④。

### Phase C 本期验收处置 / 2026-10-05

这次签字接受的是**没有锚点效果结论**，不是锚点无效、方法应删除或四个用户痛点已解决。仅 AC-C1 有实际达成证据；AC-C2–C5 保留未达与逐项签字处置，不补勾实现。原出生证、v3 measurement artifacts、分母、历史样本与 Program 生命周期均保持原 truth。

```yaml
cvo_signoff:
  proposal_message_id: private-source-id
  proposal_card_id: f314-cycle1-value-decision-20261005
  cvo_message_id: private-source-id
  cvo_quote: "F314 本期锚点实验取舍：B：接受本期证据不足（推荐）。以决策卡 f314-cycle1-value-decision-20261005 的验收范围、预算和停止边界为准。"
  accepted_scope: >-
    接受 AC-C2–C4 本期未达，不再追求缺失效果链、干预与成熟窗口；解除
    AC-C5 成熟 keep/sunset 或 tune 后 mutation/fresh outcome 的本期关闭前置。
    保留 typed insufficient，不新开锚点窗口或为凑成熟追加试跑、接线。
    F311 继续持有原 Program；不自动关停、开轮或更改其证据。
    F314/Task197/Task613 不立即关闭：原有界自然工作前后对照、整合交付与正常验收继续。
```

未被选择的 A（2 猫小时可行性核对、总 8 猫小时/30 天拟定上限）不构成授权或新的到期任务。本文只是已接受取舍的机械登记，不新增 reviewer、定时器或工程范围。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “我们可以立项了” | AC-A1, AC-A2 | Feature truth + BACKLOG + source ref | [x] |
| R2 | “这个项目可能可以特殊点实验项目” | AC-A3, AC-C3, AC-C4 | 出生证；本期实验未达部分见 operator B | [ ] C3/C4: cvo_signoff |
| R3 | “这个出生是我们建立的” | AC-A1, AC-A3, AC-B1 | 两猫蓝图 + operator kickoff + initial delivery receipt | [ ] A1/A3已达；B1字面PR预算不符，保留授权例外 |
| R4 | “后续优化迭代我们接入 F311 的自进化” | AC-C1–AC-C5 | v3真实绑定已达；10-23 Program seq134仍insufficient，C2–C5处置见operator B | [ ] C1 met；C2–C5: cvo_signoff |
| R5 | 质量与效率都必须改善，不能把闭环甩给operator | AC-B3–AC-B7, AC-C4–AC-C5 | 有界对照及修订已交；本期anchor不足不代签稳定改善 | [ ] C4/C5: cvo_signoff；整体验收开放 |
| R6 | L0 / SOP / skills 中过期机制、失效概念、假命令与重复教法必须审查并收敛 | AC-B1, AC-B8 | keep/rewrite/retire audit + exact diff + non-author review | [ ] B8已验收；B1授权例外保留，非“尚未收敛” |

### 覆盖检查

- [x] 每个需求点映射到至少一个 AC。
- [x] 每个 AC 均有可执行的命令、source ref、owner projection 或真实运行证据。
- [x] 原 Phase A/B 未新建独立 UI；10-16 的 F311 历史读面已有需求→作者实页证据映射，见上方“历史读面细化”。合入、Alpha 与正式加载按各自实际结果记录，不能沿用旧“不适用”判断。

## Phase B Landed Acceptance / 2026-09-03

本轮只验收已落地行为，不重新实现机制。Canonical accepted main 为 `d249768b2a1400489e45cf71926f660a6fa8c144`；验收时 `origin/main` / Alpha 为 `4216eb222fb78bba96fe7050ca31cfb13c01aab5`。两者之间没有触及 F314 的 main-health、gate receipt、durable local review、soft-surface 或 feature/plan 文件，因此 Alpha 证据覆盖同一 landed substantive content，但不把两个 SHA 写成同一 revision。

| AC | Verdict | Landed / runtime evidence |
|---|---|---|
| B1 | `exception_open` | 三张 merged PR 的 live objects 与 merge SHA 已复核：#4245=`1f641f6e1daac79bcbcef5a0bb51c3e0776aa1eb`、#4257=`48faec8ea1c516e5dc61c860de99c203ffc8f4cb`、#4268=`6c3abbf6ff712eaa54e76ce4688e2594453cc637`。#4257 是 operator 明确授权的严格两文件 corrective；它解决真实 gate split-brain，但让原“至多两张 PR”字面条件不成立。 |
| B2 | `accepted` | PR #4268 exact review HEAD `e699d901fa64f3fb8ad2d991c48fa95e60d8c68e` 的 durable verdict 同时携带 `acceptedSourceRef`、`acceptedRevision=6e0642701258be2d29263233b35b652d4bfc34f1`、reviewed HEAD 与非作者 verdict；Alpha API durable carrier / route 回归 223/223。Procedural 两切面 fixture：该 review cut 的 source revision 仍为 `6e064270...`（unchanged，零 re-ack）；当前 main 的 source revision 已为 `d249768...`（moved，必须 re-ack）。 |
| B4 | `accepted` | Alpha 外部 GitHub R4 / wait / scheduler 回归 20/20，local durable review/callback 回归包含“第四次只暂停一次”“history 不可得 warn-open”；实现只读既有 GitHub history / durable message fact，没有新增 Round、Reset、lease 或 verdict lifecycle。 |
| B5 | `accepted_then_retired` | Clean exact review tree + receipt `8d2b36fa-d226-462f-a078-9b6eb330d9d7`：`pnpm check:review-completion-routing` 实跑为 green；同树 `pnpm check` 实跑为 red，并投递真实 failure tail / triage；无 exact-tree green receipt 时真实输出 unknown 且 check=`not_run`。template / command / clean-tree 回归 22/22；没有定时 full gate 或新 UI/store/incident。PR #4279 修复 `ownerUserId` production wiring 后，governed opt-in 动态任务 `dyn-1788492690475-qy42i1` 累计真实唤醒 36 次并持续如实报告 unknown；operator 随后要求退役这条低价值每小时订阅，任务已删除且 wiring Task 已 `done`。验收不声称当前 main green 或 live guardian，禁止从旧 why 恢复。 |
| B6 | `accepted` | F153 直接读取真实 receipt：green run `8d2b36fa...` 为 `route=full/fullGateCount=1`，七 stage duration=`19s/376s/120s/329s/1s/3s/247s`；failed run `db472b64...` 给出 `failedStage=check` 与 `relation=related`（failure/diff packages 均为 api+mcp）；`ee84e693...` 给出 `relation=unknown`；`f4841320...` 证明前三阶段复用 `8685dcc3...`、后续阶段本 run 执行。运行健康保留在 receipt/F153，没有挂 Eval Hub。 |
| B7 | `accepted` | 非作者 Opus 5 对 exact HEAD `e699d901...` 的 typed APPROVED：`[thread-id]#private-source-id`，accepted revision `6e064270...`。其独立 targeted 证据为 API 215/215、MCP 90/90；本轮 landed Alpha 又通过 main-health 22/22、durable review API 223/223、MCP 90/90、R4 20/20。PR #4268 exact-tree full gate receipt只作为补充，不代替 exact-HEAD review 或 Alpha。 |
| B8 | `accepted` | 实施计划 Task 6 对九类 surface 逐项记录 keep / rewrite / retire 与 canonical replacement；PR #4268 的实际 diff对应 audit。Landed Alpha 上 `check:sop-definitions`、`check:skills:references`、`check:sync-docs-runtime-assets` 与 `check:review-completion-routing` 全绿；L0仍是编译模板 / placeholder，没有复制详细 review/merge SOP。 |

Vision comparison 仍以最初四条 operator source 为准：`private-source-id`（实现/review 同漂与流程成本）、`private-source-id`（对齐前不开工、猫内闭环）、`private-source-id`（不出生新 a2a/lease/verdict，main-health 项目 opt-in）、`private-source-id`（人工出生、F311 后续进化）。Phase B 除 AC-B1 已诚实记录的 operator 授权预算例外外，行为与生命周期验收已经闭合；AC-B5 的临时 Clowder AI 订阅在证明 opt-in / register / deliver 后按 operator 指示退役，不以长期刷 `unknown` 冒充守护价值。Phase C 的成熟 keep/tune/sunset 仍由既有 F311 Program 拥有，F314 不在本轮冒充完成。

## Phase C Cycle 1 Owner-Version Grounding / 2026-09-05

本节保留09-05至09-12的 owner/task 基线，不是当前待办指令。10-05真实绑定已完成、operator B已处置成熟实验要求；10-23最新只读Program/Task状态见Current State，不从本节恢复实验或复活任务。

Cycle 1 的唯一变量当时收窄到 F100 owner 明确认领的资产边界：`assetKind=skill`、`assetId=cat-cafe-skills/request-review/SKILL.md`、范围仅为 accepted-source anchor 模板 / 字段 / re-ack。Owner source：`[thread-id]#private-source-id`。该历史切面记录内容 commit `1aff39f464261971eed9bc6722a53a1eb81226ac`、blob `3c5902e12467602bd9f9ae81f098ade05c92e4ea`，不声称它们仍是今天最新版本；源码 revision 本身**不是** owner-signed `ExactAssetVersionRef`、current proof、adoption proof 或 actual-use receipt。

当时责任与条件如下；各状态是该历史切面的记录，当前不得用旧条件覆盖operator B：

| 范围 | 当时 canonical carrier / holder | 当时条件与后续处置 |
|---|---|---|
| F314 integration / acceptance | Task `private-source-id` / `@codex-sol`（doing） | 原AC-C5等成熟`keep/sunset`或`tune`后mutation/fresh outcome；**10-05 operator B已解除本期此前置**，当前仅保留原整合与正常整体验收 |
| F311 Workspace consumption / Alpha acceptance | Task `private-source-id` / `@codex-astra`（doing） | owner-backed `versionReview` 已在新 Alpha 由原 F307 history 读通；AC-UX4 仍须下一项真实同类任务产生 actual-use/source/revert 证据，接口验收不替它关闭 |
| F314 observation join | Task `private-source-id` / `@codex-sol`（doing） | canonical trajectory、异质 owner surfaces 与 F267 proof 成为 Program 可消费 refs；它不生产资产版本 |
| F100 exact-version publication + owner reader | Task `private-source-id` / `@opus`（done）；PR #4435 / merge `fce8043d0e16b90fe6f94b2e2757b785832378ec` | Reader 已在 main 注册进 `ProgramAdapterRegistry`，33/33 tests green；live runtime 仍 dormant。该交付只关闭 reader implementation，不替代 owner-loop integration、adoption 或 actual-use proof |
| F314 owner-loop integration | Child Task `private-source-id` / `@codex-sol`（done）；PR #4517 / merge `2baede2cf314e4f99fc6346d4ba773c67ddbff26`，反向锚定 parent Task `private-source-id` | F100 语义版本/history/parent/diff、exact lineage owner actions、三类 evidence、actual-use 与恢复接口已落地；新 Alpha 对同一 `ba0f…` Program 的 owner/F307 读回与重启恢复通过。自然 adoption/use/fresh outcome 不存在，不能由接口验收补造 |

F100 reader与owner-loop接口分别由#4435/#4517合入并完成当时接口验收，`reader_pending`与接口child已终结；接口通过不证明实际采用或效用。上表曾等待自然证据与fresh outcome，但**本期锚点效果现按operator B接受不足**，不能继续把这些旧等待写成F314关闭前置。原Program及各Task仍由canonical owner持有，已完成的wiring/reader/interface任务不得复活；当前原整合验收开放也不自动授权新的实验投入。

## Dependencies

- **Evolved from**: F100（Process Evolution 方法与 `request-review` asset owner）。
- **Historical dependency**: #1371 lease 退役线曾约束 AC-B2 与 AC-B4 的家里 review-history 接口；两项 landed acceptance 已闭合，它不再是当前 F314 blocker。
- **Related**: F153（运行成本 truth）、F167（既有 A2A 责任语义）、F192/F267（eval/measurement）、F281（自然 human disposition）、F303（概念归一）、F311（永久 Program 控制面）。

## Risk

| 风险 | 缓解 |
|---|---|
| “实验”变成无限期项目 | operator B 接受本期 insufficient；原整合结果验收后才收口，Program 留原 owner |
| F311 吞掉领域 owner | Program 只持 refs/lifecycle；mutation、telemetry、artifact truth 留在原 owner |
| 同时改太多导致无法归因 | 初始确定性机制直接交付；Cycle 1 只评 anchor，一个 Program 一个变量 |
| eval 变成新仪式 | E0 + named consumer；两护栏复用现有记录；insufficient 时不强行出结论 |
| 自动化故障锁猫 | R4/history warn-open；单个 observation join 只阻塞自身 |
| operator重新成为保姆 | 猫内 guardian 裁决与具名 consumer；只收割自然纠正，不要求标注、巡检或追踪 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 新建 F314，不塞进 F100/F311 | 完整交付有独立 journey/AC；资产与 Program ownership 仍留原处 | 2026-09-02 |
| KD-2 | 人猫共创出生，F311 接后续迭代 | 初始方向是价值选择；后续效用适合用真实 episode 验证 | 2026-09-02 |
| KD-3 | 一张 Program 只有 anchor 一个主变量 | 保留可归因性，确定契约与运行健康不伪装成 eval | 2026-09-02 |
| KD-4 | 实验不是新 lifecycle/status/store | 复用 Feature + F311 canonical Program，避免再造概念与球权 | 2026-09-02 |
| KD-5 | 产品 main-health 默认 off，Clowder AI day-one opt in | 社区项目自主选择；咱们自己的已知痛点立即有人负责 | 2026-09-02 |
| KD-6 | Phase B 只用一个执行 thread、至多两个 PR | PR 边界只服从 #1371 owner seam；避免一个机制一条线导致无法收敛 | 2026-09-02 |
| KD-7 | Phase B 由Maine Coon实现；PR-1 Terra review、PR-2 Opus 5 review | 把高成本架构猫用于边界判断，不用于常规编码；两张 PR 均由同一实现 owner 保持收敛 | 2026-09-02 |
| KD-8 | PR-2 同时完成 soft-surface convergence，不另开 cleanup PR | operator 确认它属于原始 F314 scope；拆出 follow-up 会再次制造 scope 漂移与无人欠账 | 2026-09-03 |
| KD-9 | operator B 接受本期 anchor 效果证据不足，解除成熟效用结论关闭前置 | 具体决策卡与原话见 Phase C 逐项 cvo_signoff；不把未达勾成已实现，不关闭其余原交付或 Program | 2026-10-05 |
| KD-10 | 研发方法立即实施，18簇原代码重构暂缓 | CVO1149拆分授权；#5788只交方法，代码等开源intake与组织仓迁移后再确认，提醒到期不自动开工 | 2026-10-20 |

## Review Gate

- Phase A 内容判断复用本 thread 两猫收敛与Ragdoll `TRANSCRIPTION APPROVED`，并以本次 operator kickoff 作价值授权。
- Phase B 由Maine Coon实现，按每个 claim 选择 targeted test/guard/telemetry；PR-1 由 Terra review，PR-2 由 Opus 5 review；最终证据必须覆盖 exact substantive HEAD。
- Phase C 只消费 canonical F311/F192/F267/source-owner refs；任何 `insufficient` 都保持可见，不用聊天结论补空。
