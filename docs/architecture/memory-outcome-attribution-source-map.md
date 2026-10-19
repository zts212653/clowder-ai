---
title: "Memory Outcome & Attribution Source Map"
doc_kind: architecture
feature_ids: [F200, F263]
related_features: [F102, F153, F192, F200, F236, F256, F263, F267, F287]
topics: [memory, recall, consumption, outcome, attribution, lifecycle, source-map, observability]
created: 2026-08-15
updated: 2026-08-15
status: census-v0.1
author: "小太阳·Maine Coon/GPT-5.6 Sol"
description: "F200/F263 运行时代码实查的记忆消费→任务结果→单条记忆贡献边界：区分展示、检视、任务级验证与因果归因，登记现有证据、假阴性和 Wave 1 合同输入。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-15T11:59:28Z
---

# Memory Outcome & Attribution Source Map

> **W0-G census v0.1，代码基线 `main@51e5c3893`。** 本文回答一个窄问题：家里现在能否从
> “某条记忆被召回”一路追到“它帮助或伤害了最终结果”？答案是：**能观察展示与后续
> 工具检视，能给整次 invocation/trajectory 挂外部成功信号；不能把成功、失败或污染因果
> 归给某一条 consumed anchor。** 本文是 observation boundary，不是 eval 设计，也不授权先造
> detector、总分或自动降权器。

## 1. 先把五种 claim 拆开

| 层级 | 精确问题 | 当前最强证据 | 当前 verdict |
|---|---|---|---|
| L0 · presented | 某次 recall 是否把 anchor 放进候选集？ | `recall_events.candidates_json`、`presented` | **可观测** |
| L1 · inspected | 猫是否在同 invocation 的有界窗口内对该 target 发起下钻/Read/安全 shell-read？ | `consumed_json` 的 anchor/rank/method/consumingEventId/distance + `attributionClarity` | **代理可观测**；不是思想读取 |
| L2 · used | 该 anchor 是否真的进入推理、判断或交付？ | 文件 read/modified、正文引用等零散旁证 | **无统一 typed observation** |
| L3 · task outcome | 该次工作的交付是否被外部强信号验证？ | `task_trajectories.output_verified` + PR/operator/reviewer/CI signals | **trajectory 级可观测，时间/任务归属仍粗** |
| L4 · contribution | 该 anchor 对结果是 helped / harmed / irrelevant？若不召回会怎样？ | 无 per-anchor outcome edge、无 paired replay/ablation | **不可观测** |

因此，`presented → inspected → outputVerified` 是一条**相关链**，不是因果链。尤其不能做三次
越级：`consumed = 正确`、`verified trajectory = 每条 consumed anchor 都有用`、`没人投诉 = 没污染`。

## 2. 当前真实数据流

```text
memory tool result
  → RecallEventCorrelator
      candidates[]
      consumed[]  ← 同 invocation、≤20 个同猫 tool call 或 ≤300s 的 target match
      resultSetId + attributionClarity(clean|ambiguous)
  → recall_events
      │
      ├─ RecallMetricsComputer / anchor_recall_metrics
      │    exposure、consumption、CTR、ranking navigation signal
      │
      ├─ TrajectoryAggregator
      │    invocationId + recallIds + filesRead/filesModified + query text
      │  → task_trajectories
      │  → OutputVerifiedDetector
      │      PR merged / operator accepted / reviewer approved / CI passed
      │      （强信号落在整条 trajectory，不落在 anchor）
      │
      └─ F263 collectLifecycleTraces
           true-zero → unmet_demand + zero-hit verification
           harmful_consumption → schema/store 已有，生产 emitter 缺席
```

可验证代码坐标：

- `RecallEventCorrelator.ts`：候选、窗口式消费代理、bundle ambiguity 与 source event provenance；
- `TrajectoryAggregator.ts` / `TrajectoryQueryService.ts`：invocation 级 search/read/modify 聚合与整体
  `outputVerified`；
- `output-verified-detector.ts` / `ThreadAwareSignalSources.ts`：强成功信号来源；
- `CrossCatMetricsComputer.ts`：只把“invocation 有任一 consumed row”与 trajectory verified bit 做
  aggregate；
- `f263-lifecycle-collector.ts` / `LifecycleTraceStore.ts`：当前自动产出 true-zero unmet demand 与
  verification；`harmful_consumption` 只有 type/store/query/仪表盘读面。

## 3. Observation coverage matrix

