---
feature_ids: [F278]
related_features: [F245, F222, F248, F128, F266, F167, F264]
topics: [paw-feel, friction, disposition, inbox, triage, system-thread, workspace, eval]
doc_kind: spec
created: 2026-07-26
tips_exempt: task-custody verification reuses the existing typed disposition action and Workspace workflow; no new user-invokable capability is introduced
description: "让每条猫猫爪感差进入系统 thread 负责的可见收件箱，并以原消息引用、猫签处置和 Workspace 实时投影形成责任闭环。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-08T00:00:00Z
---

# F278: Paw-Feel Disposition Inbox — 爪感差责任收件箱

> **Status**: in progress — Phase G production acceptance correction in branch; live remains on Phase F behavior
> **Owner**: 小太阳·Maine Coon（@codex-sol）
> **Priority**: P1
> **Initial delivery**: 2026-07-27
> **Reopened**: 2026-07-30（live dogfood 暴露 review work unit 与 duty activation gap）
> **Reopened again**: 2026-08-08（真实 duty 批次暴露 transport receipt 与业务责任真相混淆）
> **Reopened a third time**: 2026-08-10（production duty 证明 stale repair 仍被计为修复中，incomplete batch 没有可审计收据）
> **Evolved from**: F245

## Why

operator 要的不是“采到过”，而是每条爪感差都有人负责看、能追到处置，并且现场可见：

- `0001785055205203-000023-c79c98f3`：授权把“爪感差已采集”升级为“每条都被看见、审阅并有处置”。
- `0001785070497266-000579-b2934c25`：“这个必须做”“让系统 thread 的猫直接收了看了”“在 Workspace 实时看到你们都上报了什么”。
- `0001785414248058-000159-bd739ce3`：追问值班猫在哪里配置、多久看一次、看完怎样处理，以及人猫完整旅程是否真的规定。
- `0001785414536911-000162-4a459989`：指出同一 thread、同一 invocation 会产生多条相关 signal，按逐条平铺会反复阅读同一上下文。
- `0001785418998194-000191-a53bd6bd`：授权更新 F278 spec、补全 gap；代码完成后再由 operator 重启并配置值班猫。
- `0001786235537994-000350-dcdfd3c3`：真实 inbox 诊断显示 208 bundles / 262 active / 179 overdue，全部非终态仍被 UI 当作 “new”，且 `112876b3` 连续 `bundle_invalid`。
- `0001786236680561-000372-aff77c69`：授权把真实 friction signal 推进到可验证责任状态，并要求每班留下逐 bundle rich receipt；本轮不启动 runtime、不碰 Redis 6399、不做 production activation。

当前 F245 会回扫、聚类并产生周期 verdict，但 Top-N 之外的原始 signal 没有逐条责任状态。结果是“分析系统知道存在”不等于“某只猫必须看完”。F278 补的是责任控制面，不是 embedding 阈值。

2026-07-30 的 live dogfood 又证明：**逐条入账正确，不等于逐条平铺就是正确的审阅工作单元**。当时 ledger 有 520 条、全部 unseen、395 条 72h+，且 primary / backup 未配置；最近 24 小时抽样 21 条来自 20 条消息、14 个 thread，其中一个 thread 占 6 条。同消息与同 invocation 的多条 signal 需要共享一次上下文阅读，但每条 disposition 仍须独立入账。

2026-08-08 的真实收件进一步证明：**信使送达不等于业务责任完成，事件名也不等于业务真相**。值班 watermark 在 notice delivery / wake 后即完成，confirm 又重新水合当前 bundle membership，导致旧列表连续失效；与此同时 source cat 是真实 repair owner 时，终态 signer guard 错把“修复归属”和“独立签署”绑成同一身份约束。

## Association Verdict

**Verdict: 新建 F278，作为 F245 post-close evolution；不 reopen F245，也不复用 F266 的 verdict 身份。**

| Feature | 既有边界 | F278 关系 |
|---|---|---|
| F245 | 只读 friction rollup / clustering / periodic verdict；KD-4 不抢 ownership，KD-8 禁止复制 marker | 复用唯一 parser 与分析结果；新增 raw paw-feel 的 disposition ownership |
| F222 | user-authored dissatisfaction / frustration | user-authored marker 继续归 F222；F278 首期只接 canonical cat-authored paw-feel |
| F248 | Settings / Workspace Eval Hub 可读投影 | Workspace「评估」新增 live paw-feel surface |
| F266 | published eval verdict lifecycle | 复用 append-only event/projection 形状，不复用 verdict 对象或状态语义 |
| F128 | 无准确 owner 时提案 | pending proposal 是可审计 blocked exit；批准后仍须形成真实 repair binding 或 terminal disposition |
| F167 | 路由后的工作球权与闭环 | named owner + task + active lease 才能投影 `bound_in_repair`；transport-only `routed` 仍是 `unreviewed` |
| F264 | 原消息上的 durable status projection | 原消息就地显示 paw-feel disposition，不复制正文 |

