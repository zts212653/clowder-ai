---
feature_ids: [F312]
related_features: [F152, F169, F200, F221, F227, F231, F255, F263, F271, F276, F282, F287, F296]
topics: [memory, proactivity, standing-reflex, recall, closure, orchestration, runtime-acceptance]
doc_kind: spec
tips_exempt: "Renewed at F312 close on 2026-09-03: the Feature changes internal memory routing, evidence and orchestration contracts; it adds no user-invokable action or UI teaching surface."
created: 2026-08-29
completed: 2026-09-03
description: "让记忆与主动性从分散能力变成可持续关账的责任田：按 lane authority 推进六段闭环，并由总控、执行与 runtime 验收三类线程持续驱动。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-03T16:00:00Z
---

# F312: Memory Initiative Closure Command｜记忆与主动性闭环责任田

> **Status**: done | **Completed**: 2026-09-03 | **Owner**: 小太阳·Maine Coon（@codex-sol, GPT-5.6 Sol）+ F312 总控线程责任猫 | **Priority**: P1

## Why

咱们已经有记忆架构、Standing Reflex 合同、cue plane、写入 census、RecallFrame 和可执行缺口账，
却仍需要operator反复追问“下一步谁驱动、runtime 重启后谁验收、验收失败回到哪里”。结果是局部能力可以
合入，但整条 `写入 → cue → 送达 → 采用 → 结果 → 失效` 没有一个持续持球到闭环的责任田。

operator 在 source message `0001787997519472-000359-da96b72a` 冻结了新的执行方法：

1. **指挥与理论线程**负责愿景守护、发车、消费终态证据和继续驱动；线程里的责任猫不能只给建议后离场；
2. **各 Phase 执行线程**各自持有一个有边界的 owner carrier；
3. **runtime 重启后的验收 Phase**用真实旅程验收，不能拿 main、fixture 或审批卡冒充 live closure。
4. 自 Phase C 起，**一个 Phase 只使用一个 execution thread 和一个 PR**；Phase 内的 lane 纵切以多个语义 commit
   收口，不再按 lane 拆成一堆 PR。Source：`0001788319716879-000253-31b1a457`。

F312 把这套方法变成可执行 Feature，让operator可以放心不盯，而不是继续当人肉调度器。

## Current State / 现状基线

当前数字取自 Phase G 独立终验重新生成的 closure catalog；F312
kickoff baseline 是 12 missing / 49 RED，F152 terminal 后是 11 / 43，实时真相始终回源
[`memory-architecture-closure.generated.md`](../architecture/memory/memory-architecture-closure.generated.md)：

| 项 | Phase G terminal truth | 判读 |
|---|---:|---|
| lane-owned surfaces | 21 | universe 已 set-equality，不能删行来“变绿” |
| active | 10 | 只代表这些 surface 的声明与证据已过当前合同；runtime ceiling 仍按 lane 单列 |
| typed-cue exempt | 10 | 合法不出生，不是欠施工；Phase F 又确认 Library 的主动三段与 Provider-local 聚合面没有合格 named consumer，保留各自既有 authority 后退出 |
| sunset | 1 | F152 consumer surface 已由 operator 裁决退出 generic delivery，producer/forensic 证据保留 |
| missing surfaces | 0 | 21 条 surface 均已有 evidence-backed `active / exempt / sunset` disposition；没有删 surface 变绿 |
| exact RED keys | 0 | strict closure gate 与 Phase G 独立 runtime acceptance 均已通过；coverage 与运行证据仍分栏保存 |

已经落地但不能读多：

- F282 拥有 write-side proactive producer；F287 拥有 RecallOpportunity/cue lifecycle；F200 拥有 recall/outcome
  观测与机制选择；F276/F296 及各 lane feature 拥有自己的 canonical authority 与 runtime 合同。