| Claim | Producer / join | 粒度 | 可信边界 | 不能推出什么 |
|---|---|---|---|---|
| 候选被展示 | memory tool summary → `RecallEvent` | recall × anchor | 候选坐标、rank、result set 可回看 | 模型真的注意到了 |
| 候选被检视 | downstream tool target match → `consumed[]` | recall × anchor | exact target 与 shell-read 覆盖已比 HW-4 前可靠；ambiguous bundle 显式标注 | snippet-only 使用、脑内采用、检视后的赞成/否定 |
| 文件被读/改 | invocation tool events → trajectory | invocation × file | 能说明执行路径碰过哪些文件 | 哪个 recall 促成修改；修改是否正确 |
| invocation 成功退出 | evidence status | invocation | 只进入 `invocation_succeeded` signal | 不是 `STRONG_SIGNALS`，不会单独把 output 标 verified |
| 输出被强信号验证 | thread/task store → trajectory | trajectory/thread | PR merged、CI、operator/reviewer acceptance 是真实外部信号 | 信号没有证明某条 anchor 有贡献 |
| 消费后未验证 | consumed-exists join → `unverifiedConsumptionRate` | trajectory | 可做系统健康趋势 | “这条记忆有害”或“任务失败” |
| true-zero 错失需求 | `resultCount=0 + no_results` → F263 trace | recall | 是已观察查询的可靠零命中；明确 lower-bound | 没发起的 query、没被人察觉的写侧 FN |
| 有害消费 | F263 trace schema/store | trace × optional anchor | 若有明确 trace，可带 `recallId/targetAnchor/category` 回查 | 当前没有生产 emitter；零条不代表零伤害 |
| anchor 帮助/伤害终局 | — | anchor × outcome | 无 | 频率、CTR、approve 或 silence 都不能代证 |

## 4. 六个会让“看起来闭环”冒充真实归因的断点

### 4.1 粒度错位：anchor 对 trajectory

`RecallEvent` 可以指向单个 consumed anchor；`TaskTrajectory` 只保存 `searchEventIds[]` 与一枚整体
`outputVerified`。中间没有 `anchor → claim/action/output` 的 typed edge。一个 trajectory 同时消费
十条记忆而最终成功，十条不能共享功劳；失败同理。

### 4.2 检视代理不等于采用

窗口式 Read/graph/shell match 能证明“猫打开了”，不能证明“猫相信并用了”。snippet 直接进入推理
会漏报；读后明确否定仍被计为 consumed；多个 search bundle 只能降为 `ambiguous`，不能恢复内在
判断。因此 L1 可以服务导航健康，不能升级为 truth authority 或贡献 verdict。

### 4.3 强信号很强，归属却太宽

`OutputVerifiedDetector` 接收 `(invocationId, threadId)`，但 PR/operator/reviewer/CI 查询主要是
**thread 级当前状态**；operator/reviewer 只扫最近 50 条消息，接口也没有 trajectory 的开始/结束时间。
`verify-pending` 会用当前 thread 状态扫描旧的未验证 trajectory。故 `outputVerified` 可表示“这个 thread
后来出现强成功信号”，却尚不能稳定证明该信号属于这次具体记忆使用 episode。

### 4.4 trajectory 身份没有结构性幂等围栏

`task_trajectories` 对 `invocation_id` 只有普通 index；`TrajectoryAggregator.persist()` 用随机
`trajectory_id` 做 `INSERT OR IGNORE`。正常单次尾钩可保持一条，但 schema 不阻止同 invocation 重放
生成多条 trajectory。聚合统计因此仍依赖 producer 调用纪律，不能把 row count 当天然独立样本数。

### 4.5 `harmful_consumption` 目前是空插槽，不是运行 detector

F263 已冻结 `stale-pointer | identity-misbinding` 分类、append-only store、查询 API 和三轴读面；但
生产源码全局搜索没有 `kind: 'harmful_consumption'` 的 emitter。`computeThreeAxis()` 已诚实把零条
解释为 `no-data`：**“检测器尚未上报”而不是“没有有害消费”。** 这正是 W0-G 最重要的假阴性。

### 4.6 弱确认的分母与反事实都缺

“用了没出事”只有 silence；“用了并成功”也没有不使用该 anchor 的 paired replay。若直接按高频消费
分配 truth 权力，会把 popularity 正反馈误当知识正确性。反过来，完全不用 consumption 又会丢掉
审计预算分配信号。正确边界是：**频率可以决定更该抽验谁，不能决定谁更真。**

## 5. 现在允许哪些 consumer

