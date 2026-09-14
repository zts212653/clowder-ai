---
feature_ids: [F257]
topics: [harness-ledger, objective, evaluation, tracing, metrics]
doc_kind: implementation-plan
created: 2026-08-04
---

# F257 Objective Evaluation Redesign Implementation Plan

**Feature:** F257 — `docs/features/F257-harness-ledger.md`
**Goal:** 把 Harness Ledger 重构为 raw-first 的 Objective Unit 评估闭环：非结构化 `TraceEpisode` 是所有 Unit 共用的 canonical fact pool；同一 Objective 挂靠的多个段组成一个 Unit；每个 Unit 拥有独立的 readiness/cadence 水位；结构化反例只作为高优先级检索锚点和触发信号；到达评估节点后**只冻结该 Unit 的时间窗与目标/指标/版本引用（不复制 tracing 数据，见 assets/F257/terminal-contract-v1.md TC-4）**，由 eval cat 按窗从共享池读取并完成语义判断，最终追加可追溯结果。
**Acceptance Criteria:** AC-1 tracing 从 invocation 已有起点持续采集并在 terminal 时以 `invocationId/inputMessageId/outputMessageId/traceTurnId` 精确闭合；AC-2 MCP 只写 pending marker，不直接制造评估结论；AC-3 annotation 是提示/触发 sidecar，不是 raw evidence admission gate，全部 episode 留在 owner 共享 raw pool；AC-4 count 指标无需分母，高置信去重反例可触发 Unit 评估；AC-5 rate/semantic/replay 指标各自显式声明输入和规则；AC-6 Objective 静态定义与每周期有效策略/生命周期分离，CycleRecord 仅保存 `active/dormant/retired` 与当前 N/M/D，不新增第二套流程状态机；AC-7 每个 Objective Unit 以“高置信反例达到阈值 / owner raw tracing 达到容量 / 距周期起点达到 cadence”三路 `anyOf` 独立调度；N/D 依结论自适应（keep 升 / rollback·evolve 降；D 另需“连续多次 cadence-only 触发且全 keep”），不低于出厂值 N=200·M=3·D=7 天，变更写入 CycleRecord；M 在根因级去重落地前冻结于出厂值；AC-8 CycleRecord 只冻结时间窗、Objective/Metric/成员 hook/版本引用（**不内嵌 episode 正文**）；AC-9 旧 `SegmentJudgment` 不再作为评估或 Console 真相源；AC-10 每个段恰好归属一个 Objective，一个 Objective 可含多个段，一次结果投影到全部成员段；AC-11 Tracing Console 只显示唯一 Objective 的两组触发水位、cadence 与回放，Eval Console 只显示评估方式、规则与结果；AC-12 旧派生评估数据不迁移且不删除原始 tracing/message/thread；AC-13 分类不得搬移、改写或排除 raw trace；AC-14 eval cat 从高置信反例开始按窗分页读取 owner pool，回写的 evidenceRefs 必须属于冻结窗口；AC-15 cadence 基线持久化为 owner 池首条 trace 或上周期终点，重复扫描不得后移；AC-16 跳过/insufficient_evidence **仍推进下一周期起点到本周期终点**，下次通过 `windows[]` 逆序回看连续 skip；AC-17 evaluation 回写后自动进入 governance，仅回退/演进产生审批卡；AC-18 评估未回写时系统仅重触发一次；AC-19 Semantic Sweep 已移除，历史 annotation 仅审计。**本 AC 列表与 `assets/F257/terminal-contract-v1.md` 冲突时以后者为准。**
**Architecture cell:** harness-eval
**Map delta:** update required
**Map delta why:** `harness-eval` 的核心产物现为 TraceEpisode/TraceAnnotation/CycleRecord/ObjectiveVersionSnapshot；需要明确 owner 线性池、策略适配、whole-hook governance 与 Console 的单一读面。
**Architecture:** terminal seam 追加不可变 episode closure并写 owner-scoped raw index；任何 `observed/absent/disabled` 只作为 episode 属性。manifest 保证一段一 Objective，一个 Objective 可挂多段。checker 用 CycleRecord 当前 N/M/D 对 owner raw volume、高置信 annotation 与 durable cadence 做三路 `anyOf`，只冻结时间窗和内容寻址版本引用。异步 eval cat 先看高置信反例再分页读取全窗口，结构化回写 per-metric 结论与反例根因计数；governance 对 whole hook 的 content/condition params/enablement 产原子动作列表，并确定性调整 N/D。主请求路径不运行 LLM，也不等待 eval。
**Tech Stack:** TypeScript, Redis/ioredis, Node test runner, YAML registry/manifest, React/Next.js Console
**前端验证:** Yes — reviewer 必须用 Browser/Playwright 实测 Eval 指标卡、Tracing 回放剧场和段编辑器。