F277 已被开放 PR #3234 占用，因此本功能使用最新可用编号 F278。

**2026-07-30 association verdict：reopen F278，不另立 feature。** 本轮不改变 canonical signal、ledger writer、duty home 或四个既有 read surfaces；它修正 F278 自己的 review work unit、运营完成判据和 routed 证据强度。

**2026-08-08 association verdict：再次 reopen F278，不另立 feature。** 真实 signal、bundle、duty watermark、四个 read surfaces 和责任 writer 全部仍属于 F278；本轮只把既有对象从“消息已送达”提升到“业务 exit 可证明”。

**2026-08-10 association verdict：继续在 F278 内修正，不另立 feature/thread。** production 验收失败发生在同一 responsibility read model 与 duty receipt writer：安全门正确拒绝了非法出口，但人类看到的状态与 incomplete receipt 仍不诚实。这不是新的工作流，也不改变 F167/F266/F192 的 ownership。

## Architecture Ownership

```text
Architecture cell: harness-eval
Map delta: none
Why: Phase F/G 只校正既有 F278 responsibility / duty receipt 在 harness-eval cell 内的完成语义，不新增 ownership boundary；F278 的 pre-verdict 责任对象与四个 consumer 已在既有 architecture map 登记。
```

正文真相、责任真相和分析真相分离：

```text
MessageStore original message
  └─ marker body (canonical; never copied)
       ├─ F245 read-only analysis: clusters / rollups / verdicts
       └─ F278 append-only ledger: source ref / digest / disposition
            ├─ thread_eval_friction: content-free duty notice + triage entry
            ├─ Workspace → 评估: live inbox projection
            ├─ Settings → Eval Hub: duty config + compact audit summary
            └─ original bubble: in-context disposition projection
```

## Invariants

1. 每条 canonical cat-authored paw-feel signal 都进入可见 inbox，并最终获得猫签名的 disposition。
2. 聚类、embedding、Top-N 只影响排序与候选分组，永远不能决定 signal 是否可见或是否需要审阅。
3. 原消息是 marker 正文的唯一真相源；ledger 只持久化 `sourceMessageId`、定位信息、不可逆 digest 与 disposition。
4. 自动化只可 discover、suggest、group、remind；不可写 `seen`、terminal disposition，亦不可猜 owner。
5. 路由必须查证准确 owner thread；查不到进入 F128 `route_pending`，新增责任需审批。
6. `degraded=true` 时仍保留逐条可见与确定性分组，禁止输出依赖语义聚类完整性的强结论。
7. operator 与报告猫能看到未看、审阅猫、处置、目标、年龄和 source availability；现场可见优先于统计 dashboard。
8. 系统 thread 持久承担值班责任，实际当班猫可替换；猫粮耗尽不能让责任对象消失。
9. `thread_eval_friction`、Workspace live、Settings audit summary 与原消息状态都从同一 F278 event log/projection 读取；任何 surface 都不能拥有第二个 disposition writer 或可漂移副本。
10. ledger 仍按 signal 逐条 exactly-once；上下文 bundle 只是可重建 read projection，不持久化第二本 bundle ledger，也不能隐藏任何成员。
11. 确定性 bundle 优先级为同 `sourceMessageId` → 同 `turnInvocationId` → legacy `invocationId`；`threadId` 只作目录与导航，绝不等价于“同一问题”。
12. bundle 处置是 O(1) 猫确认 + O(例外) 拆出；list 返回服务端签名的精确 `signalId + expectedSequence` membership snapshot，confirm 只验证并消费该快照，禁止重新水合 membership。后来新到的成员保持原状态，不得被追溯签名。
13. transport delivery、wake、旧 `routed` 事件或文本文案都不能成为业务责任 exit；只有 terminal disposition、verified repair binding、pending proposal 或 explicit blocker 可成为当班 valid exit。`signature_waiting` 是可恢复的 active state，不完成 receipt。
14. primary / backup 未配置时必须是 Workspace 与 Settings 的最高优先级运行红灯；在完成配置并走通一批真实 triage 之前，F278 不能宣称运营完成。
15. 每个 actionable bundle 必须处于 `terminal`，或拥有 named owner + task + **当前仍 active 的 exact lease/generation**，或 **F128 当前仍为 pending 的 proposal**，或 explicit blocker；投影必须携带对应 evidence refs。read/receipt 时重新查权威 store，过期 lease 或非 pending proposal 立即失去 `validExit`。`signature_waiting` 必须继续完成独立签署或转成 explicit blocker。
16. duty watermark 的终态是业务 receipt，不是 messenger receipt。每班只有在精确 snapshot 中每个 bundle 都有 valid exit，且同一 durable notice 已更新为逐 bundle rich checklist 后才能 complete；未完成 batch 不得被新 watermark 覆盖。
17. source cat 可以是 resolver-verified repair owner，但不能 terminal-sign 自己的 signal。系统必须持久化 exact candidate、source signer exclusion 和可选 preferred signer，使 Backup / 首选 signer 中断后任一合法独立 signer 都能结构化恢复。

