---
feature_ids: [F276]
related_features: [F102, F152, F186, F188, F192, F200, F209, F227, F231, F255, F256, F260, F263, F271, F282]
topics: [memory, people, relationship, privacy, provenance, lifecycle]
doc_kind: spec
created: 2026-07-25
updated: 2026-08-11
description: "为每位用户私域维护第三方人物、第一等关系与互动事件，并以有界关系卡按需解引用。"
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-07-25T21:40:00Z
description_confirmed_by: codex-sol
description_updated_at: 2026-07-27T00:00:00Z
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F276-people-relationship-memory.md"
mcp_admission_claims:
  - ref: "file:docs/features/F276-people-relationship-memory.md"
    toolName: cat_cafe_defer_person_memory_delta
    resourceFamily: memory-write
    boundaryKind: side-effect-boundary
    decision: accepted
  - ref: "file:docs/features/F276-people-relationship-memory.md"
    toolName: cat_cafe_withdraw_deferred_person_memory
    resourceFamily: memory-write
    boundaryKind: side-effect-boundary
    decision: accepted
  - ref: "file:docs/features/F276-people-relationship-memory.md"
    toolName: cat_cafe_forget_deferred_person_memory
    resourceFamily: memory-write
    boundaryKind: destructive-boundary
    decision: accepted
---

# F276: People & Relationship Memory — 人物与关系记忆

