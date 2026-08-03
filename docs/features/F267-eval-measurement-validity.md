---
feature_ids: [F267]
related_features: [F192, F245, F263, F266, F268, F275]
topics: [eval, measurement-validity, calibration, uncertainty, repeatability, friction, work-eligibility]
tips_exempt: "Internal eval measurement governance and migration; no new user-invokable capability or action surface"
doc_kind: spec
created: 2026-07-18
updated: 2026-08-01
description: "为决策型 eval bundle 建立目标、边界、不确定性与重裁契约，并以 friction 通道召回为首个实证迁移。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-18T12:11:00Z
---

# F267: Eval Measurement Validity — 评估度量有效性迁移

> **Status**: implementation | **Owner**: Maine Coon Sol/小太阳·Maine Coon (@codex-sol) | **Reviewer**: 狸花猫 GLM-5.2 (@glm52) | **Priority**: P1

Architecture cell: `harness-eval`
Map delta: none
Why: 本 Feature 为 F192 的 decision-bearing measurement bundle 补 validity/calibration contract，并消费各 domain 的 canonical telemetry；不搬走业务真相源，也不新建跨域总分。

## Why

eval 能稳定产出数字，不等于数字真的代表我们在乎的东西。当前最硬的现行案是 friction：四个 adapter 已接入，但现存 11 份归档 rollup 的 27 个 actionable candidate 全来自 paw-feel；cancel 为 0。原因可能是真没有摩擦，也可能是 opportunity、采集、聚类、阈值或 top-N 排序漏掉了。若不先校准，我们会用 F266 很高效地闭环错误工单。本 Feature 要让每个用于行动的 measurement bundle 都能回答：测什么、为谁决策、适用到哪里、错判代价是什么、证据有多强、什么情况必须撤回。

## Current State / 现状基线

- 仓内 11 份 `*eval-friction*/raw/rollup-report.json`（2026-06-25..07-18）共有 27 个 actionable，27/27 为 `[paw-feel]`。
- 归档 signal artifact 计数 1534（窗口重叠，不能视为唯一 episode 总体）：paw-feel 1440、eval-domain 93、user-feedback 1、cancel 0；11 份均 `droppedChannels=[]`。
- `droppedChannels=[]` 只能说明 adapter 没 throw，不能证明 opportunity recall 健康；历史 rollup 若没有 canonical row IDs/冻结 store，就只能作为 symptom cohort。
- capability-wakeup 的 27/27 miss 使用 heuristic opportunity proxy；归因与样本独立性未验。n=27 即便 0 miss，单侧 95% 上界仍约 10.5%。
- Phase B 实物 census 已清点 11 个 registry entry 与 88 份 committed verdict：9 个 active decision-bearing、1 个 gated、1 个 registered/nonoperational；canonical friction bundle 已补齐 target、validity、uncertainty、calibration、repeatability 与 first-class judge version，但其余活跃 bundle 尚未迁移。
- “task-outcome/memory 运行活跃”只证明 closure chain 可见，不证明 measurement validity。
- `eval:task-outcome` 的 Episode 仍按 thread 最新 `in_progress` 对象归集，且没有 managed-work eligibility：现有历史 verdict 只能当 event/thread-level telemetry，不能支持 task-level 成功率、耗时或尝试次数。

## What

### Phase A: C7 Friction Pilot — Opportunity-to-Action Funnel

- 先做同源逐 ID 配对，不拿两个汇总数猜 recall。
- Join contract：同一精确窗口 `[sinceMs, untilMs)`、同一个冻结 `TaskOutcomeEpisodeStore` 状态；expected 只数 `type ∈ {permission_cancel, cancel_burst}` 且 scope 为 `['a2','proxy']` 的 canonical rows；`expectedId = cancel:${row.id}`，与 `CancelAdapter.pull(...)` actual IDs 对账。
- 报告 `recall = |expected ∩ actual| / |expected|`，并区分 opportunity=0、adapter 漏失、聚类未入簇、ranking/top-N 未出 actionable。
- 每个通道提供 opportunity→emitted→dropped/error→clustered→eligible→actionable 漏斗；历史 11 份 rollup 只当 symptom/trigger baseline，缺 frozen IDs 时改用 prospective paired capture。

