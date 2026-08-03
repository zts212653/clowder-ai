/**
 * Queue Enrichment Utility
 *
 * Enriches raw QueueEntry[] with messagePreview data from MessageStore
 * before sending to the frontend via SSE or HTTP.
 *
 * This is a presentation-layer concern: InvocationQueue stores lightweight
 * pointers; the enrichment layer joins persisted message data at emit time.
 */

import type { MessageContent, QueueMessageReceipt } from '@cat-cafe/shared';
import type { QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../domains/cats/services/stores/ports/queued-message-receipt.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

/** Projection of StoredMessage fields useful for QueuePanel / recall-edit. */
export interface QueueEntryMessagePreview {
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
}

/** QueueEntry enriched with message preview for frontend consumption. */
export interface EnrichedQueueEntry extends Omit<QueueEntry, 'ownerAuthProvenance'> {
  targetStates: Record<string, 'queued' | 'notified' | 'awakened' | 'seen' | 'failed' | 'steering' | 'handled'>;
  messagePreview?: QueueEntryMessagePreview;
  queueReceipt?: QueueMessageReceipt;
}

type EnrichedTargetState = EnrichedQueueEntry['targetStates'][string];
type QueueUpdateEmitter = Pick<SocketManager, 'emitToUser'>;

const QUEUE_ENRICHMENT_TIMEOUT_MS = 2_000;

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

function resolveTargetState(
  catId: string,
  state: {
    handled: ReadonlySet<string>;
    steering: ReadonlySet<string>;
    failed: ReadonlySet<string>;
    seen: ReadonlySet<string>;
    awakened: ReadonlySet<string>;
    notified: ReadonlySet<string>;
  },
): EnrichedTargetState {
  if (state.handled.has(catId)) return 'handled';
  if (state.steering.has(catId)) return 'steering';
  if (state.failed.has(catId)) return 'failed';
  if (state.seen.has(catId)) return 'seen';
  if (state.awakened.has(catId)) return 'awakened';
  if (state.notified.has(catId)) return 'notified';
  return 'queued';
}

export function projectPublicQueueEntry(entry: QueueEntry): EnrichedQueueEntry {
  const { ownerAuthProvenance: _internalOwnerAuthProvenance, ...publicEntry } = entry;
  const notified = new Set(entry.queuedNotifiedByCatIds ?? []);
  const awakened = new Set(Object.keys(entry.queuedAwakenedInvocationIdByCatId ?? {}));
  const seen = new Set(entry.queuedSeenByCatIds ?? []);
  const failed = new Set(entry.queuedFailedByCatIds ?? []);
  const handled = new Set(entry.queuedHandledByCatIds ?? []);
  const steering = new Set([
    ...(entry.steerRequestedByCatIds ?? []),
    ...Object.keys(entry.steeredInvocationIdByCatId ?? {}),
  ]);
  const targetCats = Array.isArray(entry.allTargetCats)
    ? entry.allTargetCats
    : [...new Set([...(Array.isArray(entry.targetCats) ? entry.targetCats : []), ...handled])];
  return {
    ...publicEntry,
    targetStates: Object.fromEntries(
      targetCats.map((catId) => [
        catId,
        resolveTargetState(catId, { handled, steering, failed, seen, awakened, notified }),
      ]),
    ),
  };
}

/** Collect all message IDs associated with a queue entry (primary + merged). */
function collectMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [entry.messageId, ...(entry.mergedMessageIds ?? [])].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

/** Build a message preview by aggregating content from all related messages. */
async function buildMessageEnrichment(
  msgIds: string[],
  messageStore: IMessageStore,
): Promise<{ messagePreview?: QueueEntryMessagePreview; queueReceipt?: QueueMessageReceipt } | null> {
  const blocks: MessageContent[] = [];
  let replyTo: string | undefined;
  let queueReceipt: QueueMessageReceipt | undefined;

  const mergeQueueReceipt = (projected: QueueMessageReceipt): void => {
    if (queueReceipt && JSON.stringify(queueReceipt) !== JSON.stringify(projected)) {
      throw new Error(`queue receipt projections diverged for entry ${projected.entryId}`);
    }
    queueReceipt = projected;
  };

  for (const msgId of msgIds) {
    const msg = await messageStore.getById(msgId);
    if (!msg) continue;
    if (msg.contentBlocks) blocks.push(...msg.contentBlocks);
    if (!replyTo && msg.replyTo) replyTo = msg.replyTo;
    if (msg.queueCustody) mergeQueueReceipt(projectQueueReceipt(msg.queueCustody));
  }

  if (blocks.length === 0 && !replyTo && !queueReceipt) return null;
  return {
    ...(blocks.length > 0 || replyTo
      ? {
          messagePreview: {
            ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
            ...(replyTo ? { replyTo } : {}),
          },
        }
      : {}),
    ...(queueReceipt ? { queueReceipt } : {}),
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
  const projected = entries.map(projectPublicQueueEntry);
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

async function enrichQueueEntriesWithinDeadline(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<EnrichedQueueEntry[]> {
  const projected = entries.map(projectPublicQueueEntry);
  if (!messageStore || projected.length === 0) return projected;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUEUE_ENRICHMENT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const enriched = await Promise.race([enrichProjectedQueueEntries(projected, messageStore), deadline]);
    return enriched ?? projected;
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

  // The caller still observes its own failure, while later publications chain
  // from a neutral tail and remain able to advance the same scope.
  const tail: Promise<void> = publication.catch(() => undefined);
  tails.set(scopeKey, tail);
  void tail.then(() => {
    if (tails.get(scopeKey) === tail) tails.delete(scopeKey);
  });
  return publication;
}
