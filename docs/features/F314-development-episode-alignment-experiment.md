---
feature_ids: [F314]
related_features: [F100, F153, F167, F192, F267, F281, F303, F311]
topics: [development-process, intent-alignment, review, merge-gate, process-cost, main-health, experiment, self-evolution]
tips_exempt: "Internal development-process experiment with no end-user-invocable product surface; its user-visible value is lower coordination tax rather than a new command or UI."
doc_kind: spec
created: 2026-09-02
description: "让开发从 accepted source 到 exact HEAD 保持同向，以风险匹配的最小证据交付，并把后续效用优化交给 F311 的可回滚单变量实验。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-02T08:35:00-07:00
---

# F314: Development Episode Alignment Experiment｜开发交付对齐自进化实验

> **Status**: spec / experimental kickoff | **Owner**: 小太阳·Maine Coon（@codex-sol, GPT-5.6 Sol） | **Priority**: P0
>
> **operator kickoff**: `[thread-id]#0001788362521422-000191-49e92a70`——“这个项目可能可以特殊点实验项目；这个出生是我们建立的，但是后续优化迭代我们接入 F311 的自进化。”
>
>
> **Existing Evolution Program**: `evolution-program:ba0f4524e49cc879279164d5b272cf8c`。其被进化对象仍是 F100 拥有的 `capability:development-process-harness-effectiveness`；F314 链接并验收这个 Program，不复制或改写其 canonical lifecycle。

Architecture cell: **none（integration-only Feature）**。

Map delta: **none**。F314 不出生新 control plane；`request-review` 资产归 F100/规则 owner，gate 与 review guard 归各自执行面，运行耗时归 F153，长期 eval 归 F192/F267，Program 编排归 F311。

## Why

咱们当前最贵的失败不是“代码写得不认真”，而是**把车造得极其认真，然后开错了方向**：作者和 reviewer 都可能逐渐离开 issue、愿景或 feature contract；同时，小改动支付 full gate、多轮 review 和概念兼容的高成本，最终质量仍没有提高。operator还被迫兼任产品经理、review 调度员、main 绿灯守夜人和人工提醒器。

F314 要兑现的价值不是“再建一套更严格的 SOP”，而是：

1. 每次开发都能从 accepted source 追到 exact HEAD 的非作者结论；
2. 证据成本与真实风险相称，full gate 不再是认真程度徽章；
3. 猫内默认闭环，operator只在不可替代的价值冲突出现时介入；
4. 初始机制由我们依据本次真实事故共同设计，后续效用不靠信仰维护，而由 F311 用真实 episode 做 keep / tune / sunset。

## Current State / 现状基线

- 本 thread 已确认六类重复失败：小事被流程吃掉、实现与 review 同漂、旧设计被兼容层封存、概念与球权增生、质量仪式无质量增益、闭环税回到operator。证据索引见蓝图 §0。
- 两猫已冻结完整的软 / 硬 / observability / eval 机制选择与负向契约，蓝图已在 `c72b89139c` 进入 main；本次 operator 消息授权正式立项并采用“人工出生、F311 后续进化”的实验生命周期。
- F311 Program 已真实存在，但截至本次立项读取仍为 `stage=constituting / observation=insufficient / sequence=1`：goal、measurement、economic、value owner、四测量角色以及真实 observation joins 尚未齐全。F314 不把聊天共识冒充 constitution 完成。
- Ragdoll曾有本地、未 commit、未 push 的实现草稿，并明确同意对齐前不算数；F314 不把该草稿当作既成实现或 scope 锚点。
- **Baseline window 冻结为 2026-09-02 F314 kickoff 至 accepted-source anchor PR 合入前**；该 PR 合入即 treatment 开始。窗口内复用既有 F153、feat-close 与自然纠正记录，缺失部分保持 typed `insufficient`，不补造样本。

## Association Decision / 为什么是新 Feature

| 候选归属 | 裁决 | 理由 |
|---|---|---|
| F100 子任务 | 否 | F100 拥有 Process Evolution 方法与被调节的 `request-review` 资产，但不负责 gate、main-health 与整条开发交付验收。 |
| F311 新 Phase | 否 | F311 只拥有 Program identity/lifecycle 与 owner refs；把领域干预塞进 F311 会违反“引用不是所有权”和单变量约束。 |
| F314 独立实验 Feature | 是 | 它有独立用户旅程、初始交付、跨 owner 验收、回滚边界与首次实验闭环；完成后长期迭代回到 F311，不让 Feature 永久充当手工追踪器。 |

## What

### Phase A: 人工出生与边界冻结

我们先把真实痛点、accepted source、逐项机制选择、owner matrix、负向契约和实验出生证共同冻结。这个阶段由人猫共创完成，F311 不反向生成自己的初始愿景、样本或成功标准。

