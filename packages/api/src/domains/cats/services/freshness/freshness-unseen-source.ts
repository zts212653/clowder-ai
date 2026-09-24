/**
 * What counts as an unseen message for a cat, and where to read them from.
 *
 * This is the read side the provider-native freshness notice is built on: it answers
 * "is this row real work for this cat" and "who sent it", for both delivered rows and
 * F117 queue entries that are not delivered yet. It holds no policy about what to do
 * with the answer — the notice broker owns that.
 */

import type { MessageFrom } from '@cat-cafe/shared';
import { getSourceDisplayName } from '../context/ContextAssembler.js';
import { messageFrom } from '../stores/message-from.js';
import type { ThreadMessageReadOptions } from '../stores/ports/MessageStore.js';

export interface FreshnessReadableMessage {
  id: string;
  threadId?: string;
  catId: string | null;
  from?: MessageFrom;
  content: string;
  /** #1200: visibility-domain sequence number (injected by store). */
  visibilitySeq?: number;
  mentions?: readonly string[];
  replyTo?: string;
  source?: { label: string; connector?: string; sender?: { id: string; name?: string } };
  origin?: string;
  userId?: string;
  contentBlocks?: readonly unknown[];
  extra?: {
    systemKind?: string;
    rich?: { blocks?: readonly unknown[] };
    stream?: { parallelBatchId?: string };
    causal?: { kind: 'invocation_reply'; triggerMessageId: string };
    crossPost?: {
      sourceThreadId: string;
      sourceInvocationId?: string;
      effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
    };
    targetCats?: readonly string[];
  };
}

/** Minimal interface for message store — only what freshness check needs */
export interface FreshnessMessageReader {
  getById?(id: string): FreshnessReadableMessage | null | Promise<FreshnessReadableMessage | null>;
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
    options?: Pick<ThreadMessageReadOptions, 'unresolvedCursorPolicy'>,
  ): FreshnessReadableMessage[] | Promise<FreshnessReadableMessage[]>;
}

/**
 * F254 queue-aware gate: check for queued (not yet delivered) messages.
 *
 * F117 marks messages as deliveryStatus='queued' while a cat is running,
 * and isDelivered() filters them out at the store layer. This interface
 * lets the freshness gate bypass that filter by checking the InvocationQueue
 * directly. Without this, the gate false-forwards when users send messages
 * to a running cat (operator live test 2026-06-29).
 */
export interface QueuedMessageChecker {
  getQueuedForThread(
    threadId: string,
    userId: string,
    catId: string,
  ): Array<{
    entryId?: string;
    from: MessageFrom;
    content: string;
    messageId?: string | null;
    sourceCategory?: string;
  }>;
}

/**
 * Creates a QueuedMessageChecker from any object with a list() method that
 * returns queue entries (e.g. InvocationQueue). The adapter filters to
 * 'queued' status entries only and maps to the minimal shape needed by
 * the freshness gate.
 *
 * Usage at wiring layer:
 *   queueChecker: invocationQueue
 *     ? createQueueChecker(invocationQueue, { parentInvocationId })
 *     : undefined
 */
export function createQueueChecker(
  queue: {
    getQueuedFreshnessMessagesForCat(
      threadId: string,
      userId: string,
      catId: string,
      opts?: { parentInvocationId?: string },
    ): Array<{
      entryId?: string;
      from: MessageFrom;
      content: string;
      messageId?: string | null;
      sourceCategory?: string;
    }>;
  },
  context: {
    /** Exact active parent whose safe boundary is performing this check. */
    parentInvocationId: string | undefined;
  },
): QueuedMessageChecker {
  return {
    getQueuedForThread(threadId: string, userId: string, catId: string) {
      return queue
        .getQueuedFreshnessMessagesForCat(threadId, userId, catId, {
          parentInvocationId: context.parentInvocationId,
        })
        .map((e) => ({
          ...(e.entryId ? { entryId: e.entryId } : {}),
          from: structuredClone(e.from),
          content: e.content,
          ...(e.messageId !== undefined ? { messageId: e.messageId } : {}),
          sourceCategory: e.sourceCategory,
        }));
    },
  };
}

