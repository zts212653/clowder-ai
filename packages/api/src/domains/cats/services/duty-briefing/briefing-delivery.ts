/**
 * F233 Phase A — 简报投递 adapter（包 MessageStore，给 generateAndDeliverBriefing 注入）
 *
 * deliverBriefingCard: append rich card 到 thread（origin='briefing' = F148 非路由产物语义，唯一写）
 * hasBriefingToday:    查目标 thread 当日是否已发简报卡（INV-5 纯投影，靠稳定 card id 识别）
 *
 * 照 format-briefing.ts 的 append 模式：userId='system' / catId=null / origin='briefing' / extra.rich。
 */

import type { RichCardBlock, RichMessageExtra } from '@cat-cafe/shared';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import { BRIEFING_TIMEZONE, DUTY_BRIEFING_CARD_ID } from './constants.js';

const BRIEFING_USER_ID = 'system';
const DEFAULT_BRIEFING_VIEWER = 'default-user';
const SCAN_LIMIT = 50;

/** 投递简报卡 → 返回 messageId（唯一写副作用，KD-4） */
export async function deliverBriefingCard(
  messageStore: Pick<IMessageStore, 'append'>,
  threadId: string,
  card: RichCardBlock,
  now: number,
): Promise<string> {
  const rich: RichMessageExtra = { v: 1, blocks: [card] };
  const msg = await messageStore.append({
    threadId,
    userId: BRIEFING_USER_ID,
    catId: null,
    content: card.title,
    mentions: [],
    timestamp: now,
    origin: 'briefing',
    extra: { rich },
    idempotencyKey: `${DUTY_BRIEFING_CARD_ID}:${threadId}:${dayKeyInTimeZone(now, BRIEFING_TIMEZONE)}`,
  });
  return msg.id;
}

/** 识别一条消息是否值班简报卡（origin='briefing' + blocks 含 id=DUTY_BRIEFING_CARD_ID 的 card） */
function isDutyBriefingMessage(msg: { origin?: string; extra?: { rich?: RichMessageExtra } }): boolean {
  if (msg.origin !== 'briefing') return false;
  const blocks = msg.extra?.rich?.blocks ?? [];
  return blocks.some((b) => b.kind === 'card' && b.id === DUTY_BRIEFING_CARD_ID);
}

function dayKeyInTimeZone(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

function effectiveTimestamp(msg: { timestamp: number; deliveredAt?: number }): number {
  return msg.deliveredAt ?? msg.timestamp;
}

/**
 * INV-5: 目标 thread 当日（BRIEFING_TIMEZONE）是否已发值班简报卡（纯投影，零新存储）。
 * 简报卡 userId='system' + origin='briefing' 对 operator 可见（visibility 规则），故用 operator viewer 查。
 */
export async function hasBriefingToday(
  messageStore: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>,
  threadId: string,
  now: number,
  viewerUserId: string = DEFAULT_BRIEFING_VIEWER,
): Promise<boolean> {
  const todayKey = dayKeyInTimeZone(now, BRIEFING_TIMEZONE);
  let batch = await messageStore.getByThread(threadId, SCAN_LIMIT, viewerUserId);

  while (batch.length > 0) {
    if (
      batch.some(
        (m) => isDutyBriefingMessage(m) && dayKeyInTimeZone(effectiveTimestamp(m), BRIEFING_TIMEZONE) === todayKey,
      )
    ) {
      return true;
    }

    const oldest = batch[0];
    if (!oldest) return false;
    const oldestEffectiveTs = effectiveTimestamp(oldest);
    if (dayKeyInTimeZone(oldestEffectiveTs, BRIEFING_TIMEZONE) !== todayKey) {
      return false;
    }
    batch = await messageStore.getByThreadBefore(threadId, oldestEffectiveTs, SCAN_LIMIT, oldest.id, viewerUserId);
  }

  return false;
}