### Phase B: Measurement Bundle Birth Certificate + Versioned Judge

- 单位是 measurement target / decision bundle，不是每个 scalar；bundle 内分 primary loss、guardrail、context、diagnostic，只有前两类办全证。
- 完整出生证至少含：measurement target/estimand、decision consumer/action、target population/window、primary loss 与 guardrails、false-positive/false-negative cost、validity bounds、sample contract、uncertainty/power、calibration plan、withdrawal condition、intervention card。
- judge/rubric/classifier/eval-cat prompt/model/code artifact 使用 first-class version/provenance；仅有 repo SHA 不替代可读版本与重裁输入。
- 样本不足时必须报 `n + point estimate + interval/power + insufficient`，禁止只用点估计硬过阈值。

### Phase C: Repeatability + Risk-Ordered Migration

- 对同一 frozen cohort 做至少一次独立重裁，报告 agreement/disagreement 与原因；禁止把“同一问题重放答案一样”当完整重裁证据。
- 选取“eval 全绿期间生产仍翻车”的真实窗口做 negative control，验证阴性结果的可信度。
- pilot 通过后，按 decision risk/使用频率迁移活跃 bundle；先 census 功能等价字段，再补缺，不发动 76-scalar 补证运动。
- 负空间矩阵先盘现存 gate/monitoring，再判断缺少的是 eval domain、其他 guard，还是根本没有观测；NIST 类别只作检查 taxonomy，不直接复制成域。

#### Task-outcome validity migration（依赖 F275）

- 任务分母的定义域是**已被 SOP/managed-work 权威受理的长程交付工作**，不是所有 thread、消息或 TaskItem。
- 归属必须保留 `managed_attributed / managed_unattributed / unmanaged_not_applicable` 三桶；只记归属成功会把 identity coverage 缺陷伪装成干净数据。
- F275 负责 WorkAdmission/workId/attempt 与 terminal evidence 的 canonical 契约；F267 只定义什么数据有资格进入 decision-bearing task outcome bundle。
- F275 上线前，既有 task-outcome verdict 保留历史但加 errata：`thread-level approximation + no managed-work eligibility filter`，所有 task-level 结论失效。
- 对 `unmanaged_not_applicable` 做冻结规则的概率抽样，由独立裁决者判“是否本应进入 managed work”。首期只发布**抽样桶污染率**，不把它冒充全局 SOP 漏开率；只有抽样概率、总体规模与加权估计量冻结后，才可推导 admission recall。

## User Journey

### Primary Journey: 看见数字时知道该信多少
- **Scope unit**: feature
- **Actor**: eval owner、Program guardian、operator
- **Entry**: 一条提出 fix/build/sunset 的 eval verdict
- **Flow**:
  1. 打开 verdict → 看见 measurement target、决策用途、样本窗口与 primary/guardrail 指标。
  2. 查看 n、区间/判定力、judge 版本、适用边界与 withdrawal condition。
  3. 若证据不足，系统明确标“本期无判定力”；若触发行动，可追到 intervention card 与后续 re-eval。
- **Success evidence**: friction pilot report + birth certificate artifact + frozen-cohort rejudge report + Hub/文件投影
- **Non-goals**: 不建跨域排行榜或总分；不逐 scalar 办证；不把 NIST 六类硬翻成六个域；不以固定 5% 阈值冒充普适统计契约。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 三个 Feat 并行自治，度量线先用 C7 做 pilot | AC-A1..A4 / AC-C4 | pilot artifact + workflow checkpoint | [ ] |
| R2 | cancel=0 必须判断真低摩擦还是漏采，不能凭汇总猜 | AC-A1 / AC-A2 / AC-A3 | frozen join + ID diff | [x] |
| R3 | 指标要有出生证、judge 有版本、重裁有一致性证据 | AC-B1..B5 / AC-C1 | schema/validator + replay report | [ ] |
| R4 | 未验真 claim 有名字、有撤回条件，不再高置信下病名 | AC-B3 / AC-B4 / AC-C2 | claim-card/bundle audit | [ ] |
| R5 | task-outcome 先定义谁是考生：只有 admitted managed work 进入任务分母 | AC-C5 / AC-C8 | F275 identity contract + eligibility gate | [ ] |
| R6 | fail-closed 不能静默缩小分母；归属失败和范围外必须分桶 | AC-C6 | three-bucket projection fixtures | [ ] |
| R7 | eligibility gate 上游沉默必须可见，但不能拿抽样污染率冒充全局漏开率 | AC-C7 | frozen sampling certificate + independent adjudication | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 本 Feature 无新增前端 surface；若投影进入 Hub，复用 F248 组件并补证据映射