| Consumer question | 可用机制 | 允许的 claim | 禁止升级 |
|---|---|---|---|
| 检索/索引是否健康？ | logs/metrics/traces（F153/F200） | exposure、inspect proxy、zero-hit、latency、parser quality | 不挂 utility 总分 |
| 哪些 anchor 值得增加审计预算？ | consumption frequency + age + authority guard | 高依赖 ⇒ 更应抽验 | 高依赖 ⇒ 更正确 |
| 某次明确污染是否可追查？ | F263 typed trace + source owner drill | 已报告 incident 的 source/anchor/category | incident 样本 ⇒ 全体发生率 |
| 某项机制 keep/tune/sunset？ | 有明确 consumer 后走 F192/F267 + eval-design | owner adjudication、负例、burden、outcome 分面 | 用 `outputVerified` 或 approve rate 单指标拍板 |
| 是否自动降权/纠错/forget？ | 当前无授权 | 无 | 观测层直接干预 canonical truth/ranking |

## 6. Wave 1 的合同输入（不是 schema 定稿）

Wave 1 不该先发明“完美因果归因器”，而要冻结**可说到哪一层**：

1. 所有 outcome observation 带 `trajectoryId + bounded time + source event ref`，不只带 thread 当前态；
2. 单 anchor claim 必须带 `recallId + anchor revision + observationKind`，且区分
   `presented | inspected | explicitly_cited | contradicted | adjudicated`；
3. verdict 至少三态 `supported | contradicted | unknown`，silence 永远是 unknown；
4. aggregate 报表必须保留 `attributionClarity`、sample denominator 与 maturity，ambiguous 不混入 clean；
5. harmful observation 要有真实 producer/owner/adjudication 路径；没有 emitter 时 UI 必须继续显示
   `no-data`；
6. observation 只写 shadow ledger；纠错、降权、retire、forget 仍回各 canonical lane 的 owner contract；
7. 只有当某个 keep/tune/sunset consumer 明确需要 L4，才选择 replay、ablation、owner adjudication 或
   其他 eval；不因为“还缺因果”就把所有方法都补齐。

## 7. 对首根纵切选型的约束

W0-G 不替 W0-C/W0-D 选 ASR，也不否决 ASR。首根纵切应等三份 census 合并后再选，并至少满足：

1. **合同覆盖面**：能穿过 Standing Reflex、destination truth、derived/read projection、presentation、
   correction/invalidation 与 outcome 中尽可能多的接缝；
2. **可裁决 outcome**：有 owner 能对正例、负例和“不知道”作低成本 adjudication；
3. **可归因边界**：至少能把 episode 与本次 opportunity/anchor 用 typed source ref 围起来，不靠 thread
   当前态猜；
4. **最少新基建**：优先复用现有 canonical lane 与 correction/forget path，让纵切用来证伪合同，
   不是为一个场景造特供；
5. **能打失败路径**：不仅跑 approve/happy path，还能跑 reject/not-now、stale/correct/forget 与
   absence；否则它只会证明 demo 能跑。

ASR→F276 仍是强候选：它有黄挺 detected-FN、source coordinates、owner adjudication 与现成人物 lane。
但最终选择必须等 W0-C 的 lane 病灶、W0-D 的 lineage seam 与本 W0-G 的可裁决性一起评分。

## 8. W0-G Done / 未完成项

### 本 census 已完成

- 逐字段/producer 画出 `RecallEvent → TaskTrajectory → outputVerified` 真实 join；
- 证明现有最强闭环停在 trajectory/thread 级相关，不能定位单 anchor 因果贡献；
- 证明 F263 harmful schema/store 已有而生产 emitter 缺席，零值是 no-data；
- 给出 Wave 1 attribution boundary 与首根纵切的选择门。

### 仍然开放，但不应现在实现

- trajectory-bound outcome signal（时间窗与 exact task/PR/review coordinate）；
- explicit cite/contradict/adjudicate observation；
- harmful-consumption producer 与抽样分母；
- counterfactual/replay 只在明确 utility consumer 出生后评估；
- 任何 memory update/降权/soft-forget 动作都等 lane-owned remediation + Decision Gate。

## 9. 主要真相源

- [F200 Memory Recall Eval](../features/F200-memory-recall-eval.md)
- F200 Consumption Attribution Audit
- [F263 Memory Lifecycle Repair & Metrics](../features/F263-memory-lifecycle-repair-and-metrics.md)
- `packages/api/src/domains/memory/RecallEventCorrelator.ts`
- `packages/api/src/domains/memory/TrajectoryAggregator.ts`
- `packages/api/src/domains/memory/TrajectoryQueryService.ts`
- `packages/api/src/domains/memory/output-verified-detector.ts`
- `packages/api/src/domains/memory/ThreadAwareSignalSources.ts`
- `packages/api/src/domains/memory/CrossCatMetricsComputer.ts`
- `packages/api/src/domains/memory/f263-lifecycle-collector.ts`
- `packages/api/src/domains/memory/LifecycleTraceStore.ts`

[小太阳·Maine Coon/GPT-5.6 Sol🐾]
