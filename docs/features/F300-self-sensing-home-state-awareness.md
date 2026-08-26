---
feature_ids: [F300]
related_features: [F153, F220, F223, F233, F246, F281, F293, F296, F298, F299]
topics: [self-sensing, self-management, home-state, integration-policy, capability, availability, user-friction, interaction-adaptation, feedback-loop]
doc_kind: spec
created: 2026-08-17
description: "Agent Self-Sensing & Self-Management：以薄旅程/集成合同选择相关 owner facts，并把摩擦、建议、owner 执行、首次真实使用和用户处置连成可验证改善闭环"
description_source: human
description_author: cat-eqdvbcxw
description_updated_at: 2026-08-26T07:15:00Z
---

# F300: Agent Self-Sensing & Self-Management — 薄旅程编排与家况感知

> **Status**: spec；source contract 已按产品目标重校准，runtime 未实现，source review pending
> **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1

- **Original operator direction**: 2026-08-16/17（`0001786845058052`：“期待你们在运行过程中可感知到家里整个系统的情况……不是黑盒”）及后续三机制确认。
- **Product direction**: 2026-08-25/26（`0001787716986266-000439-d91c1b16`）：F300 后续承载这块完整产品目标和设计；概念已经清楚，Plugin 整改完成后即可启动首个 plugin-backed 纵切，因此 source 必须先写清。
- **Recalibration evidence**: clowder-ai PR #1391 maintainer design audit（comment `5421892668`）：保留完整产品旅程，但把 F300 收敛为薄 journey/integration owner，不建立超级状态系统或第二真相。
- **Architecture cells**: 不新增 `self-sensing-management` cell。F300 只跨 `routing-context`、`identity-session`、`approval-index`、`human-disposition-feedback` 等现有 owner 组织集成政策和只读关联视图。
- **Map delta**: none。首个纵切完成前没有新的 runtime ownership cell；若以后证明需要稳定公共能力，最多登记 integration policy 与 read-only adapters，不能接管来源事实。

## 一句话定义

**F300 让 Agent 在行动前后读到“此刻与当前协作真正相关”的 owner facts，识别自己能力、可用性和交互摩擦，再沿已有 authority/owner 把候选改善带到第一次真实使用与用户处置；它拥有相关性与旅程验收，不拥有来源事实、通用状态本体或业务变更权。**

## Why：从“人替 Agent 维护系统认知”倒置为 Agent 自己感知

| 今天由用户被迫承担 | F300 希望 Agent 自己承担 |
|---|---|
| 取消后反复提醒“别再喊那只猫” | 在相关副作用前感知 authoritative cancellation，并阻止旧动作 |
| 一只只试猫，猜哪些猫共用同一配额桶 | 读取 owner 提供的 quota topology，一次判断可用性 |
| 先调用语音工具，失败后才知道插件或权限没准备好 | 在使用前读取 Plugin / permission / device readiness |
| 发现某个交互总要重复纠正，却只能每次临时补一句 | 识别 friction evidence，提出可解释、可撤回的改善候选 |
| 为了得到更顺手的体验，自己充当产品经理拼接插件、权限、界面和偏好 | Agent 组织跨 owner 改善旅程；用户只在必要的授权、选择和处置点介入 |

产品目标不只是“Agent 多知道一个状态”，而是让系统形成一条有边界、可验证的改善路径：

~~~text
摩擦证据
  → 读取相关 owner facts
  → 判断为什么现在相关
  → 形成 owner-backed 候选
  → 复用既有用户决定 / authority
  → 原 owner 执行并给 receipt
  → 在真实 surface 使用
  → 第一次真实使用证据
  → 用户保留 / 调整 / 忽略 / 撤回
~~~

“State”是这条路径的认知底座，但单独拥有更多 state 不等于产品目标完成。

## 0. Phase 0 只冻结四条不变量

在任何 schema、adapter 或 UI 之前，F300 只要求所有实现共同遵守：

1. **Source facts remain at owners**：来源事实留在原 owner；F300 不复制成第二账本。
2. **F300 selects relevant facts**：F300 只选择对当前 obligation、下一副作用或当前改善旅程真正相关的事实。
3. **Mutation goes to owners**：所有改变仍通过原 owner 的命令、权限与 receipt；F300 不因“感知到”而获得写权。
4. **User-visible improvement requires first real use + disposition**：只有经历第一次真实使用，并获得用户的保留、调整、忽略或撤回处置，才算用户可见改善闭环。