## Durable Identity and Data Model

F278 必须复用 F245 的 `extractPawFeelMarkers`，禁止第二套 parser。

```ts
type PawFeelSignalId =
  `${sourceMessageId}:${sha256(rawMarker)}:${sameDigestOrdinal}`;

interface PawFeelDispositionProjection {
  signalId: PawFeelSignalId;
  sourceMessageId: string;
  sourceThreadId: string;
  sourceCatId: string;
  markerDigest: string;
  markerIndex: number; // navigation hint only
  discoveredAt: string;
  state:
    | 'new'
    | 'seen'
    | 'route_pending'
    | 'routed'
    | 'fix'
    | 'closed'
    | 'duplicate'
    | 'no_action'
    | 'fix'
    | 'signature_waiting'
    | 'blocked';
  lastTransitionAt: string;
  lastActorCatId?: string;
  targetThreadId?: string;
  proposalId?: string;
  duplicateOf?: PawFeelSignalId;
  reasonCode?: string;
  outcomeRef?: string;
  signatureRequest?: PawFeelSignatureRequest;
  blocker?: PawFeelResponsibilityBlocker;
}

type PawFeelResponsibilityState =
  | 'unreviewed'
  | 'bound_in_repair'
  | 'signature_waiting'
  | 'blocked'
  | 'terminal';

// Pure read projection. Never persisted as a new authority.
interface PawFeelReviewBundle {
  bundleKey: `message:${string}` | `turn:${string}` | `legacy-invocation:${string}` | `signal:${string}`;
  basis: 'message' | 'turn_invocation' | 'legacy_invocation' | 'single_signal';
  sourceThreadId: string;
  representativeSourceMessageId: string;
  membershipToken: string; // server-authenticated exact list snapshot
  members: Array<{
    signalId: PawFeelSignalId;
    expectedSequence: number;
    sourceMessageId: string;
  }>;
  rawSignalCount: number;
  stateCounts: Partial<Record<PawFeelDispositionProjection['state'], number>>;
  responsibility: PawFeelResponsibilityProjection;
}
```

事件日志是 append-only canonical：

- `discovered`
- `seen`
- `route_pending`
- `routed`
- `route_reopened`
- `fix`
- `closed`
- `duplicate`
- `no_action`
- `signature_requested`
- `blocked`

若原文 digest 与 ledger identity 不符，必须 fail loud，不得把旧 disposition 静默挂到另一条 marker。`duplicateOf` 必须存在且无环；`no_action` 必须有枚举 reason；`closed` 必须有 `outcomeRef`。

## Authority and State Transitions

| From | To | Authority / guard |
|---|---|---|
| absent | `new` | scanner / reconciliation only |
| `new` | `seen` | authenticated duty/responsible cat |
| `seen` | `route_pending` | cat + exact owner evidence or F128 proposal ref |
| `route_pending` | `routed` | legacy audit transition only；即使 receipt 合法也不构成新业务 exit |
| `route_pending` | `seen` | owner rejection / proposal rejection (`route_reopened`) |
| `new` / `seen` / `route_pending` | `fix` | cat/operator + resolver-verified named owner, task and active F167 lease |
| `new` / `seen` / `route_pending` | `signature_waiting` | source cat requests one exact `duplicate` / `no_action` / `fix` candidate; persisted request excludes source signer and may name a preferred independent signer |
| `signature_waiting` | `fix` / `duplicate` / `no_action` | any authenticated legal signer other than excluded source signs the exact persisted candidate; preferred signer is routing preference, not a single point of failure |
| `new` / `seen` / `route_pending` / `signature_waiting` | `blocked` | cat writes an explicit blocker code + evidence ref |
| `seen` | `closed` | cat + reason + `outcomeRef` |
| `seen` | `duplicate` | cat + valid `duplicateOf` |
| `seen` | `no_action` | cat + reason enum |

`route_pending` 与旧 `routed` 都继续计入 active responsibility；`routed` 最多证明历史 transport/custody 事件，不能替代当前 business exit。source cat 可以看、补证据并成为 verified repair owner，但不能签自己 signal 的 terminal disposition。Workspace 按五态责任投影展示业务真相，不再把全部非终态都标成 `new`。

## Duty Model