---

## 0. Straight-line finish line

终态 B：任何 invocation 都形成可回放 `TraceEpisode` 并进入 owner 级共享 raw pool；一个 episode 即使没有 annotation、只有 absent/disabled opportunity，或已经被分类，也仍是 raw evidence。每个 Objective 维护高置信 counterexample、owner raw volume 与 cadence 三路水位；任一路到达时只冻结时间窗和内容寻址版本引用。高置信反例只改变 eval cat 的检索顺序，eval cat 可按 cursor 继续读取全部窗口并结构化回写结论与根因数。

Console 的职责边界固定如下：

- Tracing 回答“何时足够评估这个 Unit”：显示当前/所需 raw TraceEpisode 数、当前/所需 distinct counterexample 数、cadence 窗口、结构化锚点和原始 episode 回放。
- Eval 回答“每个指标如何评估、结果是什么”：显示 evaluator、ruleRef、最近结果及其证据窗口，不重复渲染按指标拆分的调度进度或“下次触发”。
- manifest 中的 per-metric trigger 仍是 scheduler 的内部契约；它不等于 Console 上面向 operator 的 Unit readiness，也不能把同一 episode 因多指标命中重复计数。

不做：

- 不在主回复路径调用 LLM。
- 不让 tracing 决定 Objective、Metric 或 verdict。
- 不把所有指标强制压成 `numerator / denominator`。
- 不保留旧 objective id、旧 SegmentJudgment 或旧派生数据的兼容层。
- 不删除/flush Redis、SQLite、thread、message、raw trace 等持久数据。
- 不把 verdict 重新写入 Git/PR；继续使用 local artifact store。

### 0.1 Semantic Unit metric birth certificate

```yaml
metric_birth_certificate:
  utility_claim: >-
    同一真实 Unit opportunity 上的语义反例下降，才支持 harness utility 改善；
    structured rule hit 下降本身不支持该结论。
  estimator: >-
    冻结窗口内全部 eligible TraceEpisode（含 observed/absent —— 段状态是 episode 属性，不是准入门；违反即 DV-8）；先检索结构化锚点，
    再由 eval cat 渐进读取 raw trace 并输出 labels/explanation；服务端记录 evaluator/model version 与实际检索 provenance。
  validity_bounds: >-
    terminal/segments/message 缺失、证据不足、judge 未版本化、Unit attachment 改变时，
    结果不可直接用于跨窗比较或自动治理。
  consumer: >-
    ObjectiveJudgment 与 Segment Eval Hub 消费；任何自动治理仍需要 intervention card 与独立 acceptance。
  calibration_plan: >-
    evaluator/model/rule version 改变时重建基线；每月抽样人工复核；系统性分歧时冻结自动消费并 bump judge version。
  repeatability_contract: >-
    该指标用于 discovery/attribution，不承诺 bit-exact；snapshot 冻结 raw cohort、attachments 与 model version，
    cursor receipt 冻结实际 evidence identity+digest，重试只接受同源内容；最终 acceptance 使用独立 holdout/multi-run tolerance。
```

六公理自检：E1 把 absent opportunity 纳入 universe；E2 保留多指标结果向量而非压成单分；E3 raw trace 是事实锚点、annotation 只给检索优先级；E4 snapshot/job/result 都携带 version；E5 不把该 eval 分数回灌成同窗输入；E6 本轮语义判断只承担 discovery/attribution，真正验收另走 holdout/replay 契约。

## 1. Terminal schema