这四条是不依赖具体媒介的长期产品合同。Phase 0 不冻结“大一统 self-state schema”、完整 facet 枚举、跨域状态机或新 canonical episode。

## 1. F300 拥有什么、不拥有什么

### 1.1 薄 owner 边界

F300 拥有：

- **Relevance policy**：哪些 owner facts 与此刻的 obligation / next side effect / improvement candidate 相关，以及 `whyNow`。
- **Read policy**：成员范围与被授权共享范围下，允许读取哪些来源引用；拒绝默认全家广播。
- **Thin envelope**：跨 owner 传递引用、新鲜度和可见性所需的最小公共外壳。
- **M1 / M2 / M3 integration policy**：行动前查证、相关 delta、按需快照如何互补。
- **Refs-only journey correlation**：把既有 evidence、proposal、decision、receipt、surface、first-use 与 disposition 引用关联起来，便于验收和追责。
- **Effectiveness decision**：一条改善旅程是否真的到达首次使用、是否减少摩擦，以及用户最终如何处置。

F300 不拥有：

- 通用 `SelfStateProjection` 本体、全局 self-state graph 或 `subject × facet × visibility × state` 的组合空间；
- capability、quota、custody、plugin readiness、permission、preference、surface 等 typed domain payload；
- 新的 canonical `InteractionEpisode`、`GroundedProposal` 或另一套 proposal / approval / feedback 状态机；
- “Capability Construction”或“Interaction Adaptation”两个新的 F300 子系统——它们是产品旅程步骤，事实与 mutation 仍归原 owner；
- 私有/共享双份 store、presentation ledger、command receipt store 或 retention ledger；
- 仅凭推断、摩擦或“为了用户好”绕过 authority 的能力。

### 1.2 三种感知是判断维度，不是状态本体

| 判断维度 | Agent 要回答的问题 | 典型 owner facts | 不能被误读为 |
|---|---|---|---|
| **Capability Sense** | 我会不会做、能力来自哪里、适用边界是什么？ | core capability、Plugin/Limb registry、tool contract、技能声明 | “tool 名存在”或“UI 看得到”就等于能用 |
| **Availability Sense** | 此刻能不能做；配额、权限、依赖、设备和运行健康是否允许？ | quota topology、custody、permission、provider/Plugin/runtime readiness | 安装过就等于 ready；stale/unknown 就等于 available |
| **User-Friction Sense** | 我提供的能力与交互，在当前协作中是否反复让用户解释、等待、切换或纠正？ | 用户显式反馈、重复纠正、失败回执、任务/交互证据 | 诊断用户、推断人格或把所有不满永久画像化 |

三种感知是**判断问题**；owner payload 是答案来源。它们不要求 F300 再复制一套 capability/availability/friction facets。尤其 friction 是当前协作中的效果信号，不是“用户状态”或“Agent 内在状态”。

`installed ≠ enabled ≠ authorized ≠ reachable ≠ healthy ≠ appropriate now`。实现必须保留这些 owner-defined 差异，不能压成一个含糊布尔值。

## 2. 两种读取策略，而不是两个数据平面

### 2.1 Member-scoped read

Agent 为自己的当前 obligation 做判断时，只读取该 principal 被授权访问、且与当前动作相关的 owner facts。用途包括：

- 我是否仍持有这个球；
- 我在当前 provider / quota / Plugin 条件下是否可执行；
- 我是否需要在产生外部副作用前重新查证；
- 我刚才的交互是否出现了可验证 friction。

### 2.2 Authorized-shared read

团队协作确实需要共享时，读取由原 owner 已明确授权给相关成员/线程的引用。例如共享 quota pool、同一 cancellation subject 或团队已接受的 surface 配置。

### 2.3 边界

Member-scoped 与 authorized-shared 是**同一组 canonical owner facts 上的读取策略**：

- 不是 private store 与 shared store；
- 不是所有私有事实都会晋升为共享；
- 不是 F300 创建新的团队广播通道；
- visibility 只表达读取边界，不转移事实所有权；
- F296 可负责 presentation/delivery，但“被显示/被注入”不改变 canonical owner。

## 3. 最小跨 owner 外壳

F300 只冻结足以引用事实并判断新鲜度的薄 envelope：