- 稳定责任归口：`thread_eval_friction`。
- thread 只接**无 marker 正文**的 duty notice 与 source-ref inbox 入口，保持 F245 KD-8 的 single-source 约束。
- 初始 primary / backup duty cat 由 operator 配置；猫粮或会话不可用时由 operator 显式换班（更新 duty config，将接棒猫设为 primary），ledger、SLA 与 thread 不换。
- 每日两批审阅；24h 未看升级为 overdue 但仍由 primary 负责；72h 未处置在 Workspace 标红并 operator-visible。年龄阈值只升级严重度，不自动把责任转给 backup。
- unseen 从 0→1、达到批次阈值或 SLA 时才提醒，避免逐条刷 thread。
- 每次 duty claim 持久化精确 bundle/member snapshot；delivery 与 wake 后状态保持 `awaiting_receipt`。每个 bundle 获得 valid exit 后，系统把同一 durable notice 更新为逐 bundle Rich Checklist，再完成 watermark；重试只更新同一 receipt，不重复发消息，且新 backlog 不能覆盖未完成 batch。
- primary / backup 均未配置时，不运行虚假的 escalation 链；Workspace 与 Settings 顶部显示“爪感差值班未配置 · N 条待看 / M 条超时”，并给出配置入口。
- “代码可配置”不是运营完成。operator 在新 runtime 配置 Primary/Backup 后，值班猫必须走通首批真实 bundle triage，才能重新 close 本 feature。
- 首批真实 triage 同时收口已入 append-only ledger 的存量 parser 假阳性：值班猫按 bundle 签 `no_action(reason=parser_false_positive)`；不得删除历史、由 automation 代签或让 reconciliation 静默抹掉。

## User Journey

### operator：Workspace 实时看见

打开 Workspace →「评估」，在现有周期 eval cards 上方先看到“爪感差 · 实时”：

- raw signal / 待审 bundle / 处理中 / 待路由确认 / 已处置 / 超时两个分母；
- 默认按上下文 bundle 展示；同消息、同 invocation 的多条 signal 共享一次 source context，原始成员始终可展开；
- 报告猫、年龄、审阅猫、处置理由、目标 thread/proposal；
- 点击原消息、责任系统 thread、目标 thread；
- 通过 websocket 或短轮询及时刷新，不等待三天 rollup。
- 未配置值班猫时，首先看到系统级红灯和配置入口，而不是一片无人认领的单条 72h badge。

### 值班猫：系统 thread 收件并审阅

系统 thread 收到无正文提醒；当班猫打开 inbox 批次：

1. 每个 bundle 只读一次原始上下文，查看其中所有 marker；
2. 选择共同 disposition，必要时把例外成员拆出；
3. 一次确认后，服务端为快照中的每个 signal 独立校验 sequence、独立写猫签事件并明确报告冲突；
4. 路由与信使回执只提供 transport evidence；真实 repair 必须解析到 named owner + task + active lease，未知 owner 则保持 pending proposal / explicit blocker；
5. 查不到 owner 时走 F128 proposal，不猜 owner、不直接代替 owner 修复。
6. source cat 同时是 verified repair owner 时，提交 exact signature request；任一非 source 的合法 signer 可从持久化 candidate 继续签署，不依赖原 Backup invocation 存活。
7. 当 snapshot 中每个 bundle 都达到允许的 valid exit 后，值班 notice 原地生成逐 bundle rich receipt，作为本班完成凭据；`signature_waiting` 仍保持未勾选。

Phase E 的值班主动作收敛为三个：`duplicate`、带理由 `no_action`、`fix`。`fix` 必须解析到 named owner + task + F167 active lease；task-backed implement 的直线路径是 persisted task standing → `implement/task_done` lease，不接受 generic durable-verdict、自报 ACK 或 transport receipt。它表示“责任已进入可执行修复球权”，不是“问题已修复”。旧 `route_pending/routed/closed` 事件继续可审计，但 transport-only receipt 不再可由新动作写绿。

semantic suggestion 只是在 bundle 之上的候选合并层；未命中或 degraded 时不影响确定性 bundle 与 raw signal 可见性。

### 报告猫：原消息就地确认

报告猫回到原 turn 看到一个聚合状态框，例如“3 条：2 已看 · 1 已交修”，展开后才看逐条状态；`fix` 显示 named owner/task/lease 并明确“已进入修复，不等于已修复”。不会因为一条消息含多个 marker 就出现多个相似“责任箱”。

## Design in Context

- 入口：`packages/web/src/components/eval-workspace/EvalWorkspacePanel.tsx`
- 现有周期卡片：`EvalWorkspaceEventCard.tsx`
- 新 live section 放在统计与周期 eval cards 之前，避免把实时责任项埋进“最近闭环与观察”。
- live section 默认渲染 contextual bundle cards；逐条 row 是展开细节与审计坐标，不再是 500+ 条时的默认工作单元。
- Settings Eval Hub 保留 duty config、域字典与 compact audit summary，并深链回 Workspace；不再重复渲染一套完整 flat history。Workspace 是唯一现场工作台。
- 窄屏优先展示状态、年龄、报告猫和“看原消息”；目标/理由进入展开区。
- source 暂不可读时仍显示 ledger row 与明确 unavailable 状态，禁止静默消失。
- Workspace live、Settings compact audit 与原消息状态都读同一 F278 ledger；不得各建状态、缓存或写入口。

## Capacity Plan

基线约 624 markers / 7 天（约 89/天）；2026-07-30 live snapshot 为 520 raw / 520 unseen / 395 overdue：