```ts
type MetricKind = 'counter' | 'rate' | 'semantic' | 'replay';
// `semantic-sweep` is retained only so historical annotations remain readable.
type AnnotationSource = 'mcp-marker' | 'structured-rule' | 'semantic-sweep';

interface TraceEpisodeRef {
  traceTurnId: string;
  invocationId: string;
  threadId: string;
  catId: string;
  inputMessageId: string;
  outputMessageId: string;
}

interface TraceTerminalExtension extends TraceEpisodeRef {
  terminalAt: number;
  terminalKind: 'completed' | 'failed' | 'cancelled';
  outputText?: string;
  toolCalls: Array<{ toolName: string; callId?: string; outcome: 'ok' | 'error' }>;
}

interface PendingTraceMarker {
  markerId: string;
  invocationId: string;
  ownerUserId: string;
  subjectCatId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: Array<{ unitType: 'segment'; unitId: string; clauseId?: string }>;
  polarity: 'counterexample' | 'positive' | 'candidate';
  note?: string;
  createdAt: number;
}

interface TraceAnnotation {
  annotationId: string;
  episodeRef: TraceEpisodeRef;
  source: AnnotationSource;
  ruleId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: Array<{ unitType: 'segment'; unitId: string; clauseId?: string }>;
  polarity: 'counterexample' | 'positive' | 'irrelevant' | 'unscorable';
  confidence: number;
  incidentKey: string;
  evidenceRefs: string[];
  createdAt: number;
}

interface MetricDefinition {
  id: string;
  kind: MetricKind;
  evaluator: { kind: 'code' | 'llm' | 'replay'; ruleRef: string };
  trigger:
    | { kind: 'distinct-counterexamples'; threshold: number; lookbackMs?: number }
    | { kind: 'minimum-sample'; minimum: number; windowMs: number }
    | { kind: 'cadence'; cadence: 'daily' | 'weekly' | `every-${number}d` };
}

interface EvaluationSnapshot {
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  evaluationModelId: string;
  evaluationModelVersion: string;
  unitRefs: Array<{ unitType: 'segment'; unitId: string; clauseId?: string }>;
  metricDefinitions: MetricDefinition[];
  window: { start: number; end: number };
  traceCorpus: TraceEpisode[];
  episodeRefs: TraceEpisodeRef[];
  annotationIds: string[];
  samples: TraceAnnotation[];
  createdAt: number;
}

interface MetricResult {
  resultId: string;
  snapshotId: string;
  objectiveId: string;
  metricId: string;
  kind: MetricKind;
  value:
    | { kind: 'counter'; count: number; threshold: number }
    | { kind: 'rate'; numerator: number; denominator: number; rate: number }
    | {
        kind: 'semantic';
        labels: Record<string, number>;
        explanation: string;
        retrieval: {
          frozenCorpusSize: number;
          inspectedInvocationIds: string[];
          priorityAnchorIds: string[];
          exhausted: boolean;
        };
      }
    | { kind: 'replay'; passed: number; failed: number };
  evaluatedAt: number;
}
```

> **历史模型警告（2026-09-04）**：上面的 `EvaluationSnapshot` / `MetricResult` 形状仅保留为方案演进考古，不再是实现指令。当前生产契约是轻量 `CycleRecord`（只冻结窗口与内容寻址版本引用、不复制 corpus）+ owner 线性池按窗读取；唯一规范见 `docs/features/assets/F257/terminal-contract-v1.md` TC-1～19。

`EvaluationIndexer` 不是语义判断器。它只执行 annotation 的确定性校验、按 `incidentKey` 去重并维护提示水位。raw eligibility 仅由 owner + 半开时间窗确定，annotation 与 `summary.segments[].status` 都不参与 admission。Semantic Sweep 生产路径已移除；历史 annotation 只作审计。

## 2. Stateful object census

### 2.1 TraceEpisode closure

Lifecycle owner：invocation terminal seam。prompt trace producer 只能创建 open trace；terminal seam 只能一次性闭合或幂等重放同一 closure。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| absent | prompt trace persisted | open | 写 summary/detail/replay exposure |
| open | terminal completed/failed/cancelled | closed | 写 terminal extension，注册 episode index |
| closed | identical terminal retry | closed | no-op |
| closed | conflicting terminal retry | closed | fail closed + anomaly log，不覆盖 |
| absent | terminal before trace persist | terminal-pending | 暂存 terminal extension |
| terminal-pending | late trace persist | closed | 原子绑定并删除 pending terminal |

旁路约束：generic trace delete 只用于明确 owner-scoped 单 turn 删除；annotation/result store 不随之自动级联删除，以保留审计引用并显示 `source_missing`。

不变量：

