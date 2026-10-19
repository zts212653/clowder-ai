/** Read-only historical message projections and shared visibility helpers.
 * Runtime freshness scanners, Queue bypass adapters and notice producers are retired.
 */

import type { MessageFrom, PublishedFreshnessAnnotation } from '@cat-cafe/shared';
import { getSourceDisplayName } from '../context/ContextAssembler.js';
import { messageFrom } from '../stores/message-from.js';
import type { StoredMessage, ThreadMessageReadOptions } from '../stores/ports/MessageStore.js';

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
    liveCompanion?: NonNullable<StoredMessage['extra']>['liveCompanion'];
    freshness?:
      | PublishedFreshnessAnnotation
      | { kind: 'closure_replacement'; closureId: string; targetCatId: string; originTriggerMessageId?: string | null };
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

export function getFreshnessSenderLabel(msg: Pick<FreshnessReadableMessage, 'from' | 'catId' | 'source'>): string {
  if (msg.source) return getSourceDisplayName(msg.source);
  const from = messageFrom(msg as unknown as Parameters<typeof messageFrom>[0]);
  if (from.kind === 'agent') return from.catId;
  if (from.kind === 'external') return from.sender?.name ?? from.sender?.id ?? from.connectorId;
  if (from.kind === 'plugin') return from.instanceId;
  if (from.kind === 'system') return from.service;
  return 'user';
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