- 默认 50 bundles/页，同时报告 raw / bundle 两个分母；按 unseen、age、source cat、bundle basis 过滤；
- 确定性 message / invocation bundle 永远可用；机器可在 bundle 之上建议 semantic candidate 和共同 disposition draft；
- 猫可批量确认，但服务端仍为每条写独立、可审计、猫签事件；
- reconciliation 全量/重叠窗口是完整性承重墙；cursor 与 on-append 只是延迟优化；
- backfill 标记 `backfilled`，aging 从进入 inbox 时起算，首次安排一次性 bulk triage。

## Mechanism Selection

按 claim 选机制，不把整项贴一个标签：

| Claim | Mechanism |
|---|---|
| 每条 signal 可见、bundle 可重建、状态合法、正文不复制、重放不丢不重、新 capture 意图明确 | deterministic tests / schema / state-machine guards / typed capture + bounded legacy parser corpus |
| scanner 延迟、reconciliation 覆盖、unseen 与 SLA backlog | logs / metrics / traces |
| 机器建议 grouping 是否真降低审阅成本 | eval |
| 准确 owner / F128 / 值班操作方式 | convention / skill |

确定性 message/invocation bundle 是契约，不走 eval。Semantic grouping 在 Primary/Backup 已配置、真实值班猫成为 consumer 之前保持冻结；启用后才以 bundle 为输入，观察 median seconds per reviewed signal、bundle accept/split/reject rate 与 raw-to-bundle ratio，做 keep / tune / sunset。连续 4 批节省低于 15% 或建议拒绝率高于 30% 时 sunset semantic layer，不影响 inbox。

## Phases

### Phase A ✅ — Durable Intake + Reconciliation

- append-only ledger、projection、stable identity、共享 parser；
- backfill、全量/overlap reconciliation、coverage health；
- 状态机、authority、idempotency、invalid-transition tests。

### Phase B ✅ — System-Thread Duty + Triage Workflow

- `thread_eval_friction` duty config、content-free notice、primary/backup SLA；
- source evidence resolver、50-item batch、bulk suggestion + per-item signature；
- exact-owner/F128 route receipt 与 reopen。

### Phase C ✅ — Workspace Live Surface + In-Context Status

- `/api/eval-hub` live read model + push/refresh；
- Workspace 实时 section、filter/detail/deep links；
- 原消息 durable status projection、Settings 历史审计；
- loading/error/empty/degraded/source-unavailable/narrow-layout states。

### Post-close Live Correction ✅

2026-07-27 的 live 使用暴露了“数据确实在，但现场很难看懂”的同源问题。operator 原始反馈：

- `0001785188124054-000066-b920c355`：为什么都显示“已等待 12 小时”、为什么看不到刚刚上报的消息、能否倒序、多久收集一次、语义聚类由谁看。
- `0001785189086903-000100-1dc3ae41`：先把问题写入 feature 真相源并直接提交，再开 worktree 修复。

| ID | Live evidence / root cause | Correction contract |
|---|---|---|
| LC-1 | Workspace active list 固定按 `discoveredAt` 最旧优先；没有倒序入口，新 signal 会落到末页。 | operator live inbox 默认最新优先，并提供“最新 / 最久未处理”显式切换；值班 backlog 可继续默认最久未处理。 |
| LC-2 | UI 把 `discoveredAt` 一律写成“已等待”。首批约 393 条在同一次 backfill 中进入 ledger，因此历史 signal 同时显示约 12 小时，既看不出原消息时间，也看不出是回填。 | 同时展示原消息发生时间与进入 inbox / SLA 起算时间；`backfilled=true` 明示“历史回填”，禁止把回填时长冒充原 signal 年龄。 |
| LC-3 | 完整性依赖 15 分钟 overlap reconciliation、24 小时 full scan；前端另有 30 秒刷新。正确但不实时，刚上报的 marker 最坏要等约 15 分钟才进入 ledger。 | canonical message append 后走同一 parser/identity 的热路径，目标 60 秒内可见；15 分钟 overlap 与 24 小时 full scan 继续作为完整性兜底，不另建 parser 或 writer。 |
| LC-4 | `degraded` banner 暗示 live inbox 正在提供语义聚类，但当前 surface 实际只渲染 deterministic `tool:*` 分组；F245 的周期 clustering 是另一条分析管线。 | UI 只陈述当前真实能力：逐条可见 + 确定性分组。只有真实 semantic suggestions 已接入并可供值班猫确认时，才显示语义聚类状态；`degraded` 永不影响可见性。 |
| LC-5 | live snapshot 出现全部 signal 仍为 unseen、0 disposed；duty primary / backup 尚未配置，但 Workspace 没把“当前无人值班”作为首要运行状态。 | 未配置 duty 时在 Workspace 与 Settings 明确显示“无人值班 / 尚未开始审阅”及配置入口；不得把系统 thread 归口误写成已有具体猫接单，也不得自动猜 owner。 |