- INV-1 一个 `invocationId` 最多对应一个 canonical episode closure。
- INV-2 closure 的四个 join id 一旦写入不可修改。
- INV-3 terminal retry 不产生第二个 episode。
- INV-4 LLM/eval 错误不能改变 invocation terminal outcome。

### 2.2 PendingTraceMarker

Lifecycle owner：marker resolver（terminal seam 后异步执行）。MCP callback 只允许 create；不得直接 resolve、delete 或计数。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| absent | authenticated MCP trigger | pending | append marker keyed by invocationId |
| pending | episode closes | resolved | 原子创建 TraceAnnotation 并标记 resolved |
| pending | same MCP retry | pending | incidentKey 幂等 no-op |
| pending | terminal exists before marker | resolved | 读取 closure 后立即解析 |
| pending | resolver crash after annotation append | resolved | annotation idempotency 后补 resolved marker |
| pending | retention audit finds no invocation | orphaned | 记录 diagnostic；不伪造 annotation |

不变量：

- INV-5 pending marker 本身永不计入 Metric。
- INV-6 marker 的 owner/subject 来自 server-trusted principal/invocation，不信任 body。
- INV-7 resolve 后 annotation 必须引用 exact episode，禁止时间窗猜测。

### 2.3 TraceAnnotation ledger

Lifecycle owner：TraceAnnotationStore。无 update/delete API；修正通过追加 `supersedesAnnotationId`（V1 可先只支持 append）。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| absent | append valid annotation | present | SETNX record + objective/metric/unclassified indexes |
| present | same annotation retry | present | no-op |
| present | same id different payload | present | fail closed |
| unclassified episode | semantic annotation append | classified | 从 unclassified 工作索引 ACK，raw trace 不改 |
| unclassified episode | irrelevant/unscorable append | terminal-classified | 避免每个周期重复送 LLM |

不变量：

- INV-8 三种 source 使用完全相同的 annotation schema。
- INV-9 annotation append 与 index 更新原子化；重复 `incidentKey` 不重复计数。
- INV-10 raw trace 内容不可被 annotation 回写或改写。

### 2.4 历史：EvaluationSnapshot / UnitSemanticEvaluationJob / MetricResult（已由 CycleRecord 取代）

> 本节记录旧状态机为什么被淘汰。`snapshot / job / receipt / watermark` 不得据此重新接回生产路径；现行周期语义由 CycleRecord 五态、窗口引用与专属 Objective thread 承担。

Lifecycle owner：EvaluationScheduler 创建 snapshot，EvaluatorRunner 完成，MetricResultStore 追加结果。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| no snapshot | Unit 三路 trigger 均未 ready | no snapshot | 保留首条 eligible trace 的 durable cadence baseline |
| no snapshot | counterexample/raw volume/cadence 任一路 ready | queued | 原子冻结**时间窗 + hints/attachments/versions 引用**（不复制 corpus，TC-4） |
| queued | eval cat prepares semantic job | running | 确定性 job id + evaluator principal custody |
| running | eval cat cursor retrieval | running | append cursor receipt（invocation identity + evidence digest，不复制 message body） |
| running | code/LLM/replay 全部成功 | completed | append 全部 MetricResult，原子 commit Unit judgment + actual completion watermark |
| running | evaluator fails | retryable | 保留 snapshot，释放/超时 lease |
| retryable | retry succeeds | completed | 同一 snapshot 只写一个 result |
| completed | scheduler repeats same range | completed | watermark 防重复 run |

不变量：

- INV-11 snapshot 一旦创建不可修改；重试读取同一输入。
- INV-12 count threshold 只数 distinct `incidentKey` episode，不数重复 annotation。
- INV-13 counter 结果不包含虚构 denominator/rate。
- INV-14 semantic worker 不在 invocation 主流程运行。
- INV-15 completed watermark 只在 result 持久化成功后推进。
- INV-16 annotation/classification 不得改变 raw corpus membership。
- INV-17 首条 eligible trace 的 cadence baseline 只写一次；重复扫描不得造成 sliding starvation。
- INV-18 cursor receipt 不可改写，重复 cursor 只能验证同一 evidence digest；source 漂移/删除时失败关闭且不复活正文。
- INV-19 同一 Objective 的全部 attached segments 属于一个 Unit，同一 judgment 投影到每个成员段。

### 2.5 Derived indexes/cursors

索引与 readiness 全部是可重建投影；不得成为第二真相源。EvaluationIndexer 使用 per-owner cursor，advance 必须与目标索引写入原子化；cursor 丢失可从 annotation ledger 重放。

