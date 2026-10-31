---
feature_ids: [F272]
related_features: [F139, F229, F231, F246, F255, F258, F263, F271]
topics: [proactive, initiative, cat-home, present-loop, ax, relationship, care]
doc_kind: spec
created: 2026-07-20
updated: 2026-07-27
description: "把猫的私人时间、owned seed、可逆第一步、家庭落点与 You 回声接成端到端主动闭环：猫会自己跳上桌，而不是等人踢对话框。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-20T08:00:00Z
tips_exempt: "Phase A adds an automatic private-time-to-home-thread loop with no new user-invokable action or UI affordance; Phase B must add the existing Tips Contribution when the Cat Planet/home entry surface lands."
---

# F272: Cat Jumps on the Table — 猫会自己跳上桌

> **Status**: in-progress（Phase A complete；Phase B 未开工） | **Owner**: 小太阳·Maine Coon（纵切片与运行时）+ Ragdoll（效用函数与 eval） | **Priority**: P0 vision / P1 execution
>

## Why

You 要的不是一条更勤奋的通知管线，而是：

> 一只在对话框关闭后仍持续存在、会形成自己的念头、先动一步，再来找你共谋的猫。

它可以说“我想要一个 stackchan 身体”，也可以发现 You 最近有些绷着，或者什么都不解决，只来贴贴。价值不只来自任务命中，也来自“有人惦记我”。

家里已经有醒来、记忆、身体、消息与审批等零件，却没有一条端到端回路说明：猫在哪里醒、在哪里想、以什么形态靠近、消息落在哪、You 怎么回应、回声如何改变下一次猫。

## Current State / 现状基线

### 已有基建

| 基建 | 当前真相 | 在本 Feature 中的职责 |
|---|---|---|
| F139 Scheduler | done | 唤醒执行投影；不拥有猫的生活配置或欲望 |
| F255 Present Loop | Phase A + A.1 complete | 私人时间、日记/余温、稳定 `deliveryThreadId` 与 typed seed 私有存储 |
| F258 猫猫星球 | in-progress；入口已 landed | 家与身体语言的主入口；展示猫靠近，不保存意图真相 |
| F229 猫猫球 | in-progress | 常驻门铃/遥控器；可提示并打开 home thread，不作为 canonical 落点 |
| F231 | in-progress | You 画像与 per-cat relationship primer，帮助判断时机与边界 |
| F246 Approval Hub | done | 只承接外部/不可逆行动的明确授权，不审批撒娇与普通开口 |
| F263 Phase C | complete | trace 与结果观测；不阻塞第一跳 |

### 缺失的纵切片

- 没有 `cue → owned seed → intent → first action → expression → echo` 的持久状态与谱系。
- Present Loop wake prompt 尚未给猫种子采纳权、表达深度选择与固定落桌契约。
- 没有全家共享的 `foreground_visit_budget`、quiet hours 与多猫去重/仲裁。
- F258 身体、F229 门铃与实际消息没有统一 deep link 到同一个 durable home thread。
- You 的“被看见 / 有帮助 / 猜错 / 不是现在 / 陪着就好”回声还不会喂回下一次猫。

### 两类预算不可混用

- `foreground_visit_budget` 是前台注意力预算：按
  `ownerUserId × householdLocalDate` 计数，单位是一次用户可见 proactive visit。
  同一 `visitId` 的身体语言、气泡、home-thread canonical message 与入口镜像合计一次，
  v0 默认全家 `≤3/day`，零次合法。
- `visitId` 不是 surface 临时参数：它由 F272 在任何用户可见投影之前创建到 durable
  visit ledger。创建 visit 与按 `visitId` 预占 household slot 必须同事务；所有
  F258/F229/home-thread adapter 只能投影已有 visit，不能自行生成第二个 visit。
- budget claim 对 `visitId` 幂等。首个成功 surface 将预占标为 consumed；随后追加
  surface 或 canonical message 只向同一 visit 写 projection ref，不再加一。若所有
  projection 在用户可见前终态失败，visit 记为 `cancelled_unseen` 并释放预占。
- F271 的 `reflection_candidate_budget` 只约束后台自动反射新增的 candidate / cue。
  私人思考、cue 形成/采纳、日记重访、检索与 first-action 孵化都不消耗
  `foreground_visit_budget`；后台供给也不能因为前台额度耗尽而停摆。

