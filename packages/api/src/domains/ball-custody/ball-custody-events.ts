/**
 * F233 Phase B — B2: 球权事件构造纯函数（零 IO，可测）。
 *
 * 把"现有系统动作的现场字段"翻译成 terminal-schema BallCustodyEvent：
 *  - sourceEventId 遵 plan §F 幂等键规范
 *  - subjectKey 遵 KD-1（从现有痕迹派生 ball:thread:{threadId}，不引入球 ID 新原语）
 *  - classification 决定 reject 时是否记 lastRejectedEvent（state-changing 记 / informational 不记）
 *
 * 接线点（route-serial）只调这些纯函数 + ingest.record()，事件语义集中在此，可单测、不污染路由 generator。
 *
 * §F 细化（B2 PR1，请 reviewer 确认）：handed 的 sourceEventId 在 `route:{messageId}` 基础上**追加
 * `:{toCatId}`**——一条消息可行首 @ 多猫（`@catA @catB`），各产生一条独立 handed 事件；若只用
 * `route:{messageId}` 则第二只猫被全局 sourceEventId 去重静默吞掉。void_pass 追加 `:void` 与 handed
 * 区分（同一 messageId 理论互斥——evaluateVoidHold 在有 lineStartMention 时不触发——但显式后缀更防御）。
 */

import type { BallCustodyEvent, BallIntent, BallResolveMode } from '@cat-cafe/shared';

export interface HandedEventInput {
  /** 前手 catId（用户首传 / 无前手时省略） */
  fromCatId?: string;
  /** 接球 catId（行首 @ 的目标） */
  toCatId: string;
  threadId: string;
  /** 被 @ 的消息 id（§F sourceEventId 锚） */
  messageId: string;
  /** Unix ms */
  at: number;
}

/** 行首 @ 路由投递 → ball.handed（holder 变更，球继续）。 */
export function buildHandedEvent(input: HandedEventInput): BallCustodyEvent {
  return {
    sourceEventId: `route:${input.messageId}:${input.toCatId}`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'ball.handed',
    classification: 'state-changing',
    payload: {
      toCatId: input.toCatId,
      ...(input.fromCatId ? { fromCatId: input.fromCatId } : {}),
    },
    at: input.at,
  };
}

export interface VoidPassEventInput {
  threadId: string;
  /** 触发虚空传球检测的消息 id（持球声明但无系统动作） */
  messageId: string;
  /** 命中的 HOLD_PATTERN id（observability，可选） */
  matchedPattern?: string;
  /** Unix ms */
  at: number;
}

/** F167 虚空传球守卫（声明持球但无 hold_ball / 无行首 @）→ ball.void_pass。 */
export function buildVoidPassEvent(input: VoidPassEventInput): BallCustodyEvent {
  return {
    sourceEventId: `route:${input.messageId}:void`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'ball.void_pass',
    classification: 'state-changing',
    payload: {
      ...(input.matchedPattern ? { matchedPattern: input.matchedPattern } : {}),
    },
    at: input.at,
  };
}

export interface HandedCvoEventInput {
  fromCatId?: string;
  threadId: string;
  messageId: string;
  intent: BallIntent;
  at: number;
}

export function buildHandedCvoEvent(input: HandedCvoEventInput): BallCustodyEvent {
  return {
    sourceEventId: `route:${input.messageId}`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'ball.handed_cvo',
    classification: 'state-changing',
    payload: {
      ...(input.fromCatId ? { fromCatId: input.fromCatId } : {}),
      intent: input.intent,
    },
    at: input.at,
  };
}

export interface HeldEventInput {
  threadId: string;
  catId: string;
  fireAt: number;
  at: number;
}

export function buildHeldEvent(input: HeldEventInput): BallCustodyEvent {
  return {
    sourceEventId: `hold:${input.threadId}:${input.catId}:${input.fireAt}`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'ball.held',
    classification: 'state-changing',
    payload: { catId: input.catId, fireAt: input.fireAt },
    at: input.at,
  };
}

