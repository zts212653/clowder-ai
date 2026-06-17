/**
 * F233 Phase A — generateAndDeliverBriefing（值班简报生成 + 投递编排核心）
 *
 * on-demand route 与 daily cron 共用。纯编排 + 注入抽象（deliverCard / hasBriefingToday），
 * 核心逻辑可单测（mock 注入），投递/查询实现由 route/cron wiring 提供。
 *
 * KD-4 只读：除最终 deliverCard（发简报消息 = 唯一写，spec 允许）外全只读。
 * INV-2 degraded 不静默：绑定失效 → 降级到 fallback（on-demand 来源 thread）或返回 error outcome（cron 无 fallback）。
 * INV-5 当日重发：投递前查目标 thread 当日是否已发简报卡（纯投影），已发跳过。
 */

import type { RichCardBlock } from '@cat-cafe/shared';
import { aggregateDutyBriefing } from './BallCustodyAggregator.js';
import { type IBriefingConfigStore, resolveBriefingTarget } from './BriefingConfigStore.js';
import { type CollectDutyBriefingDeps, collectDutyBriefingInput } from './collectDutyBriefingInput.js';
import { renderBriefingCard } from './renderBriefingCard.js';

export type GenerateOutcome =
  | 'unbound' // 无绑定 → 不投递
  | 'already-sent-today' // INV-5：当日已发，跳过
  | 'delivered' // 正常投递
  | 'degraded-delivered' // 绑定失效但降级到 fallback 投递（INV-2）
  | 'degraded-no-fallback'; // 绑定失效且无 fallback（cron）→ 调用方记 error，不静默

export interface GenerateResult {
  delivered: boolean;
  outcome: GenerateOutcome;
  threadId?: string;
  messageId?: string;
}

export interface GenerateBriefingDeps {
  /** IO 层数据源 deps（bindingStatus/now 由本函数注入） */
  collectDeps: Omit<CollectDutyBriefingDeps, 'bindingStatus' | 'now'>;
  configStore: IBriefingConfigStore;
  /** 校验 thread 是否存在（degraded 判定，只读） */
  threadExists: (threadId: string) => Promise<boolean> | boolean;
  /** INV-5：查目标 thread 当日是否已发简报卡（纯投影，只读） */
  hasBriefingToday: (threadId: string, now: number) => Promise<boolean> | boolean;
  /** 投递简报卡 → 返回 messageId（唯一写副作用） */
  deliverCard: (threadId: string, card: RichCardBlock) => Promise<string>;
  /** degraded 时降级投递目标（on-demand = 来源 thread；cron 无 fallback） */
  fallbackThreadId?: string;
  now: number;
}

export async function generateAndDeliverBriefing(deps: GenerateBriefingDeps): Promise<GenerateResult> {
  const target = await resolveBriefingTarget(deps.configStore, deps.threadExists);

  if (target.status === 'unbound') {
    return { delivered: false, outcome: 'unbound' };
  }

  let deliverThreadId = target.threadId as string;
  let bindingStatus: 'bound' | 'degraded' = 'bound';

  if (target.status === 'degraded') {
    bindingStatus = 'degraded';
    // INV-2 不静默：降级到 fallback（on-demand 来源 thread）；cron 无 fallback → 返回 error outcome
    if (!deps.fallbackThreadId) {
      return { delivered: false, outcome: 'degraded-no-fallback', threadId: target.threadId };
    }
    deliverThreadId = deps.fallbackThreadId;
  }

  // INV-5 当日重发判定（纯投影，零新存储）
  if (await deps.hasBriefingToday(deliverThreadId, deps.now)) {
    return { delivered: false, outcome: 'already-sent-today', threadId: deliverThreadId };
  }

  const input = await collectDutyBriefingInput({ ...deps.collectDeps, bindingStatus, now: deps.now });
  const briefing = aggregateDutyBriefing(input);
  const card = renderBriefingCard(briefing);

  const messageId = await deps.deliverCard(deliverThreadId, card);
  return {
    delivered: true,
    outcome: bindingStatus === 'degraded' ? 'degraded-delivered' : 'delivered',
    threadId: deliverThreadId,
    messageId,
  };
}