- F312 **不取代这些 owner**。它只拥有跨 lane 的完成定义、release 顺序、终态核验、runtime acceptance 与
  roadmap 关账。
- `lessons-learned` 和 `skill` 两个 carrier 已关闭；一张 Person 审批卡只证明观察、候选和呈现，不证明
  owner 裁决、canonical revision、后续独立 recall、applied outcome 或失效。
- F169 是已完成的早期 Agent Memory Reflex 愿景；它不是本轮 21-surface closure 的当前 execution owner。

## Architecture Admission

Architecture cell: memory

下游关系循环见 `proactive-relationship-loop`。
- **Map delta**: 更新既有 `memory` cell 的 source-map、Standing Reflex、write-lane census 与 closure catalog；
  F312 仍是薄的 integration/acceptance owner，不新增 owner cell、拓扑、store、router、中央 cue engine、统一 Hub、
  mutable registry 或 canonical authority。
- **Canonical truth**: Standing Reflex contract + generated closure catalog + 各 lane feature/authority。
- **Claim guard**: `pnpm check:memory-architecture-catalog` 与 `pnpm gate:memory-architecture-closure`。
- **Consumer evidence**: 21=21 universe、每个 RED key 的 ownerRef/nextAction、每次 release 的 exact catalog delta。

## Current Command State