## Acceptance Criteria

<!-- 每条 AC 必须 trace 回 Why，并由非作者复核。 -->

### Phase A（C7 Friction Pilot）
- [x] AC-A1: 实现/运行精确 join contract：同窗口、同冻结 store、canonical row 类型/scope、逐 ID 对账；仅比汇总数不能通过。
- [x] AC-A2: 报告 expected/actual/intersection/missing IDs 与 recall；能区分 opportunity=0、adapter 漏失和下游聚类/ranking 淘汰。
- [x] AC-A3: 四通道 opportunity→actionable 漏斗带 error/drop provenance；`droppedChannels=[]` 不被解释成 coverage healthy。
- [x] AC-A4: 11 份历史 rollup 明标 symptom cohort；若无 frozen IDs，prospective paired capture 产出可复核 baseline。

> 2026-07-18 live acceptance：以上四项按 **measurement mechanism** 验收通过；本窗口的 measurement verdict 仍为 `insufficient`。这不等于 cancel recall 已有判定力，也不解除 AC-C4 的批量迁移硬门。

### Phase B（Birth Certificate + Versioning）
- [x] AC-B1: registry/bundle census 列出所有活跃 decision-bearing bundle、consumer/action 与已有功能等价字段；bundle 数由实物清点，不用 `domain×估算`。
- [x] AC-B2: measurement bundle schema/validator 覆盖 target、population/window、loss/guardrail、cost、uncertainty、calibration、withdrawal、intervention；context/diagnostic 只登记归属。
- [x] AC-B3: judge/rubric/classifier/prompt/model/code provenance first-class versioned，并可用同版本重放 frozen cohort。
- [x] AC-B4: verdict 若 n/判定力不足必须输出 `insufficient` 和撤回条件；只有 point threshold 的报告被 hard check 拒绝。
- [x] AC-B5: 每次提出 fix/build/sunset 前存在 intervention card，说明干预目标、guardrail、预期变化与复评窗口。

> 2026-07-19 Phase B contract acceptance：以上五项证明出生证、结果、版本集、同版本 replay、`insufficient` 与 intervention gate 的机制可执行；friction dogfood 仍为 `n=0`、recall=`null`、decision=`insufficient`。这不构成 Phase C 独立重裁、全量迁移或 cancel recall 健康证明，AC-C1..C4 全部保持关闭。

### Phase C（Repeatability + Migration）
- [x] AC-C1: 至少一批 frozen cohort 被非原 judge/人工独立重裁，产出 agreement、分歧样本与 adjudication report。
- [x] AC-C2: 至少三段连续 keep_observe/green 窗口与同期生产事故对照，报告阴性可信度和传感盲区。
- [ ] AC-C3: 所有活跃 decision-bearing bundle 有完整证，所有自动 judge 有显式版本；缺证 bundle 不允许驱动 fix/build/sunset。
- [ ] AC-C4: migration 按风险分批，friction pilot 未通过前不批量迁移；每 Phase checkpoint 写明新增证据和是否改变跨 Feat contract。
- [ ] AC-C5: `eval:task-outcome` 的 target population 明确限定为 F275 admitted managed work；thread/message/TaskItem 存在性不得代替 eligibility。
- [ ] AC-C6: 任务归属结果保留 `managed_attributed / managed_unattributed / unmanaged_not_applicable` 三桶；只有第一桶进入 task-level loss，第二桶作为 coverage guardrail，第三桶不适用。
- [ ] AC-C7: unmanaged 抽样审计拥有独立出生证、冻结抽样概率与 judge 版本；首期指标命名为 `unmanaged_should_have_been_managed_rate`，不得直接发布为 `SOP miss rate`。
- [ ] AC-C8: 既有 task-outcome verdict 全部带双重失真 errata；F275 identity coverage 与 AC-C6/C7 validity 未通过前，task-level fix/build/sunset verdict hard blocked。