~~~ts
type SensingFactEnvelopeV1 = Readonly<{
  subjectRef: string;
  ownerRef: string;
  sourceRefs: readonly string[];
  revision: string;
  freshness: Readonly<{
    observedAt: number;
    expiresAt?: number;
    invalidators: readonly { ownerRef: string; ref: string }[];
  }>;
  visibility: 'member_private' | 'authorized_shared';
}>;
~~~

- **Typed payload belongs to the owner**：F300 不规定每个 owner 的 payload union，也不把 domain 状态反序列化成万能 schema。
- `sourceRefs` 必须可回到 canonical truth；摘要或 projection 不得自称 source。
- 取消、权限、authority 等副作用前置事实必须按 owner 规则实时回源；可缓存项过期后只能是 `unknown`。
- `visibility` 只约束读取，不授予 mutation。
- envelope 可以被 transport/presentation 包裹，但不能替代 F296 的 receipt/ledger，也不能让 MessageStore/UI toast 冒充“模型已看见”。

## 4. 三种互补送达机制

### M1 — Authoritative preflight

在下一次不可忽略的副作用前，按 exact `subjectRef` 向 owner 重读 authoritative truth。典型例子：

- 为同一 obligation 再次 @/dispatch 前查 cancellation/custody；
- 使用语音、摄像头或物理 Limb 前查 permission + runtime readiness；
- 选择一只猫前查 family/shared-pool quota topology。

`unknown` 不得被当成“可以继续”。M1 与旧 M2 冲突时 M1 获胜。

### M2 — Relevant delta

owner fact 变化且会影响当前 obligation / next side effect 时，F300 admission 为相关 delta，由 F296 负责 epoch-aware presentation、重验证、去重和 provider receipt。

~~~ts
type HomeStateDeltaV1 = Readonly<{
  fact: SensingFactEnvelopeV1;
  consumerScope: { threadId: string; catIds: readonly string[] };
  whyNow: 'affects_current_obligation' | 'affects_next_side_effect';
}>;
~~~

M2 不向 active generation 随意插入半句话；只在 provider 已证明安全的边界呈现，否则留到下一 invocation。M2 是否及时到达不替代 M1。

### M3 — Pull snapshot

Agent 需要规划或解释时，按 scope 拉取一组 refs-only snapshot。snapshot 只组合 owner references、新鲜度和相关性；不复制 typed truth，不建立长期中心账本。

M1/M2/M3 随 Phase 1 的 Home-State 机制纵切落地，并在后续完整产品旅程中复用。它们不是必须等 Plugin 整改才能开始的部分。

## 5. 产品改善旅程：完整，但不接管原 owner

| 旅程阶段 | F300 的工作 | Canonical owner / authority |
|---|---|---|
| 1. Friction evidence | 选择与 Agent 自己提供的能力/交互相关的证据，记录 `whyNow` | message/task/history、失败 receipt、用户显式反馈等原证据 owner |
| 2. Sense relevant facts | 通过 M1/M2/M3 读取能力、可用性和当前摩擦所需引用 | capability/Plugin/runtime/quota/custody/permission 等各 owner |
| 3. Match opportunity | 判断“哪项可用能力可能减少哪项摩擦”，保留不确定性与反证 | F300 relevance policy；不产生新 domain fact |
| 4. Owner-backed proposal | 让能执行的 producer 形成可审查候选，而非 F300 发明万能 proposal | F246 approval index 与现有 producer proposal |
| 5. User decision / authority | 复用既有授权；低风险可逆项也必须遵守原 owner policy | F281 `HumanDispositionDecisionEpisode`、原 permission/approval owner |
| 6. Owner mutation + receipt | 将命令送回原 owner；成功、失败和 partial 都由 owner receipt 证明 | Plugin、permission、preference、surface、runtime 等 owner |
| 7. Surface adaptation | 把已获授权且有 receipt 的结果呈现在正确 surface | F223 capability surface 与对应 surface owner |
| 8. First real use | 在真实任务中观察这次改善是否真的被使用，而非“配置成功”即宣称有效 | task/message/session/surface evidence owner |
| 9. Feedback & disposition | 用户保留、调整、忽略或撤回；必要时回滚到 owner | F281 feedback/disposition + preference/retention owner |

### 5.1 Refs-only correlation / acceptance view

为回答“这条改善从哪里来、做到哪一步、是否真的有用”，F300 可以维护短生命周期、可重建的关联视图：

