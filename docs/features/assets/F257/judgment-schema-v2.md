---
feature_ids: [F257]
doc_kind: spec
status: accepted
created: 2026-08-31
supersedes: judgment-schema-v1.md#4-patchtrial--修补--验证环行为差分的实验记录
---

# Judgment Schema v2 — Objective 结论与 PatchTrial 测量契约

本契约只接管 Objective-driven evaluator 的结论与试验测量。治理
`Candidate` 继续使用冻结的 judgment-schema-v1 §3，不改字段或状态机。

## 1. 为什么必须换坐标

Objective redesign INV-13 要求 counter 结果不包含虚构 denominator/rate。
旧 PatchTrial 把任何指标强制写成 `violationRate`，会把“3 个明确反例”
伪装成“3 / trace corpus”。v2 保留指标的自然坐标：counter/replay/semantic
label 用 count；本来就有分母的 rate 才归一化为 lower-is-better badness。

## 2. ObjectiveJudgment v2

```ts
type MetricComparisonMeasurement =
  | { kind: 'count'; value: number; howCounted: string }
  | { kind: 'rate-badness'; value: number; howCounted: string };

interface ObjectiveJudgment {
  schemaVersion: 2;
  // v1 既有字段保持；以下是结论环新增权威字段
  verdict: SegmentVerdict;
  verdictDecision: {
    schemaVersion: 2;
    evaluationModelVersion: string;
    metricDecisions: Array<{
      metricId: string;
      rule: MetricVerdictRule;
      status: 'breach' | 'clean' | 'inconclusive' | 'insufficient_evidence' | 'unavailable';
      reason: string;
      measurement: MetricComparisonMeasurement | null;
      attributedSegmentIds: string[];
    }>;
    primaryMetricId: string | null;
    measurement: MetricComparisonMeasurement | null;
    targetSegmentIds: string[];
  };
}
```

`trigger` 只决定何时评估；`MetricVerdictRule` 独立决定测量结果意味着什么。
没有明确判定规则的 metric 必须 inconclusive，不能自动判 alive。
`targetSegmentIds` 只能来自主 breach metric 的 exact counterexample refs；
Objective 的其他成员段可以看到同一结论，但不能因此被批量治理。

## 3. PatchTrial v2

```ts
interface PatchTrial {
  schemaVersion: 2;
  trialId: string;
  candidateRef: string;
  mechanism: Candidate['proposedAction']['mechanism'];
  executedVia: string;
  baseline: {
    window: { startMs: number; endMs: number };
    measurement: MetricComparisonMeasurement;
  };
  treatment: {
    window: { startMs: number; endMs: number };
    measurement: MetricComparisonMeasurement;
  };
  minWindowDays: number;
  outcome: 'improved' | 'no-change' | 'regressed' | 'inconclusive' | 'pending';
  decision: 'solidify' | 'rollback' | 'falsified' | 'pending';
  trace: { beforeHash: string; afterHash: string };
}
```

## 4. 比较与执行不变量

1. before/after 必须是同一个 `primaryMetricId`、同一个 measurement kind、
   同一个 `evaluationModelVersion`；否则 outcome = inconclusive，decision = pending。
2. treatment 窗口不得短于 `minWindowDays`，也不得与批准前窗口重叠。
3. trace hash 必须证明 segment injection state 真实改变；只增加流量不算改变。
4. lower is better：treatment < baseline → improved/solidify；
   treatment > baseline → regressed/rollback；相等 → no-change/solidify。
   对 override-disable 的 retire trial，no-change 证明该段无行为贡献，支持保留停用。
5. rollback executor 缺失或失败时不得关闭 trial；保持 pending 并记录 worker error。
6. Candidate、context、trial 以及 owner/segment indexes 全部 TTL=0。

## 5. 恢复与迁移

- pre-v2 ObjectiveJudgment 由其 immutable EvaluationSnapshot 在读取时确定性
  重建 v2 verdictDecision，再经幂等 governance reconciliation 补候选。
- 本闭环合入前没有 production PatchTrial writer，因此不存在需要原地改写的
  v1 trial 数据。若将来读到非 v2 trial，必须视为 unavailable，不能猜测 rate。
