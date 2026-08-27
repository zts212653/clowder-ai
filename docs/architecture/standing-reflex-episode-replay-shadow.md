---
doc_kind: architecture
description: "Standing Reflex 的 lane-neutral 四拍 episode、source-only replay 与 content-free shadow health 基座，以及 Taste/Profile E0 Decision Packet。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-27T03:00:00Z
feature_ids: []
related_features: [F192, F221, F231, F276, F281, F287, F296]
related_docs:
  - docs/architecture/memory-standing-reflex-contract.md
  - docs/architecture/memory-write-lane-census.md
  - docs/architecture/memory-outcome-attribution-source-map.md
  - docs/features/F192-socio-technical-harness-eval.md
  - docs/features/F221-taste-lane.md
  - docs/features/F231-user-profile-capsule.md
  - docs/features/F276-people-relationship-memory.md
  - docs/features/F281-feedback-channel-first-class.md
  - docs/features/F287-memory-cue-plane.md
  - docs/features/F296-continuity-aware-context-injection.md
topics: [memory, standing-reflex, episode, replay, shadow-health, eval, taste, profile]
created: 2026-08-26
status: active
---

# Standing Reflex Episode / Replay / Shadow 基座

## 1. 结论

Standing Reflex 现在有一套可复用的**只读证据协议**：每个 episode 显式写出
感知 → 提案 → 裁决 → 消费四拍，历史或 synthetic replay 固定 source coordinate、时钟与合同版本，
shadow health 只投影 content-free 运行信号。它不新建中央 mutable store，不接管任何 lane 的 detector、
proposal、审批、canonical truth 或 consumption authority。

本基座只能证明确定性合同和运行健康结构。历史 fixture 被 schema 固定为：

```text
runtimeEpisode=false
ownerTruthMutation=false
utilityVerdict=not_measured
sourcePolicy=opaque_refs_only
```

因此，当前**不建立 Taste/Profile utility eval，也不建立总分 Eval Hub**。Taste 是下一案的有条件推荐，
Profile 暂不发牌照；推荐不是 detector 或生产施工授权。

## 2. Evidence owner 审计

四拍已有分散而真实的 owner。episode 是 refs-only adapter/projection，不复制这些 owner 的状态：

| 证据 | 当前 owner | 可作为 episode 的事实 | 不得被 episode 接管 |
|---|---|---|---|
| eligible / delivered / omitted | F296 presentation mapper/ledger；F276 `WriteOpportunityDeliveryStore` | 某 generation 是否进入 eligible、provider 是否实质送达或明确 omission | source payload、provider response、是否值得写 |
| disposition / defer re-entry / terminal lineage | F276 disposition、deferred receipt 与 terminal ledger | propose/defer/abstain、generation、re-entry、expiry 与 invalidation refs | destination proposal 的批准与 canonical truth |
| adjudication receipt | F281 `HumanDispositionLedger` + producer-owned proposal store | exact subject 的 approve/reject/not-now 等人类裁决引用 | producer 的 canonical proposal state |
| consumption episode | F287 `MemoryCueEpisodeStore` | presented/drilled/applied/dismissed 与独立 invalidation reason | 私密推理、单 anchor 因果贡献 |
| feedback | F281 human-disposition envelope/episode | 人类反馈绑定哪个 producer subject | 把 feedback 自动晋升为规范性 memory |
| eval control plane | F192 source adapter → packet → publish/closure | 在 E0 通过后承载已有 domain truth 的 verdict | domain truth、无 consumer 的指标、统一 utility score |

源文件与实现锚点以这些文档及其引用的 symbols 为真相源；scanner/index 只有发现权。若 producer 增加或
修改证据，adapter 应升级 `contractRevision`，不能在 episode 旁另写一份“更方便”的状态。

## 3. 协议与边界

实现真相源：

- `packages/shared/src/types/standing-reflex-episode.ts`
  - `standingReflexEpisodeV1Schema`：四拍齐全；`none|exempt|sunset` 合法，缺拍非法；
  - `standingReflexReplayContractV1Schema`：source-only、冻结版本/时钟、非 live、非 utility；
  - `standingReflexShadowEventV1Schema`：content-free shadow event；
  - `projectStandingReflexShadowHealth`：纯函数健康投影，不评分；
  - `compareStandingReflexReplays`：只比较同一冻结合同，发现版本、时钟或 episode drift。
- `packages/api/src/scripts/standing-reflex-first-case-contract.ts`：把首案历史 trace 适配为 lane-neutral contract。
- `packages/api/src/scripts/standing-reflex-first-case-replay.ts`：保留 ASR→F276 的 domain replay；不承担 live episode。
- `packages/shared/src/__tests__/standing-reflex-episode.test.ts` 与
  `packages/api/test/memory/standing-reflex-first-case-replay.test.js`：结构与 replay guard。