~~~ts
type SelfManagementJourneyRefsV1 = Readonly<{
  frictionEvidenceRefs: readonly string[];
  sensingFactRefs: readonly string[];
  proposalRef?: string;
  decisionRef?: string;
  commandReceiptRefs: readonly string[];
  surfaceRef?: string;
  firstUseEvidenceRef?: string;
  dispositionRef?: string;
}>;
~~~

它只关联引用：

- 不成为 canonical `InteractionEpisode`；
- 不成为 canonical `GroundedProposal`；
- 不复制 proposal、decision、receipt、surface episode 或 retention 状态；
- 缺失任一关键引用时，验收视图必须如实显示“尚未完成”，不能用文字摘要补齐证据。

### 5.2 产品设计合同

1. **每个能力都有出生证**：能力来自哪里、谁拥有、当前能否使用、需要什么权限、失败怎么恢复。
2. **事实与呈现分层**：owner fact、presentation、模型 receipt、用户看到的 UI 状态是四件不同的事；任何一层都不能冒充另一层。
3. **注意力与证据成比例**：一次偶发摩擦先低打扰观察；重复、明确且可行动的摩擦才提升为候选；需要权限或不可逆时必须显式请求。
4. **候选先于定型**：先生成可解释、可拒绝、可撤回的改善候选；不要因一次推断永久改变 Agent 或用户。
5. **用户塑造体验，而不是被迫做产品设计**：用户表达目标、纠正和处置；Agent 负责查事实、组织 owner、解释影响并验证真实效果。

## 6. Plugin gate 是 voice slice-local gate

Plugin 完整改只阻塞**依赖 Plugin 的语音首纵切**。它不阻塞：

- cancellation/custody 的 M1/M2/M3；
- refs-only Home-State projection contract；
- 非 Plugin owner 的只读 adapter；
- 不依赖 Plugin 的 capability/friction slice；
- source contract、tests 和 acceptance fixtures。

进入 plugin-backed voice journey 前，必须由 Plugin truth owner/operator 提供可验证证据：

1. 安装、启用、权限、runtime readiness 和失败原因可区分；
2. provider/Plugin capability 有稳定 owner ref 与可查询 typed truth；
3. microphone 等敏感权限必须由用户亲授，F300 不能代授权；
4. 调用成功/失败/取消都有 owner receipt，且 UI/presentation 不冒充执行成功；
5. uninstall/disable/revoke 后相关 proposal、surface 与 retained preference 能失效或回滚。

F300 可以判断这些证据是否满足 voice slice entry criteria，但**无权宣布 Plugin 全域整改完成**。

## 7. Phases

### Phase 0 — Thin source contract

- 冻结四条不变量、薄 envelope、owner map、Plugin slice-local gate。
- 删除/禁止通用 self-state ontology、新 canonical episode/proposal 与过宽 ownership cell。
- source truth 必须先落地；publication 只能镜像同源合同，并在合入前对其 exact HEAD 做非作者内容 review。

### Phase 1 — Home-State mechanism slice

- 用取消例完成 M1 authoritative preflight + M2 relevant delta + M3 refs-only snapshot。
- 保留 F296 provider receipt / presentation ledger、F298 durability 与原 custody owner 边界。
- 可并行补 quota topology、非 Plugin runtime readiness adapter。

### Phase 2 — First complete product journey: voice

- Plugin gate 满足后，用“反复打字摩擦 → 语音候选 → 亲授麦克风 → owner receipt → 首次真实使用 → 用户处置”跑通完整旅程。
- 语音是第一个完整纵切，因为它能同时验证 capability、availability、friction、authority、surface 与 rollback；它不是永久架构中心。

### Phase 3 — Heterogeneous proof

- 至少再跑一条不同 owner、不同媒介的纵切，例如取消协作、配额路由、桌面 surface 或通知注意力调整。
- 只有两个异质纵切都重复出现的结构，才有资格从 journey-local 代码提升为稳定 integration adapter。

### Phase 4 — Feedback and retention

- 通过现有 feedback/disposition/preference owners 完成保留、调整、忽略、撤回和失效。
- 用 first-use evidence 判断“真的减少摩擦”，而不是把配置或 UI 出现当成成功。

## User Journey

### Primary Journey：不用反复打字，Agent 帮我把语音带到真实使用