| 字段 | 当前真相 |
|---|---|
| Current release | ✅ Phase G terminal：独立验收 thread `[thread-id]` 已复核 21=21 / RED=0、两条异权完整 episode、prompt-shape、no-eval 与 meta-method 边界，并给出 `Vision Guard PASS`。 |
| Durable task | `0001787998012562-000377-a8cfce90` · `done` · owner `codex-sol`；关闭理由绑定 Phase G exact evidence 与 CloseGateReport |
| Workflow projection | 本 thread 从未有可回读的 canonical WorkflowSop：reader=404，owner invocation 更新=403 `strict_owner_auth_required`。早期“Mission Hub workflow vN”只是错误文档声明，已从 AC 删除；责任连续性实际由 durable task、F312 spec 与 generated catalog 承担。该独立 harness 缺口已以 source ref 投给 F275 owner thread，不阻塞 F312 产品价值关账。 |
| Phase A exit | ✅ spec/BACKLOG/Atlas/roadmap 已在 `main@25f9f0046`；direct-docs 与 catalog/architecture 门禁通过 |
| Phase B · Person | ✅ F296 continuity/presentation substrate 已终态：PR #4040/#4149/#4162 均 merged，merged-main Alpha 与 production 已加载 exact revision `80e3b50a11ac17e2922d728caf21fe6bc54b5057`。在后续独立 owner query `[thread-id]#0001788330028612-000493-e99ad30d` 中，runtime 呈现吴浪 `subject_seen` cue；消费猫 drill 到 F276 canonical Person revision `sha256:7b7bd7a4c96a0ae8bd9c49393aa465c7e9565a43d453744abf6165e27636599b`，据此给出仅回答 Growing 贡献的 bounded response，并正式记录 `applied`。同一 invocation 在五分钟后重放原 opaque handle 得到 `410 expired`，形成 expiry invalidation negative；没有修改 Person truth，也未借用 correction/forget authority。 |
| Phase B · F152 | ✅ PR #4077 / `main@cddb57dda8` 已关闭 `global-distillation-f152` surface；writeCapture 按 producer 实证纠正为 implemented，其余 consumer/delivery/invalidation 维度写 sunset；`search_evidence`、`graph_resolve` 与 `list_recent` 停止送达 `distilled:` anchors，producer、retained artifacts 与显式 forensic/admin browse 保留。catalog 49→43、missing surfaces 12→11 |
| Phase C exit | ✅ Profile + Event terminal：PR #4222 merged `21196f0c73`；Alpha 实测暴露的 Event prompt-budget RED 由 PR #4237 merged `6f0d6b5f3a` 修复；merged-main Alpha `c72b89139c` 已完成真实 Event `presented → drilled → applied → source_forgotten` 旅程。Profile 诚实停在 loaded/no-candidate。 |
| Phase D exit | ✅ 唯一 Phase implementation PR #4252 squash-merge 为 `24b0093f016be31ab65d25e4a917050830a7ceed`，Terra 审阅 exact HEAD `03b8cd0a8ebac6b8b503ecaf1da38d249fe224d6`，P1/P2=0。两条仅在前序 merge 后的 Alpha 才可观察的独立 production RED 分别由窄 follow-up #4264（merge `89d9722b3ce378db63d1b37c8cc5c53cf342916b`，reviewed patch `4480b299bd47017a97ace1f9e4b6aa29d1cb7bda`）与 #4267（merge `b3256dac8490e34efe18498ed82bf3841b5c820a`，reviewed `33776c2b7ae294733e13309ecba4254cd4f9d4d2`）修复。Merged-main Alpha 已完成 Decision `ADR-020` 与 Project Knowledge `F312` 的真实 `presented → drilled → applied`；Method E0=`exempt`。catalog 21=21、RED 36→27、missing 9→6。总控独立 vision guard PASS。 |
| Phase E exit | ✅ Terra 对 substantive HEAD `89600a32f2364068a97a3a69af7d55455c2d4812` APPROVED，并对 docs-only final HEAD `84025a22df0f4ec43a8d80b68d505f66a2470dcd` 给出 continuity APPROVED；唯一主 PR #4277 merge `ee6d72d5e653f8601f50f235a7a24bfd899ac2e8`。Merged-main Alpha 加载该 exact merge、`/ready` 全绿、F255 Present Loop ready 且 V43 `consumer_cat_id` 存在；真实 `codex-sol` owned Seed candidate 存在，但 03:00 自然 wake 已错过，正式 schedule API 按 F255 治理拒绝通用 manual trigger，因此 ceiling 为 `loaded/candidate-present/no-eligible-trigger`，`cat_owned_seed` receipt 保持 0，不造 presentation/outcome。无 Alpha-only production RED、无 follow-up PR。Generated catalog 21=21、RED 27→11、missing 6→2。 |
| Phase F exit | ✅ 唯一主 PR #4281 的 authored HEAD `e28f1f514e4d4d50948b8edb89c8234f4e791bc3` 经 Opus 4.7 非作者架构 review APPROVED，`pnpm gate --risk contract` full gate 通过，squash-merge=`e83ae64b822ace1415a0ba119374586bf4161b47`。Library 保留 F186 collection/catalog/source-revision/ACL authority，主动 cue/receipt/outcome 因无 named consumer 合法 `exempt`；七个 provider carrier 各自保留 provider-native authority/correction/delete/retirement，Standing Reflex 聚合面同样 `exempt`，无内容复制或中央 store/cue engine。Merged-main Alpha exact merge 上 API `/ready`、3011、closure gate 与 catalog 16/16 全绿；因两条 lane 均无 active pair，ceiling=`loaded/no-candidate/no-receipt/no-outcome`，无 Alpha-only production RED。Generated catalog 21=21、active 10 / exempt 10 / sunset 1 / missing 0，exact RED 11→0。 |
| Phase G exit | ✅ 非作者 Terra 在 `[thread-id]#0001788487647377-000084-9a701316` 独立复跑 catalog 16/16 与 strict closure gate。Event 与 Decision 两条 canonical authority 均完成 `presented → drilled → applied → source_forgotten`；non-match 为 0 lane payload，match 各只有一条 457/456-byte bounded cue，resume 为 0/`no_reservation`。G1/G2 分别归确定合同与 runtime traces，缺 utility consumer/出生证故明确 no-eval。Vision Guard PASS。 |
| F312 production RED · Entity Nudge | ✅ PR #4097（reviewed HEAD `91b31752530811191c8d3d1b569a2cc2f35e7f73`，merge `4a3b90adc856b2114952e52725ab6f51588432c4`）已在 Alpha `main@124c9ae4c565bd01911e54bdda882ccf8b4f3204` 验收：同一 source 的 `codex-sol` 与 `opus` 各有一份 exact prompt 和一条三坐标完整的 delivered ledger；各自重放后才各自进入 cooldown。原始 家属喵/未婚喵 与 fable-5 不在该 Alpha 数据/配置中，故这是实际 direct-entity path 的 UAT，不冒充原 subject-pair replay。 |
| Next release | 无。F312 已 terminal；未来只有某个 exempt/sunset surface 出现新的 named consumer + immutable revision + authorized drill 时，才由该 lane owner 单独重跑 E0，不重启全局迁移。 |

