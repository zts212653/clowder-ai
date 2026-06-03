/**
 * F216 c1.2: routeSerial 决策层 — 纯函数统一路由 guard。
 *
 * routeSerial 历史上把"该不该派下一只猫"的 depth/dedup/streak/pendingTail 判断散在 inline-mention
 * (route-serial.ts:1703-1797) 和 relay (route-serial.ts:1126-1150) 两段里各写一遍，加任何决策都要
 * 多处同步改 → 笛卡尔积式炸 edge case（F215 7 轮 review 的根因）。
 *
 * 本模块把这套判断收口成一个**纯函数** resolveRoutingDecisions：输入一个 RoutingSignal + 一份只读
 * RoutingContext 快照，输出结构化 RoutingDecision[]。**不做任何副作用** —— worklist.push /
 * updateStreakOnPush(mutate) / span 创建 / yield 都留在 routeSerial 执行层 apply decision 时做
 * （砚砚 GPT-5.5 OQ3：副作用不进决策函数，否则纯函数变上帝函数）。streak 用 ctx.peekStreak 只读预判
 * （配对 WorklistRegistry.peekStreakOnPush，c1.1）。
 */

import type { CatId } from '@cat-cafe/shared';

/** 路由信号来源 —— 三条历史路径各自的触发形态。 */
export type RoutingSignal =
  | { type: 'inline_mention'; cats: CatId[]; content: string; callerCatId: CatId }
  | { type: 'relay_malformed'; cat: CatId; callerCatId: CatId }
  | { type: 'deferred'; cats: CatId[]; content: string; callerCatId: CatId };

/** 结构化决策 —— 执行层据此 apply 副作用。 */
export type RoutingDecision =
  | { action: 'enqueue_worklist'; cat: CatId } // 执行层：worklist.push + updateStreakOnPush + span
  | { action: 'defer_queue'; cat: CatId } // 执行层：deferA2AEnqueue（排到非-agent 之后）
  | { action: 'mark_replyto'; cat: CatId } // pendingTail 命中且非原始 target：只设 a2aFrom/triggerMsg，不 push
  | { action: 'skip'; cat: CatId; reason: 'depth' | 'dedup_active' | 'aborted' | 'queue_pending' }
  | { action: 'block_pingpong'; cat: CatId; pairCount: number }; // 执行层：yield a2a_pingpong_terminated

/** 决策所需的只读上下文快照（不 mutate）。 */
export interface RoutingContext {
  /** 当前 A2A 深度（已 push 的 A2A 目标数）。 */
  a2aCount: number;
  /** A2A 链最大深度。 */
  maxDepth: number;
  /** 本 cat 的执行 signal 是否已 abort。 */
  aborted: boolean;
  /** 队列里是否有非-agent（user/connector）消息待处理 —— fairness gate。 */
  queuedMessagesPending: boolean;
  /** worklist 中尚未执行的尾部（index+1..），用于 dedup。 */
  pendingTail: readonly CatId[];
  /** pendingTail 中属于用户原始选择的 target（这些应回复用户，不应被当成 A2A 重派）。 */
  pendingOriginalTargets: readonly CatId[];
  /** 该 cat 是否已在 InvocationQueue 中活跃处理（跨路径 dedup）。 */
  hasActiveAgent: (cat: CatId) => boolean;
  /** 只读 streak 预判（不 mutate；配对 peekStreakOnPush）。 */
  peekStreak: (target: CatId) => { wouldBlock: boolean; count: number };
}

/**
 * 纯函数：把一个路由信号解析成有序的决策列表。
 *
 * inline_mention：逐个 cat 走完整 guard 链（abort→queue→depth→dedup→pendingTail→streak→enqueue），
 *   depth 预算在多 cat 间累计消费（每次 enqueue 占一个 slot）。
 * relay_malformed：恢复路径，只受 depth + pending-only dedup 约束（F215 逐字语义），不碰 streak/fairness。
 * deferred：等同 inline_mention 在 queue-pending 时的形态（全部 defer_queue），c2 接线时复用。
 */
