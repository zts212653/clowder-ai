/**
 * F245 Phase A — Friction Signal 结构化类型
 *
 * 把分散的摩擦信号（爪感差 marker / cancel / 用户反馈 / eval domain）统一成
 * 结构化值对象，供 harness-eval friction rollup 消费。
 *
 * 本文件只定义跨包共享的「值类型」；source port（IFrictionSignalSource）在 api 层
 * `harness-eval/friction/friction-signal-source.ts`（依赖 RedisMessageStore，不进 shared）。
 *
 * 注意：FrictionChannel 是 F245 自有通道枚举，独立先行；与 F236 的
 * domainId/sourceAdapter 注册枚举无关（Phase C 协调，勿混用）。
 */

/** 摩擦信号来源通道。Phase A 仅实现 'paw-feel'，其余 Phase B 起补齐。 */
export type FrictionChannel = 'paw-feel' | 'cancel' | 'user-feedback' | 'eval-domain';

/** 摩擦严重度。Phase A 采集层默认 'medium'，severity 推断留 Phase B。 */
export type FrictionSeverity = 'low' | 'medium' | 'high';

/**
 * 结构化摩擦信号——不可变值对象（DTO），无生命周期状态（无 draft→confirmed 流转）。
 * 幂等靠 deterministic `id`，零持久去重存储。
 */
export interface FrictionSignal {
  /** 幂等键，deterministic：`${channel}:${rawRef}`（同 message+marker → 同 id） */
  id: string;
  /** 来源通道 */
  channel: FrictionChannel;
  /** 触发摩擦的猫（可选，部分通道无归属） */
  catId?: string;
  /** 摩擦发生的 thread（可选） */
  threadId?: string;
  /** 信号时间戳，ISO8601 */
  timestamp: string;
  /** 解析出的工具名；解析失败或措辞无明确工具 = undefined（宁缺勿误拆） */
  tool?: string;
  /** 人话现象描述（marker 内容主体） */
  symptom: string;
  /** 回指源：`${messageId}#${markerIndex}`，幂等键的可追溯部分 */
  rawRef: string;
  /** 严重度。Phase A 采集层默认 'medium' */
  severity: FrictionSeverity;
  /** 原文摘录（整条 marker 文本），便于人工核查 */
  sourceEvidence?: string;
}

/**
 * F245 Phase B — 聚类成员（回指某条 FrictionSignal，保留可追溯锚点）。
 */
export interface FrictionClusterMember {
  /** 成员 FrictionSignal.id */
  signalId: string;
  /** 回指源（messageId#idx / signalRowId / issueId / verdictId#component#metric） */
  rawRef: string;
  /** 成员来源通道 */
  channel: FrictionChannel;
}

/**
 * F245 Phase B — 摩擦聚类。同类信号折叠成 1 cluster（含 count + 成员 evidence refs）。
 * 不可变值对象，无生命周期状态（KD-5 内存聚合，不持久化）。
 */
export interface FrictionCluster {
  /** deterministic：sha1(归一化 cluster key) 前 12 位 */
  clusterId: string;
  /** 代表 symptom（最高频成员，cluster 标题） */
  representative: string;
  /** 成员涉及的通道（去重升序）；跨通道出现 = 强信号（Phase C 排序用 channel diversity） */
  channels: FrictionChannel[];
  /** 成员数（=== members.length） */
  count: number;
  /** 成员 evidence refs */
  members: FrictionClusterMember[];
  /** 此 cluster 由哪层聚出（rule 精确归一 / embedding 语义近似），便于误聚合归因 */
  method: 'rule' | 'embedding';
}

/**
 * F245 Phase C — 五类摩擦传感器形态（F192 §8.1 真相源）。回答"信号怎么来的"。
 */
