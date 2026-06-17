/**
 * F233 Phase A — BallCustodyAggregator（纯投影聚合器，KD-4 零写副作用）
 *
 * 纯函数核心：DutyBriefingInput（已从各 store 取出的原始数据）→ DutyBriefing DTO。
 * 数据获取由 collectDutyBriefingInput 负责（薄 IO 层，Redis-backed 测试覆盖查询行为）。
 * 这层只做分类/排序/降级，无任何 store 访问 → AC-A5 只读 trivial 满足。
 *
 * 设计照 F232 thread-artifacts-aggregator（姊妹篇）：窄 Input 类型 + 每源一个 mapper。
 */

import type { BallEntry, DutyBriefing } from '@cat-cafe/shared';
import { NEEDS_USER_BLOCKED_MIN_MS, STALE_BLOCKED_THRESHOLD_MS, TITLE_MAX } from './constants.js';

// ---- 窄 Input 类型（只声明聚合用到的字段，降耦合 + 好测）----

export interface AggregatorTask {
  id: string;
  title: string;
  ownerCatId: string | null;
  status: string; // 'todo' | 'doing' | 'blocked' | 'done'
  why: string;
  updatedAt: number;
  threadId: string;
}

export interface AggregatorZombie {
  invocationId: string;
  threadId: string;
  catId: string | null;
  recordUpdatedAt: number;
  detail?: string; // 如 'no_tracker_no_fresh_draft' / 'spend-limit'
}

export interface AggregatorExpiredHold {
  threadId: string;
  catId: string | null;
  fireAt: number; // 已过期（fireAt < now）
  message?: string;
}

export interface AggregatorVoidPass {
  trigger: string; // verdict keyword (verdict_reject / approve / P1 ...)
  firedAtMs: number;
  catId?: string | null;
}

export interface AggregatorMentionCandidate {
  threadId: string;
  messageId: string;
  catId: string | null; // 发 @co-creator 的猫
  title: string;
  timestamp: number;
}

export interface DutyBriefingInput {
  tasks: AggregatorTask[];
  zombies: AggregatorZombie[];
  expiredHolds: AggregatorExpiredHold[];
  voidPasses: AggregatorVoidPass[];
  mentionCandidates: AggregatorMentionCandidate[];
  /** threadId→title 映射，用于 zombie/hold 条目标题（无 title 的 thread 不在 map 中） */
  threadTitles: Record<string, string>;
  /** 健康活球计数（doing task + 活跃 hold + active invocation） */
  activeCount: number;
  /** 健康球里最老的心跳（ms 时长） */
  oldestHeartbeatMs: number;
  bindingStatus: 'bound' | 'degraded';
  degradedSources: string[];
  now: number;
}

function asHolder(catId: string | null | undefined): BallEntry['holder'] {
  return (catId ?? undefined) as BallEntry['holder'];
}

const byAgeDesc = (a: BallEntry, b: BallEntry): number => b.ageMs - a.ageMs;

// ---- 每源 mapper（纯函数）----

/** blocked task 超龄 >7d → staleBlocked（睡美人近似） */
function tasksToStaleBlocked(tasks: AggregatorTask[], now: number): BallEntry[] {
  return tasks
    .filter((t) => t.status === 'blocked' && now - t.updatedAt > STALE_BLOCKED_THRESHOLD_MS)
    .map((t) => ({
      kind: 'task' as const,
      confidence: 'structured' as const,
      title: t.title,
      ageMs: now - t.updatedAt,
      holder: asHolder(t.ownerCatId),
      anchor: { taskId: t.id, threadId: t.threadId },
      detail: t.why || undefined,
    }));
}

/** blocked task 1d~7d → needsUser（结构化搁置球，球卡住但未到睡美人） */
function tasksToNeedsUser(tasks: AggregatorTask[], now: number): BallEntry[] {
  return tasks
    .filter((t) => {
      if (t.status !== 'blocked') return false;
      const age = now - t.updatedAt;
      return age >= NEEDS_USER_BLOCKED_MIN_MS && age <= STALE_BLOCKED_THRESHOLD_MS;
    })
    .map((t) => ({
      kind: 'task' as const,
      confidence: 'structured' as const,
      title: t.title,
      ageMs: now - t.updatedAt,
      holder: asHolder(t.ownerCatId),
      anchor: { taskId: t.id, threadId: t.threadId },
      detail: t.why || undefined,
    }));
}

