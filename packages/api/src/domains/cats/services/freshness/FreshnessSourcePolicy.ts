import { isCrossThreadProvenance, type MessageFrom } from '@cat-cafe/shared';
import { messageFrom } from '../stores/message-from.js';

export interface FreshnessSourceMessage {
  threadId?: string;
  from?: MessageFrom;
  catId: string | null;
  extra?: { crossPost?: { sourceThreadId: string } };
}

export interface FreshnessQueueSourceEntry {
  from: MessageFrom;
  sourceCategory?: string;
  messageId?: string | null;
}

export interface FreshnessSourceMessageReader {
  getById?(id: string): FreshnessSourceMessage | null | Promise<FreshnessSourceMessage | null>;
}

/**
 * Same-cat speech from another thread belongs to a parallel invocation, not
 * to the active turn that is deciding freshness. Provenance must be structured
 * and target the current thread; prose and catId alone are insufficient.
 */
export function hasCrossThreadFreshnessProvenance(message: FreshnessSourceMessage, targetThreadId: string): boolean {
  if (message.threadId !== undefined && message.threadId !== targetThreadId) return false;
  return isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, targetThreadId);
}

export function isFreshnessSelfSourceMessage(
  message: FreshnessSourceMessage,
  catId: string,
  targetThreadId: string,
): boolean {
  const from = messageFrom(message as unknown as Parameters<typeof messageFrom>[0]);
  const authorCatId = from.kind === 'agent' ? from.catId : null;
  return authorCatId === catId && !hasCrossThreadFreshnessProvenance(message, targetThreadId);
}

/**
 * Queue rows do not carry thread provenance directly. Resolve their bounded,
 * durable trigger identities and fail closed as self-source when exact message
 * provenance is unavailable. Only explicit A2A rows can represent parallel-self
 * coordination; continuations remain self-source.
 */
export async function isFreshnessSelfSourceQueueEntry(
  entry: FreshnessQueueSourceEntry,
  catId: string,
  targetThreadId: string,
  messageStore: FreshnessSourceMessageReader,
): Promise<boolean> {
  if (!(entry.from.kind === 'agent' && entry.from.catId === catId)) return false;
  if (entry.sourceCategory !== 'a2a' || !messageStore.getById) return true;

  const messageIds = entry.messageId ? [entry.messageId] : [];
  for (const messageId of messageIds) {
    const message = await messageStore.getById(messageId);
    const from = message ? messageFrom(message as unknown as Parameters<typeof messageFrom>[0]) : null;
    const authorCatId = from?.kind === 'agent' ? from.catId : null;
    if (message && authorCatId === catId && hasCrossThreadFreshnessProvenance(message, targetThreadId)) {
      return false;
    }
  }
  return true;
}