### Phase B: 一次完整的初始干预交付

默认用**一个可回滚 implementation PR**交付蓝图中的六项能力；只有真实代码 ownership 或回滚边界证明必须拆分时，才允许至多两个 PR，禁止按“软 / 硬 / eval”拆票：

1. `request-review` durable artifact 增加 accepted-source anchor 模板；
2. gate-time 比较 accepted revision，source 移动时要求 author 显式 re-ack；
3. targeted/full classifier 内嵌现有 `pnpm gate`，机器推导可推导信息，只留一个只能加严的 `--risk <axis>`；
4. 同一 PR 正式 `CHANGES_REQUESTED >= 4` 时暂停一次自动 re-request，回读 accepted source 并写 Finding Pattern Summary；
5. 通用、项目 opt-in 的 main-health schedule template + guardian skill；Clowder AI 在能力落地时明确 opt in；
6. F153 接入 stage duration、full-gate 次数、失败相关性与重跑观测。

Soft / hard / eval 按 claim 分工：anchor 模板先作为低成本软干预；revision、gate route 与 R4 brake 是确定契约 guard；耗时与 main 红灯是运行健康；只有“anchor 是否真的减少 intent drift”进入 F311。

### Phase C: F311 接管后续效用迭代

Phase B 的 exact version、证据与 owner receipts 进入既有 Evolution Program。F311 在出生证齐全后运行真实 baseline、live holdout、归因与 keep/tune/sunset：

- Cycle 1 唯一干预变量是 accepted-source anchor 模板；
- 每一轮只改一个 owner-owned 变量，先有 intervention card，再由资产 owner 修改并返回 receipt；
- deterministic guard 的 bug/契约修复仍走原 owner 的 test/guard，不因存在 Program 而等待 eval；
- F311 Phase 3 已足以在成熟证据上形成 `keep | sunset | insufficient`；只有结论为 `tune`、需要受治理写回 owner 资产时，才依赖 Phase 4 的 mutation + fresh outcome 闭环；
- 未来若要评估另一个不确定机制，必须另立 E0 合格 claim/Program，但仍可挂在 F314 的产品边界下；不得把多个变量塞进本 Program；
- 首次可行动 verdict 完成后，F314 可以关闭；后续 Program 周期继续由 F311 与具名 consumer 持有，不靠operator或 F314 backlog 人肉续命。

## User Journey

### Primary Journey: 交付一件事，不被流程带离原意

- **Scope unit**: development episode
- **Actor**: operator、author 猫、reviewer 猫、愿景守护猫
- **Entry**: operator给出一句小事、issue 或 Feature contract，形成 accepted source。
- **Flow**:
  1. Author 开工时绑定 source ref；Feature 用 `docs/features/F*.md@<commit>`，小事用 source message ref，不复制正文。
  2. 实现期间 source revision 若移动，现有 gate 要求一次 re-ack；未移动则零额外动作。
  3. Reviewer 针对 exact HEAD 给结论；blocking finding 必须锚到 accepted source 或数据、安全、契约、不可逆风险，并证明与当前 diff 的因果。
  4. Gate 自动选择最低充分证据；语义风险只能由 author 用 `--risk` 加严，不能降权。
  5. Review 达到四次正式 changes-requested 时，只暂停一次自动重投并回源复盘，不新建 Round、lease、verdict 或 custody。
  6. 合入后，项目若 opt in main-health subscription，由 guardian 猫看红灯并完成 triage；operator不用巡夜。
  7. 后续真实 episode 被既有 F153/F281/feat-close/F299 owner surfaces 观察；F311 的 consumer 决定 anchor 机制 keep、tune 或 sunset。
- **Success evidence**: exact-source → exact-HEAD → non-author verdict 的可追溯链；targeted regression tests；Clowder AI main-health opt-in 的真实通知/triage；F311 canonical Program 的首次可行动 verdict。
- **Non-goals**: 新 UI、新 store、新 task/incident/verdict/receipt/registry；让用户打标签；把 main-health 强加给社区；在第一周期修改 L0；用更多 PR、reviewer 或 full gate 代表质量。

## Eval Birth Certificate / F311 出生证

### E0 资格

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