export function buildHoldExpiredEvent(input: HeldEventInput): BallCustodyEvent {
  return {
    sourceEventId: `holdexp:${input.threadId}:${input.catId}:${input.fireAt}`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'ball.hold_expired',
    classification: 'state-changing',
    payload: { catId: input.catId, fireAt: input.fireAt },
    at: input.at,
  };
}

export interface TaskBlockedEventInput {
  taskId: string;
  threadId: string;
  ownerCatId?: string | null;
  blockedSinceAt: number;
  resolveMode?: BallResolveMode | null;
}

export function buildTaskBlockedEvent(input: TaskBlockedEventInput): BallCustodyEvent {
  return {
    sourceEventId: `task:${input.taskId}:blocked:${input.blockedSinceAt}`,
    subjectKey: `ball:task:${input.taskId}`,
    kind: 'task.blocked',
    classification: 'state-changing',
    payload: {
      taskId: input.taskId,
      threadId: input.threadId,
      ...(input.ownerCatId ? { ownerCatId: input.ownerCatId } : {}),
      ...(input.resolveMode ? { resolveMode: input.resolveMode } : {}),
    },
    at: input.blockedSinceAt,
  };
}

export interface TaskEventInput {
  taskId: string;
  at: number;
}

export function buildTaskUnblockedEvent(input: TaskEventInput): BallCustodyEvent {
  return {
    sourceEventId: `task:${input.taskId}:unblocked:${input.at}`,
    subjectKey: `ball:task:${input.taskId}`,
    kind: 'task.unblocked',
    classification: 'state-changing',
    payload: { taskId: input.taskId },
    at: input.at,
  };
}

export function buildTaskIdleLongEvent(input: TaskEventInput): BallCustodyEvent {
  return {
    sourceEventId: `task:${input.taskId}:idle:${input.at}`,
    subjectKey: `ball:task:${input.taskId}`,
    kind: 'task.idle_long',
    classification: 'state-changing',
    payload: { taskId: input.taskId },
    at: input.at,
  };
}

export interface WakeSentEventInput {
  taskId: string;
  threadId: string;
  ownerCatId?: string | null;
  blockedSinceAt: number;
  at: number;
}

export function buildWakeSentEvent(input: WakeSentEventInput): BallCustodyEvent {
  return {
    sourceEventId: `wake:${input.taskId}:${input.blockedSinceAt}:${input.at}`,
    subjectKey: `ball:task:${input.taskId}`,
    kind: 'ball.wake_sent',
    classification: 'informational',
    payload: {
      taskId: input.taskId,
      threadId: input.threadId,
      ...(input.ownerCatId ? { ownerCatId: input.ownerCatId } : {}),
      blockedSinceAt: input.blockedSinceAt,
    },
    at: input.at,
  };
}

export function buildTaskDoneEvent(input: TaskEventInput): BallCustodyEvent {
  return {
    sourceEventId: `task:${input.taskId}:done`,
    subjectKey: `ball:task:${input.taskId}`,
    kind: 'task.done',
    classification: 'state-changing',
    payload: { taskId: input.taskId },
    at: input.at,
  };
}

export interface InvocationStartedEventInput {
  invocationId: string;
  threadId: string;
  catId?: string;
  at: number;
}

export function buildInvocationStartedEvent(input: InvocationStartedEventInput): BallCustodyEvent {
  return {
    sourceEventId: `inv:${input.invocationId}:started`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'invocation.started',
    classification: 'state-changing',
    payload: {
      invocationId: input.invocationId,
      ...(input.catId ? { catId: input.catId } : {}),
    },
    at: input.at,
  };
}

export interface InvocationHeartbeatEventInput {
  invocationId: string;
  threadId: string;
  catId?: string;
  draftUpdatedAt: number;
}

