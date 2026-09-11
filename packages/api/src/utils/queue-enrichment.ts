/**
 * Queue Enrichment Utility
 *
 * Enriches raw QueueEntry[] with messagePreview data from MessageStore
 * before sending to the frontend via SSE or HTTP.
 *
 * This is a presentation-layer concern: InvocationQueue stores lightweight
 * pointers; the enrichment layer joins persisted message data at emit time.
 */

import type {
  CatRoutingError,
  MessageContent,
  MessageFrom,
  QueueAuthorIntentReceipt,
  QueueReminderAttempt,
} from '@cat-cafe/shared';
import {
  type QueueEntry,
  queueEntryOwnerId,
  queueEntryTargetCats,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

/** Projection of StoredMessage fields useful for QueuePanel / recall-edit. */
export interface QueueEntryMessagePreview {
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
}

/** Stable browser DTO. The durable ledger remains nested and is never leaked to clients. */
export interface EnrichedQueueEntry {
  id: string;
  threadId: string;
  userId: string;
  content: string;
  messageId: string | null;
  mergedMessageIds: string[];
  from: MessageFrom;
  targetCats: string[];
  routingWarnings?: readonly CatRoutingError[];
  intent: string;
  status: 'queued';
  /** Pending-target delivery preference; actual delivery lives in History dispatchRefs. */
  authorIntentByTarget?: Record<string, QueueAuthorIntentReceipt>;
  /** Reminder requests remain scoped to targets that are still pending. */
  reminderAttempts?: readonly QueueReminderAttempt[];
  createdAt: number;
  autoExecute: boolean;
  priority: QueueEntry['priority'];
  sourceCategory?: QueueEntry['sourceCategory'];
  continuationKey?: string;
  position?: number;
  messagePreview?: QueueEntryMessagePreview;
}

type QueueUpdateEmitter = Pick<SocketManager, 'emitToUser'>;

const QUEUE_ENRICHMENT_TIMEOUT_MS = 2_000;

/** RFC #1356 private inputs are execution custody, never user-visible Queue rows. */
export function isPublicQueueEntry(entry: Pick<QueueEntry, 'kind'>): boolean {
  return entry.kind !== 'private_input';
}

/**
 * Queue updates are full-state replacements in the browser. Keep one ordered
 * publication tail for each runtime/thread/user scope so a slow older preview
 * lookup cannot arrive after a newer queue mutation. Weak ownership isolates
 * runtime and test SocketManager instances without retaining them globally.
 */
const queueUpdatePublicationTails = new WeakMap<QueueUpdateEmitter, Map<string, Promise<void>>>();

function freezeQueueSnapshot(entries: QueueEntry[]): QueueEntry[] {
  return structuredClone(entries);
}

function publicationTailsFor(socketManager: QueueUpdateEmitter): Map<string, Promise<void>> {
  let tails = queueUpdatePublicationTails.get(socketManager);
  if (!tails) {
    tails = new Map();
    queueUpdatePublicationTails.set(socketManager, tails);
  }
  return tails;
}

function projectAuthorIntents(entry: QueueEntry): Record<string, QueueAuthorIntentReceipt> | undefined {
  const projected = Object.fromEntries(
    entry.targets.flatMap((targetId) => {
      const intent = entry.delivery.authorIntentByTarget?.[targetId];
      if (!intent) return [];
      return [[targetId, { ...intent, effective: intent.fallbackAt ? 'next_work' : intent.requested }]];
    }),
  );
  return Object.keys(projected).length > 0 ? projected : undefined;
}

export function projectPublicQueueEntry(entry: QueueEntry): EnrichedQueueEntry {
  const targetCats = queueEntryTargetCats(entry);
  const authorIntentByTarget = projectAuthorIntents(entry);
  const reminderAttempts = entry.delivery.reminderAttempts?.filter((attempt) =>
    targetCats.includes(attempt.targetCatId),
  );
  return {
    id: entry.id,
    threadId: entry.threadId,
    userId: queueEntryOwnerId(entry),
    content: entry.payload.content,
    messageId: entry.payload.messageId ?? null,
    mergedMessageIds: [],
    from: structuredClone(entry.from),
    targetCats,
    ...(entry.payload.routingWarnings ? { routingWarnings: structuredClone(entry.payload.routingWarnings) } : {}),
    intent: entry.execution.intent,
    status: 'queued',
    ...(authorIntentByTarget ? { authorIntentByTarget } : {}),
    ...(reminderAttempts?.length ? { reminderAttempts: structuredClone(reminderAttempts) } : {}),
    createdAt: entry.enqueuedAt,
    autoExecute: entry.execution.autoExecute,
    priority: entry.priority,
    ...(entry.sourceCategory ? { sourceCategory: entry.sourceCategory } : {}),
    ...(entry.sourceCategory === 'continuation' ? { continuationKey: entry.payload.sourceRecordId } : {}),
    ...(entry.position !== undefined ? { position: entry.position } : {}),
  };
}

/** One source entry references at most one History message. */
function collectMessageIds(entry: Pick<EnrichedQueueEntry, 'messageId'>): string[] {
  return entry.messageId ? [entry.messageId] : [];
}

/** Build a message preview by aggregating content from all related messages. */
async function buildMessageEnrichment(
  msgIds: string[],
  messageStore: IMessageStore,
): Promise<{ messagePreview: QueueEntryMessagePreview } | null> {
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
    messagePreview: {
      ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
      ...(replyTo ? { replyTo } : {}),
    },
  };
}

/**
 * Enrich queue entries with message previews from the message store.
 *
 * For entries with a messageId, projects its rich History preview. Returns
 * entries unchanged when messageStore is null or no messageId is available.
 */
export async function enrichQueueEntries(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<EnrichedQueueEntry[]> {
  const projected = entries.filter(isPublicQueueEntry).map(projectPublicQueueEntry);
  return enrichProjectedQueueEntries(projected, messageStore);
}

async function enrichProjectedQueueEntries(
  projected: EnrichedQueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<EnrichedQueueEntry[]> {
  if (!messageStore || projected.length === 0) return projected;

  try {
    return await Promise.all(
      projected.map(async (entry) => {
        const msgIds = collectMessageIds(entry);
        if (msgIds.length === 0) return entry;

        const enrichment = await buildMessageEnrichment(msgIds, messageStore);
        return enrichment ? { ...entry, ...enrichment } : entry;
      }),
    );
  } catch {
    // Presentation-layer enrichment must not break queue mutations.
    // Fall back to raw entries on any messageStore error.
    return projected;
  }
}

async function buildQueueUpdateProjectionWithinDeadline(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<{ queue: EnrichedQueueEntry[] }> {
  const projected = entries.filter(isPublicQueueEntry).map(projectPublicQueueEntry);
  if (!messageStore || projected.length === 0) return { queue: projected };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUEUE_ENRICHMENT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const update = enrichProjectedQueueEntries(projected, messageStore).then((queue) => ({ queue }));
    return (await Promise.race([update, deadline])) ?? { queue: projected };
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
    const payload = await buildQueueUpdateProjectionWithinDeadline(snapshot, messageStore);
    socketManager.emitToUser(userId, 'queue_updated', {
      threadId,
      ...payload,
      action,
    });
  });

  // The caller still observes its own failure, while later publications chain
  // from a neutral tail and remain able to advance the same scope.
  const tail: Promise<void> = publication.catch(() => undefined);
  tails.set(scopeKey, tail);
  void tail.then(() => {
    if (tails.get(scopeKey) === tail) tails.delete(scopeKey);
  });
  return publication;
}