/** mention 尾部 @co-creator 无后续 → needsUser（启发式候选，confidence=heuristic） */
function mentionsToNeedsUser(candidates: AggregatorMentionCandidate[], now: number): BallEntry[] {
  return candidates.map((c) => ({
    kind: 'mention-heuristic' as const,
    confidence: 'heuristic' as const,
    title: c.title,
    ageMs: now - c.timestamp,
    holder: asHolder(c.catId),
    anchor: { threadId: c.threadId, messageId: c.messageId },
  }));
}

/** invocation zombie → deadBalls（死球，复用 F194 liveness 判定结果） */
function zombiesToDeadBalls(
  zombies: AggregatorZombie[],
  now: number,
  threadTitles: Record<string, string>,
): BallEntry[] {
  return zombies.map((z) => {
    const tTitle = threadTitles[z.threadId];
    const label = tTitle || (z.catId ? `${z.catId} 无心跳` : '调用无心跳');
    return {
      kind: 'invocation-death' as const,
      confidence: 'structured' as const,
      title: label.length > TITLE_MAX ? `${label.slice(0, TITLE_MAX - 1)}…` : label,
      ageMs: now - z.recordUpdatedAt,
      holder: asHolder(z.catId),
      anchor: { threadId: z.threadId, invocationId: z.invocationId },
      detail: z.detail,
    };
  });
}

/** 过期 hold → deadBalls（zombie-hold 形态：猫该被唤醒但 hold 已过期） */
function expiredHoldsToDeadBalls(
  holds: AggregatorExpiredHold[],
  now: number,
  threadTitles: Record<string, string>,
): BallEntry[] {
  return holds.map((h) => {
    const tTitle = threadTitles[h.threadId];
    const label = tTitle || (h.catId ? `${h.catId} 持球过期` : '持球已过期');
    return {
      kind: 'hold-expired' as const,
      confidence: 'structured' as const,
      title: label.length > TITLE_MAX ? `${label.slice(0, TITLE_MAX - 1)}…` : label,
      ageMs: now - h.fireAt,
      holder: asHolder(h.catId),
      anchor: { threadId: h.threadId },
      detail: h.message,
    };
  });
}

/** F167 C2 verdict-without-pass → voidPasses（锚点恒空，HMAC 不可逆 — Task 0 降级） */
function voidPassesToEntries(vp: AggregatorVoidPass[], now: number): BallEntry[] {
  return vp.map((v) => ({
    kind: 'void-pass' as const,
    confidence: 'structured' as const,
    title: v.catId ? `${v.catId} 疑似虚空传球（${v.trigger}）` : `虚空传球（${v.trigger}）`,
    ageMs: now - v.firedAtMs,
    holder: asHolder(v.catId),
    anchor: {}, // 锚点降级：F167 telemetry id 单向 HMAC 不可逆（Task 0 探查结论）
    detail: `来自 telemetry · trigger=${v.trigger} · 无跳转`,
  }));
}

/** 纯函数聚合：DutyBriefingInput → DutyBriefing（KD-3 异常优先，区内晾龄降序） */
export function aggregateDutyBriefing(input: DutyBriefingInput): DutyBriefing {
  const needsUser = [
    ...tasksToNeedsUser(input.tasks, input.now),
    ...mentionsToNeedsUser(input.mentionCandidates, input.now),
  ].sort(byAgeDesc);
  const deadBalls = [
    ...zombiesToDeadBalls(input.zombies, input.now, input.threadTitles),
    ...expiredHoldsToDeadBalls(input.expiredHolds, input.now, input.threadTitles),
  ].sort(byAgeDesc);
  const voidPasses = voidPassesToEntries(input.voidPasses, input.now).sort(byAgeDesc);
  const staleBlocked = tasksToStaleBlocked(input.tasks, input.now).sort(byAgeDesc);

  return {
    generatedAt: input.now,
    bindingStatus: input.bindingStatus,
    counts: {
      active: input.activeCount,
      needsUser: needsUser.length,
      dead: deadBalls.length,
      voidPass: voidPasses.length,
      staleBlocked: staleBlocked.length,
    },
    needsUser,
    deadBalls,
    voidPasses,
    staleBlocked,
    healthy: { count: input.activeCount, oldestHeartbeatMs: input.oldestHeartbeatMs },
    degradedSources: input.degradedSources,
  };
}