export type FrictionSensorForm =
  | 'act' // 中断动作：cancel / deny / skip / reject / discard（无语义打断）
  | 'reason' // 中断理由：cancel reason / Magic Word / 明确纠偏 / user edit（动作的语义增量）
  | 'world_truth' // 世界结果真值：test/build pass-fail / merge / rollback（A1 客观成败）
  | 'aggregate_proxy' // 聚合 proxy：burst / 跨线程重复 / 返工 / 链路耗时（趋势，只导航）
  | 'absence'; // 缺席摩擦：bypass / 使用量下降 / wakeup miss（该发生没发生）

/**
 * F245 Phase C — 7-class 根因（= F192 attribution 矩阵，与 api `AttributionClass` 同源）。
 * root cause 是 eval cat 的 attribution **判断**（落在 verdict 的 rootCauseHypothesis）；
 * **producer 不做规则分类**（KD-8：不用 regex/小模型替猫判断 intent，只给 sensorForm + 证据数据）。
 */
export type FrictionRootCause =
  | 'vision_gap'
  | 'translation_gap'
  | 'harness_misfit'
  | 'tool_gap'
  | 'execution_gap'
  | 'environment_drift'
  | 'taste_gap';

/**
 * F245 Phase C P1-4 — 分类后的 cluster：FrictionCluster + sensorForms 标注。
 * sensorForms 由成员 channel **确定性派生**（数据标注，非判断；跨通道 cluster 多值，去重升序）。
 * rootCause 故意不在此（KD-8：eval cat 在 verdict 里判，producer 不替猫分类）。
 */
export interface ClassifiedFrictionCluster extends FrictionCluster {
  /** 该 cluster 涉及的传感器形态（channels 确定性映射，eval cat 可细化为 world_truth/absence） */
  sensorForms: FrictionSensorForm[];
  /**
   * cluster 最高成员 severity（由 producer join input.signals 取 max）。用于排序 + **直接暴露给
   * eval cat**——prompt 让 cat weigh severity，不暴露则 cat 得自己重跑 join（cloud R2 P2）。
   */
  severity: FrictionSeverity;
}

/**
 * F245 Phase D — cluster 在出口层的语义分流。
 * actionable_candidate = 可由 eval cat 提议修复；
 * reference_only = 只展示引用，不进入 propose_thread 出口。
 */
export type FrictionClusterActionability = 'actionable_candidate' | 'reference_only';

/**
 * F245 Phase D — friction cluster 对应的 propose_thread 草稿。
 * 这是 eval cat 的“一键起草”载荷，不代表自动执行。
 */
export interface FrictionFollowupDraft {
  clusterId: string;
  title: string;
  summary: string;
  evidenceRefs: string[];
  suggestedOwnerCatId?: string;
  reportingMode: 'none' | 'final-only' | 'state-transitions' | 'blocking-ack';
  projectPath?: string;
}

/**
 * F245 Phase D — 可进入修复出口的 cluster。
 * mixed-channel cluster 若含 eval-domain 成员，这些 evidence refs 只作 reference-only 附带证据，
 * 不改变本 cluster 可提议修复的主语义。
 */
export interface ActionableFrictionCandidate extends ClassifiedFrictionCluster {
  actionability: 'actionable_candidate';
  followupDraft: FrictionFollowupDraft;
  referenceOnlyEvidenceRefs: string[];
}

/**
 * F245 Phase D — 只展示、不进入修复出口的 cluster（当前 = eval-domain-only）。
 */
export interface ReferenceOnlyFrictionCluster extends ClassifiedFrictionCluster {
  actionability: 'reference_only';
  evidenceRefs: string[];
}

/**
 * F245 Phase B — Friction rollup 的纯函数输入（Phase C rollup 消费）。
 * 给定窗口 → dedup 后全量 signals + cluster 列表 + degraded 标志。可独立测试（fixture → 断言）。
 */