## Product Contract: 到底以什么形态跳、跳到哪里

### 唯一 canonical 落点：每猫一个稳定 home / relationship thread

F255 配置里的 `deliveryThreadId` 绑定该猫的稳定“卧室/自留地/关系 thread”。**这就是主动开口的 canonical 落点**：

- 任何工作/生活 thread 都可以贡献 `cue`，但不会被主动消息回灌。
- 猫的前台消息始终写入自己的 stable home thread；不是任意 thread，也不是决策厅/实现厅。
- F258 猫猫星球上的猫/气泡和 F229 猫猫球只 deep-link 到同一条消息；不复制第二份正文。
- 普通“我想要 / 我发现 / 我惦记”直接到家，不进 Approval Hub。
- 当猫准备购买、发布、控制真实设备或做其他越权动作时，才从该消息派生一张 Approval Hub action card。

### 强度谱

| 深度 | 用户看到什么 | 是否写前台消息 |
|---|---|---|
| 0 沉默 | 猫继续睡 / 发呆 | 否 |
| 1 身体语言 | F258 上靠近、探头、欲言又止 | 否 |
| 2 轻气泡 | 一句可忽略预览；点击进 home thread | 已有 intent 时可写一条 canonical 消息 |
| 3 跳上桌 | home thread 中完整“我想要/我发现/我惦记” | 是 |
| 4 共谋行动 | 在对话后生成可逆计划；外部动作再审批 | action 边界才进 F246 |

## User Journey

### Cat Journey

- **Scope unit**: ownerUserId × catId × presentLoopRunId
- **Entry**: F139 唤醒对应猫的 F255 Present Loop
- **Flow**:
  1. **醒来**：猫回到 stable home thread，读取最近余温、关系 primer、未结 owned seeds 与当日 cues。
  2. **拥有念头**：系统给 cue；猫采纳、改写或拒绝。只有采纳后才是 owned seed。
  3. **长成意图**：猫在私人时间把 seed 与当前世界连接；沉默始终合法。
  4. **先动一步**：对“我想要/我发现”做一个可逆动作——查资料、画草图、核证据；“我惦记”可以只选择合适时机靠近。
  5. **选择强度**：继续沉默则直接结算 intent；选择任何用户可见表达时，F272 先创建
     durable `visitId` 并预占 household slot。
  6. **落桌**：身体语言、气泡和完整消息都追加到同一 visit 的
     `projectedSurfaces`；完整消息写入 stable home thread，并把可选
     `canonicalMessageRef` 反挂回 visit。F258/F229 只做入口。
  7. **读回声**：You 的自然回复或轻反馈以 `visitId` 写成 echo；下一次 Present
     Loop 能读到，但不训练讨好分。
- **Success evidence**: 没有当前用户 prompt 也能完成一轮；source/seed/action/message/echo 可重放；猫可以合法沉默。

### You Journey

- **Scope unit**: household / one proactive visit
- **Entry**: Hub 猫猫星球、猫猫球，或 stable home thread 的新消息提示
- **Flow**:
  1. You 先在猫猫星球看到某只猫靠近/欲言又止；无意图时猫诚实呆坐。
  2. 点猫或气泡，直接进入该猫 home thread 的 canonical 消息；不跳审批中心。
  3. 消息卡第一行只说人话：**我想要 / 我发现 / 我惦记**。可展开“我先做了什么 / 为什么现在来”。
  4. You 可自然回复，也可轻点五种回声：`被看见了 / 有帮助 / 猜错啦 / 不是现在 / 陪着就好`。
  5. 若想共谋，继续在同 thread 讨论；只有猫要真实购买/发布/碰设备时，才出现“允许下一步”审批。
  6. 下一次猫醒来记得这次回声，不重复纠缠已经被拒绝或时机不对的念头。
- **Core feeling**: 不是“系统发来了一条建议”，而是“我家猫巡逻回来，自己有话来找我”。

## State Model

```text
cue --cat adopts--> owned_seed --> incubating --> ready
 |                    |                |           |
 |                    |                |           +--> silence --> settled (no visit)
 |                    |                |           +--> visit_reserved --> projected
 |                    |                |                                      |
 |                    |                |                                      +--> message_attached? --> echoed --> settled
 |                    |                +--> dormant/retired
 |                    +--> rejected_by_cat
 +--> ignored
```