> 2026-07-27 AC-C1 独立重裁验收：冻结的三个 friction closed-window item 由非原 judge `codex-terra` 在只见 blind cohort 与独立 rubric 的条件下重裁，随后由代码从 Phase B 原始来源重建 baseline rows 并完成 join。adjudication report 为 3/3 agreement、0 disagreement、agreement rate=1；因此本批没有分歧样本需要人工裁决。第三只猫 `gpt52` 在消息 `0001785122998488-000516-cbb99771` 对 exact HEAD `d5df548d0c7111ac9672d4595b98296ee822edd9` 完成校准并 `APPROVE`；五枚已审 patch 5/5 等价重放后，PR #3249 squash merge 到 canonical `main@c51753a1d9304290e202323a9f436afd17e5f29c`。该结果只证明 `no_opportunity + recall=null + downstream_degraded` 这一种 insufficient 条件的 repeatability，不提供 calibration 或 discrimination 证据。
>
> cancel recall remains `null`/not estimable for these windows; AC-C4 bulk migration remains closed; F268 remains disabled; AC-C5..C8 remain dependent on F275.

> 2026-08-01 AC-C2 / batch-1 验收：`eval:memory` 的三个相互重叠 30-day `keep_observe` 窗口均固定 200/200 search-quality observations，随后一段真实生产事故 verdict 又固定 official output=`0`、底层 SQLite rows=`32,258`、direct observations=`200`。checked-in incident snapshot 却记录 200 observed searches，故确定性重建得到 `green_window_coverage=1`、`incident_detection_rate=1`、`incident_evidence_consistency=0`，overall=`insufficient`、action=`keep_observe`。这证明 negative control 能抓住传感链自相矛盾，不能证明 memory search quality 健康。GLM 在消息 `0001785594420381-000795-a9794ee9` 对 exact HEAD `1ed6409a35482a6f6d2300338b090b422662b56d` 独立复核并 `APPROVE`，PR #3363 随后 squash merge 到 canonical `main@708f68213728c73676b138db75570f5c3d7bdd6e`，因此 AC-C2 的 review + landing 时序门已满足。AC-C3/C4 仍开放，其余 8 个 active bundle 均不具 action enablement（friction=`certified_insufficient`、6 个=`unmigrated`、task-outcome=`blocked_f275`）。

## Eval / Tracking Contract

- **Primary Users + Activation Signal**: eval designer/owner、reviewer、Program guardian；新 bundle、judge/阈值改变、verdict 要求行动时激活。
- **Friction Metric**: 办证耗时、context scalar 被误升全证比例、无版本 judge 数、insufficient 被误判 healthy 数、重裁 disagreement、negative-control 漏报率。
- **Regression Fixtures**: contaminated 27/27 capability attribution、cancel opportunity>0/actual缺失、empty/no-power window、同 cohort 两版 judge 分歧。
- **Sunset Signal**: 当 schema/validator 成为 F192 registry/publish 的稳定硬不变量、活跃 bundle 迁移完成且连续两个周期无人工补证债，本迁移 Feature 可 close；validator 与周期抽检继续作为运行时能力保留。

### Metric birth certificate: unmanaged bucket contamination

```yaml
metric_birth_certificate:
  utility_claim: "抽样污染率下降，表示被留在 unmanaged 桶里的会话更少包含本应受理的长程交付工作；只用于调 admission policy 与决定 task-level eval 是否继续封锁。"
  estimator: "按冻结概率从 unmanaged_not_applicable 会话抽样；独立 judge 盲判 should_manage / not_applicable / unknown；报告 n、抽样概率、point estimate、CI 与 unknown。"
  validity_bounds: "非概率抽样、抽样概率不可追溯、judge 看见现有分类、用户需求分布或 SOP eligibility 版本变化时撤回；首期不得外推为全局 admission recall。"
  consumer: "F275 owner 调整 admission contract；F267 guardian 决定 task-level bundle keep-blocked / pilot / activate。"
  calibration_plan: "每个 SOP eligibility 版本至少由第二裁决者复核分歧样本；与 operator 明确指出的漏开 SOP 案例对表，漏掉任一已知正例则先修采样面。"
  repeatability_contract: "冻结 cohort、selection probabilities、rubric/judge version；同 cohort 独立重裁并报告 agreement；需求漂移只能进入新版本 cohort。"
```