## What

### Phase A: Command Plane Freeze｜总控与真相面冻结

建立 F312 Feature、BACKLOG 入口、roadmap 当前执行权和 durable task。总控只保存“当前 release、
终态证据、下一棒与阻塞”，不复制 generated missing state，也不替 lane owner 写实现。

### Phase B: Release 1｜Person production + F152 qualification

先解除两类最大公共不确定性：

1. F276/F292 production bridge 在 merged-main runtime 重启后跑完 owner 裁决、canonical materialization、
   独立 recall、`applied|dismissed`、bounded outcome 与 correction/forget/expiry 失效；
2. F152 global distillation 必须给出 evidence-bound named consumer，或选择 sunset。producer/36 份产物存在
   不能替代 consumer 出生证。

### Phase C: Release 2｜Profile + Event 两条异权纵切

Profile 与 Event 使用共同六段 closure 语言，但保留各自 authority、predicate、时效与失效语义。至少一条达到
重启后 Alpha/UAT；另一条可停在诚实的 main/fixture ceiling，不能为整齐造假绿。

### Phase D: Release 3｜Decision + Method + Project Knowledge

复用 revision-bound receipt transport，分别以 ADR、Method/Skill、Project Knowledge 的 canonical owner 为准。
搜索命中或 presented/drilled 不能冒充 applied；consumer 不明确时允许 exempt/sunset。

E0 冻结后的 candidate contract：Decision 只对 owner 当前任务唯一 accepted ADR 生效；Project Knowledge
只对 workflow-bound feature（或无 workflow 时 owner 当前消息唯一 F-ID）生效；两者的 `applied` 都只描述
当前 response/action 的实际采用，不做总分或单条因果归因。Method canonical 目录没有已发布卡片和 named
consumer，因此在 catalog 中合法标为 `exempt`，不为 closure 表格制造 active detector、receipt 或 eval。

### Phase E: Release 4｜Diary + Episode + Reflection + Cat-owned Seed

先做 authority/consumer 资格门，再给保留者补 cue、receipt、outcome 与 revision/delete/supersession 失效。
第一人称产物、暂存假设和 owner-confirmed truth 不得被压成同一种审批权。

E0 冻结后的 candidate contract：Diary 的 `/starry` pull reader、Episode template/fixture 与 F271 reflection
producer 都不是 invocation consumer，因此三面合法 `exempt`，不出生 detector、receipt、outcome 或 eval。
Cat-owned Seed 由 producing cat 的 scheduled Present Loop 消费；predicate 精确绑定 owner/cat/seed/source
revision，prompt content-free，`applied` 额外要求同 invocation/cat/seed intent。任何跨猫、revision/scope/status
drift 都 fail closed；Seed 不获得 owner/person/team truth authority。

### Phase F: Release 5｜Library + Provider-local

处理多 collection/provider 的 authority、ACL、隐私和失效边界；没有安全通用读链的 provider-local memory
可以保持 exempt/sunset，不因 strict gate 压力创造第三真相源。

### Phase G: Runtime Acceptance + Vision Guard｜真实验收与关账