> **Status**: Phase A/B + live proposal-status resolver + pending-card atomic
> replacement/withdrawal + cross-thread owner evidence + the operator-approved
> known-person delta dual path are landed on main. The dual path keeps immediate
> proposal and adds a content-free `capture/defer` receipt followed by a bounded
> daily clerk. On 2026-08-11 the first real `InteractionEvent`
> approve→materialize→relationship-card recall vertical slice passed against live
> owner-private truth. Phase C remains open for the rest of AC-C1 and AC-C2/C3; this
> single slice is not an overall utility or standing-reflex verdict. |
> **Owner**: 小太阳·Maine Coon
> (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **Scope authorization**: operator 已批准四阶段 trigger policy，并授权实现聊天富文本主卡 +
> Approval Hub 唯一审批面；不预设新数据库。2026-07-27 operator 进一步批准单一人物身份根：
> 唯一 active workspace person Entity 存在时，F276 只能作为其 owner-private extension。

## Architecture Ownership

Architecture cell: memory

Subcell: `private-person-relationship`（new，F276 owns）

Map delta: **landed** — F276 持有 per-user third-party person claims、
You↔person first-class relationship、append-only interaction truth 与 bounded
relationship-card projection；不新建 architecture cell，不创建平行 evidence store。

Why: F209/F260 拥有 workspace person identity root / locator，F231 只拥有 You profile
与 cat↔You primer；F276 补齐 owner-private typed truth，但不得再造平行 person identity。

### MCP admission boundary

- `cat_cafe_defer_person_memory_delta` 是独立的 side-effect boundary：只持久化
  content-free、exact-source-bound receipt，不创建 Approval Hub 卡，也不写人物记忆；失败时
  零 receipt，后续只能由有界 daily clerk 显式 claim。
- `cat_cafe_withdraw_deferred_person_memory` 是独立的 rollback boundary：只能按 exact receipt ID
  在 proposal 生成前移出 daily queue 并清除 dedupe/source payload；它不等价于再次 capture，且
  对已生成 proposal fail closed。
- `cat_cafe_forget_deferred_person_memory` 是独立 destructive boundary：永久清除 receipt 及所有
  locator，必须 owner 明确请求并保持 profile-gated；已生成 proposal 时拒绝局部遗忘，改走 F276
  proposal/person hard-forget lifecycle。

上述三个工具共享 server-derived owner/invocation 与 typed provenance，但 side-effect、rollback 与
destructive risk 不同；将它们并入 proposal 或一个混合 action union 会污染审批写入与 destructive
annotation，违反 ADR-044 的 authority/risk boundary。既有 `cat_cafe_propose_person_memory` 仅新增
daily-clerk 的 fenced `deferredReceipt` lineage，因此提升为 canonical 的同资源 lifecycle contract，
不新增第二个 proposal 名称。既有 `cat_cafe_record_proactive_memory_abstention` 同样提升为 canonical：
它只在原有 abstention write boundary 内增加 content-free `writeOpportunityRef`，让服务端把明确的
`abstain` 绑定到实际送达的 generation；没有新增 top-level 工具、action、authority 或 risk boundary。

## Why

operator 已经明确介绍过一个低频但高价值的具名人物、稳定背景与一次重要互动；猫却把它只
消费成一次性上下文，随后又把跨部门人物误带成近端关系方。现有 entity proposal
`ep-11` 只能让名字以后指向同一个 anchor，不能保存“这个人是谁、You 与其是什么
关系、哪些事实被纠正过、互动如何演化”。

价值目标不是“建联系人库”，而是：**让猫以后不要求 You 重复科普，同时让第三方
隐私、事实/判断/推断、时态与来源始终可区分、可纠正、可遗忘。**

来源：

- `[thread-id]/0001785014645086-000091-8a3f3500`
- `[thread-id]/0001785015126734-000097-464fce9f`
- `[thread-id]/0001785040313762-000216-7ac202f8`
- `[thread-id]/0001785059633834-000252-42d139ea`
- `[thread-id]/0001785165071118-000167-256ec6cf`
- `[thread-id]/0001785165896876-000182-c2913251`
- `[thread-id]/0001785184786109-000007-82d809aa`
- `[thread-id]/0001785185114109-000016-1c6ee114`

## Current State / 现状基线

- F209/F260 已有 entity registry、alias、nudge、conflict revision，但 canonical record
  只回答“名字指向谁”；F260 已关闭，且把真实时间关系需求留给独立 Design Gate。
- F231 有 per-user capsule + cat↔You relationship primer；subject 是用户与 persona，
  不是第三方联系人。
- F227 有 typed event timeline/teleport，但人物 interaction lane 与 active write gate
  不存在。
- F186/F263 已有 owner-authorized private recall 与 redaction/trace 基座；尚无 private
  person dossier truth。
- F276 Phase A/B、identity-root + informed-event remediation、live proposal-status
  resolver、pending-card atomic replacement/withdrawal 与跨 thread owner evidence 均已合入。
  PR #3277 保证状态回答从 owner-private store 实时投影；PR #3286 允许 pending/not-now 卡
  原子替换或撤回；PR #3296/#3326 让当前对话中的完整卡可绑定任意 owner-visible thread
  的精确 owner 来源。部署状态不得从 merge 或旧 snapshot 推断；2026-08-11 的 authenticated
  live status/recall 调用已证明该真实 case 的 materialized read path 可用。
- 跨 thread source bundle 将 approval card 固定在当前 invocation thread，同时保留每条
  原消息的真实 thread/ref；server 在 stage 与 publish 前逐条重验
  owner、owner authorship、connector absence、delivery、deletion/tombstone、visibility、
  excerpt/digest 与 assertion role，任一失败零写入。
- 2026-08-08 黄挺真实 dogfood 暴露新的生产端缺口：人物已登记后，F282 registry filter
  会整类抑制后续 delta；即时 proposal 又会被主任务挤掉。operator 选择“双路径闭环”，PR
  #3503 已将其合入 main：明确且时机合适时继续即时 proposal；值得记但当前不宜打断时只写
  exact-source-bound、TTL=0、content-free deferred receipt，由 daily clerk 有界转换成仍需
  owner 审批的 F276 proposal。daily 不扫描对话、不接触私密正文，也绝不静默 materialize；
  本次 status/recall 证据未区分该 candidate 来自即时 propose 还是 deferred daily clerk，
  因而不能据此宣称双路径均已完成生产 dogfood。
- Phase C 的 `InteractionEvent` approve→materialize→recall vertical slice 已于 2026-08-11
  首次通过：exact proposal 当前为 `materialized`、`publicationState=anchored`、无 remaining
  drafts；同一人物 alias 的只读 recall 返回 bounded person/relationship/latest-interaction
  card 与原消息 provenance。该证据关闭“尚无获准真实卡”的旧状态，但未覆盖 source excerpt
  drill、correct/forget、reject/not-now absence，也未形成 AC-C2 runtime-health 或 AC-C3 utility
  verdict；完整 Phase C 仍未闭环。
- 首个真实 `InteractionEvent` proposal 已进入 owner-private Approval Hub，但 operator 拒绝并
  判为失败 dogfood：决策卡没有直接说明“发生了什么”，单一 invocation-origin source
  也无法表达由同一 thread 多条 owner 消息逐步讲清的事件、重要性与不确定性；同时 MCP
  把 duration 暴露为 `any`，与 runtime `TemporalValue` contract 漂移。该样本不得计入
  Phase C 成功；PR #3265 已修 informed card、bounded `sourceRefs[]` 与 temporal
  parity，但仍须激活后以新 proposal 重跑。

## What

### Phase 0: Design Gate + substrate census

- 确认本 spec 的 logical contract、privacy threat model、forget purge matrix 和 source map。
- 对现有 user data root、memory SQLite、private Collection、F227 event store 与 F255
  product/projection 模式做 code census。
- 选择能满足 canonical truth、transaction、backup、redaction、rebuild 与 auth 的最薄
  substrate；没有证据不得新建数据库/Store。这里的“新 Store”指独立 durable backing
  （新 database/file/service/shard，拥有独立 migration/backup/retention lifecycle）；
  在既有 canonical user-data database 内增表属于 schema expansion，不等于新 Store，
  但仍须证明 transaction/auth/purge 不变量并保持 F276 ownership。
- operator 已 exact signoff 四阶段 trigger policy：普通对话可主动 `detect → propose`，但只有
  逐项审批、明确记忆命令或对既有 current claim 的锚定纠正，才能 `materialize`；
  只有 materialized truth 可参与 future `recall`。
- Phase 0 census 选择现有 Redis durable backing 内的 F276 owner-private logical keyspace；
  不新增独立 database/file/service/shard。private Collection 仅可作为可重建读投影，
  不能成为 canonical truth。
- 审批体验固定为一个 canonical `CaptureCandidate` / Approval Envelope 的双投影：
  chat 富文本卡是主要呈现面，Approval Hub 是唯一审批面。两边不得各自保存 decision
  state；Hub 的逐项批准原子 materialize 后，chat 卡同步为 receipt。

### Phase A: In-turn capture + typed private truth

- 明确介绍、纠正、关系或重要互动在**第一次出现当轮**可被当前猫 detect，并在自然
  断点主动亮 owner-private approval proposal；不要求记忆口令、不按重复次数、不做
  后台 LLM 监控。
- detect 是当轮 ephemeral 判断；approval card 成功展示后才可持久化 pending
  `CaptureCandidate`。pending/rejected candidate 不进入 canonical dossier、搜索或 recall。
- person identity、versioned claims、first-class relationship、append-only interaction
  events 分层。
- `reported_fact` / `user_assessment` / `agent_inference` 在类型上严格分离；只有前两者可
  成为 approval draft 与 canonical `PersonClaimVersion`。猫推断只在当轮明确展示，
  owner 认同时须重新陈述为带新 source ref 的 owner-authored claim，禁止 approval-time cast。
- third-party truth 默认 owner-private；workspace Entity 与 private dossier 仍单向解耦，
  但 identity root 不再可选：唯一 active workspace person Entity 存在时，由 server
  resolver 派生 `workspaceEntityLink`，F276 只创建 owner-private extension；不存在
  Entity 时才允许 private-only identity。歧义、resolver unavailable、caller hint 冲突
  均 fail closed，不创建候选。
- 同一 `(ownerUserId, entityRef)` 至多一个 active F276 extension；不同 owner 可各自拥有
  隔离的 private extension。既有 unlinked rows 禁止仅按 display name 静默回填。
- `InteractionEvent` proposal 必须提供有界、按序、逐条鉴权的 `sourceRefs[]`：允许
  authenticated owner 在任意 owner-visible thread 中由 owner 发出的精确消息；每条
  source excerpt 明确映射其支持的 event fields。当前 anaphoric instruction 只证明
  proposal intent，不能替代原始事实来源，来源 thread 也不能决定卡片投递 thread。
- event approval projection 必须直接展示人物、发生了什么、时间及冲突、时长、重要性/
  主题与仍不确定部分；MCP input schema 与 shared `TemporalValue` schema 同源，禁止
  ingress 使用 `any` 扩大契约。
- proactive disposition 是 `propose | capture/defer | abstain` 三态：能立即清晰提案就
  `propose`；值得记但主任务不宜中断就 `capture/defer`；确实不应记录才 `abstain`。
  没有 proposal、defer receipt 或 typed abstention 的沉默仍是 `uninformed_silence`。
- deferred receipt 只保存 server-derived owner/cat/invocation/origin、人物 identity binding、
  exact typed source coordinates/digests 与状态，不保存消息正文。known-person delta 允许进入，
  但 exact registry + source bundle delta 在 capture/proposal/materialized lineage 间去重。
- daily clerk 每轮最多消费 8 条显式 confirmed receipt，只把 exact refs 交回原 requester cat
  生成普通可拒绝 F276 proposal；未确认 ASR/第三方转写保持 `awaiting_confirmation`，不会入队。

### Phase B: Authorized relationship card + lifecycle

- caller 授权后，resolver 合并 private alias 与 workspace Entity alias 两条路径；只有
  两路唯一收敛到同一 materialized active PersonIdentity 时才注入 ≤160-token
  relationship card。分歧/歧义 fail closed；pending/not-now/retired/workspace-only
  命中不 hydrate。
- 卡片只含 current reported facts、current relationship、最近互动 headline、
  uncertainty 与 provenance refs；猫按需发起有预算的 typed drill。
- correction/supersede/retire/relationship-change/same-name ambiguity/redaction/hard
  forget 全部有确定状态机与 purge 验证。
- v1 禁止把 F276 identifiers、aliases、source refs 或 payload 投影进 F227/F263/F200；
  F227 只作为猫主动选择单一 source ref 后的 typed teleport reader。

### Phase C: Dogfood + utility verdict

- 用首个真实 source case 做 owner-private vertical slice，不把真实 payload 写入 repo、
  fixture、eval artifact 或日志。
- 失败 proposal 不计成功样本；只有 owner 能在审批前读懂 event narrative、逐项查看
  source excerpt 并 drill 原消息，且批准后 materialized truth 可正确 recall，才算
  `InteractionEvent` vertical slice 通过。
- runtime 只观测 capture/materialize/card/drill/purge 健康；不把工程计数硬挂 Eval Hub。
- 按 `relationship_continuity_episode_vector` 出生证跑 pre/post replay + 真实抽样，
  由 F276 owner 决定 keep/tune/sunset。

## User Journey

### Primary Journey: 介绍一次，以后猫认得

- **Scope unit**: one owner-private person relationship
- **Actor**: You + 当前对话猫
- **Entry**: You 首次明确介绍具名人物及稳定身份/关系/重要互动。
- **Flow**:
  1. 当前猫在当轮 detect continuity-valued person delta；detect 本身不持久化。
  2. owner auth 后，server resolver 先查询 active workspace person identity：
     唯一匹配则预填同一 Entity 的 private extension；无匹配可走 private-only；
     歧义、resolver unavailable 或 caller hint 冲突则不创建 proposal。
  3. 自然断点主动亮至多一张 owner-private approval card：每 turn 一人、最多 3 条 claim，
     逐条标明 draft、materializable claim kind、来源角色与 bounded verbatim excerpt；
     猫推断不进入可审批条目。互动事件条目还须直显 narrative、时间/冲突、时长、
     重要性/主题与不确定性，并为每个字段绑定 same-owner、owner-visible 的精确 source
     excerpt；来源可以跨 thread，approval card 仍留在当前对话。
  4. chat 富文本卡承担完整可读呈现并引导打开 Approval Hub；Hub 是唯一审批入口。
     You 可全选、逐项选择、暂不处理或拒绝；只有获准 claim 才原子 materialize，
     chat 卡随后同步为 receipt + undo。`not now` 进入 owner-visible pending list，
     默认 TTL=0 且不主动重弹；普通陈述本身不等于写入授权。
  5. 新 thread 再出现已授权 private alias 或同一 workspace Entity alias，系统要求两条
     identity path 收敛后，只用 materialized current truth 亮 bounded
     relationship card；pending/rejected proposal 永不参与 hydration。
  6. 猫需要细节时才按 item/time window drill；单次 ≤500 tokens、每人每 turn ≤3 次、
     全部人物合计 ≤1200 tokens/turn，原文另经单一 source ref typed teleport。
- **Success evidence**: 单次介绍无需记忆口令即可出现 proposal；未审批时新 thread 不召回；
  审批后不重复问背景；card ≤160 tokens；drill budget 可机械拒绝超限；无 whole dossier
  injection。
- **Non-goals**: CRM、全联系人扫描、社交评分、后台 NER/LLM 监控、自动 workspace
  entity creation、新数据库先行。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | claim | You | 纠正旧事实 → 新 version supersede → card 当轮更新 | state-machine test + owner UAT |
| S2 | alias | You/猫 | 同名多候选 → bounded disambiguation → 不自动合并 | ambiguity fixture |
| S3 | dossier | You | forget → canonical + private projection/cache purge → content-free receipt | absence/purge test + cross-cell identifier scan |
| S4 | interaction event | You/猫 | 任意 owner-visible thread 的多条 owner 原话 → 有界 typed source set → 当前对话可读审批卡 → 逐项跨 thread drill 后审批 | card contract + provenance auth matrix + owner UAT |

## 最薄终态契约

逻辑对象只有六种；物理载体由 Phase 0 census 决定：

1. `PersonIdentity` — owner-scoped stable private extension + private aliases；若唯一 active
   workspace person Entity 已存在，必须带 server-derived one-way link，否则才可 private-only。
2. `PersonClaimVersion` — materializable `reported_fact | user_assessment` discriminated union +
   typed authority/status/time/source/supersedes；`agent_inference` 保持当轮 ephemeral，不能
   approval-time cast。
3. `PersonRelationship` — You↔person stable relationship identity + lifecycle。
4. `InteractionEvent` — append-only event + bounded ordered source refs；每个 narrative/
   temporal/importance field 都能映射到 owner-authored excerpt/ref，修正用 `amendsEventId`。
5. `CaptureCandidate` — 已展示的 owner-private approval envelope 与逐项授权状态；不是
   canonical dossier truth。not-now / partial approval 必须可在 owner-visible pending list
   继续、拒绝或遗忘。
6. `RelationshipCard` — derived、bounded、`storable:false/indexable:false` 的 authorized view。

详细 schema、privacy resolver、lifecycle matrix 与 eval birth certificate 见

## 机制选择

| Claim | Selected mechanism |
|------|--------------------|
| 明确介绍/纠正时猫想起 capture | convention/skill |
| owner/scope/claim kind/provenance/card budget/lifecycle/forget | schema/test/runtime guard |
| 各 runtime stage 的耗时、成功/失败与 purge health | F153 traces/metrics |
| 是否减少重复科普且不增加误绑/注意力税 | licensed utility eval |

## Eval / Tracking Contract

### Primary Users + Activation

You 与所有 owner-authorized cats。Activation = 已 materialize person 在新 context 被再次
提及并生成 card；candidate 数量本身不算成功。

### Friction Vector

- `repeat_explanation_needed`
- `identity_misbinding`
- `stale_fact_used`
- `irrelevant_card_or_drill`
- `intrusive_or_repeated_proposal`
- `continuity_succeeded_without_reteach`

不加权成总分；任何 confirmed privacy leak 立即 kill。

### Fixtures

- 首个真实 case 仅 owner-private replay，repo 中只保存 opaque source refs。
- 至少 4 个匿名 fixture：首次介绍、事实纠正、同名歧义、hard forget。
- 同一 tune cohort 与 acceptance holdout 分离。

### Sunset

- ≥20 eligible episodes 后，若相对 pre-F276 baseline 没减少 repeat explanation，且存在
  sustained proposal/card attention tax，tune 或 sunset proactive proposal / automatic
  card hydration，保留 explicit memory command 与 drill。
- 任一 private leakage 或 hard-forget 后可再读到 payload，立即停用相关 lane 并修复。
- 具体出生证见 Design Gate discussion；drill rate 或 candidate count 不能单独作为效用。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 低频高价值人物第一次出现可主动提议，不等三次/记忆口令 | AC-A1 | single-message fixture | [x] |
| R2 | 不做后台 LLM 监控 | AC-A2 | architecture/code path audit | [x] |
| R3 | person/fact/relationship/event 分层，事实/判断/推断分离 | AC-A3, AC-A4 | schema/type tests | [x] |
| R4 | 第三方默认 per-user private，workspace alias 解耦 | AC-A5, AC-A6 | auth/privacy fixtures | [x] |
| R5 | 再提人物只亮短卡，可 drill provenance | AC-B1, AC-B2 | token-budget + UAT | [x] |
| R6 | correction/retire/forget/同名/关系变化完整 | AC-B3..B6 | lifecycle matrix | [x] |
| R7 | harness 按 claim 选机制，不盘点未选项 | AC-C2, AC-C3 | Design Gate review | [x] |
| R8 | 不静默建档；审批卡逐 claim 清晰展示来源/类型与适量原话 | AC-A8..A10 | auth/card contract tests + UAT | [x] |
| R9 | F260 是 workspace person identity root；F276 只做 owner-private extension | AC-A6, AC-A11, AC-A12, AC-B7 | resolver/uniqueness/convergence/forget tests | [x] |
| R10 | 事件卡必须让 owner 看懂发生了什么，并能用任意 owner-visible thread 的多条原话逐字段举证；不能要求 owner 搬 thread | AC-A13..A15, AC-A18, AC-C1 | card/source auth/schema parity + Alden cross-thread E2E + owner UAT | [ ] 2026-08-11 approve→materialize→recall slice 通过；source drill/correct/forget 等完整 AC-C1 仍待验 |
| R11 | 已登记人物的后续重要互动不能因 registry suppression 或主任务繁忙持续漏记 | AC-A19..A25 | tri-state evaluator + deferred receipt/store/daily/proposal/purge tests | [x] 工程 contract；本次 live slice 未区分 immediate/deferred lane，双路径 dogfood 仍待分路验证 |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端非必需；若 Phase 0 选择 Hub 管理面，再补需求→截图映射

## Acceptance Criteria

### Phase 0（Design Gate + census）

- [x] AC-01: operator 批准 Decision Packet 的推荐默认；implementation scope 与 non-goals
  有明确签字。
- [x] AC-02: code census 证明选定 substrate 是现有能力中的最薄可行承载；若引入独立
  database/file/service/shard，必须列出现有 contract 不可表达的具体不变量并回到 operator gate。
  既有 canonical database 内增表不是新 Store，但须证明 transaction/auth/purge closure。
- [x] AC-03: privacy threat model + lifecycle/purge matrix 经非作者 reviewer 覆盖。
- [x] AC-04: architecture map、source map、User Journey 与 logical contract 同步且无 owner
  重叠。

### Phase A（capture + private truth）

- [x] AC-A1: 单次 eligible cue 即可在自然断点主动展示 approval proposal；不要求重复次数
  或显式记忆口令。detect 在展示前保持 ephemeral。
- [x] AC-A2: 无后台 corpus scan、LLM/NER classifier 或 proper-noun auto-write path。
- [x] AC-A3: approval draft 与 canonical `PersonClaimVersion` 只接受
  `reported_fact | user_assessment`；agent inference 无 approve pathway。owner 若认同，
  必须在新 source message 中重新陈述，禁止 approval-time kind cast。
- [x] AC-A4: version/current projection、source refs、valid time、stance、supersedes 有契约测试。
- [x] AC-A5: ownerUserId server-derived；private alias/dossier unauthorized caller 只收到
  constant-shape `not_available`，不区分 missing/unauthorized/ambiguous，响应走 bounded
  equalized path，不能靠 error/body/timing 枚举。
- [x] AC-A6: workspace Entity 与 private dossier 保持单向解耦，workspace reader 无法观察
  dossier existence；但唯一 active workspace `person` Entity 已存在时，
  `workspaceEntityLink` 必须由 server resolver 派生，只有无匹配时才允许 private-only。
  目标 rename/merge/delete 时只更新 link state（linked/stale/deleted）并 fail soft，
  不自动删除、合并或改写 private person truth。
- [ ] AC-A7: 首个真实 source case 完成 owner-private capture，不产生 tracked payload。
- [x] AC-A8: ordinary assertion 不能直接 materialize；只有 card-bound typed approval
  （绑定 exact candidate/claim IDs）、bounded explicit memory command，或对既有 current
  claim 的 anchored correction 可授权写入。每次 materialize 都有 receipt + undo。
- [x] AC-A9: approval card 每 turn 最多 1 张/1 人/3 claims、总计 ≤240 tokens；每条展示
  normalized draft、claim kind、source role 与 ≤24-token verbatim excerpt，全部 excerpts
  合计 ≤64 tokens，并提供 approve-all / select-and-approve / not-now / reject。card 成功
  展示后才可持久化 pending candidate；semantic dedupe 阻止重复催批。
- [x] AC-A10: not-now 使用显式 `not_now` state，并在卡片说明候选会以 TTL=0 留在
  owner-visible pending list，直到 owner 继续审批、reject/withdraw 或 hard forget；系统
  不主动重弹。partial approval 的 remaining draft IDs 留在同一列表，可续批且每次 exact-bind；
  candidate 完全 materialize 后 purge draft/excerpt payload，只留 content-free receipt refs。
- [x] AC-A11: Entity resolver 只接受 exact-normalized、active、workspace-visible `person`
  record，并在 durable write 前 revalidate。ambiguous、resolver unavailable、substring-only
  match 或 caller-provided link 冲突均 fail closed，且零 candidate / alias / reverse-index 写入。
- [x] AC-A12: Redis 对 `(ownerUserId, entityRef)` 实施原子 reverse uniqueness：同一 owner
  至多一个 active extension；不同 owner 可各自拥有隔离 extension。既有 unlinked rows
  不按 display name 静默回填，只能经 owner 明确消歧的 bounded reconciliation 绑定。
- [x] AC-A13: `InteractionEvent` approval projection 直接展示 person、event narrative、
  occurred-at value/conflict、duration、importance/topic 与 uncertainty；不能用
  “有一个 InteractionEvent draft”或仅类型标签代替知情内容。chat 与 Hub 仍投影同一
  candidate/decision truth。
- [x] AC-A14: interaction draft 接受有界 ordered `sourceRefs[]`；server 对每条 ref
  验证 message existence、same authenticated owner、owner authorship、connector absence、
  delivery、deletion/tombstone、caller visibility 与 excerpt/digest，允许 ref 来自不同
  owner-visible thread，任一失败则整次 proposal 零写入。每个可审批 event field/summary
  至少映射一个 bounded excerpt/ref，并可在审批前 drill 原消息；当前 anaphoric
  continuation 只作为 proposal intent，不自动成为事实来源。
- [x] AC-A15: MCP `propose_person_memory` 的 interaction temporal inputs 直接复用 shared
  `TemporalValue` schema/type；duration/occurred-at 不得以 `any` 或比 runtime 更宽的
  schema 暴露。shared contract、MCP schema 与 API parser 有 parity tests。
- [x] AC-A16: owner 可在 Approval Hub 撤回尚未 materialize 的 pending/not-now proposal；
  撤回会 purge draft/excerpt payload、移出 pending list，且不会创建 rejection suppression。
  纠错通过新 proposal 的 `replacesProposalId` 完成：只有同 owner、同人物且仍为
  pending/not-now 的旧卡可被替换；新卡成功持久化并锚定 Approval Envelope 与旧卡
  `withdrawn + replacedByProposalId` 必须在同一 Redis transition 原子提交。已 materialize
  内容仍走 exact undo / anchored correction，不允许伪装成审批前替换；F276 纠错不得退回
  workspace Entity mutation 兜底。
- [x] AC-A17: 若 pending/not-now 卡的完整原始事实位于其他 owner-source thread，当前猫在
  当前对话用原 owner 消息重建**完整**新卡并携带 `replacesProposalId`；纠错消息只可证明
  被改字段，不得把“发生了纠错”建模成新的 `InteractionEvent`，也不得丢弃未受影响的
  claim / relationship / event。显式历史 `sourceMessageId` 只有通过同 owner、
  owner-authored、可见、未删除且包含所有 claim/relationship 精确 evidence excerpt 的
  校验后，才能成为 proposal source。
- [x] AC-A18: proposal 的 `sourceMessageRef` / Approval Envelope origin 始终绑定当前
  authenticated invocation，决定卡片留在哪个 thread；typed source bundle 中每条
  `sourceRef` 独立保留真实历史 thread/message，决定证据 drill 去哪里。server 不接受 caller
  伪造 thread，且对跨 owner、cat-authored、connector、undelivered、deleted/tombstoned、
  excerpt/digest drift 与不合法 assertion role fail closed。真实 Alden route E2E 必须证明
  “当前 thread 发起 + 其他 thread 的 who/what/assessment 原话”产生有信息量的当前卡，
  不能用 proposal-success ToolEvent 或零信息卡冒充验收。
- [x] AC-A19: proactive outcome 是互斥的 `propose | capture/defer | abstain`；defer 是
  informed disposition，既不能和 propose/abstain 同时发生，也不能把无动作沉默洗成 abstain。
- [x] AC-A20: defer callback 只接受 bounded subject、typed source coordinates 与 client request id；
  owner/cat/invocation/current origin、source thread 与 digest 均由 server 派生并在 stage 后重验。
  receipt TTL=0 且不保存消息正文、excerpt、transcript、relationship fact 或 owner 可伪造的 auth 字段。
- [x] AC-A21: registered person Entity/private Person 的新 interaction delta 可进入 defer lane；非人物
  Entity 与 pending/dormant 仍抑制重复卡。多个 exact active person Entity 命中时零写入 fail closed。
  dedupe fingerprint 由 exact registry binding + 排序后的无重复 source-coordinate set 生成，source
  顺序不改变 identity，重复 coordinate 直接拒绝；同一 lineage 横跨 immediate proposal、deferred
  receipt、claimed/proposed 与 materialized truth，不能因“人物已登记”整类 suppression，也不能
  在 immediate → defer 或 defer → immediate 任一方向生成第二条 receipt/card lineage。direct proposal
  即使使用不同 `sourceId`，只要解析到同一 message/attachment coordinate，也必须在 candidate/card
  写入前以 `duplicate_source_coordinate` fail closed。
- [x] AC-A22: daily clerk 只读取最多 8 条显式 deferred receipt，使用有期限 claim fence；
  它不扫描全量对话、不读取正文，只唤醒原 requester cat 以 exact typed refs 生成普通 F276
  approval proposal。投递失败释放 exact claim；成功时 candidate anchor、pending index、payload-free
  terminal receipt、ready/binding/proposal indexes 与 lineage swap 在同一个 Redis Lua 内提交，并原子
  重验 receipt state、claim id、`claimUntil`、fingerprint 与 binding membership。并发 withdraw 或 lease
  expiry 只能得到 409 + 非 approvable staged candidate，不能留下可审批的 orphan card/candidate。若
  card 已持久化后旧 lease 才过期，下一位 clerk 可在 receipt 新 claim 仍有效时，以 old-claim/new-claim/
  fingerprint/候选 raw snapshot/hard-forget fence 的 Redis CAS 原子续接同一 staged candidate；重试
  复用唯一卡并完成 anchor，不得因固定 `clientRequestId=receiptId` 永久卡死，也不得另建 candidate。
- [x] AC-A23: message attachment/ASR/第三方转写只有绑定同 owner 的明确准确性确认后才可从
  `awaiting_confirmation` 进入 daily queue；跨 owner、cat-authored、connector、删除、不可见、
  digest/confirmation drift 全部 fail closed。
- [x] AC-A24: owner 可按 exact receipt 撤回或 hard forget；proposal hard-forget 与整个人物
  hard-forget 都清除关联 receipt、owner/dedupe/proposal locator 与 ready index。terminal receipt
  只留 content-free disposition/lineage，不可从隐藏 derived person id 反查；receipt 一旦绑定
  proposal，receipt-only forget 必须拒绝，避免“收据已删、事实卡仍在”的假 purge。
- [x] AC-A25: F153 health 只记录低基数 `capture` / `deferred_daily` stage outcome 与 latency，
  不含人物、owner、receipt、source 或 hash；utility 继续消费既有 F282/F276 eval，不以工程计数
  冒充 keep/tune/sunset verdict。

### Phase B（card + lifecycle）

- [x] AC-B1: card ≤160 tokens，最多 3 facts + 1 relationship + 1 latest event；只读取
  materialized current truth，无 pending/rejected proposal、原文或 agent inference。
  hydration 必须先通过 owner auth，再合并 private alias 与 workspace Entity alias；
  两路唯一收敛到同一 `status='active'` PersonIdentity 才 hydrate。
  pending/not-now/retired/workspace-only 命中不 hydrate。
- [x] AC-B2: 每个 card item 有 typed provenance drill；必须选择 item/time window，单次
  ≤500 tokens、每人每 turn ≤3 次、全部人物 aggregate ≤1200 tokens/turn；超限 fail closed，
  drill 不返回 raw body，只返回 bounded projection + 最多一个 typed source ref。
- [x] AC-B3: correction/supersede/retire/current projection 在同一 turn 可见且有状态机测试。
- [x] AC-B4: same-name 多候选 fail closed，不自动 merge/任选。
- [x] AC-B5: relationship state change append-only；interaction correction 用 amend，不 overwrite。
- [x] AC-B6: hard forget purge canonical payload、alias projection、Entity reverse index、
  private index、card/cache/replay，但不删除或改写 F260 Entity；
  pending candidates、content-free suppression token 与 deletion receipt scope 同样覆盖；
  没有 person binding 的 terminal candidate 由 owner-authenticated exact `proposalId`
  purge 做 fenced、幂等、跨 owner 等权清除；person-bound proposal 在该 surface fail closed，
  继续要求整个人物关系 forget；
  deletion receipt content-free，absence test 全绿。F276 identifiers/aliases/source refs/payload
  禁止进入 F227/F263/F200；跨 cell 只允许不可按 person/claim/event 反查的 aggregate counters。
- [x] AC-B7: recall 合并 private alias 与 workspace Entity alias → owner reverse index 两条
  identity path；两路同人或单一路径唯一命中才可读取 private truth，路径分歧、任一路径
  歧义或 stale reverse pointer 均 fail closed。合法 Entity 但无 owner-private extension时
  返回 constant-shape `not_available`，不泄漏其他 owner 是否建档。

### Phase C（dogfood + verdict）

- [ ] AC-C1: detect→propose→approve→materialize→card→drill→correct→forget 全 journey
  owner-private UAT 通过；reject/not-now 路径证明 future recall absence。2026-07-27
  首个 `InteractionEvent` proposal 因 informed-approval/source-set contract 不足被
  owner 拒绝，只记失败证据、不计成功样本。PR #3265 已关闭工程路径。2026-08-11
  exact live status + recall 证明一个新的真实 `InteractionEvent` candidate 已完成
  approve→materialize→bounded card recall，故该 vertical-slice pass condition 已关闭；
  source excerpt/drill、correct/forget 全 journey 与 reject/not-now absence 尚未闭合，AC-C1
  仍保持 open。
- [ ] AC-C2: runtime traces 能定位各 stage 健康，但 detect/proposal telemetry 只含 aggregate
  count、latency、decision category；不得带 person/candidate/claim/source refs、
  alias/name/excerpt 或其 hash/fingerprint，且原始工程计数不冒充 utility eval。
- [ ] AC-C3: `relationship_continuity_episode_vector` 出生证完整，≥20 eligible episode 或
  明确 no-decision；输出 keep/tune/sunset verdict。

## Dependencies

- **Evolved from**: F260（entity locator/nudge 的真实后继，不重开 F260）
- **Blocked by**: Phase C 不再受 blanket runtime activation 阻塞；首个真实
  approve→materialize→recall slice 已通过。剩余 blocker 是 AC-C1 未覆盖的 drill /
  correct / forget / absence journey，以及 AC-C2 runtime-health 与 AC-C3 utility verdict；
  identity-root / informed-event 确定契约已由 PR #3265 合入
- **Related**: F186（private collection）、F200（aggregate navigation utility）、F227（typed
  source teleport only）、F231（user/persona boundary）、F263（failure taxonomy/aggregate harm）

## Risk

| 风险 | 缓解 |
|------|------|
| 第三方隐私从 workspace alias 反向泄漏 | private-only one-way link；authorization before lookup |
| 已有 Entity 仍创建未关联 private duplicate | server-derived resolver + owner/entity reverse uniqueness |
| private alias 与 Entity alias 指向不同人物 | recall convergence guard；任一歧义/分歧 fail closed |
| 历史 unlinked row 被猜测性回填 | 禁止 display-name migration；只允许 owner 明确消歧 |
| 猫推断污染人物事实 | inference 无 approval/materialize pathway；owner 认同须新 source 重述 |
| 旧事实持续污染推理 | versioned current projection + stale/supersede guard |
| 过度保守导致每次都要说“记住” | eligible cue 主动亮一次低摩擦 approval card，不要求记忆口令 |
| 过度激进造成静默建档 | ordinary assertion 只到 proposal；materialize/recall 均需确定授权 |
| proposal storm / approval fatigue | 每 turn 一卡一人三 claim + semantic dedupe + not-now/reject |
| not-now 退化成长久暗档 | owner 明示 hold + visible pending list + no auto-reprompt + reject/forget purge |
| 事件卡只显类型、owner 无法知情审批 | event narrative/temporal/importance/uncertainty 必显 + owner UAT |
| 待审批卡错字迫使用户误改 workspace Entity | F276 原子 replace/withdraw + 同人物/状态校验 + Entity 工具边界 guard |
| 单一当前消息覆盖多轮事实来源 | same-owner cross-thread bounded sourceRefs + true source-thread drill + field mapping + fail-closed auth |
| 为引用历史证据强迫 owner 搬 thread | current-thread card origin 与 cross-thread evidence refs 分离；MCP 明示留在当前对话 |
| MCP temporal schema 比 runtime 更宽 | shared schema 单源 + API/MCP parity tests，禁止 `any` |
| whole dossier context DDoS | ≤160-token card；drill 500/call、3/person/turn、1200 aggregate/turn |
| forget 只藏不删 | 禁止跨 cell identifiers + private purge matrix + absence verification |
| 为新语义私造数据库/Store | Phase 0 census + ownership review；无证据禁止新增 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新 F276，不重开 F260、不扩肥 F231 | typed truth owner 与 locator/profile subject 均不同 | 2026-07-25 |
| KD-2 | Architecture cell=`memory`，新增 subcell、不新 cell | 复用现有 memory ownership；只补缺失 owner | 2026-07-25 |
| KD-3 | 新 typed owner 不预设新 Store | 独立 backing 才算新 Store；既有 DB 增表仍需 census 证明 | 2026-07-25 |
| KD-4 | third-party 默认 owner-private；workspace link one-way（“optional”部分由 KD-12 取代） | 可寻址性不等于私域授权 | 2026-07-25 |
| KD-5 | 短卡 pull，不整档案 push | 降 context/隐私/stance 污染 | 2026-07-25 |
| KD-6 | 按 claim 选 convention/guard/observability/eval | ADR-031 v3.4；机制不是清单 | 2026-07-25 |
| KD-7 | v1 禁止 F276 identifiers 跨 cell projection | 让 hard forget closure 可机械证明 | 2026-07-25 |
| KD-8 | typed drill 采用三层预算 | 保留主动 provenance，同时阻断 dossier injection | 2026-07-25 |
| KD-9 | 主动 detect/propose；确定授权后才 materialize/recall | 同时避免记忆口令依赖与静默建档 | 2026-07-25 |
| KD-10 | 一个 Approval Envelope，chat + Hub 双投影；Hub 独占审批权 | chat 更适合阅读，Hub 更适合治理；单一 decision truth 避免双批与 split-brain | 2026-07-26 |
| KD-11 | canonical truth 使用现有 Redis backing 的 F276 logical keyspace | 复用 durable/atomic/auth 基座，不扩肥 F231、不把 compiled index 当 truth | 2026-07-26 |
| KD-12 | F260 Entity 是唯一 workspace person identity root；F276 仅为 owner-private extension | truth ownership 可分层，人物身份不能分叉；唯一匹配时 link 必须 server-derived | 2026-07-27 |

## Review Gate

- Design Gate: closed。operator 已对 OQ-1 与双投影单审批面 exact signoff；既有非作者 review
  已覆盖 logical contract、privacy、source ownership。
- Implementation: identity-root + informed-event remediation 已由 PR #3265 合入 main
  `146e43280`；server-derived resolver、reverse uniqueness、recall convergence、
  forget cleanup、event card/sourceRefs/temporal parity 均已落地，F260 write scope
  未重开。2026-08-11 authenticated live status/recall 已覆盖一个 materialized
  `InteractionEvent` read slice；未覆盖的 lifecycle 与分路证据按 AC-C1..C3 继续开放。
- Dogfood: first real owner-private `InteractionEvent` approve→materialize→recall slice
  passed on 2026-08-11. Full AC-C1 remains blocked on drill/correct/forget/absence evidence；
  AC-C2/C3 与 immediate/deferred 分路验证仍开放，tracked docs 不复制真实 payload。

## Tips Contribution（F244）

已有 `feature-f276-private-person-memory` tip 介绍 capture/approval；F281 closure 另增
`feature-f281-exact-proposal-forget`，只在 exact unbound terminal proposal 删除边界可用时提示。