export function resolveRoutingDecisions(signal: RoutingSignal, ctx: RoutingContext): RoutingDecision[] {
  if (signal.type === 'relay_malformed') {
    return [resolveRelay(signal.cat, ctx)];
  }

  const decisions: RoutingDecision[] = [];
  // Local depth budget: each route slot consumes one, so later cats can hit the limit mid-list.
  // Both enqueue_worklist (inline) AND defer_queue (queue-pending path, c2) are real A2A route slots —
  // a defer_queue enqueues a handoff behind non-agent messages, it just runs later. Counting only
  // enqueue_worklist would let a batch resolve emit unlimited defer_queue past maxDepth
  // (砚砚 review PR#1991 P2). skip/mark_replyto/block_pingpong do NOT consume a slot (no new route).
  let depth = ctx.a2aCount;
  for (const cat of signal.cats) {
    const decision = resolveInlineCat(cat, ctx, depth);
    if (decision === null) continue; // pending original target → no decision (replies to user)
    decisions.push(decision);
    if (decision.action === 'enqueue_worklist' || decision.action === 'defer_queue') depth++;
  }
  return decisions;
}

/** relay 恢复路径：depth + pending-only dedup（F215 :1131-1134 逐字语义），无 streak/fairness。 */
function resolveRelay(cat: CatId, ctx: RoutingContext): RoutingDecision {
  if (ctx.a2aCount >= ctx.maxDepth) return { action: 'skip', cat, reason: 'depth' };
  // F215 pending-only dedup: cat already queued ahead → skip duplicate relay push.
  if (ctx.pendingTail.includes(cat)) return { action: 'skip', cat, reason: 'dedup_active' };
  return { action: 'enqueue_worklist', cat };
}

/**
 * inline-mention 单 cat guard 链（顺序与 routeSerial:1703-1785 一致）。
 * 返回 null = pending 原始 target，不发决策（保持回复用户）。
 */
function resolveInlineCat(cat: CatId, ctx: RoutingContext, depth: number): RoutingDecision | null {
  // Outer gate (routeSerial :1703): aborted takes priority over everything.
  if (ctx.aborted) return { action: 'skip', cat, reason: 'aborted' };
  // Depth (consumed cumulatively across the cat list).
  if (depth >= ctx.maxDepth) return { action: 'skip', cat, reason: 'depth' };
  // Cross-path dedup: cat already processing via InvocationQueue (callback path).
  if (ctx.hasActiveAgent(cat)) return { action: 'skip', cat, reason: 'dedup_active' };
  // Already pending in worklist tail.
  if (ctx.pendingTail.includes(cat)) {
    // Original user target → leave it replying to user (no decision).
    if (ctx.pendingOriginalTargets.includes(cat)) return null;
    // Non-original duplicate → just (re)bind reply metadata, don't push again.
    return { action: 'mark_replyto', cat };
  }
  // Ping-pong breaker (read-only预判; execution layer does the real updateStreakOnPush mutate).
  const streak = ctx.peekStreak(cat);
  if (streak.wouldBlock) return { action: 'block_pingpong', cat, pairCount: streak.count };
  // F216 c2: queue fairness gate is the LAST check, AFTER depth/dedup/pendingTail/streak. This way the
  // deferred path (queuedMessagesPending=true) still runs the full guard chain before deferring — it
  // gets skip:depth / skip:dedup_active / mark_replyto / block_pingpong exactly like inline, then
  // defers a clean enqueue. For the inline path queuedMessagesPending is always false (outer condition
  // `!queuedMessagesPending`), so this check is a no-op there → inline behavior unchanged.
  if (ctx.queuedMessagesPending) return { action: 'defer_queue', cat };
  return { action: 'enqueue_worklist', cat };
}
