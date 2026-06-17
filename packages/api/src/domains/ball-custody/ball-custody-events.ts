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

import type { BallCustodyEvent } from '@cat-cafe/shared';

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