### 3.1 四拍 episode

每个 beat 必须是两类之一：

- `observed`：有 bounded outcome 与至少一个 evidence ref；
- `none|exempt|sunset`：有 reason code，且 evidence refs 必须为空。

`unknown` 不能靠删字段表示。若事实尚不可观察，应在 lane 的 current-truth 文档写明不可观察，并用
合法 absence state 表示该 fixture 没有此证据；不得伪造 adjudication 或 consumption。

episode 只允许 opaque source ref + revision，不允许 transcript、人物名、speaker map 或私密推理。
它统一 transport protocol，不统一 detector、Hub、store 或 canonical authority。

### 3.2 deterministic replay

`pnpm --filter @cat-cafe/api fixture:standing-reflex-first-case` 会：

1. 以冻结的历史 source refs 和时间重放 ASR→F276 状态机；
2. 保留非 ASR source 作为 admission negative，而不是伪造第三条 ASR；
3. 将每个 generation 投影成四拍 episode；
4. 再次 parse/compare 同一冻结输出，报告 drift；
5. 输出 shadow health，但永远不输出 keep/tune/sunset utility verdict。

source revision 是冻结 coordinate identity，不是历史正文快照；fixture 不证明正文真实性、owner 判断、
生产送达或效用。live truth 仍由对应 owner thread/feature 记录。

### 3.3 content-free shadow health

shadow schema 分开记录九个 family：

| family | 回答的问题 |
|---|---|
| eligible | producer observation 是否通过 admission |
| delivered | 已证明的实质送达 |
| omitted | source/policy/consumer 原因造成的明确未送达 |
| disposition | propose/defer/abstain |
| defer_reentry | deferred generation 是否按谓词再次入场 |
| terminal | generation 是否以 proposed/deferred/abstained/expired 结束 |
| invalidation | source correction/forget/scope revoke/supersede |
| error | contract 或 adapter 失败 |
| burden | approval request/decision/manual correction 的 bounded units |

projection 始终保留每个 family，即使该 family 当前为空；不把空样本解释为零伤害。结构中没有
transcript、人物名、speaker map、私密 reasoning，也没有 `totalScore`。生产 wiring 若未来接入，只能从
上述 owner 的内容无关 receipt 派生，并按运行风险走 F153 logs/metrics/traces；不默认进入 F192。

## 4. Taste / F221 当前四拍与 E0

### 4.1 四拍 current truth

| 拍 | current truth | observation / authority / consumer | 可裁决失败路径 |
|---|---|---|---|
| 感知 | 当前是猫在对话中识别 taste 信号后主动调用 `cat_cafe_propose_taste`；没有获准的自动 detector | observation 来自 source message；猫只负责提议。原话/说话人真实性仍应回源 | quote 实为转述或第三人观点；speaker/provenance 不足时应拒绝 admission |
| 提案 | typed Taste proposal 进入 `RedisTasteProposalStore`，并由 F221 adapter 投影到 Approval Hub | F221 proposal schema/store 是 proposal authority；自动 defer/abstain 当前 `exempt` | proposal 创建但 card 未发布；误投 Profile；同 source 重复提案 |
| 裁决 | operator 在 F221 Approval Hub approve/reject；approve 才由 Taste repository/materializer 写 canonical vignette | operator 是裁决者；F221 repository 是 materialization authority | reject/expire 不写；approve 后 write/index 失败；quote 污染被批准 |
| 消费 | 猫通过 docs/search 与后续 F287 cue 路径读取 public Taste；reader 存在，但 organic use/harm 未形成可比 episode | consumer 是后续协作猫；canonical vignette 与其 revision 是 truth | vignette 从未被用；错误 taste 被使用；纠正/forget 后旧索引仍出现 |

### 4.2 E0 三问

| E0 问题 | Taste 答案 | Verdict |
|---|---|---|
| claim 属哪个 GT 域？ | source author/provenance 属原消息 owner；proposal/adjudication 属 F221+operator；是否帮助后续协作属于 consumption/owner utility，不属于 scanner | 可分权，不能合成单一 GT |
| 新鲜 bit 在哪里？ | proposal、operator disposition、canonical revision 已存在；speaker/quote admission 与 organic consumption/harm 尚无同一 episode binding | **utility E0 未通过** |
| 裁判工资谁付？ | operator 已支付 approval；utility 仍需要 operator/consumer 对实际使用与伤害裁决，不能用 approve 代付 | 当前工资过高且证据不完整 |

明确 consumer：后续读取 Taste 的协作猫。keep/tune/sunset 决策者：F221 owner 提案、operator 裁决。
可用 observation：source auth result、F221 proposal/disposition refs、canonical revision、F287 consumption ref、
bounded burden units。当前牌照：只允许设计/验证 read-only episode adapter 与 provenance guard；**不授权 detector，
不授权 utility eval**。