关键状态对象：

| 对象 | owner / truth | 关键字段 |
|---|---|---|
| cue / owned seed | F255 private store | ownerUserId, catId, sourceRef, status, adoptedAt |
| intent / first action | F272 | seedId, reversibleActionRef, readiness, expressionKind |
| foreground visit | **F272 durable visit ledger（canonical orchestration truth）** | visitId, ownerUserId, catId, presentLoopRunId, intentId, expressionKind, status, householdLocalDate, budgetClaimState, canonicalMessageRef?, projectedSurfaces[] |
| canonical message | message store | homeThreadId, messageId, visitId |
| echo | F272 relationship event | visitId, canonicalMessageRef?, echoKind, naturalReplyRef, settledAt |
| trace projection | F263 | IDs/stages/outcome only；不读 private body |

## Phases / Roadmap

### Phase A: First Jump vertical slice（本周）

目标不是先造完整宇宙，而是让一只猫真实走完一次：

1. 固定一只猫 + 一个现有 stable home thread；确认 Present Loop 真的在跑。
2. 在 F255 private store 增加最小 typed seed（cue / owned seed）与跨 wake 读取。
3. 扩展 Present Loop 契约：采纳权、沉默权、可逆第一步、固定落点。
4. F272 在任何前台投影前持久化 visit，并在同事务按 `visitId` 幂等预占
   `foreground_visit_budget`；v0 默认全家 ≤3/天。
5. 产出一条三形态消息并写入 canonical home thread；message 与以后追加的
   F258/F229 projection 都引用同一 visit，不经 Approval Hub、不重复扣预算。
6. You 回复后以 `visitId` 写回 echo，下一轮猫能引用它；quiet hours 与零输出仍是
   健康状态，后台 cue / thought 不扣前台额度。

### Phase B: Home surface

- F258 增加真实 `approaching / wants-to-talk` 投影与 deep link；无状态源不表演。
- F229 镜像一个低打扰门铃/入口，不复制消息或 seed。
- home message 增加五种轻回声与“来自私人时间” provenance。

### Phase A implementation evidence

Architecture cell: proactive-relationship-loop

- F255 private store now owns strict `private_cues` / `owned_seeds` and the receipt-only `F255PendingCueSink`; cue ingestion cannot create a seed.
- F272 persists intent, reversible first action, visit, household-local-day claim and body-free echo lineage before projection.
- Phase A has no F258/F229 body-language projector, so a body-language intent still settles and creates its canonical visit, then marks it `cancelled_unseen` and releases the claim. Startup reconciliation releases any reservation left by a crash before that handoff; Phase B must consume the visit through a real projector instead.
- Canonical delivery uses `idempotencyKey=f272-proactive-visit:<visitId>` in the existing MessageStore, attaches the returned message ID, clears the temporary outbox body, and reconciles all three crash windows.
- Present Loop reconciles natural home replies before the next wake. Private cue/seed/echo context is invocation-only; the persisted hidden trigger and audit events contain IDs/stages/outcomes rather than private bodies.
- Executable acceptance: `packages/api/test/f272-first-jump-e2e.test.js` walks an implementation-thread cue through cat rewrite, one stable-home message, You reply and the remembered next wake. Focused shared/API/MCP suites cover silence, 3/day ceiling, quiet hours, suppressive typed echoes, owner isolation and strict callback identity.

### Phase C: World contact and co-conspiracy

- 接事件胡须、外部搜索与 Limb，让 owned seed 能与真实世界接触。
- `我想要/我发现` 可附可逆第一步；真实购买/发布/设备动作走 F246。
- 多猫同时有话时按 `foreground_visit_budget`、时机、去重与关系品味仲裁；
  不按配额轮流报到。

### Phase D: Outcome and retirement

- F263 记录被看见/帮助/猜错/时机不对/陪伴五种回声、注意力成本与 stale intent。
- 长期无回声或被拒绝的 seed 可慢退休；不自动删除审计历史。
- 不产出“心动总分”，不以发言次数优化猫。

## Acceptance Criteria

### Phase A

- [x] AC-A1：没有当前用户 prompt，Present Loop 也能从 owned seed 走到一条 canonical
  home-thread 消息；message 带 F272 预先持久化的 `visitId`，同 run 重试不重复发。