## 3. Adversarial test matrix

| Scenario | Expected | Invariants |
|---|---|---|
| terminal 先于 prompt trace persist | 后到 trace 自动闭合 | INV-1..4 |
| terminal 双写且 payload 冲突 | 原 closure 保留，冲突可见 | INV-1..3 |
| MCP marker 重试 3 次 | 只产生一个 annotation | INV-5..9 |
| resolver 在 append 后 crash | 重启后补 resolved，不重复计数 | INV-7..9 |
| 两个结构规则同时命中同一 incident | 同 incidentKey 只计一次 | INV-9,12 |
| 3 个 distinct counterexample、阈值 3 | 恰好创建一个 snapshot | INV-11,12,15 |
| 10 个 trace 无 annotation | 只进入 async sweep，不阻塞回复 | INV-4,10,14 |
| 200 个 trace 全无 annotation | raw volume 仍触发并冻结 200 条 Unit corpus | INV-11,16 |
| episode 添加 classified annotation | owner raw corpus 计数与 membership 不变 | INV-10,16 |
| 首条 trace 后 scheduler 多次扫描，尚未满 7 天 | cadence baseline 不后移；第 7 天恰好触发 | INV-15,17 |
| 同一 cursor 重试但 source content 已漂移 | 返回 evidence_changed，不回放 shadow copy | INV-11,18 |
| Objective 挂两个 segments | 一次 Unit result 在两个 segment read model 均可见 | INV-11,19 |
| LLM timeout/格式错误 | snapshot retryable，主 invocation 不受影响 | INV-4,11,14 |
| evaluator 写 result 后在 watermark 前 crash | retry 读到同 result 并补 watermark | INV-11,15 |
| trace 被 owner 删除后结果仍引用 | Console 显示 source_missing，不复活 trace | INV-10,11 |
| 旧 SegmentJudgment Redis 数据存在 | 新 read model 完全忽略 | AC-9, AC-12 |

## 4. Implementation tasks

### Task 1: Write contract tests for terminal trace correlation

**Files:**
- Modify: `packages/shared/src/types/injection-trace.ts`
- Modify: `packages/api/src/domains/prompt-hooks/InjectionTraceStore.ts`
- Test: `packages/api/test/injection-trace-store.test.js`
- Test: `packages/api/test/f257-trace-episode-correlation.test.js`

1. 写红测：trace first、terminal first、identical retry、conflicting retry、四 join id 完整。
2. 运行 `pnpm --dir packages/api build && node --test packages/api/test/f257-trace-episode-correlation.test.js`，确认缺少 API 失败。
3. 增加 `TraceTerminalExtension`、episode/pending-terminal keys 与 Lua 原子闭合。
4. 将 route serial/parallel/invocation terminal seam 写入 exact refs；不新增 LLM work。
5. 重跑测试，预期全绿；commit `feat(f257): close trace episodes at invocation terminal`。

### Task 2: Replace direct MCP observation with pending marker

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.ts`
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.ts`
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/resolve-pending-markers.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/deviation/report-harness-signal.ts`
- Modify: `packages/api/src/routes/callbacks.ts`
- Modify: `packages/mcp-server/src/tools/report-harness-signal-tool.ts`
- Test: `packages/api/test/report-harness-signal.test.js`
- Test: `packages/api/test/harness-eval/trace-annotation-store.test.js`

1. 写红测：MCP 返回 marker id；terminal 前 annotation count=0；terminal 后 exact resolve=1；principal spoof 被拒。
2. 跑 focused 测试确认旧 direct `ManualObservationEvent` 行为使测试失败。
3. 实现 marker/store/atomic resolver；工具文案改为“标记当前 invocation，terminal 后关联 tracing”。
4. 保留旧 DeviationEventLog 供其他消费者只读，但从此路径拆除；不迁移旧数据。
5. 运行 API + MCP focused 测试；commit `feat(f257): bind harness signals to trace episodes`。

### Task 3: Add the structured annotation producer

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/structured-rule-tagger.ts`
- Test: `packages/api/test/harness-eval/structured-rule-tagger.test.js`

