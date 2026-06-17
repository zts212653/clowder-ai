/**
 * F233 Phase A — 值班简报 DTO（终态 schema 先行，Task 1）
 *
 * 纯投影聚合器 BallCustodyAggregator 的输出契约。零新存储——所有字段从现存数据源
 * 只读投影（task / invocation liveness F194 / F167 telemetry / mention / hold_ball）。
 * 数据源可读路径见 docs/plans/2026-06-12-f233-phase-a-duty-briefing.md 附录 Task 0 探查结论。
 *
 * 数据分级（R1，gpt52 spec review 钉死）：confidence='structured' 可直接信
 * （task / invocation zombie / F167 计数）；'heuristic' 仅候选（mention 启发式——消息模型
 * 无 handoff/fyi/done intent 维度，故只能产候选不产结论）。卡面两者视觉必须可区分。
 */

import type { CatId } from './ids.js';

/**
 * 球的数据来源。与所在区数组解耦：区（needsUser/deadBalls/...）表示"哪种掉球形态"，
 * kind 表示"从哪个数据源投影而来"。例：一个 'task' kind 可落 needsUser 或 staleBlocked。
 */
export type BallEntryKind =
  | 'task' // TaskStore（落 needsUser 或 staleBlocked）
  | 'mention-heuristic' // MessageStore 尾部 @co-creator 启发式（落 needsUser，仅候选）
  | 'invocation-death' // InvocationRecord zombie（F194 liveness 模型，落 deadBalls）
  | 'hold-expired' // 过期 hold_ball（trigger.fireAt < now，落 deadBalls）
  | 'void-pass'; // F167 C2 verdict-without-pass（落 voidPasses）

/** 单颗掉球条目 */
export interface BallEntry {
  kind: BallEntryKind;
  /** R1 数据分级：structured 可直接信 / heuristic 仅候选（卡面视觉必须可区分） */
  confidence: 'structured' | 'heuristic';
  /** 一行标题：这颗球是什么 */
  title: string;
  /** 晾龄（ms）——区内降序排列依据 */
  ageMs: number;
  /** 持球者：死球=catId / 搁置=ownerCatId 或 'user'(operator)；虚空传球可能无明确持有者 */
  holder?: CatId | 'user';
  /**
   * 跳转锚点（优先级 task > message > thread > invocation）。
   * ⚠️ void-pass 恒为空 {}——F167 telemetry id 经 RedactingSpanProcessor 单向 HMAC 不可逆
   * （Task 0 降级声明）；渲染器据"anchor 全空"标注"来自 telemetry · 无跳转"。
   */
  anchor: {
    threadId?: string;
    messageId?: string;
    taskId?: string;
    invocationId?: string;
  };
  /** 补充细节：死球"末扫 03:08 · 无心跳 3.4h"、搁置球 why 摘要、虚空传球 trigger keyword */
  detail?: string;
}

/** 各区计数（头部一行总分——看完这行就能决定要不要往下看） */
export interface DutyBriefingCounts {
  /** 健康活球（KD-3 异常优先：仅计数，正文不列条目） */
  active: number;
  needsUser: number;
  dead: number;
  voidPass: number;
  staleBlocked: number;
}

/** 值班简报终态 DTO（BallCustodyAggregator 输出 → renderBriefingCard 输入） */
export interface DutyBriefing {
  /** 生成时刻（epoch ms） */
  generatedAt: number;
  /** 简报 thread 绑定状态（degraded=绑定失效，头部带 ⚠️ 行，INV-2 不静默吞简报） */
  bindingStatus: 'bound' | 'degraded';
  /** 头部计数摘要 */
  counts: DutyBriefingCounts;
  /** 🔴 搁置球区（structured task + heuristic mention 混合，晾龄降序） */
  needsUser: BallEntry[];
  /** 💀 死球区（invocation zombie + 过期 hold） */
  deadBalls: BallEntry[];
  /** ⚠️ 虚空传球区（F167 C2，锚点降级无跳转） */
  voidPasses: BallEntry[];
  /** 💤 睡美人近似区（blocked task 超龄 >7d） */
  staleBlocked: BallEntry[];
  /** 🟢 健康球：仅一行计数 + 最老心跳（KD-3 异常优先，正常球不配出现在 operator 眼前） */
  healthy: { count: number; oldestHeartbeatMs: number };
  /** 部分降级时不可用的数据源名（对抗场景 3：单 collector 失败整卡照发） */
  degradedSources: string[];
}