## ADR-031 三层计划

| 层 | 本 Feature 承重 |
|----|----------------|
| Soft | eval-design 使用指南、bundle/claim 语义、审计者撤回条件 |
| Hard | schema/validator、版本字段、insufficient gate、frozen replay 与逐 ID join tests |
| Eval | repeatability、negative controls、channel recall、certificate burden/sunset 监测 |

## Program Operating Contract

- **operator authorization**: `0001784376506778-000328-2a877146`；Fable OK: `0001784376508012-000331-f2b9dad1`。
- **Execution**: 独立 thread 自治；C7 pilot 是扩面前硬门，不等待 F266。
- **Checkpoint delegation**: Phase checkpoint 由 Sol/Fable 异步守愿景；只有 contract/愿景/隐私/不可逆红灯升级。
- **Review boundary**: Sol 是 Phase A author；GLM 的 Design Gate 证据是输入、最终 review 必须覆盖 Sol 的 exact final HEAD；作者、reviewer、最终 guardian 必须不同个体。

## Dependencies

- **Evolved from**: F192（跨域 eval runtime）、F245（friction signal/rollup）、2026-07-18 audit（validity gaps）
- **Blocked by**: F275（仅阻塞 task-outcome 的 task-level migration；friction 与其他 bundle 迁移不受阻）
- **Related**: F263（memory-specific lifecycle measurement 参考，不纳入本 scope）、F266（valid verdict 的后续 closure）、F268（tips 启用前消费本契约）、F275（managed-work canonical identity/eligibility）

## Risk

| 风险 | 缓解 |
|------|------|
| 出生证变成官僚填表 | 单位按 decision bundle；context/diagnostic 不办全证；持续跟踪办证成本 |
| 用统计外衣强化脏 opportunity label | 先审机会定义与 source coverage，再算区间；claim 有 withdrawal condition |
| pilot 成功后运动式迁移全部域 | risk-ordered batch + C7 pilot gate + 每批负控/重裁 |
| 人工重裁受原 verdict 锚定 | frozen cohort + 独立 judge/人工先裁后看原结论 |
| fail-closed 归属静默缩小分母 | managed_unattributed 单独入账并作为 coverage guardrail |
| unmanaged 抽样率被营销成全局 SOP recall | 指标命名、出生证与 validator 禁止无权重外推 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 出生证单位是 measurement target / decision bundle | scalar 逐项办证会制造官僚负担且混淆测量目标 | 2026-07-18 |
| KD-2 | C7 friction 是唯一首 pilot | 已有全窗口偏斜证据与可执行逐 ID join contract | 2026-07-18 |
| KD-3 | 历史 rollup 缺 frozen IDs 时只叫 symptom cohort | 汇总相关性不能证明 adapter recall | 2026-07-18 |
| KD-4 | adapter unavailable 与 recall=0 分离 | pull 失败没有 observed actual set；必须输出 `unavailable`/`recall=null`，不能伪造漏召回 | 2026-07-18 |
| KD-5 | Phase B census 以 registry + runtime instruction/publish wiring + committed verdict 实物三源分类 | domain 数、metric 数或文件名估算都不能证明 decision-bearing bundle 可运行 | 2026-07-19 |
| KD-6 | 出生证、result、replay、census 是四类不可混写的 immutable evidence | 将证书与单次结果混成一个 scalar 会丢失适用边界、版本身份与撤回语义 | 2026-07-19 |
| KD-7 | Task outcome 的 eligibility 由 F275 WorkAdmission 定义，F267 不拥有 canonical work data | eval 定义可用分母但不能铸造业务身份 | 2026-07-25 |
| KD-8 | 归属采用 managed/unattributed/not-applicable 三桶 | 二值归属会把范围外错记成失败，或把失败静默排除 | 2026-07-25 |
| KD-9 | unmanaged 抽样先测桶污染率，不直接声称全局 SOP 漏开率 | 没有抽样权重与总体规模时，局部比例不等于 admission recall | 2026-07-25 |
| KD-10 | historical `artifactRevision` 必须是 canonical `origin/main` 的祖先，full SHA 格式本身不代表 durable | feature/pre-squash commit 即使当前可解析，也可能在分支删除与 Git GC 后消失，不能作为 sealed evidence 的长期 locator | 2026-07-27 |