1. 写红测：结构规则和 MCP 写相同 schema；规则只能读取不可变 episode。
2. 实现纯函数规则注册表，规则只能输出 annotation draft，不能改 raw trace。
3. `semantic-sweep` 不设生产者；仅保留 source 枚举以读取历史 annotation，历史记录不得进入触发、排序或治理。
4. 跑测试；commit `feat(f257): bind structured trace annotations`。

### Task 4: Canonize 23 Objectives, 46 unit attachments, and metric models

**Files:**
- Modify: `docs/harness-feedback/objectives/registry.yaml`
- Modify: `packages/api/src/infrastructure/harness-eval/objective-registry.ts`
- Create: `docs/harness-feedback/objectives/unit-evaluation-manifest.yaml`
- Create: `packages/api/src/infrastructure/harness-eval/unit-evaluation-manifest.ts`
- Test: `packages/api/test/f257-objective-registry.test.js`
- Test: `packages/api/test/harness-eval/unit-evaluation-manifest.test.js`

1. 写红测：23 个 slug 精确集合、46/46 段/条款覆盖、无孤儿/重复 clause、metric kind/trigger/evaluator 合法。
2. registry schema v2 增加 `evaluationModelId` 与 metric definitions；Objective 本身无 lifecycle state。
3. manifest 写入 46 段与 clauseId 映射，C1/L1/L2/L3/L4/L7/D16 按条款寻址。
4. 增加 hook asset anchor existence + uniqueness lint。
5. 跑 parser/lint 测试；commit `feat(f257): register objective metrics and unit attachments`。

### Task 5（历史，已取代）: Implement raw-first Unit scheduler and durable watermarks

> 下列文件清单是旧实施计划，不是当前 TODO。终态已经删除 `EvaluationScheduler` / `EvaluationSnapshotStore` / `MetricResultStore`，改由 CycleRecord + owner 线性池 + code-only N/D 自适应策略实现。

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/EvaluationIndexer.ts`
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/EvaluationScheduler.ts`
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.ts`
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/MetricResultStore.ts`
- Test: `packages/api/test/harness-eval/evaluation-indexer.test.js`
- Test: `packages/api/test/harness-eval/evaluation-scheduler.test.js`

1. 写红测：unknown objective/metric fail closed；incident dedupe；200 个 unannotated raw traces；classified trace 仍在 corpus；durable cadence baseline；watermark crash recovery。
2. Indexer 只验证并索引 annotation，不读 message 语义、不运行 LLM。
3. Scheduler 从 owner raw index 按 Objective 的全部 attached segments 投影 Unit corpus；counterexample/raw volume/cadence 三路 `anyOf` readiness，不 ready 只返回 `collecting` 投影。
4. snapshot store 原子 claim并冻结 raw corpus/hints/attachments/versions；MetricResult append-only；counter value 无 denominator。
5. 跑 Redis-isolated focused tests；commit `feat(f257): schedule raw-first objective unit evaluations`。