export function getFreshnessSenderLabel(msg: Pick<FreshnessReadableMessage, 'from' | 'catId' | 'source'>): string {
  if (msg.source) return getSourceDisplayName(msg.source);
  const from = messageFrom(msg as unknown as Parameters<typeof messageFrom>[0]);
  if (from.kind === 'agent') return from.catId;
  if (from.kind === 'external') return from.sender?.name ?? from.sender?.id ?? from.connectorId;
  if (from.kind === 'plugin') return from.instanceId;
  if (from.kind === 'system') return from.service;
  return 'user';
}

export function getQueuedFreshnessSenderLabel(entry: { from: MessageFrom; sourceCategory?: string }): string {
  if (entry.from.kind === 'user') return 'user';
  if (entry.from.kind === 'external' || entry.from.kind === 'plugin') {
    if (entry.sourceCategory === 'review') return 'Review';
    if (entry.sourceCategory === 'issue') return 'Issue';
    if (entry.sourceCategory === 'ci') return 'CI';
    return 'Connector';
  }
  if (entry.from.kind === 'agent') return entry.from.catId;
  return entry.from.service;
}

const INTERNAL_FRESHNESS_USER_IDS = new Set(['system']);

/**
 * Freshness should react only to routable conversation content.
 *
 * Internal diagnostics and tool-only empty stream placeholders may be visible in
 * the stored timeline, but they are not new work for a cat. Keeping this in the
 * freshness domain prevents Phase A/B/D callers from each hand-rolling a slightly
 * different visibility filter.
 *
 * Scheduler-authored messages are intentionally not excluded here: hold-ball and
 * scheduled-task triggers are prompt-visible work, not display-only system badges.
 */
export function isFreshnessRoutableMessage(msg: FreshnessReadableMessage): boolean {
  if (msg.userId && INTERNAL_FRESHNESS_USER_IDS.has(msg.userId)) return false;
  if (msg.origin === 'briefing') return false;
  if (msg.extra?.systemKind === 'context_briefing') return false;
  if (msg.source?.connector === 'routing-guard-failure') return false;

  const hasText = typeof msg.content === 'string' && msg.content.trim().length > 0;
  const hasContentBlocks = Array.isArray(msg.contentBlocks) && msg.contentBlocks.length > 0;
  const hasRichBlocks = Array.isArray(msg.extra?.rich?.blocks) && msg.extra.rich.blocks.length > 0;
  return [hasText, hasContentBlocks, hasRichBlocks].some(Boolean);
}

/**
 * True when `msg` is an expected downstream reply to the current cat's A2A handoff.
 *
 * A line-start @ handoff is a route instruction, not a request to re-wake the caller
 * just because the target produced the expected answer. We recognize that narrow case
 * by following replyTo back to the caller's trigger message and checking that the trigger
 * actually mentioned the replying cat.
 */
export async function isExpectedA2AReplyForCat(
  msg: Pick<FreshnessReadableMessage, 'from' | 'catId' | 'replyTo'>,
  catId: string,
  messageStore: Pick<FreshnessMessageReader, 'getById'>,
): Promise<boolean> {
  const from = messageFrom(msg as unknown as Parameters<typeof messageFrom>[0]);
  const replyCatId = from.kind === 'agent' ? from.catId : null;
  if (!msg.replyTo || !replyCatId || replyCatId === catId) return false;
  if (typeof messageStore.getById !== 'function') return false;

  const parent = await messageStore.getById(msg.replyTo);
  if (!parent) return false;
  const parentFrom = messageFrom(parent as unknown as Parameters<typeof messageFrom>[0]);
  const parentCatId = parentFrom.kind === 'agent' ? parentFrom.catId : null;
  if (parentCatId !== catId) return false;
  return Array.isArray(parent.mentions) && parent.mentions.includes(replyCatId);
}