- **Scope unit**: member + current thread；共享只发生在 owner 已授权的引用上
- **Actor**: 用户 + Agent；用户拥有权限与最终处置权
- **Entry**: 用户在持续协作中多次表达“打字累/想说话”，或出现可验证的重复输入摩擦
- **Flow**:
  1. Agent 把明确表达、重复纠正或输入中断识别为 **friction candidate**；它描述交互效果，不诊断用户健康或人格。
  2. Agent 读取相关 owner facts：当前是否有语音能力、Plugin/runtime 是否 ready、设备与权限状态、当前 surface 能否承载。
  3. 若证据不足或不可用，Agent 说明缺口并继续原任务；不展示一个注定失败的“快捷入口”。
  4. 若证据充分，Agent 提出 owner-backed 候选：“要不要在这个协作里试一次语音输入”，说明影响、权限、失败恢复和可撤回性。
  5. 用户接受后，麦克风权限仍由用户亲授；拒绝或忽略不会被当作隐式同意。
  6. Plugin / permission / surface owner 执行并返回 receipts；失败时原位说明哪个 owner、哪一步失败，且原任务仍可继续。
  7. surface 出现可用语音入口；Agent 不把“按钮出现”当成能力已生效。
  8. 用户在真实任务中说出下一条内容，系统成功将其带回原任务——这是第一次真实使用证据。
  9. 用户可保留、调整适用范围、暂时忽略或撤回；相应 owner 更新或回滚，F300 只关联 disposition ref。
- **Success evidence**: proposal、decision、permission/Plugin receipts、surface ref、真实语音输入回到原任务、最终 disposition 全部可追溯；任一缺失都不能宣称闭环。
- **Failure semantics**: permission denied、Plugin unavailable、device missing、provider failure、surface failure、first-use failure 分开表达；绝不诊断健康，绝不静默扩大权限。

### Mechanism Journey：取消一只猫，全家在相关判断点知道

1. 用户取消某个 invocation/obligation，canonical custody owner 写入事实。
2. F300 只对受影响的 thread/cats admission M2 delta；F296 负责送达与 provider receipt。
3. 猫在同一 subject 上准备再次 @/dispatch 前执行 M1；若 cancelled 则阻止，若 unknown 则 fail closed。
4. 用户在原动作位置看见 recorded / pending / presented / failed-or-unknown；只有 provider receipt 才能写 presented。
5. 新 subject 的无关工作不继承旧 cancellation。

### Supporting Journeys

| ID | 判断维度 | 旅程 | 预期证据 |
|---|---|---|---|
| S1 | Availability | @ Ragdoll 前读取 shared-pool quota topology，一次判断替代逐只试错 | owner topology ref + M1 result |
| S2 | Capability + Availability | 想用某个非语音 Plugin/Limb 时先读 capability、authorization 与 runtime readiness | owner refs + typed unknown/degraded reason |
| S3 | Friction | 某 surface 被连续关闭/撤回，Agent 降低注意力或提出可拒绝调整 | repeated evidence refs + existing disposition + later first-use/absence evidence |

## 需求点 Checklist

| ID | 需求点 | AC | 验证 |
|---|---|---|---|
| R1 | F300 是薄旅程/集成 owner，不建立新 ontology 或第二真相 | AC-0.1–0.4 | source diff + ownership review |
| R2 | M1/M2/M3 保留并复用 canonical owner facts | AC-1.1–1.5 | contract/integration tests |
| R3 | 完整产品旅程到 first real use + disposition，而非止于 proposal/config | AC-2.1–2.6 | voice journey evidence manifest |
| R4 | Plugin 整改只 gate plugin-backed voice slice | AC-G1–G4 | gate evidence + independent non-plugin fixtures |
| R5 | private/shared 是读取策略，authority/visibility/mutation 不混淆 | AC-0.2、AC-2.3 | authorization fixtures |
| R6 | 抽象必须由异质纵切证明，不以文档枚举先造超级系统 | AC-3.1–3.3 | two-slice comparison |

## Acceptance Criteria

### Phase 0：Source contract