export function buildInvocationHeartbeatEvent(input: InvocationHeartbeatEventInput): BallCustodyEvent {
  return {
    sourceEventId: `inv:${input.invocationId}:hb:${input.draftUpdatedAt}`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'invocation.heartbeat',
    classification: 'state-changing',
    payload: {
      invocationId: input.invocationId,
      ...(input.catId ? { catId: input.catId } : {}),
      draftUpdatedAt: input.draftUpdatedAt,
    },
    at: input.draftUpdatedAt,
  };
}

export interface InvocationDiedEventInput {
  invocationId: string;
  threadId: string;
  catId?: string;
  reason: string;
  lastScanAt: number;
  at: number;
}

export function buildInvocationDiedEvent(input: InvocationDiedEventInput): BallCustodyEvent {
  return {
    sourceEventId: `inv:${input.invocationId}:died`,
    subjectKey: `ball:thread:${input.threadId}`,
    kind: 'invocation.died',
    classification: 'state-changing',
    payload: {
      invocationId: input.invocationId,
      ...(input.catId ? { catId: input.catId } : {}),
      reason: input.reason,
      lastScanAt: input.lastScanAt,
    },
    at: input.at,
  };
}

// ─── Phase C 安乐死事件 builders（C1a 第一棒，KD-C1/C2 + 砚砚 R0 修正：sourceEventId 含 kind）──

/**
 * Phase C 安乐死事件 input。三 kind 共用 input shape——
 * - `subjectKey` 必填（operator/owner 显式发杀，已知目标 ball；KD-1 不引球 ID 新原语，subjectKey
 *   与 Phase B 同源派生格式 `ball:thread:{threadId}` | `ball:task:{taskId}`）
 * - `why` 必填理由（plain text，简报/轨迹用，KD-1 言语行为本位）
 * - `by` 必填发起者（`catId` 或 `'cvo'`，观察 spend-pattern + 滥用诊断）
 * - `at` Unix ms
 * 三 kind 独立 builder（KD-C2，非单 builder + severity 字段）→ 调用方意图自带 + projector
 * pattern match 直接 + 简报 per-kind collapsing 策略可调。
 */
export interface EuthanasiaEventInput {
  subjectKey: string;
  why: string;
  by: string;
  at: number;
}

/** Phase C ball.frozen：冷冻——暂停推进可解冻（短期降优先级，可后续手动 reopen 或转 degraded/abandoned）。 */
export function buildBallFrozenEvent(input: EuthanasiaEventInput): BallCustodyEvent {
  return {
    sourceEventId: `euthanasia:${input.subjectKey}:frozen:${input.at}`,
    subjectKey: input.subjectKey,
    kind: 'ball.frozen',
    classification: 'state-changing',
    payload: {
      kind: 'frozen',
      why: input.why,
      by: input.by,
    },
    at: input.at,
  };
}

/** Phase C ball.degraded：降级——明确降优先级（球保留可见但弱化，简报视觉降权而非消项）。 */
export function buildBallDegradedEvent(input: EuthanasiaEventInput): BallCustodyEvent {
  return {
    sourceEventId: `euthanasia:${input.subjectKey}:degraded:${input.at}`,
    subjectKey: input.subjectKey,
    kind: 'ball.degraded',
    classification: 'state-changing',
    payload: {
      kind: 'degraded',
      why: input.why,
      by: input.by,
    },
    at: input.at,
  };
}

/** Phase C ball.abandoned：放弃——终态"不做了"（简报僵尸球区消项，事件流诚实保留 trajectory）。 */
export function buildBallAbandonedEvent(input: EuthanasiaEventInput): BallCustodyEvent {
  return {
    sourceEventId: `euthanasia:${input.subjectKey}:abandoned:${input.at}`,
    subjectKey: input.subjectKey,
    kind: 'ball.abandoned',
    classification: 'state-changing',
    payload: {
      kind: 'abandoned',
      why: input.why,
      by: input.by,
    },
    at: input.at,
  };
}