## 5. Profile / F231 当前四拍与 E0

### 5.1 四拍 current truth

| 拍 | current truth | observation / authority / consumer | 可裁决失败路径 |
|---|---|---|---|
| 感知 | `ProfileDistillationTrigger.onSessionSealed` 只做 observability；真实 harvest 仍由猫依据白名单信号主动调用 `cat_cafe_propose_profile_update` | session-seal counter 不是 candidate truth；source message/typed user signal 才是 observation | trigger 发生但没有 proposal；稳定事实漏记；临时印象被误判稳定 |
| 提案 | typed Profile proposal；只能写当前认证 user/persona 的 primer，不能借 Profile 承载 Taste | F231 proposal store/schema 是 authority；MCP auth 限定 scope | cross-user/persona、whole-file replacement 丢旧内容、Taste 误投 |
| 裁决 | operator approval 后经 `FileProfileRepository` 写 canonical profile root；reject/expire 不变更 | operator 裁决；repository + provenance 是 canonical authority | OQ-7 的 relationship granularity 未关闭；错误 target 仍可能“合法”写入 |
| 消费 | L0 发 logical URI，认证 `cat_cafe_read_profile` 解引用当前 relationship；猫是 consumer | authenticated repository read 是 truth；注入/读取只是 consumption surface | pointer missing/stale、读到错误 persona、内容在场但行为未采用 |

### 5.2 E0 三问

| E0 问题 | Profile 答案 | Verdict |
|---|---|---|
| claim 属哪个 GT 域？ | source fact 归 owner/source；proposal/adjudication 归 F231+operator；relationship identity/granularity 归 F231 OQ-7 决策 | authority 仍有开放边界 |
| 新鲜 bit 在哪里？ | session-seal/proposal/approval/read 各有局部 signal，但 trigger→proposal→正确 relationship→consumption 尚无同一 episode binding | **E0 未通过** |
| 裁判工资谁付？ | operator 支付高代价事实与关系更新审批；“猫真的更认识我”仍需 owner 体感，缺低成本稳定 judge | 当前无法稳定支付 |

明确 consumer：L0/profile reader 后的当前 persona。keep/tune/sunset 决策者：F231 owner 提案、operator 裁决；
OQ-7 未关闭前不得把 family/individual/model 的选择交给 adapter 猜。当前牌照：不进入下一案；不得为统一
episode 新建第三个 store，也不得把 observability-only trigger 冒充 detector。

## 6. 当前不建 utility eval

指标出生证的两个前提都不成立：

1. Taste 与 Profile 尚不能产出语义可比、贯穿四拍且绑定 consumption 的 episode；
2. utility claim 的 consumer 虽能点名，但可重复 judge 与工资来源未建立。

ASR 首案的 historical replay 也不是 live utility sample。故本阶段只保留：确定契约的 schema/test/guard，
以及运行健康的 content-free shadow contract。没有“待补一个总分 Eval Hub”的欠账。

## 7. 下一案 Decision Packet

**决策题**：在 ASR 首案完成真实 runtime closure 后，是否给 Taste 一个受限的 next-case design license？

**推荐：Taste，条件式；Profile 暂缓。** 理由：Taste 的 proposal、operator adjudication、canonical
materialization 和明确下游 reader 已存在；它还能用 speaker/provenance 污染与 approval burden 攻击首案
未覆盖的失败面。Profile 的 standing trigger 仍断裂，relationship authority 尚有 OQ-7，若为 episode 补仓
会制造第三 truth。

受限 license 只包含：

- 复用本协议做 read-only adapter/fixture；
- 在不保存 quote/transcript/speaker map 的前提下，验证 source author/provenance admission；
- 从现有 F221/F281/F287 refs 投影 episode 与 burden；
- 先产出可比 episode，再单独申请 utility 指标出生证。

它不包含 detector、自动提案、新 store、总分、生产 rollout 或 keep/tune/sunset 预判。

**反例 / 翻转条件**：若 Taste provenance 只能靠复制 transcript/quote，或 approval burden 无法 bounded，或
consumption 无法绑定 canonical revision，则 Taste 不获牌照。若此前 Profile 关闭 OQ-7，并能从既有 whitelist
event→proposal→authenticated read 投影完整 episode、无需新 store，则 Profile 可反超。

## 8. Architecture admission

- architecture cell：Memory；map delta 是一个共享只读 contract/projection，无新 owner cell。
- canonical source：各 lane/ledger 保持原 owner；本文件只引用，不复制运行状态。
- consumer：首案 replay、后续 lane adapter、contract tests；F192 仅在 E0 通过后才是 utility consumer。
- claim guard：strict Zod schemas + RED→GREEN tests；production path 未改。
- rollback：删除共享 export、adapter 与文档即可；不会回滚或迁移用户数据。