### Task 6: Wire code/LLM/replay evaluators and retire SegmentJudgment from production truth

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/evaluator-runner.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/manual-trigger/trigger-now.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/domain/eval-domain-daily.ts`
- Modify: `packages/api/src/index.ts`
- Disconnect legacy-only: `packages/api/src/infrastructure/harness-eval/segment-judgment-engine.ts`
- Disconnect legacy-only: `packages/api/src/domains/prompt-hooks/SegmentJudgmentCache.ts`
- Disconnect legacy-only: `packages/api/src/infrastructure/harness-eval/manual-trigger/trigger-now-judgments.ts`
- Replace tests: `packages/api/test/harness-eval/segment-judgment-engine.test.js`

1. 写红测：zero annotations 的 raw corpus 仍可 evaluate；code evaluator deterministic；eval-cat cursor/principal/retry fail closed；replay input frozen。
2. runner 按 metric `evaluator.kind` dispatch；LLM evaluator 只接受 server-issued Unit job/cursor，receipt 记录 identity+digest 而不复制 message body，未知 rule fail closed。
3. daily/N-day/manual 任务先跑 readiness，再把冻结时间窗与 Objective/version 引用注入 eval cat；不再并行运行 Semantic Sweep。
4. 删除 SegmentJudgment 的 production wiring/cache/time-window attribution；legacy 模块只为旧 API/测试兼容保留，新 Console 和评估路径不实例化、不读取。legacy Redis keys 不读不迁移。
5. 跑 manual/daily/lifeline focused tests；commit `refactor(f257): replace segment judgments with metric results`。

### Task 7: Rebuild lifeline read model and Console

**Files:**
- Modify: `packages/api/src/routes/segment-lifeline.ts`
- Modify: `packages/api/src/routes/segment-lifeline-chain.ts`
- Modify: `packages/api/src/routes/segment-lifeline-replay.ts`
- Create: `packages/web/src/components/settings/ObjectiveEvaluationPanel.tsx`
- Create: `packages/web/src/components/settings/SegmentTraceTheater.tsx`
- Modify: `packages/web/src/components/settings/SegmentLifelineModal.tsx`
- Modify: `packages/web/src/components/settings/SegmentEditorModal.tsx`
- Test: `packages/api/test/segment-lifeline.test.js`
- Test: `packages/web/src/components/settings/__tests__/LifelineStageDetail-replay.test.tsx`

1. 写红测：Tracing 显示 Unit 级窗口起点、当前/所需 raw episode、当前/所需 distinct counterexample 及记录；Eval 显示归属/模型/指标的 evaluator、ruleRef、时间和结果窗口；同一 Objective Unit 的 judgment 在全部成员段可见；trace replay 含 input/output/tool/segment scene。
2. 新 `segment-evaluation` read model join manifest + latest MetricResult + episode refs；新 Modal 不读 SegmentJudgmentCache，也不渲染 legacy `EvalStagePanel/LifelineStageDetail`。
3. tracing tab 改 Unit readiness + episode replay theater；仅 ID 降为可复制 provenance。
4. 编辑器对可写 text hook 直接编辑；移除模板来源/冗余预览；变量用 KV；readonly 保留明确原因。
5. Browser/Playwright 截图验证；commit `feat(f257): present objective metrics and trace replay`。

### Task 8: Update truth sources and purge only invalid derived fixtures

**Files:**
- Modify: `docs/features/F257-harness-ledger.md`
- Mark superseded: `docs/features/assets/F257/objective-driven-redesign-v1.md`
- Modify: `docs/architecture/ownership/cells/harness-eval.md`
- Modify: `packages/mcp-server/src/server-toolsets.ts`
- Modify relevant generated fixtures/tests only where they encode legacy judgment semantics.

1. 文档明确 tracing/eval 分工、23 objectives、metric kinds、threshold/cadence、异步 LLM、无 Objective 状态机。
2. 删除 repo 内旧派生 verdict fixture/测试期望（若存在）；不操作 Redis/SQLite/runtime data。
3. 跑 convention graph 重新索引，核对 MCP contract consumers。
4. commit `docs(f257): define annotation-driven objective evaluation`。

### Task 9: Verification and review

1. `pnpm --filter @cat-cafe/shared build`。
2. `pnpm --dir packages/api build`。
3. 运行所有新增/修改 focused tests；预期 0 fail。
4. 运行 F257 Redis isolated suite；预期 0 fail。
5. `pnpm biome check . --diagnostic-level=error` 与 `git diff --check`。
6. `pnpm --dir packages/api test:public`；预期 0 fail。
7. 生成 UI screenshots 和 exact SHA evidence。
8. 请求跨家族 fresh-context review；作者不得自审。

## 5. Technical decisions resolved during implementation

- invocation exact id 的现有来源若不贯穿 route，将在 invocation request object 上增加一个 server-generated id；不得以 timestamp proximity 代替。
- `outputText` 只从现有 canonical MessageStore 在 eval-cat retrieval 时读取；Unit receipt 仅保存 invocation identity + evidence digest，不复制敏感/长文本。源消息被删除或漂移后重试必须 `evidence_changed/source_missing`，不得从 ledger 复活正文。
- annotation correction V1 若无产品入口，仅保留 append-only + deterministic id；不为未提出的人工编辑造 UI。
- Semantic Sweep 生产路径已移除；历史 `semantic-sweep` annotation 不删除，但不参与触发、排序或治理。
- 旧 `SegmentJudgment` 源文件暂留给历史 API/回归测试，但 bootstrap、manual/daily eval、新 `segment-evaluation` read model 与新 Console 均不再消费它。这是“退出生产真相”，不是对旧派生数据做兼容迁移。

## 6. No operator value questions

本轮价值判断均已由 co-creator 明确：旧不合适数据可清理/忽略；tracing 与 eval 分离；MCP 是 trigger；语义分析异步；反例 count threshold 不强求分母。因此没有待升级的价值 OQ。