## Phase A Implementation Evidence (merged; live acceptance captured)

- `friction-measurement-pilot.ts`：closed window 前置守卫；canonical cancel rows 单次查询并冻结；四 adapter 只捕获一次，aggregator/clusterer 重放同批结果。
- `friction-measurement-report.ts`：cancel expected/actual/intersection/missing/extra/recall + 四通道 emitted→aggregate→clustered→eligible→actionable ID 漏斗；非 cancel opportunity 明标 `unmeasured`。
- `eval-friction-live-verdict.ts`：每份新 friction bundle 强制写 `raw/measurement-validity.json` 并独立纳入 provenance hash；缺 capture 或窗口身份不一致 hard reject。
- executable proof：真实 `TaskOutcomeEpisodeStore(':memory:')` 逐 ID 配对、单读 mutation trap、source error、zero opportunity、missing/extra/mixed/unavailable、隐私序列化、bundle writer 与 publish e2e。
- independent review：@glm52 对 `392ed40184f5f0678c59741adde323362b8ec84d` 给出 `APPROVE`，独立运行 12 个 friction suites 共 85/85 通过；rebase 后 patch-id 连续，合入 PR #3058。
- canonical landing：PR #3058 已 squash merge 为 `589531e4f4bb55932145461705d6b3ee09f86bd2`。

### Post-merge runtime acceptance boundary

- `main=landed`：canonical main 已含 F267 Phase A provider、hard guards 与 artifact writer。
- `live=activated`：API PID 58897（2026-07-18 14:50:21 启动）加载 runtime `39546dbad33d835cfa0001dd3530adbd41a18292`；source/dist 均含 F267 writer。运行验收未启动或替换该进程，只通过正式 domain trigger 调度已注册的 `eval:friction` eval cat。
- durable artifact：`docs/harness-feedback/bundles/2026-07-18-eval-friction-manual-recheck-rolling-window-toolgap-watch/`，由 PR #3064（merge `5c16f6af394fccb376104555b963ad5b7a1d286a`）落入 canonical main。
- exact window：`[1784157586204, 1784416786204)`；measurement window 与 rollup selector 完全一致。历史 11 份 rollup 明标 `symptom_cohort`，baseline 为 `prospective_paired_capture`。
- cancel join：canonical opportunity=0、actual=0、intersection/missing/extra 均为空，status=`no_opportunity`，recall=`null`；没有把“没机会观测”伪造成 0 recall 或健康覆盖。
- four-channel funnel：paw-feel opportunity=`unmeasured`，其 adapter→aggregate→clustered→eligible→actionable 为 `327→326→326→326→37`；cancel 从 measured opportunity 到 actionable 各 stage 均为 0；user-feedback 全 0；eval-domain opportunity=`unmeasured`，其下游五段为 `7→7→7→0→0`。报告同时标记 `downstream_degraded`，因此 overall decision=`insufficient`。
- withdrawal conditions：等有 canonical cancel opportunity 的 closed window 重跑，并在 downstream dependency 恢复后重跑；在此之前不产生 decision-bearing recall 结论，AC-C4 的批量迁移硬门保持关闭。
- provenance/privacy：`rollup-report.json` SHA-256 `c3db70fd054e209922231add4439b3291bb77384bb914957b9c93aa5a79a988f`；`measurement-validity.json` SHA-256 `62c9131d0f694afcb9b4f58d2c692ae0857a2bf3a9622e08d9710189a745e652`，均与 provenance 记录一致；真实 artifact 通过 raw evidence denylist 检查。
- independent acceptance：@glm52 对 PR #3064 durable artifact 独立复核 7/7 claims 后给出 `ACCEPT`；`downstream_degraded` 是解除硬门前必须重跑的 follow-up condition，不阻塞 mechanism acceptance。
- post-merge acceptance task：`0001784384968815-000817-020c8d89`。本次运行已完成首份 live artifact 的结构验收；其统计判定仍为 `insufficient`，不得表述为“cancel recall 已验证健康”或“pilot 已允许扩面”。

## Phase B Implementation Evidence (merged; not yet Phase C)