语义与审阅责任明确分工：

- **F278 raw inbox**：primary / backup 值班猫逐条查看原始 evidence，并为每条 signal 签署 disposition。
- **F245 periodic clustering / verdict**：`eval:friction` 当轮执行猫审阅周期聚类与 verdict；该结果只辅助排序和发现模式，不代替 F278 逐条审阅。
- **未来 live semantic suggestions**：机器只产候选分组；F278 值班猫确认分组是否成立并逐条签署 disposition。未真实接入、未暴露 provenance/health 前，UI 不得宣称该能力可用。

附加可用性：刷新后若有新 signal，显示“新增 N 条”并允许一键回到最新位置，避免 operator 在翻页时静默错过新到项。

本 correction 不新立 feature、不改变 canonical source / append-only ledger / 猫签 disposition / F128 路由边界。它修正的是 F278 已承诺的 live journey，使“全部可见”同时成为“现场可发现、时间语义诚实、责任状态看得懂”。

### Phase E — Contextual Bundle & Duty Activation Correction

- contextual bundle read projection：message → turn invocation → legacy invocation → single signal；
- O(1) bundle confirm + O(exceptions) split，逐 signal CAS fan-out，不新增 bundle ledger；
- server-owned typed capture + bounded legacy parser corpus；保留历史合法正例并明确 ambiguous/contaminated，不用 Markdown stripping 猜意图；
- Workspace bundle-first、原消息聚合 dock、Settings 只留 duty config + compact audit/deep link；
- unconfigured duty system-level fail-loud；
- `route_pending → routed` 读取 F167 custody / owner ack；
- operator 重启后配置 Primary/Backup，并用真实 backlog 完成首批运营验收。

### Phase F — Business Responsibility & Auditable Duty Receipt

- list 为每个 bundle 返回服务端签名的 exact membership snapshot；confirm 不再按实时 source context 重建成员；
- 在 disposition event 之上派生 `unreviewed / bound_in_repair / signature_waiting / blocked / terminal` 五态责任真相，并在读取时复验 active lease 与 pending proposal 后暴露 valid-exit evidence；
- source=owner 与 source=signer 解耦：source 可成为 verified repair owner，但 exact terminal candidate 必须由独立 signer 签署；首选 signer 中断不锁死恢复；
- duty watermark 持久化每班 snapshot，delivery/wake 只推进到 `awaiting_receipt`；逐 bundle valid exit 后将同一 durable notice 更新为 rich checklist receipt，再 complete；
- Workspace、原消息 bubble 与筛选器消费 responsibility projection，旧 `routed` 不再被误算为业务完成；
- 不重启 runtime、不访问 Redis 6399、不做 production activation；live truth 继续标为 dormant，等待合入后的独立激活步骤。

### Phase G — Production Acceptance Correction

- 失效 task/lease 的历史 `fix` 事件保留审计引用，但 responsibility 回到 `unreviewed`；只有复验仍 active 的 exact binding 才计入 `bound_in_repair`；
- incomplete batch 也更新同一 durable notice，写入 danger card + 逐 bundle checklist；未覆盖项保持 unchecked，watermark 继续 `awaiting_receipt`；
- scheduler 在唤醒 duty cat 前先把 batch 推到 `awaiting_receipt` 并幂等 reconcile，使 usage-limit / restart 不能阻止收据落地；机器预写明确标为收据维护，不冒充审阅猫；
- scheduler 可在旧 batch 已全部取得合法出口时写 success receipt 并完成 watermark；这表示机器已复验业务终态，不表示当班猫亲自签过本班；
- 不新增状态机、SOP、thread 或用户管理面；不触碰 Redis 6399，production 生效仍需合入后的显式 runtime activation。

## Acceptance Criteria

### A — Completeness

- [x] AC-A1: parser 重放、顺序变化、同文 marker 与 parser 演进不会错挂 disposition。
- [x] AC-A2: 语义聚类 degraded/失败时，所有 signal 仍逐条可见，确定性分组仍可用。
- [x] AC-A3: ledger 不持久化 marker 正文；source/digest mismatch fail loud。
- [x] AC-A4: full/overlap reconciliation 能证明 coverage 边界并暴露 unavailable/lag。

### B — Responsibility

- [x] AC-B1: system thread notice 不含 marker 正文，只含计数/年龄/inbox link/source refs。
- [x] AC-B2: automation、source cat 与未授权 actor 的非法 transition 被拒绝并有测试。
- [x] AC-B3: duty cat 可替换，系统 thread、ledger 与 aging 保持连续。
- [x] AC-B4: owner rejection/F128 rejection 可 reopen；`routed` 不显示为 fixed。
- [x] AC-B5: 50-item batch/bulk confirm 最终产生逐条猫签 disposition。

### C — Visibility