- [ ] AC-B1: 一次实现交付覆盖蓝图六项能力；默认一个 PR、至多两个且每次拆分有真实 ownership/rollback 证据；changed files 与 PR/commit 可复核→Why②
- [ ] AC-B2: request-review durable artifact 在 #1371 退役 lease 后仍能保存 accepted-source anchor；至少一个 source-moved fixture 要求 re-ack、一个 unchanged fixture 零提示→Why①
- [ ] AC-B3: `pnpm gate` 在不增加第二命令/文件/receipt 的前提下推导 targeted/full；`--risk <axis>` 只能加严；targeted/full 正反 fixture 均通过→Why②
- [ ] AC-B4: 同一 PR 的正式 changes-requested 达到 4 次时仅暂停一次自动 re-request；外部 GitHub 路径不等 #1371，家里路径只接退役后 durable review fact；history 不可得时 warn-open；回归证明没有 Round/Reset/lease/verdict 新状态→Why①②
- [ ] AC-B5: 通用 main-health template 可由任意项目显式注册；Clowder AI 真实 opt in 后以覆盖 main HEAD 的既有 exact-tree receipt + 便宜 `pnpm check` 为 health source，由 guardian 收到 red/green/unknown + bisect candidates；不得为 main 另排 full gate，且没有新 task/incident/store/UI→Why③
- [ ] AC-B6: F153 可从真实 run 读取 stage duration、full-gate 次数、失败相关性与 rerun；失败路径与 diff 无关时在原执行面就地可见→Why②
- [ ] AC-B7: exact-HEAD targeted tests、非作者 review 与 landed Alpha/真实运行验收共同证明最终内容；不得以 full gate 次数或旧 review SHA 冒充完成→Why①②

### Phase C（F311 后续自进化）

- [ ] AC-C1: existing Program 完成 constitution，goal/measurement/economic/value-owner/四角色均为 canonical owner refs；consumer 解析不到具名猫时保持 `consumer_missing`，不找 operator 填坑→Why③④
- [ ] AC-C2: Program 连接 F299 trajectory、至少两个异质 owner surfaces、F267 decision proof、consumption/exposure/holdout proof；缺任一项只报告 typed `insufficient`→Why④
- [ ] AC-C3: Cycle 1 只改变 accepted-source anchor 模板；intervention card 含竞争归因、单一 lever、预期 delta、双 falsifier、cost/rollback、replay 与独立 holdout→Why④
- [ ] AC-C4: 首个成熟窗口输出 keep/tune/sunset/insufficient 之一；primary 与两条 guardrail 不相加，任何 guardrail 恶化都不能被 primary 抵消→Why②③④
- [ ] AC-C5: 首次成熟 `keep | sunset` verdict 回链后 F314 可关闭；若为 `tune`，则须再回链 Phase 4 owner mutation receipt + fresh outcome 才关闭；`insufficient` 继续自动收证据。后续周期由 F311 与具名 consumer 延续，F314 不保留人工催办责任→Why③④

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “我们可以立项了” | AC-A1, AC-A2 | Feature truth + BACKLOG + source ref | [x] |
| R2 | “这个项目可能可以特殊点实验项目” | AC-A3, AC-C3, AC-C4 | 出生证 + intervention card + first verdict | [ ] |
| R3 | “这个出生是我们建立的” | AC-A1, AC-A3, AC-B1 | 两猫蓝图 + operator kickoff + initial delivery receipt | [ ] |
| R4 | “后续优化迭代我们接入 F311 的自进化” | AC-C1–AC-C5 | canonical Program projection + outcome refs | [ ] |
| R5 | 质量与效率都必须改善，不能把闭环甩给operator | AC-B3–AC-B7, AC-C4–AC-C5 | targeted tests + F153/F281 guardrails + role resolution | [ ] |

### 覆盖检查

- [x] 每个需求点映射到至少一个 AC。
- [x] 每个 AC 均有可执行的命令、source ref、owner projection 或真实运行证据。
- [x] 本 Feature 无新 UI，前端需求→证据映射不适用。

## Dependencies

- **Evolved from**: F100（Process Evolution 方法与 `request-review` asset owner）。
- **Blocked by**: #1371 lease 退役线只阻塞 AC-B2 与 AC-B4 的家里 review-history 接口；AC-B3、B5、B6 及 AC-B4 的外部 GitHub 路径不跟随等待。
- **Related**: F153（运行成本 truth）、F167（既有 A2A 责任语义）、F192/F267（eval/measurement）、F281（自然 human disposition）、F303（概念归一）、F311（永久 Program 控制面）。

## Risk

| 风险 | 缓解 |
|---|---|
| “实验”变成无限期项目 | 首次可行动 verdict 后 F314 关闭；后续由 canonical Program 持有 |
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

## Review Gate

- Phase A 内容判断复用本 thread 两猫收敛与Ragdoll `TRANSCRIPTION APPROVED`，并以本次 operator kickoff 作价值授权。
- Phase B 由Maine Coon实现，按每个 claim 选择 targeted test/guard/telemetry；PR-1 由 Terra review，PR-2 由 Opus 5 review；最终证据必须覆盖 exact substantive HEAD。
- Phase C 只消费 canonical F311/F192/F267/source-owner refs；任何 `insufficient` 都保持可见，不用聊天结论补空。