- executable census：`docs/harness-feedback/registry/measurement-bundles.yaml` 逐 entry 绑定 registry consumer/owner、allowed action、source selector、instruction/publish wiring、functional equivalents 与 committed verdict count；validator 从真实 registry 与 88 份 verdict 反查，新增/重复/错 consumer/错 classification 均 fail closed。
- canonical certificate：`docs/harness-feedback/certificates/f267-friction-opportunity-to-action.yaml` 以 decision bundle 为单位，区分 primary loss / guardrail / context / diagnostic；judge、rubric、classifier、prompt、model、code 六类组件各有可读版本、repo ref、SHA-256，并汇成 deterministic version-set hash。
- normalized result：`docs/harness-feedback/measurement-results/f267-friction-2026-07-18.yaml` 从 Phase A accepted artifact 重新投影；`cancel_adapter_recall` 保留 `n=0`、point estimate=`null`、`not_estimable`，overall decision 保留两条 reason 与两条 withdrawal condition，action 仅为 `keep_observe`。
- same-version replay：`docs/harness-feedback/replays/f267-friction-2026-07-18-same-version.yaml` 使用同 certificate、同 cohort ref/hash、同 version set 重新运行 friction projection，生成独立 replay result identity 后得到 `exact_agreement`；任一 cohort/version identity 漂移先 fail closed，不伪装成普通 disagreement。
- hard layer：root `pnpm check:measurement-bundles` 验证 census、strict schema、component/cohort hash、canonical friction reprojection 与 replay；mutation tests 拒绝 stale census、路径逃逸、hash drift、thin legacy certificate、point-only/false-usable result。
- F268 boundary：`eval:capability-tips` enable gate 已改为消费 canonical F267 parser，不再维护重复薄 schema；checked-in domain 仍 `enabled:false` 且 certificate/replay refs 为 `null`，没有签发证书、启动 pipeline 或开启 Phase C。
- privacy：canonical certificate/result/replay 仅含 contract、counts、status、version/hash 与可审计 provenance；不复制 Phase A raw message、symptom/sourceEvidence/rawRef 或逐条 signal IDs。
- independent review：@glm52 在 exact HEAD `93fd27e57904cc00a1f4da20d6cafc052bbc9210` 独立运行 22/22 targeted tests 与 hard checker 后给出 `APPROVE`；作者侧 full gate、最新 main 合成 gate 与 GitHub CI 均通过。
- canonical landing：PR #3080 已 squash merge 为 `20001d90f62ae4945d23b6e8bfe629de8052b3d7`；这只收口 Phase B contract，不声明 Phase C 已开启、F268 已启用或 cancel recall 已健康。

## Phase C AC-C1 Implementation Evidence

