/**
 * Queue Enrichment Utility
 *
 * Enriches raw QueueEntry[] with messagePreview data from MessageStore
 * for HTTP. Mutation SSE publishes the pending ledger immediately.
 *
 * This is a presentation-layer concern: InvocationQueue stores lightweight
 * pointers; the enrichment layer joins persisted message data at emit time.
 */

import type {
  CatRoutingError,
  ConnectorSource,
  MessageContent,
  MessageFrom,
  QueueAuthorIntentReceipt,
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
  /** Stored connector identity, so a queue row can render the same summary as its timeline bubble. */
  connector?: string;
  source?: ConnectorSource;
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
  createdAt: number;
  autoExecute: boolean;
  priority: QueueEntry['priority'];
  sourceCategory?: QueueEntry['sourceCategory'];
  continuationKey?: string;
  position?: number;
  messagePreview?: QueueEntryMessagePreview;
}

type QueueUpdateEmitter = Pick<SocketManager, 'emitToUser'>;

/** RFC #1356 private inputs are execution custody, never user-visible Queue rows. */
export function isPublicQueueEntry(entry: Pick<QueueEntry, 'kind'>): boolean {
  return entry.kind !== 'private_input';
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
  let connector: string | undefined;
  let source: ConnectorSource | undefined;

  for (const msgId of msgIds) {
    const msg = await messageStore.getById(msgId);
    if (!msg) continue;
    if (msg.contentBlocks) blocks.push(...msg.contentBlocks);
    if (!replyTo && msg.replyTo) replyTo = msg.replyTo;
    if (!connector && msg.source?.connector) connector = msg.source.connector;
    if (!source && msg.source) source = structuredClone(msg.source);
  }

  if (blocks.length === 0 && !replyTo && !connector) return null;
  return {
    messagePreview: {
      ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(connector ? { connector } : {}),
      ...(source ? { source } : {}),
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

/**
 * Publish committed pending targets without joining presentation data.
 * /queue supplies rich previews and fenced actions after this event. Waiting
 * for History here delays scheduling and retirement even with an idle member.
 * One synchronous publication prevents late preview work from restoring targets.
 */
export async function emitQueueUpdated(
  socketManager: QueueUpdateEmitter,
  userId: string,
  threadId: string,
  entries: QueueEntry[],
  action: string,
): Promise<void> {
  const queue = entries.filter(isPublicQueueEntry).map(projectPublicQueueEntry);
  socketManager.emitToUser(userId, 'queue_updated', { threadId, queue, action });
}