export interface FrictionRollupInput {
  /** 采集窗口 [sinceMs, untilMs) */
  window: { sinceMs: number; untilMs: number };
  /** dedup + intent-filter 后的全量 signal（cluster 成员的并集 ⊆ 此） */
  signals: FrictionSignal[];
  /** 聚类结果 */
  clusters: FrictionCluster[];
  /** 不完整标志：embedding 降级 OR 有采集通道抛错被丢。Phase C 不应把 degraded rollup 当完整发布 */
  degraded: boolean;
  /** 抛错被降级跳过的采集通道（degraded 的明细，便于 Phase C 知道缺了哪个通道；无丢则 []） */
  droppedChannels: FrictionChannel[];
}

/**
 * F245 Phase C — 长尾折叠摘要（Top-N 配额之外的 cluster 聚合统计，不逐条列）。
 */
export interface FrictionTailSummary {
  /** 折叠掉的 cluster 数（未进 Top-N） */
  clusterCount: number;
  /** 折叠掉的成员信号总数 */
  signalCount: number;
  /** 长尾按通道的信号计数（"哪个通道长尾最多"一眼可见） */
  byChannel: Partial<Record<FrictionChannel, number>>;
}

/**
 * F245 Phase C — friction rollup 周期报告（Top-N 配额 + 长尾折叠 + token 上限）。
 * 由 `buildFrictionRollupReport` 从 `FrictionRollupInput` 纯函数派生（零存储，可独立测试）。
 * P1-4 起 `topClusters` 升级为 `ClassifiedFrictionCluster`（只加 sensorForms；rootCause 是
 * eval cat 的 verdict 层判断，KD-8，不由 producer 赋值）。
 */
export interface FrictionRollupReport {
  /** 透传采集窗口 */
  window: { sinceMs: number; untilMs: number };
  /** 报告生成时刻（ISO8601；调用方传入，纯函数不读时钟，保证可测） */
  generatedAt: string;
  /** 深挖区：Top-N cluster（severity × count × channelDiversity 降序，默认 N=10；P1-4 起含 sensorForms） */
  topClusters: ClassifiedFrictionCluster[];
  /** Phase D：可由 eval cat 提议修复的候选 cluster（默认最多 3 个，可调） */
  actionableCandidates: ActionableFrictionCandidate[];
  /** Phase D：reference-only cluster（当前 = eval-domain-only，不重复开修复 thread） */
  referenceOnly: ReferenceOnlyFrictionCluster[];
  /** 长尾折叠摘要（Top-N 之外的 cluster） */
  tailSummary: FrictionTailSummary;
  /** 透传：rollup 不完整（embedding 降级 OR 通道抛错）。degraded 报告不应被当完整发布 */
  degraded: boolean;
  /** 透传：被降级丢弃的通道 */
  droppedChannels: FrictionChannel[];
  /** token 预算：硬上限 cap + 本报告估算 estimated（estimated 超 cap 时触发更激进折叠） */
  tokenBudget: { cap: number; estimated: number };
}

/**
 * F245 Phase C PR1b — 可重放的 friction rollup 选择器（publish_verdict eval:friction 入口）。
 * Provider（`FrictionMetricsProvider`）按窗口解析 → live FrictionRollupInput；generator 据此
 * 用 `buildFrictionRollupReport` 产出 rollup snapshot + verdict.md + bundle。replayable-selector
 * 范式，对齐 `MemoryRecallSourceSelector` / `TaskOutcomeSnapshotSourceRefs`（值类型同地，跟随
 * friction report/input 类型放 shared）。
 */
export interface FrictionRollupSourceSelector {
  kind: 'friction-rollup-snapshot';
  /** 采集窗口下界（含），epoch ms */
  windowStartMs: number;
  /** 采集窗口上界（不含），epoch ms；必须 > windowStartMs */
  windowEndMs: number;
  /** 深挖区 Top-N 配额（producer 默认 10）；正整数 */
  topN?: number;
  /** rollup 报告硬 token 上限（producer 默认 4000）；正整数 */
  tokenCap?: number;
}