- [x] AC-C1: Workspace 实时展示所有 disposition 状态、actor、年龄、理由与目标。
- [x] AC-C2: 一行预览在读取时从 exact source message 解析；正文不进入 ledger/API cache。
- [x] AC-C3: 原消息、Workspace、Settings history 与系统 thread 投影来自同一 ledger/event log，且不存在第二个 disposition writer。
- [x] AC-C4: loading/error/empty/degraded/source-unavailable/72h breach/窄屏均有截图与确定性测试。
- [x] AC-C5: 89/day 基线下分页、筛选、提醒与 reconciliation 不丢 signal。

### D — Post-close Live Correction

- [x] AC-D1: Workspace live 默认最新优先，并可切换到最久未处理；新 signal 不需要翻到末页寻找。
- [x] AC-D2: original occurrence、inbox discovery / SLA age 与 backfill 身份在 UI/API 中语义分离。
- [x] AC-D3: 新 canonical marker 在正常 message append 路径下 60 秒内进入 inbox；reconciliation 仍能补漏且幂等。
- [x] AC-D4: grouping / degraded 文案与实际投影能力一致，不暗示不存在的 live semantic grouping。
- [x] AC-D5: primary / backup 未配置时，Workspace 和 Settings 都明确显示无人值班且不制造已审阅假象。
- [x] AC-D6: 最新数据到达时有可见提示，翻页中的 operator 可一键回到最新位置。

### E — Contextual Bundle & Duty Activation

- [x] AC-E1: read model 按 message → turn invocation → legacy invocation → single signal 稳定派生 bundle；thread 只作目录；每个 raw signal 仍可展开与定位。
- [x] AC-E2: Workspace/API 同时报告 raw 与 bundle 分母；bundle 无独立 store/writer/body copy，分页与轮询重建结果稳定幂等。
- [x] AC-E3: bundle confirm 对快照中的每条 `signalId + expectedSequence` 独立签事件；部分冲突可见，后来成员不会被追溯处置。
- [x] AC-E4: 新报告由 server-owned typed capture 明确意图；legacy parser 保留合法 inline/fenced/blockquote 正例，仅以确定性 provenance guard 排除 escaped placeholder / copied marker；ambiguous/contaminated 历史行可见且不静默改写，存量确认假阳性由值班猫签 `no_action(parser_false_positive)`。
- [x] AC-E5: 本阶段不接 semantic suggestion；UI 明确问题族数量不可可靠计算。未来若启用，只比较 bundle 并显示 provenance/health；degraded 不影响 deterministic bundle / raw visibility。
- [x] AC-E6: Workspace 默认 bundle-first 且 duty-unconfigured fail-loud；Settings 只保留 duty config + compact audit/deep link，不重复完整 history；原消息只显示一个可展开的聚合状态框。
- [x] AC-E7: transport receipt / 任意字符串不能完成 `routed`；只有 resolver-verified F167 active custody 可签 `fix`。task-backed implement 必须由真实 task 的 named owner 在 task thread 建立 `implement/task_done` lease；owner ACK 不替代 custody。
- [ ] AC-E8: 520/624 规模 cohort 已证明不丢 signal、raw/bundle denominator 一致；仍须 operator 从最新 main 重启 runtime，配置不同的 Primary/Backup，并走通一批真实 triage 后才允许重新标 done。

### F — Business Responsibility & Duty Receipt

- [x] AC-F1: 公共 list→confirm 使用 server-authenticated exact membership snapshot；confirm 期间 source hydration 变化不会让旧列表漂移，late members 不被追溯签署。
- [ ] AC-F2: 每个 bundle 派生五态 responsibility 与 `validExit`；transport-only `routed` 与失效 repair binding 均保持 `unreviewed`，只有 active exact binding 计入 `bound_in_repair`；UI、counts、filters 与原消息 bubble 使用同一投影。（Phase G code ready；等待 production 以同一真实 cohort 复验。）
- [ ] AC-F3: actionable bundle 只有 terminal、权威 store 复验仍有效的 owner/task/active lease、当前仍 pending 的 proposal 或 explicit blocker 才能完成本班责任；过期绑定保留历史 evidence 但重新进入 duty，可重绑或显式阻塞；recoverable signature request 保持 active，直到独立 signer 完成 exact candidate 或记录 explicit blocker。（Phase G code ready；等待 production 以同一真实 cohort 复验。）
- [x] AC-F4: source cat 可作为 verified repair owner，但不能 terminal-sign 自己的 signal；持久化 exact candidate 与 signer exclusion，preferred signer / Backup 中断后可由其他合法 signer 恢复。
- [ ] AC-F5: duty delivery/wake 不完成 watermark；complete 与 incomplete 都更新同一 durable notice 的逐 bundle rich checklist，只有全部 checked 才 complete；scheduler-owned reconcile 在 duty invocation 失败时仍能留下 danger receipt，未完成 batch 不被新 watermark 覆盖。（Phase G code ready；等待 production 以同一真实 cohort 复验。）
- [x] AC-F6: 真实 `112876b3` failure mode 有 RED→GREEN 回归；focused API/MCP、shared contract、Web 全量与 isolated Redis 6398 DB 15 均有 fresh green evidence。
- [x] AC-F7: operator 已显式重启 production runtime 并激活真实 duty；2026-08-10 首班 production 验收发现 Phase G blocker，证明 activation gate 已执行但 feature 尚未完成。