每个影响 runtime 的 release 合入后，必须在最新 merged main 重启 Alpha/目标 runtime，再由独立验收 Phase
验证真实用户旅程和负向失效。验收线程不顺手修代码；失败 finding 回到对应 owner execution thread。
总控消费终态后更新 F312、roadmap 和 durable task，再发下一 release；Phase G 后则直接关账。

## Three-Thread Operating Model｜三类线程运行法

### 1. Command / Theory Thread｜指挥与理论线程

当前 canonical command thread 为 `[thread-id]`。在该线程里接过 F312 球、更新过 command
state 或参与 release 判断的猫都是**责任猫**：共同守住愿景并主动推进下一状态迁移，不能把“等operator再问”
当停止条件。

它只做五件事：

1. 读取 generated truth，选择下一 release；
2. 把 carrier 投给真实 lane owner，不接管其 authority；
3. 核验 execution thread 的 terminal packet，而不是消费进度表演；
4. 发起并消费 runtime acceptance；
5. 做 vision guard、同步 feature/roadmap/durable task，然后继续发车或关账。

### 2. Phase Execution Thread｜各 Phase 执行线程

一个线程只拿一个 bounded carrier，或一个 Phase 内不可拆的 lane 组合。默认 final-only；普通施工 chatter 不回灌
总控。自 Phase C 起，release topology 固定为 **one Phase = one execution thread = one PR**；Profile/Event 等
lane 在同一 feature worktree/branch 内用多个语义 commit 分段，最终只对 Phase 的 exact HEAD 做一次完整合入判断。
runtime acceptance 仍可使用独立验收线程，但不因此新开 implementation PR。终态 packet 必须包含：

- exact reviewed HEAD、PR/merge SHA 与 main containment；
- generated catalog before/after，明确 removed/added RED keys；
- `docs-only | fixture | main | live | UAT` 证据 ceiling；
- runtime loaded 与否、负例、unsupported claims、cleanup truth；
- 下一 blocker/owner；不得用 ACK、open PR、测试计划或 approval card 冒充 terminal。

### 3. Runtime Acceptance Thread / Phase｜重启后验收

验收只针对已合入并已加载的版本，记录 deployment revision、真实 source/receipt refs、`applied|dismissed`、
bounded outcome 与 correction/forget/revision/expiry 负例。它不成为新的 implementation thread；失败时按
finding 指回 lane owner，并保持本 release 未通过。

### Machine-driven closure loop

```text
owner terminal packet
  → command 核验 merge/main truth
  → regenerate catalog（RED 只按 owner declaration 机械变化）
  → runtime restart acceptance
  → vision guard（用户旅程 / authority / prompt budget / 证据 ceiling）
  → update F312 + roadmap + durable task
  → release 下一棒，或 terminal close
```

## Prompt-Budget Invariant

只有短小的宪法级路由指针可以常驻 L0；各 lane 的 canonical 内容、generated RED、候选正文和运行状态都不得
每轮硬塞进 query。具体记忆只可由 query/typed lifecycle predicate 动态形成 bounded RecallFrame；non-match
必须没有该 lane payload，cold/resume 也不得重复注入旧内容。

## Mechanism Selection｜按 claim 选保障机制

| 要回答的问题 | 机制 | F312 不做什么 |
|---|---|---|
| 六段合同、owner set、字段完整性是否确定满足 | test / schema / guard | 不用 eval 替合同签字 |
| 真实送达、耗时、稳定性和 invalidation 是否健康 | logs / metrics / traces | 不用 fixture 冒充 runtime |
| 某条 recall 是否值得 keep/tune/sunset | 有 named consumer 后才申请 utility eval 出生证 | 不给所有 lane 批量挂 Eval Hub |
| 三类线程怎样持球与回传 | Feature + durable task convention | 不把每个 SOP 细节塞进 L0 |

## User Journey

### Primary Journey: operator只说一次，咱们自己持有到闭环

