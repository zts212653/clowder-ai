/**
 * Queue Enrichment Utility
 *
 * Enriches raw QueueEntry[] with messagePreview data from MessageStore
 * before sending to the frontend via SSE or HTTP.
 *
 * This is a presentation-layer concern: InvocationQueue stores lightweight
 * pointers; the enrichment layer joins persisted message data at emit time.
 */

import type { MessageContent } from '@cat-cafe/shared';
import type { QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

/** Projection of StoredMessage fields useful for QueuePanel / recall-edit. */
export interface QueueEntryMessagePreview {
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
}

/** QueueEntry enriched with message preview for frontend consumption. */
export interface EnrichedQueueEntry extends QueueEntry {
  messagePreview?: QueueEntryMessagePreview;
}

type QueueUpdateEmitter = Pick<SocketManager, 'emitToUser'>;
const QUEUE_ENRICHMENT_TIMEOUT_MS = 2_000;

/**
 * Full queue snapshots replace frontend state, so every publisher sharing a
 * SocketManager must preserve mutation-time call order for each user scope.
 * Weak ownership keeps independent runtime/test SocketManagers isolated and
 * allows their publication maps to be collected with the manager instance.
 */
const queueUpdatePublicationTails = new WeakMap<QueueUpdateEmitter, Map<string, Promise<void>>>();

function freezeQueueSnapshot(entries: QueueEntry[]): QueueEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(Array.isArray(entry.targetCats) ? { targetCats: [...entry.targetCats] } : {}),
    ...(Array.isArray(entry.mergedMessageIds) ? { mergedMessageIds: [...entry.mergedMessageIds] } : {}),
    ...(entry.senderMeta ? { senderMeta: { ...entry.senderMeta } } : {}),
    ...(entry.callerTraceContext ? { callerTraceContext: { ...entry.callerTraceContext } } : {}),
  }));
}

function publicationTailsFor(socketManager: QueueUpdateEmitter): Map<string, Promise<void>> {
  let tails = queueUpdatePublicationTails.get(socketManager);
  if (!tails) {
    tails = new Map();
    queueUpdatePublicationTails.set(socketManager, tails);
  }
  return tails;
}

/** Collect all message IDs associated with a queue entry (primary + merged). */
function collectMessageIds(entry: QueueEntry): string[] {
  return [entry.messageId, ...(entry.mergedMessageIds ?? [])].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

/** Build a message preview by aggregating content from all related messages. */
async function buildPreview(msgIds: string[], messageStore: IMessageStore): Promise<QueueEntryMessagePreview | null> {
  const blocks: MessageContent[] = [];
  let replyTo: string | undefined;

  for (const msgId of msgIds) {
    const msg = await messageStore.getById(msgId);
    if (!msg) continue;
    if (msg.contentBlocks) blocks.push(...msg.contentBlocks);
    if (!replyTo && msg.replyTo) replyTo = msg.replyTo;
  }

  if (blocks.length === 0 && !replyTo) return null;
  return {
    ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

/**
 * Enrich queue entries with message previews from the message store.
 *
 * For entries with messageId (and mergedMessageIds), aggregates contentBlocks
 * from all associated messages. Returns entries unchanged when messageStore
 * is null or when no messageId is available.
 */
export async function enrichQueueEntries(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<EnrichedQueueEntry[]> {
  if (!messageStore || entries.length === 0) return entries;

  try {
    return await Promise.all(
      entries.map(async (entry) => {
        const msgIds = collectMessageIds(entry);
        if (msgIds.length === 0) return entry;

        const preview = await buildPreview(msgIds, messageStore);
        return preview ? { ...entry, messagePreview: preview } : entry;
      }),
    );
  } catch {
    // Presentation-layer enrichment must not break queue mutations.
    // Fall back to raw entries on any messageStore error.
    return entries;
  }
}

async function enrichQueueEntriesWithinDeadline(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<QueueEntry[] | EnrichedQueueEntry[]> {
  if (!messageStore || entries.length === 0) return entries;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUEUE_ENRICHMENT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const enriched = await Promise.race([enrichQueueEntries(entries, messageStore), deadline]);
    return enriched ?? entries;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Emit an enriched queue_updated SSE event.
 *
 * Convenience wrapper: enriches entries then emits. All 14+ emit points
 * should use this instead of raw socketManager.emitToUser('queue_updated', ...).
 */
export function emitQueueUpdated(
  socketManager: QueueUpdateEmitter,
  userId: string,
  threadId: string,
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
  action: string,
): Promise<void> {
  const snapshot = freezeQueueSnapshot(entries);
  const scopeKey = JSON.stringify([threadId, userId]);
  const tails = publicationTailsFor(socketManager);
  const previous = tails.get(scopeKey) ?? Promise.resolve();
  const publication = previous.then(async () => {
    const payload = await enrichQueueEntriesWithinDeadline(snapshot, messageStore);
    socketManager.emitToUser(userId, 'queue_updated', {
      threadId,
      queue: payload,
      action,
    });
  });
  // A failed publisher must reject to its own caller without poisoning later
  // same-scope publications. The stored tail is therefore failure-neutral.
  const tail: Promise<void> = publication.catch(() => undefined);
  tails.set(scopeKey, tail);
  void tail.then(() => {
    if (tails.get(scopeKey) === tail) tails.delete(scopeKey);
  });
  return publication;
}