## Key Decisions

| ID | Decision | Why |
|---|---|---|
| KD-1 | 新建 F278，不 reopen F245 | 责任对象、writer 和用户旅程均是新能力 |
| KD-2 | 系统 thread 持责，猫可替换 | 责任不绑定模型额度或单一 session |
| KD-3 | Workspace live、Settings history | 现场看见与完整审计各归适合的 surface |
| KD-4 | source message body SoT | 避免重复计数、漂移和 marker 邮箱化 |
| KD-5 | clustering never gates review | 语义质量不能决定证据是否存在 |
| KD-6 | 先完成 Design Gate 再写代码 | 本功能改变责任边界、状态机与用户 surface |
| KD-7 | bundle 是 read projection，不是第三本 ledger | 降低重复阅读，同时保留 per-signal exactly-once 与单一责任真相 |
| KD-8 | message / invocation 是确定性 context；thread 只作目录 | 同 thread 可含多个问题，不能用 thread 粗暴自动合并 |
| KD-9 | semantic layer 后置且可 sunset | 没有真实值班 consumer 时不为不确定效用建 Eval Hub 仪式 |
| KD-10 | routed 读取 F167 custody truth | transport 成功不等于 owner 接单，F278 不重造第三套 custody |
| KD-11 | 新报告走 typed capture，legacy parser 有界兼容 | 相同字节可能既是教学示例也是真实报告，不能靠 Markdown 位置猜意图或删历史 |
| KD-12 | responsibility 是 event log 的纯读业务投影 | disposition 事件保留历史语义，surface 不再用事件名猜责任是否已完成 |
| KD-13 | list snapshot 由服务端签名并在 confirm 验证 | confirmation 消费用户实际看过的成员，source hydration 变化不能改写审阅集合 |
| KD-14 | repair owner 与 terminal signer 分离 | owner 可以等于 source；独立签署约束只排除 source signer，且不能依赖单个 Backup invocation |
| KD-15 | duty completion 以 durable rich receipt 为准 | messenger delivery 只证明信使成功；逐 bundle valid exit 才证明本班责任完成 |

## Review Gate

- 初轮非作者架构审视：Fable 5，HOLD（`0001785056199848-000099-17b86217`）。
- B1–B5 补齐后 spot-check：PASS（`0001785056890878-000123-bd34b08b`）。
- 本次新增“系统 thread 持责 + Workspace 实时 surface”是产品 delta，须由非作者复核后进入实现。
- 实现 exact-HEAD review：GPT-5.4 在 `056a217f0` 提出并复验两项 P1，最终 APPROVE（`0001785118226652-000421-046a0fb6`）。
- latest-main rebase continuity：14 个作者 commit patch-equivalent，独立 F152 composition-root 增量无 F278 symbol/hunk 交集，`pnpm gate` 在 `99b31c62` 全绿。
- 完成愿景守护：Terra 对 Workspace live、系统 thread duty、Settings history 与原消息状态逐项验收，PASS（`0001785122495627-000472-dc54cc2a`）。
- post-close correction exact-HEAD review：GPT-5.4 对 `e87cbbfd8aca6b0ff7d965850a74b83388023e08` APPROVE，无 finding（`0001785195165254-000335-df9b0bbf`）。
- post-close correction 愿景守护：Opus 4.7 对 AC-D1..D6 与真实容量主旅程逐项验收，PASS（`0001785196231738-000344-f6ea2450`）。
- contextual bundle / duty activation 设计复核：Fable 5 认可 read-side bundle、unconfigured fail-loud、F167 custody evidence 与“bundle 先行再点火值班”的收敛方向（`0001785418302678-000173-0b5b8bd2`）。
- Phase E docs content review：Fable 5 对 bundle 纯读投影、O(1)+exceptions、duty fail-loud、F167 authority 与无第三 ledger/eval 域逐项 PASS（`0001785419651028-000210-65a308b8`）。
- Phase E implementation exact-HEAD review：Kimi 对 PR #3303 `229f339982c5646b8ccd45a436f3abec2e3f2514` APPROVE；reconciliation、strict parser、bundle fan-out、duty/F167/UI 均无阻塞 finding（`0001785429107743-000571-ce98a056`）。
- Phase E post-merge vision guard：Opus 4.7 对 AC-E1..E7 PASS；AC-E8 明确保留为 operator activation gate（`0001785429890132-000581-1dbbd163`）。
- Phase F 独立 review gate：唯一 reviewer 为 Opus 5；必须 exact-HEAD APPROVE 后才能进入 merge-gate，不追加第二轮 cloud AI review。合入不等于 runtime activation。