- **Scope unit**: memory surface × release
- **Actor**: operator、责任猫、lane owner、runtime acceptance 猫
- **Entry**: operator在自然对话中提供一个值得长期影响未来判断的事实、偏好、人物线索或工作经验
- **Flow**:
  1. observation 产生 bounded write opportunity，而不是直接成为真相；
  2. owner 审批/规则裁决后写入 canonical revision；
  3. 后续独立 query/event 由 typed predicate 形成 source-only cue 并送达；
  4. 真实 consumer 写 `applied|dismissed` 与 bounded outcome；
  5. correction/forget/revision/expiry 使旧 cue 和派生投影 fail closed；
  6. 总控自动关账并发下一 release；最终 Phase 后关闭 durable task，不等operator踢屁股。
- **Success evidence**: generated catalog zero-RED + 两条异权 runtime/UAT episode + 负向失效 receipt
- **Non-goals**: 自动相信抽取结果、中央 truth authority、每轮 prompt 全量注入、用总分衡量单条记忆因果

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|---|---|---|---|---|
| S1 | carrier | lane owner | 接 bounded RED keys → 实现/审阅/合入 → terminal packet | exact HEAD、merge SHA、catalog delta |
| S2 | release | acceptance 猫 | 重启 merged main → 正/负真实旅程 → 回传 receipt | deployment revision、live/UAT refs |
| S3 | command | 责任猫 | 核验 terminal → vision guard → 更新 truth → 下一棒/关账 | F312 timeline、durable task status |

## Acceptance Criteria

### Phase A（总控与真相面冻结）

- [x] AC-A1: F312、BACKLOG、Atlas 与 roadmap 明确唯一 current execution authority；`pnpm check:feature-truth`、frontmatter 与 docs discovery 可复核。
- [x] AC-A2: 当前 thread 有 F312 durable task，resume truth 由 F312 spec 与 generated catalog 共同锚定；不再声称存在无法回读的 Mission Hub WorkflowSop。
- [x] AC-A3: 每次 owner terminal 都执行 `merge truth → catalog delta → runtime acceptance → vision guard → truth sync → next release`，且 command thread 不复制 lane canonical state；Phase C–G timeline 与 terminal packets 可逐段复核。

### Phase B（Person + F152）

- [x] AC-B1: Person 在 runtime restart 后完成 owner adjudication、canonical revision、独立 typed recall、`applied|dismissed`、bounded outcome 与一条失效负例；审批卡本身不计完成。
- [x] AC-B2: F152 以 evidence-bound Decision Packet 证明 producer 存在但 consumer 五段缺失；operator 批准 sunset 后同步 lane declaration 与 generated disposition，并以 search、graph、recent-browse 负例锁住“不再送达”。

### Phase C（Profile + Event）

- [x] AC-C1: Profile 按其 owner contract 关闭 then-current RED，无新增 authority/store，并记录证据 ceiling。实现随 #4222 合入；Alpha `c72b89139c` 已加载该 composition，但 owner 数据没有可用 capsule，因此 UAT ceiling 诚实停在 loaded/no-candidate，不造假 receipt。
- [x] AC-C2: Event 按其 owner contract 关闭 then-current RED，含时效/expiry invalidation；merged-main Alpha invocation `5a54ab2f-dc56-402c-a607-d76f0f3cc26e` 对 cue `cue_4156e2b7660e26b6b5f6771417711834` 形成真实 `presented → drilled → applied`，bounded response 只解释当前 thread 的 `human_brake/user_brake` Event；owner 随后软删除 synthetic source message，同一 invocation / handle 再 drill 为 `404 not_available`，append-only ledger 记录 `invalidation_reason=source_forgotten`。

### Phase D（Decision + Method + Project Knowledge）