- checker-only source map：`docs/harness-feedback/rejudge-source-maps/f267-friction-2026-07-18-to-24.yaml` 绑定三个已提交 measurement/rollup source pair 的安全路径与 SHA-256；它不进入 Terra blind packet。
- blind cohort：`docs/harness-feedback/rejudge-cohorts/f267-friction-2026-07-18-to-24.yaml` 只含 opaque item IDs、窗口、source digests、counts/status 与 degraded/drop evidence；不含 repo raw refs、逐行 IDs 或 baseline decision/action。
- independent rubric/procedure：`docs/harness-feedback/rejudge-rubrics/f267-friction-blind-sufficiency-v1.yaml` 将 `codex-terra`、固定 `gpt-5.6-terra` model component 与 blind-only reason vocabulary 绑定进独立 procedure version set；该 identity 与 Phase B baseline 不同。
- durable Terra return：replacement payload message `0001785114541929-000350-c03e2999`，source invocation `019fa11c-6925-7cb0-97c0-ae082a79b814`；wrapper `docs/harness-feedback/independent-judgments/f267-friction-2026-07-18-to-24-terra.yaml` 保存 MessageStore exact UTF-8 bytes、payload SHA-256 与 provenance。首份 malformed payload 被 fail closed 丢弃，未规范化或代修。
- comparator/report：`docs/harness-feedback/adjudications/f267-friction-2026-07-18-to-24.yaml` 的 baseline rows 由 checker 从 exact source bytes 重建，outcome 只比较 decision/action rows；3 个 item 全部为 `insufficient + keep_observe`，3/3 agreement、0 disagreement。
- hard closure：root `pnpm check:measurement-bundles` 重建 source map/cohort、验证 rubric/procedure、核对 Terra exact bytes/provenance、重建 baseline 与 adjudication report；mutation matrix 拒绝 raw-ref/ID 泄露、unsafe ref、judge/model/hash drift、item drift、cross-phase reason、action bypass、canonical-byte drift 与 summary/coverage 漂移。
- independent review + landing：`gpt52` 在消息 `0001785122998488-000516-cbb99771` 对 exact HEAD `d5df548d0c7111ac9672d4595b98296ee822edd9` 给出 `APPROVE`，无 P1/P2；作者以 5/5 `range-diff =` 与 final full-gate PASS 证明 rebase continuity，PR #3249 squash merge 为 `c51753a1d9304290e202323a9f436afd17e5f29c`。
- historical procedure identity：Phase B certificate 的 component hashes 与 `versionSetHash=5f3c96d...` 恢复为首次发行值；`artifactRevision=20001d90...` 只负责从 canonical-main ancestor 的 immutable Git tree 取回当时 bytes，不进入 version identity。checker 拒绝仅在 feature/pre-squash branch 上可达的 full SHA；后续 feature/prompt 修改、重命名或删除不得重标或破坏已有 result/replay/adjudication。
- coverage boundary：本批三个窗口全属同一 `no_opportunity + recall=null + downstream_degraded` 类，只支持该类 repeatability；不支持 calibration/discrimination，不改变 cancel recall 的不可估状态，也不解除 AC-C4/F268/F275 边界。

## Phase C AC-C2 / Batch 1 Accepted Evidence

- frozen negative control：`docs/harness-feedback/negative-controls/f267-memory-search-quality-v1.yaml` 绑定三段相互重叠的 `keep_observe` 绿窗和一段后续生产事故；每个 case 同时固定 snapshot/verdict ref、SHA-256、半开窗口与重建 observation。
- certificate + procedure identity：`docs/harness-feedback/certificates/f267-memory-search-quality.yaml` 以 `main@1783be155ec82f66151db1ea728f4ab2e6fb3c0e` 为 immutable `artifactRevision`，固定 judge、rubric、classifier、prompt、model、code 六类组件，version-set hash=`3086a9995a2d213af25b7c677250f83da206bc74feb9954349591b44d9b1e39a`。
- deterministic result：`docs/harness-feedback/measurement-results/f267-memory-search-quality-negative-control-v1.yaml` 的三个 metric 为 `1 / 1 / 0`；事故 truth 与 checked snapshot 无法同源重建，decision=`insufficient`，action=`keep_observe`，撤回条件要求提交 direct incident observation 或重建可复现 snapshot。
- same-version replay：`docs/harness-feedback/replays/f267-memory-search-quality-negative-control-v1.yaml` 使用同 certificate/cohort/version set 重放，结果 `exact_agreement`；hard checker 从 source bytes 重建 cohort、result 与 replay，任一 ref/hash/procedure drift 均 fail closed。
- migration boundary：registry 将 `eval:memory` 标为 `certified_insufficient + keep_observe_only`；它完成首个风险批次的证据迁移，但不允许任何 intervention。`eval:friction` 仍 `certified_insufficient`，其余 6 个 active bundle 仍 `unmigrated`，`eval:task-outcome` 仍 `blocked_f275`；AC-C3/C4、F268 与 task-outcome 边界均不改变。
- temporal boundary：非作者 GLM exact-HEAD review（消息 `0001785594420381-000795-a9794ee9`）与 PR #3363 canonical-main landing（`708f68213728c73676b138db75570f5c3d7bdd6e`）均已存在；本独立 closure delta 因而勾选 AC-C2。该时序闭环不替代 AC-C3 的全量补证，也不解除 AC-C4 的风险有序迁移硬门。

## Review Gate

- Design Gate: 先开箱 friction store/adapter/artifact identity，再冻结 pilot；禁止先写泛化框架。
- 每 Phase: owner 自选非作者 reviewer；重裁 reviewer 不看原 verdict 后独立下判。
- Close: pilot、出生证迁移、重裁、阴性抽检四类证据缺一不可。