- [x] **AC-0.1**: source 明确只冻结四条不变量，并删除“完整 state ontology 是先决条件”的方向
- [x] **AC-0.2**: Member-scoped / authorized-shared 被定义为读取策略，不是两个 store/data plane；visibility 不授 mutation
- [x] **AC-0.3**: 薄 envelope 仅含 `subjectRef / ownerRef / sourceRefs / revision / freshness / visibility`，typed payload 留在 owner
- [x] **AC-0.4**: F300 不拥有 canonical proposal、decision/surface/interaction episode、command receipt 或 retention truth；refs-only view 缺证据时不得补写结论
- [x] **AC-0.5**: publication exact HEAD 经非作者内容 review 通过，并有 continuity evidence 证明其 F300 合同与已落地 source 同源
- [x] **AC-0.6**: 不新增 `self-sensing-management` ownership cell；source Feature Truth 与 ROADMAP 同步

### Phase 1：M1/M2/M3

- [ ] **AC-1.1**: cancellation M1 按 exact subject 回源；cancelled 阻止同 obligation 动作，unknown fail closed，无关新 subject 不受污染
- [ ] **AC-1.2**: M2 缺 exact consumer scope、why-now、revision、freshness 或 source refs 即拒绝
- [ ] **AC-1.3**: F296 负责 epoch-aware presentation、dedupe 与 provider receipt；F300 不建第二 channel/ledger
- [ ] **AC-1.4**: M3 snapshot 只组合 owner refs；stale/expired 显示 unknown，不拼接推断
- [ ] **AC-1.5**: quota/plugin/runtime 等 adapter 分别保留 owner typed states，不压成通用 bool

### Plugin-backed voice entry gate

- [ ] **AC-G1**: Plugin truth owner 提供 installed/enabled/authorized/reachable/healthy 的可区分证据与 stable owner refs
- [ ] **AC-G2**: microphone 权限由用户亲授；拒绝/撤回有 typed result，不产生隐式同意
- [ ] **AC-G3**: Plugin invocation 与 surface mutation 均有 owner receipts，失败原因可定位
- [ ] **AC-G4**: disable/uninstall/revoke 后 proposal/surface/preference 能按原 owner 规则失效或回滚；该 gate 不阻塞 Phase 1 与非 Plugin slice

### Phase 2：完整 voice 产品旅程

- [ ] **AC-2.1**: friction evidence 只描述 Agent 能力/交互效果，不诊断用户；候选可解释、可拒绝、可撤回
- [ ] **AC-2.2**: capability + availability refs 能支持 why-now；证据不足时继续原任务而不是诱导失败
- [ ] **AC-2.3**: proposal、user decision/authority、owner commands 与 receipts 逐段可追溯，无 silent authority expansion
- [ ] **AC-2.4**: surface 出现不等于成功；首次真实语音输入必须回到原任务并留下 owner evidence
- [ ] **AC-2.5**: permission denied、Plugin unavailable、device missing、provider failure、surface failure、first-use failure 六类失败分别验收
- [ ] **AC-2.6**: 用户可保留、调整、忽略或撤回；F300 只引用 existing disposition/preference/retention truth

### Phase 3–4：异质证明与反馈

- [ ] **AC-3.1**: 至少两个不同 owner、不同媒介纵切完成，语音不是永久绑定
- [ ] **AC-3.2**: 任何提升为 shared integration adapter 的结构都有两条异质纵切证据；否则留在 journey-local
- [ ] **AC-3.3**: effectiveness 由 first-use + disposition / later evidence 判定，proposal accepted、config written 或 UI rendered 都不能单独记成功

## Existing owner map

| Truth / action | Existing owner | F300 只做 |
|---|---|---|
| custody / cancellation | F233/F293 对应 custody/routing owner | relevance + M1/M2 refs |
| execution lifecycle | F220/runtime owner | read refs；不改状态机 |
| runtime health | F153 | relevance + typed adapter |
| context presentation / model receipt | F296 | 提供 admitted delta；消费 receipt |
| durability / wake admission | F298 | 依赖其寿命证据 |
| capability / surface | F223 及具体 capability/surface owner | match journey + surface ref |
| producer proposal / approval index | F246 | 引用 proposal/approval |
| human decision / feedback / disposition | F281 | 引用 decision/disposition |
| Plugin capability / command / readiness | Plugin truth owner/operator | preflight + entry gate |
| user preference / retention | 对应 preference/retention owner | 关联 ref，不复制 |

## Dependencies