- [x] AC-D1: 三条 lane 分别拥有 revision-bound predicate/receipt/outcome 声明；Decision/Project Knowledge active，Method E0 exempt；generated catalog 保持 21=21 并机械移除九个对应 RED（36→27、missing surfaces 9→6），search/presented/drilled 不冒充 applied。唯一 Phase PR #4252 已 merge；两个仅在前序 merge 后 Alpha 才暴露的独立 production RED由 #4264/#4267 窄修。包含最终修复的 merged-main Alpha 已分别对 `ADR-020` 与 `F312` 写入真实 `presented → drilled → applied`，且 ledger revision-bound、content-free。

### Phase E（Diary + Episode + Reflection + Seed）

- [x] AC-E1: 四条 lane 均先完成 E0；Diary/Episode/Reflection 因没有 named invocation consumer 合法 `exempt`，Cat-owned Seed `active`。唯一 PR #4277 的 Red→Green 覆盖 correction、delete、source drift、scope/status supersession、跨猫回放与同 invocation intent；merged-main Alpha `ee6d72d5e6` 诚实停在 `loaded/candidate-present/no-eligible-trigger`，没有制造 receipt。

### Phase F（Library + Provider-local）

- [x] AC-F1: 21=21 universe 保持不变且 strict closure gate 归零；Library/provider-local 通过 E0 合法 `exempt`，未删除 surface、复制 private provider memory 或新增中央 authority。唯一 PR #4281 merge `e83ae64b82`，merged-main Alpha 的 closure gate 与 catalog 16/16 通过。

### Phase G（Runtime Acceptance + Vision Guard）

- [x] AC-G1: Event 与 Decision 两条 canonical authority 在 Phase G merged-main Alpha 完成真实 `presented → drilled → applied → source_forgotten` episode；非作者验收 packet 保存 source/cue/thread/invocation/revision 坐标。
- [x] AC-G2: trace `d9a405edf8d3d16676196aae658359d6` 的 non-match 为 0 lane payload；match traces `299b65868590b504a61b0614e507db8d` / `9109a72ba983c62c5fbdb8ce2fcda9b3` 各为单条 bounded cue（457/456 bytes）；resume `291be47d9f57ec530041896cdb579d04` 为 T0/T1/T2=0、`no_reservation`。
- [x] AC-G3: Phase G 逐 claim 判定 G1 为确定合同、G2 为 runtime health；缺少匹配的 utility consumer、keep/tune/sunset decision 与 metric birth certificate，因此明确 no-eval。
- [x] AC-G4: Phase D 与 Phase F 已重复跑通 command→execution→acceptance→vision-guard；反思结论是保留“三线程 + 单 Phase 主 PR”作为 F312 本地 convention，跨 domain 证据不足，不新建 Method/Skill。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “roadmap 最好写成一份可执行、类似 feat md” | AC-A1 | feature-truth + docs discovery | [x] |
| R2 | “建立一份记忆系统现在和主动性相关的 feat，自己驱动责任田闭环” | AC-A2, AC-A3 | durable task + terminal ledger | [x] |
| R3 | “指挥与理论 thread 负责 vision 守护 + 驱动干活” | AC-A3 | timeline + terminal state transitions | [x] |
| R4 | “各个 phase 执行 thread” | AC-B1–AC-F1 | per-carrier terminal packets | [x] |
| R5 | “runtime 重启之后的验收 phase” | AC-G1, AC-G2 | Alpha/UAT receipts + negative path | [x] |
| R6 | “这个甚至可以变成我们的 meta method” | AC-G4 | multi-cycle reflection + extraction decision | [x] |
| R7 | “不要一个 phase 一堆 PR；一个 phase 用一个 PR、多个 commit 收口” | AC-C1–AC-F1 | per-Phase thread/PR ledger + final exact-HEAD review | [x] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有命令、catalog delta、receipt 或 reflection 等可复核证据。
- [x] 本 Feature 不新增前端 surface；既有 Approval Hub/Workspace 变化由各 lane Feature 自己提供需求→证据映射。

