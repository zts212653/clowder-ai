/**
 * What happens when a cat waits for the owner without the line-start mention.
 *
 * The owner decided on 2026-10-10 that only an explicit mention enters the mailbox
 * (`thread_mulzdwvps2dh01b3#0001791632021300-001262-d4c8bcd6`), so nothing here adds
 * the message to the mailbox on the cat's behalf. The cat itself must either decide or
 * write the mention:
 * - a tool post is refused before it is stored, so the cat fixes it in the same turn;
 * - a final reply is already on screen, so the cat is woken once with a private correction
 *   unless the owner is in a live exchange: he wrote in the thread within ten minutes of the
 *   reply finishing, besides the message that started this turn. An instruction he sent and
 *   left after is not presence; that message is excluded.
 * In the 2026-11-09 census this split gives 119 wakes a month that reach 45 of the 48 asks
 * left for six hours or more; the 43 asks inside live exchanges became long stalls 3 times.
 */

import { getCoCreatorConfig } from '../../../../../config/cat-config-loader.js';
import type { DeliverOpts } from '../../../../../infrastructure/scheduler/types.js';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';

export const OWNER_ASK_CHECK_CONNECTOR = 'owner-ask-check';
const OWNER_PRESENT_WINDOW_MS = 10 * 60 * 1000;
const RECENT_MESSAGES = 30;

function ownerHandle(): string {
  return getCoCreatorConfig().mentionPatterns[0] ?? '@co-creator';
}

/** Returned by post_message / cross_post instead of storing the message. */
export function ownerAskRejection(kind: string) {
  const handle = ownerHandle();
  return {
    kind: 'owner_ask_without_mention' as const,
    ownerAsk: kind,
    message:
      `这条在等co-creator决定或动手，但没有行首 ${handle}，也没有传给任何猫：他看不到，也不会进他的小信箱，所以没有发出。` +
      `先过决策漏斗：可回滚、翻代码能定的，自己定了，改成结论再发；确实要他，就在行首独立一行写 ${handle}，` +
      '写清要他做什么、为什么、今天不答会怎样。交互卡只有人能点，同样要这样喊他，或用 create_rich_block 带 awaitResponseV1 发成决定卡。',
  };
}

export interface OwnerAskCorrectionDeps {
  readonly messages: Pick<IMessageStore, 'getById' | 'getByThreadBefore'>;
  /** The scheduler's system delivery: one atomic Message + Queue admission that wakes the target. */
  readonly deliver: (opts: DeliverOpts) => Promise<string>;
}

export interface OwnerAskCorrectionInput {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly askMessageId: string;
  /** When the reply finished. The stored timestamp is when the turn started. */
  readonly answeredAt: number;
  /** The message that started this turn: never a sign of presence, and a correction never asks for another. */
  readonly triggerMessageId?: string;
  /** The final paragraph that waited for the owner. */
  readonly excerpt: string;
}

export type OwnerAskCorrectionResult =
  | { readonly outcome: 'delivered'; readonly messageId: string }
  | { readonly outcome: 'owner_present' | 'correction_turn' };

async function isCorrectionTurn(deps: OwnerAskCorrectionDeps, triggerMessageId?: string): Promise<boolean> {
  if (!triggerMessageId) return false;
  const trigger = await deps.messages.getById(triggerMessageId);
  return trigger?.source?.connector === OWNER_ASK_CHECK_CONNECTOR;
}

async function ownerSpokeRecently(deps: OwnerAskCorrectionDeps, input: OwnerAskCorrectionInput): Promise<boolean> {
  const recent = await deps.messages.getByThreadBefore(
    input.threadId,
    input.answeredAt,
    RECENT_MESSAGES,
    undefined,
    input.userId,
  );
  return recent.some(
    (message) =>
      message.id !== input.triggerMessageId &&
      messageFrom(message).kind === 'user' &&
      !message.extra?.crossPost &&
      message.timestamp >= input.answeredAt - OWNER_PRESENT_WINDOW_MS,
  );
}

export async function requestOwnerAskCorrection(
  deps: OwnerAskCorrectionDeps,
  input: OwnerAskCorrectionInput,
): Promise<OwnerAskCorrectionResult> {
  if (await isCorrectionTurn(deps, input.triggerMessageId)) return { outcome: 'correction_turn' };
  if (await ownerSpokeRecently(deps, input)) return { outcome: 'owner_present' };
  const handle = ownerHandle();
  const messageId = await deps.deliver({
    userId: input.userId,
    threadId: input.threadId,
    targetCatId: input.catId,
    content: '上一条在等你决定或动手，但没有 @ 你，所以没进小信箱。已请它自己定掉，或者补上 @。',
    privateContent:
      `[掉球检查] 你上一条消息的最后一段在等co-creator（「${input.excerpt.slice(0, 160)}」），但没有行首 ${handle}，` +
      '也没有传给任何猫。他现在不在这条线程里，看不到，也不会进他的小信箱。' +
      '先过决策漏斗：可回滚、翻代码能定的细节，自己定掉，回一句结论；确实只有他能定或要他动手的，' +
      `另发一条，行首独立一行 ${handle}，写清要他做什么、为什么、今天不答会怎样。不要重复全文。`,
    idempotencyKey: `${OWNER_ASK_CHECK_CONNECTOR}:${input.askMessageId}`,
    ownerAuthProvenance: 'unknown',
    source: {
      connector: OWNER_ASK_CHECK_CONNECTOR,
      label: '掉球检查',
      icon: '📮',
      meta: { askMessageId: input.askMessageId },
    },
  });
  return { outcome: 'delivered', messageId };
}