- **Can proceed now**: Phase 0 source contract、Phase 1 M1/M2/M3 contracts/fixtures、非 Plugin read-only adapters。
- **Plugin-backed voice slice blocked by**: Plugin truth owner/operator 对 AC-G1–G4 的完整证据；不是一句“整改完成”。
- **Runtime delivery depends on**: F296 presentation/receipt contract 与 F298 principal/admission/result durability。
- **Related**: F223 capability surfaces、F246 proposals/approval、F281 human disposition、F299 user-visible trajectory。

## Non-goals

- 不造 universal self-state ontology、490 类组合矩阵或中心 self graph。
- 不新增 `self-sensing-management` ownership cell 作为前置条件。
- 不新增 canonical Interaction/Grounded Proposal/feedback episode。
- 不把 private/shared 做成双 store 或默认广播。
- 不因“感知到摩擦”自动安装 Plugin、扩大权限、改生产数据或永久画像用户。
- 不让 UI rendered、message persisted、proposal accepted 或 command admitted 冒充 first real use。
- 不让 Plugin 整改成为所有 F300 runtime 的全局 gate。

## Risks

| 风险 | 防线 |
|---|---|
| F300 扩成接管所有状态和改善动作的超级系统 | 四不变量 + 薄 envelope + existing owner map + 禁止新 cell |
| private/shared 被实现成双真相 | 明确为读取策略；所有引用回到同一 owner |
| friction 变成用户诊断/画像 | 只描述 Agent 自己能力与交互效果；显式反馈优先；候选可撤回 |
| proposal/episode 名称换皮后重复建账本 | refs-only view；F246/F281/surface/owner receipts 继续 canonical |
| M2 到达被误当成动作安全 | 副作用前 M1 回源，冲突时 M1 胜 |
| Plugin 整改口头化或变成全局 blocker | AC-G1–G4 精确证据；只 gate voice slice |
| “配置完成”被统计为产品改善 | 必须 first real use + disposition |
| 语音纵切绑死跨媒介设计 | Phase 3 至少一个异质媒介，抽象须双切片证据 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 保留 Capability / Availability / User-Friction 三种判断维度 | 覆盖“会不会、现在能不能、交互是否有效”，同时不要求通用状态本体 | 2026-08-25 |
| KD-2 | M1 preflight / M2 relevant delta / M3 pull snapshot 继续作为 Home-State 机制 | 它们直接对应取消、配额、Plugin readiness 三个真实例子，且可独立于 voice 开始 | 2026-08-17/26 |
| KD-3 | F300 是薄 journey/integration owner | 产品旅程需要统一验收，但来源事实、mutation 和 authority 必须留在原 owner | 2026-08-26 |
| KD-4 | Member Self View / Team Shared View 降为 member-scoped / authorized-shared read strategies | 避免双 store、双 plane 与 visibility→authority 漂移 | 2026-08-26 |
| KD-5 | 不新增 canonical InteractionEpisode / GroundedProposal | 复用 F246、F281、surface episode、owner receipts；F300 只保留 refs-only correlation | 2026-08-26 |
| KD-6 | Capability Construction / Interaction Adaptation 是旅程步骤，不是 F300 子系统 | 构建与适配都必须由原 capability/surface/Plugin/preference owner 执行 | 2026-08-26 |
| KD-7 | Plugin gate 只阻塞 plugin-backed voice 首纵切 | M1/M2/M3、read-only projection 与非 Plugin slice 可独立推进 | 2026-08-26 |
| KD-8 | 产品改善必须有 first real use + disposition | 防止把 proposal、配置或 UI 投影视为真实用户价值 | 2026-08-26 |
| KD-9 | 先更新 Cat Café source truth，再同步 public PR | source 是单一真相；publication 不得反向覆盖内部产品合同 | 2026-08-26 |

## Review & Delivery Gate

1. source Feature Truth 与 ROADMAP 必须先在 `develop_base` 落地并 push，publication 不得先行定义产品合同。
2. publication PR #1391 镜像同源 F300/ROADMAP，并移除过早的 `self-sensing-management` cell 及其索引、Plugin cell 越权登记。
3. 对 publication 新 exact HEAD 做非作者内容 review，同时检查“产品目标是否完整”“ownership 是否足够薄”以及 source/publication continuity；AC-0.5 只允许基于该 terminal review 勾选。
4. publication formal review 重新绑定新 exact HEAD；作者不自审、不自行 merge。
5. runtime 实现另走 F128 execution thread、测试与独立验收；spec 完成不等于 runtime 已实现。