## Dependencies

- **Evolved from**: F169、F282、F287（早期反射愿景、写侧 producer、读侧 cue plane）。
- **Blocked by**: none；all generated RED owners have terminal dispositions, and Phase G independently passed runtime acceptance.
- **Related**: F200（recall/outcome 观测）、F296（continuity/presentation）、F263（invalidation/harm）、F276（Person 首案）。

## Risk

| 风险 | 缓解 |
|---|---|
| F312 变成中央 owner | 只拥有顺序/验收/关账；canonical truth 和 implementation 继续在 lane owner |
| Feature 与 roadmap/generated catalog 三份状态互相腐化 | generated catalog 管动态 keys；F312 管 current release/AC；roadmap 管研究依据与历史 ledger |
| 为追求归零给无 consumer 的 lane 造 cue | active/exempt/sunset 都合法；consumer-or-sunset 先于 implementation |
| 每条规则塞进每轮 query | 宪法指针常驻、typed predicate 动态投影、prompt-shape 负例守门 |
| main/fixture/审批卡冒充真实闭环 | 独立 runtime acceptance Phase；证据 ceiling 与 deployment revision 必填 |
| 总控线程只讨论、不继续发车 | 责任猫 + durable task + F312/current catalog；terminal 后同回合关账并发下一棒 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 新立 F312，而不把 F169/F282/F287/F200 改成 umbrella | 这些 Feature 各有稳定边界，没有一个拥有 21-surface release/acceptance 责任 | 2026-08-29 |
| KD-2 | 统一六段协议，不统一 detector/store/Hub/authority | 归一完成定义，同时保留 lane 主权 | 2026-08-29 |
| KD-3 | 总控、执行、runtime acceptance 三类线程分责 | 防止讨论、实现和验收在同一线程互相冒充 | 2026-08-29 |
| KD-4 | meta method 先作为候选，至少两轮闭环后再决定是否成 Skill | 避免用一次成功过早抽象新权威 | 2026-08-29 |
| KD-5 | sunset 必须同时退出所有 generic delivery eligibility，不能只改文档标签 | RED 证明 legacy global/all/N-collection search、graph resolve/traversal 与 recent browse 都会送达 `distilled:` rows；仅写 disposition 或只封一条入口都会留下幽灵 consumer surface | 2026-08-29 |
| KD-6 | 自 Phase C 起，一个 Phase 只用一个 execution thread 与一个 PR，lane 纵切以多个语义 commit 收口 | 降低 PR/review/merge 扇出，让 Phase terminal 对应一个 exact HEAD；不改变各 lane 的 authority，也不把 runtime acceptance 混进 implementation | 2026-09-01 |
| KD-7 | F312 的 meta-method 候选止于本地 convention，不升级 Method/Skill | Phase D/F 证明 memory domain 内可重复，但没有第二个 domain 的 named consumer/结果证据；避免把一次 domain 内成功过早变成新权威 | 2026-09-03 |

## Review Gate

- Phase A: operator 原话 + existing Atlas/Standing Reflex/closure contracts reuse；docs-only direct merge lane。
- Phase B: 既有 carriers 按各自 truth 收尾；不得用 F296 terminal 或 Person materialized 单独冒充 AC-B1 terminal。
- Phase C–F: 每个 Phase 只有一个 implementation PR；Phase 内多个语义 commit 共同形成 final exact HEAD，并按行为/数据/安全/契约/不可逆五轴选择非作者验证源。
- Phase G: acceptance 猫不得是该 carrier 的实现作者；Terra 已消费 merged+loaded truth并给出 `Vision Guard PASS`。

## Tips Contribution

F312 不新增用户入口，因此不新建 Tips。各 lane 的既有 Approval Hub/Workspace Tips 仍由 lane Feature
自己拥有；Phase G 验收的是 prompt/receipt/invalidation 合同，不创造新的用户教学 surface。
