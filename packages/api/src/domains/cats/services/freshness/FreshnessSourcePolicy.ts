import { isCrossThreadProvenance } from '@cat-cafe/shared';

export interface FreshnessSourceMessage {
  threadId?: string;
  catId: string | null;
  extra?: { crossPost?: { sourceThreadId: string } };
}

export interface FreshnessQueueSourceEntry {
  source: string;
  callerCatId?: string;
  sourceCategory?: string;
  messageId?: string | null;
  mergedMessageIds?: string[];
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
  return message.catId === catId && !hasCrossThreadFreshnessProvenance(message, targetThreadId);
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
  if (!(entry.source === 'agent' && entry.callerCatId === catId)) return false;
  if (entry.sourceCategory !== 'a2a' || !messageStore.getById) return true;

  const messageIds = [entry.messageId ?? '', ...(entry.mergedMessageIds ?? [])].filter(
    (messageId, index, all) => messageId.length > 0 && all.indexOf(messageId) === index,
  );
  for (const messageId of messageIds) {
    const message = await messageStore.getById(messageId);
    if (message?.catId === catId && hasCrossThreadFreshnessProvenance(message, targetThreadId)) {
      return false;
    }
  }
  return true;
}