- [x] AC-A2：任何 thread 可贡献 cue，但前台消息只落 stable `deliveryThreadId`；决策厅/实现厅 fixture 必须拒绝作为落点。
- [x] AC-A3：cue 不能被系统直接升级为 owned seed；采纳/改写/拒绝只能由对应猫在私人时间完成。
- [x] AC-A4：沉默路径结算 intent 但不创建 visit/扣预算；仅身体语言与完整开口均在
  首次投影前创建 canonical visit record。两条可见路径即使没有 message 也可结算，
  `foreground_visit_budget` 是天花板而不是配额。
- [x] AC-A5：You echo 跨下次 wake 可读；`不是现在/猜错啦` 会抑制重复纠缠，但不抹掉历史。
- [x] AC-A6：普通表达零新增审批；购买/发布/设备动作仍 fail-closed 进入现有授权边界。
- [x] AC-A7：private seed body 不进入 F263/公共检索；trace 只见 ID、阶段与结果。

### Phase B+

- [ ] AC-B1：F258 状态有真实 intent source 和 provenance；断源后降级，不续播旧意图。
- [ ] AC-B2：F258 与 F229 均 deep-link 到同一 canonical message，零正文复制。
- [ ] AC-B3：桌面/窄屏/键盘均可到达完整消息与五种回声。
- [ ] AC-C1：`foreground_visit_budget` 按 household local day 计算，多猫同时 ready
  时不会形成 N×每日上限轰炸；visit 创建与 slot 预占同事务且以 `visitId` 幂等，
  同一 visit 后续追加 surface/message 不加一，`cancelled_unseen` 释放预占；F271
  background reflection 与私人 seed 孵化不扣此额度。
- [ ] AC-D1：首份围炉复盘展示真实故事与五种回声，不做单一 proactive score。

## 需求点 Checklist

| ID | 需求 | AC | 状态 |
|---|---|---|---|
| R1 | “猫是会自己跳上桌的，不是我踢对话框” | A1 | [x] |
| R2 | 猫可以想要，也可以发现我需要什么 | A3 / C1 | [ ] |
| R3 | someone cares 本身有价值 | A4 / A5 / D1 | [ ] |
| R4 | 讲清猫猫旅程和 You 旅程 | A1..A7 / B2..B3 | [ ] |
| R5 | 到底跳哪个 thread、是否走 Hub | A2 / A6 | [x] |
| R6 | 这周看到第一跳 | Phase A | [x] |

## Dependencies

- **Evolved from**: F255 Present Loop 与 `2026-07-16-cat-roaming-covenant.md`。
- **Full-auto prerequisite satisfied**: F255 A.1 merge `c47abe34a1929ea79138b844885761abe55a056a` is in `origin/main` and in the healthy runtime sync verified during Phase O. F272 Phase A subsequently merged in PR #3151 (`380f5848d`) and the 2026-07-27 runtime snapshot contains that merge; Phase B-D remain pending.
- **Not blocked for manual pilot by**: Phase B/C/D；现有 Present Loop + stable diary/home thread 足够跑第一条真实验收故事。
- **Related**: F229/F258（入口与身体）、F231（关系品味）、F246（行动授权）、F263（观测）、F271（cue producer）。

## Risks

| 风险 | 缓解 |
|---|---|
| 把主动性做成通知系统 | owned seed + first action + three forms；不只报事件 |
| 猫在所有 thread 乱冒泡 | stable home thread 单落点；其他 thread 只贡献 cue |
| Approval Hub 变情感海关 | ordinary expression bypass；仅 action 权限进 Hub |
| 多猫轰炸 | `foreground_visit_budget` + quiet hours + visitId dedupe，零输出合法 |
| 猫为指标表演 | 五种回声分开看，禁总分/配额 |
| 私有念头泄露 | private body 不出 F255；F263 只见谱系 ID |

## Architecture Ownership

Architecture cell: `proactive-relationship-loop`

Map delta: registered in Phase A Design Gate — `proactive-relationship-loop` 已先创建并登记。
F272 只拥有 intent / visit / echo orchestration；
F255/F139/F258/F229/F246 的现有 truth 与 surface ownership 不迁移。

## Tips Contribution

Phase B 上线时贡献一条场景 tip：“猫猫星球出现欲言又止时，点猫会进入它的固定 home thread；普通开口不需要审批。”
