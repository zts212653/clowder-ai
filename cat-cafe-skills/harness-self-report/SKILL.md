---
name: harness-self-report
description: >
  在当前 invocation 的正常执行中发现明确成功、违例或值得复核的 Harness 信号时，自标到现有 Objective/Metric。
  Use when: 当前执行现场出现了可指向既有 Objective/Metric 的行为证据。
  Not for: 评价别的猫或历史 invocation、替代周期评估、每 turn 例行打点、猜测不存在的坐标。
  Output: 绑定当前 invocation 的 pending marker，terminal 后解析为评估优先线索。
---

# Harness Self Report

只报告**当前已认证 invocation**里亲历的信号。它是覆盖度探针和评估唤醒线索，不是自我裁决。

## 决策

1. 已知精确 `objectiveId`、`metricId` 与相关段：直接调用 `cat_cafe_report_harness_signal`。
2. 信号明确但坐标不确定：先调用 `cat_cafe_list_objectives`，只从返回目录选择；仍对不上就不报。
3. `polarity`：
   - `counterexample`：当前行为清楚违背已声明指标；
   - `positive`：当前行为清楚满足该指标，且记录它会帮助后续评估；
   - `candidate`：现象真实，但是否属于该指标仍需周期评估判断。
4. `note` 只写当前可观察事实和为何关联该坐标，不写最终 verdict，也不建议直接改 hook。

## 边界

- 不替别人、别的 thread 或历史 invocation 上报。
- 不为“可能有用”而每 turn 打点；没有具体行为证据就 abstain。
- 同一 invocation 可关联多个 metric，但反例阈值 M 按 Objective 下的 distinct invocation 计一次。
- 自标最多唤醒独立 Objective 评估并排到优先阅读；只有评估回写、非 `insufficient_evidence` 且 operator approve 后，治理才可能改变 hook。
