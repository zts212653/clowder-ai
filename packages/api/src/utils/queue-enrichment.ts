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
  MessageContent,
  QueueMessageReceipt,
  QueueMessageReceiptProjection,
  QueueRecoveryAction,
} from '@cat-cafe/shared';
import type { QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  canSteerQueueSources,
  projectUnconsumedQueueCarrier,
  readQueueCarrierMessages,
} from '../domains/cats/services/agents/invocation/QueueCarrierSourceProjection.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../domains/cats/services/stores/ports/queued-message-receipt.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

/** Projection of StoredMessage fields useful for QueuePanel / recall-edit. */
export interface QueueEntryMessagePreview {
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
}

/** QueueEntry enriched with message preview for frontend consumption. */
export interface EnrichedQueueEntry extends Omit<QueueEntry, 'ownerAuthProvenance' | 'exactSteerBatch'> {
  targetStates: Record<string, 'queued' | 'notified' | 'awakened' | 'seen' | 'failed' | 'steering' | 'handled'>;
  messagePreview?: QueueEntryMessagePreview;
  queueReceipt?: QueueMessageReceipt;
  /** Canonical executable escape hatches. Browser code must not reconstruct these from raw state. */
  recoveryActions: QueueRecoveryAction[];
}

export interface QueueUpdatePublicationOptions {
  receiptMessageIds?: readonly string[];
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function latestQueueEntryExposure(
  entry: QueueEntry,
  catId: string,
  invocationId?: string,
): NonNullable<QueueEntry['queuedBodyExposures']>[number] | undefined {
  let latest: NonNullable<QueueEntry['queuedBodyExposures']>[number] | undefined;
  for (const exposure of entry.queuedBodyExposures ?? []) {
    if (exposure.targetCatId !== catId) continue;
    if (invocationId !== undefined && exposure.invocationId !== invocationId) continue;
    if (!latest || exposure.seenAt >= latest.seenAt) latest = exposure;
  }
  return latest;
}

function hasAgentLiveReceiptEvidence(entry: QueueEntry): boolean {
  return (
    entry.source === 'agent' &&
    Boolean(entry.queuedSeenByCatIds?.length || Object.keys(entry.queuedAwakenedInvocationIdByCatId ?? {}).length)
  );
}

/**
 * Agent/A2A work has a QueueEntry lifecycle but may not have a stored-message
 * queueCustody record. Project its existing per-target truth into the same DTO
 * consumed by QueuePanel; do not let the browser read raw QueueEntry maps.
 *
 * A live seen row requires both the recorded child id and its matching body
 * exposure. Legacy/mismatched evidence stays receipt-visible but without an id,
 * so the UI retains its fail-closed recovery path.
 */
function projectAgentAwakenedTarget(entry: QueueEntry, catId: string): QueueMessageReceipt['targets'][number] {
  const invocationId = entry.queuedAwakenedInvocationIdByCatId?.[catId];
  const awakenedAt = entry.queuedAwakenedAtByCatId?.[catId];
  return {
    catId,
    state: 'awakened',
    ...(isNonEmptyString(invocationId) ? { invocationId } : {}),
    ...(awakenedAt !== undefined ? { awakenedAt } : {}),
  };
}

function projectAgentSeenTarget(entry: QueueEntry, catId: string): QueueMessageReceipt['targets'][number] {
  const invocationId = entry.queuedSeenInvocationIdByCatId?.[catId];
  if (!isNonEmptyString(invocationId)) return { catId, state: 'seen' };
  const exposure = latestQueueEntryExposure(entry, catId, invocationId);
  return exposure ? { catId, state: 'seen', invocationId, seenAt: exposure.seenAt } : { catId, state: 'seen' };
}

function projectAgentFailedTarget(entry: QueueEntry, catId: string): QueueMessageReceipt['targets'][number] {
  const exposure = latestQueueEntryExposure(entry, catId);
  if (exposure) return { catId, state: 'failed', invocationId: exposure.invocationId, seenAt: exposure.seenAt };

  const invocationId = entry.queuedAwakenedInvocationIdByCatId?.[catId];
  const awakenedAt = entry.queuedAwakenedAtByCatId?.[catId];
  return {
    catId,
    state: 'failed',
    ...(isNonEmptyString(invocationId) ? { invocationId } : {}),
    ...(awakenedAt !== undefined ? { awakenedAt } : {}),
  };
}

function projectAgentReceiptTarget(
  entry: QueueEntry,
  catId: string,
  state: EnrichedTargetState,
): QueueMessageReceipt['targets'][number] {
  if (state === 'seen') return projectAgentSeenTarget(entry, catId);
  if (state === 'awakened') return projectAgentAwakenedTarget(entry, catId);
  if (state === 'failed') return projectAgentFailedTarget(entry, catId);
  return { catId, state };
}

function projectAgentQueueReceipt(
  entry: QueueEntry,
  targetCats: readonly string[],
  targetStates: EnrichedQueueEntry['targetStates'],
): QueueMessageReceipt | undefined {
  if (!hasAgentLiveReceiptEvidence(entry)) return undefined;

  return {
    version: 1,
    entryId: entry.id,
    targets: targetCats.map((catId) => projectAgentReceiptTarget(entry, catId, targetStates[catId])),
    reminderAttempts: [],
  };
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Stable optimistic-concurrency fence for a failed Queue target. The fence is
 * derived only from Queue's canonical failure facts, so it survives durable
 * restore and changes whenever a later attempt fails again.
 */
export function failedQueueRecoveryActionId(entry: QueueEntry, catId: string): string {
  const failedAt = entry.queuedFailureAtByCatId?.[catId] ?? 'legacy';
  const reason = entry.queuedFailureReasonByCatId?.[catId] ?? 'unknown';
  const attemptId = entry.queuedAttemptIdByCatId?.[catId] ?? 'initial';
  return ['queue-retry', entry.id, encodeURIComponent(catId), failedAt, reason, encodeURIComponent(attemptId)].join(
    ':',
  );
}

export function projectQueueRecoveryActions(entry: QueueEntry): QueueRecoveryAction[] {
  if (!entry.id || !entry.threadId) return [];
  const threadPath = encodePathSegment(entry.threadId);
  const entryPath = encodePathSegment(entry.id);
  if (entry.status === 'processing') {
    return [
      {
        id: `queue-force-reset:${entry.id}:${entry.processingStartedAt ?? entry.createdAt}`,
        entryId: entry.id,
        kind: 'force_reset',
        request: { method: 'POST', path: `/api/threads/${threadPath}/force-reset` },
      },
    ];
  }

  const failed = new Set(entry.queuedFailedByCatIds ?? []);
  const targetCats = Array.isArray(entry.targetCats) ? entry.targetCats : [];
  const actions: QueueRecoveryAction[] = [...failed]
    .filter((catId) => targetCats.includes(catId))
    .map((catId) => {
      const id = failedQueueRecoveryActionId(entry, catId);
      return {
        id,
        entryId: entry.id,
        kind: 'retry_target' as const,
        targetCatId: catId,
        request: {
          method: 'POST' as const,
          path: `/api/threads/${threadPath}/queue/${entryPath}/targets/${encodePathSegment(catId)}/retry`,
          body: { recoveryActionId: id },
        },
      };
    });
  if (targetCats.some((catId) => !failed.has(catId))) {
    actions.unshift({
      id: `queue-steer:${entry.id}`,
      entryId: entry.id,
      kind: 'steer',
      request: { method: 'POST', path: `/api/threads/${threadPath}/queue/${entryPath}/steer` },
    });
  }
  actions.push({
    id: `queue-withdraw:${entry.id}`,
    entryId: entry.id,
    kind: 'withdraw',
    request: { method: 'DELETE', path: `/api/threads/${threadPath}/queue/${entryPath}` },
  });
  return actions;
}

export function projectPublicQueueEntry(entry: QueueEntry): EnrichedQueueEntry {
  const {
    ownerAuthProvenance: _internalOwnerAuthProvenance,
    exactSteerBatch: _internalExactSteerBatch,
    ...publicEntry
  } = entry;
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
  const targetStates = Object.fromEntries(
    targetCats.map((catId) => [
      catId,
      resolveTargetState(catId, { handled, steering, failed, seen, awakened, notified }),
    ]),
  ) as EnrichedQueueEntry['targetStates'];
  const queueReceipt = projectAgentQueueReceipt(entry, targetCats, targetStates);
  return {
    ...publicEntry,
    targetStates,
    recoveryActions: projectQueueRecoveryActions(entry),
    ...(queueReceipt ? { queueReceipt } : {}),
  };
}

/** Collect all message IDs associated with a queue entry (primary + merged). */
function collectMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [entry.messageId, ...(entry.mergedMessageIds ?? [])].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

type DurableRetryEntry = Pick<QueueEntry, 'id' | 'threadId' | 'userId'>;

/**
 * Resolve the durable attempt that makes one message-backed Retry executable.
 * GET projection and POST execution share this static custody gate; live retry
 * authority is still revalidated atomically by the command route.
 */
export function resolveDurableRetryAttemptId(
  entry: DurableRetryEntry,
  message: StoredMessage,
  targetCatId: string,
): string | undefined {
  if (message.userId !== entry.userId || message.threadId !== entry.threadId || !message.queueCustody) {
    return undefined;
  }
  const targetCarrier = message.queueCustody.carrierByTargetCatId?.[targetCatId];
  const carrierEntryId = targetCarrier?.entryId ?? message.queueCustody.entryId;
  if (carrierEntryId !== entry.id) return undefined;
  const target = projectQueueReceipt(message.queueCustody).targets.find((candidate) => candidate.catId === targetCatId);
  const latest = target?.attempts?.at(-1);
  if (
    target?.state !== 'failed' ||
    target.retryable === false ||
    !latest ||
    (latest.state !== 'failed' && !(latest.state === 'cancelled' && latest.terminalReason === 'invocation_cancelled'))
  ) {
    return undefined;
  }
  return latest.id;
}

function failClosedMessageBackedRetry(entry: EnrichedQueueEntry): EnrichedQueueEntry {
  if (collectMessageIds(entry).length === 0) return entry;
  return {
    ...entry,
    recoveryActions: entry.recoveryActions.filter(
      (action) => action.kind !== 'retry_target' && action.kind !== 'steer',
    ),
  };
}

/** Build a message preview by aggregating content from all related messages. */
async function buildMessageEnrichment(
  entry: EnrichedQueueEntry,
  msgIds: string[],
  messageStore: IMessageStore,
): Promise<{
  messagePreview?: QueueEntryMessagePreview;
  queueReceipt?: QueueMessageReceipt;
  retryableTargetCatIds: ReadonlySet<string>;
}> {
  const blocks: MessageContent[] = [];
  let replyTo: string | undefined;
  let queueReceipt: QueueMessageReceipt | undefined;
  const retryableTargetCatIds = new Set<string>();

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
    for (const action of entry.recoveryActions) {
      if (action.kind === 'retry_target' && resolveDurableRetryAttemptId(entry, msg, action.targetCatId)) {
        retryableTargetCatIds.add(action.targetCatId);
      }
    }
  }

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
    retryableTargetCatIds,
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
  return enrichProjectedQueueEntries(entries, messageStore);
}

async function enrichProjectedQueueEntries(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<EnrichedQueueEntry[]> {
  if (entries.length === 0) return [];
  if (!messageStore) return entries.map(projectPublicQueueEntry).map(failClosedMessageBackedRetry);

  const enriched = await Promise.all(
    entries.map(async (raw): Promise<EnrichedQueueEntry | null> => {
      let entry = projectPublicQueueEntry(raw);
      const msgIds = collectMessageIds(entry);
      if (msgIds.length === 0) return entry;

      try {
        const messages = await readQueueCarrierMessages(raw, messageStore);
        const live = projectUnconsumedQueueCarrier(raw, messages);
        if (!live) return null;
        entry = projectPublicQueueEntry(live);
        const { retryableTargetCatIds, ...enrichment } = await buildMessageEnrichment(
          entry,
          collectMessageIds(entry),
          messageStore,
        );
        return {
          ...entry,
          ...enrichment,
          recoveryActions: entry.recoveryActions.filter(
            (action) =>
              (action.kind !== 'retry_target' || retryableTargetCatIds.has(action.targetCatId)) &&
              (action.kind !== 'steer' ||
                live.targetCats.some((catId) =>
                  canSteerQueueSources(
                    live,
                    messages.filter((message) => collectMessageIds(entry).includes(message.id)),
                    catId,
                  ),
                )),
          ),
        };
      } catch {
        // Preview failures do not suppress Queue publication, but custody-dependent
        // Retry must fail closed until the store can prove the exact action again.
        return failClosedMessageBackedRetry(entry);
      }
    }),
  );
  return enriched.filter((entry): entry is EnrichedQueueEntry => entry !== null);
}

async function projectMessageReceipts(
  messageIds: readonly string[],
  messageStore: IMessageStore,
): Promise<QueueMessageReceiptProjection[]> {
  const uniqueMessageIds = [...new Set(messageIds.filter((messageId) => messageId.length > 0))];
  const projections = await Promise.all(
    uniqueMessageIds.map(async (messageId): Promise<QueueMessageReceiptProjection | undefined> => {
      try {
        const message = await messageStore.getById(messageId);
        return message?.queueCustody
          ? { messageId, queueReceipt: projectQueueReceipt(message.queueCustody) }
          : undefined;
      } catch {
        // Socket projection is recoverable from history hydration. One unavailable
        // message must not suppress the ordered Queue snapshot or sibling receipts.
        return undefined;
      }
    }),
  );
  return projections.filter((projection): projection is QueueMessageReceiptProjection => projection !== undefined);
}

async function buildQueueUpdateProjectionWithinDeadline(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
  receiptMessageIds: readonly string[],
): Promise<{ queue: EnrichedQueueEntry[]; messageReceipts?: QueueMessageReceiptProjection[] }> {
  const projected = entries.map(projectPublicQueueEntry);
  const failClosedProjection = projected.map(failClosedMessageBackedRetry);
  if (!messageStore) return { queue: failClosedProjection };
  if (projected.length === 0 && receiptMessageIds.length === 0) return { queue: projected };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUEUE_ENRICHMENT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const update = Promise.all([
      enrichProjectedQueueEntries(entries, messageStore),
      projectMessageReceipts(receiptMessageIds, messageStore),
    ]).then(([queue, messageReceipts]) => ({
      queue,
      ...(messageReceipts.length > 0 ? { messageReceipts } : {}),
    }));
    return (await Promise.race([update, deadline])) ?? { queue: failClosedProjection };
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
  options: QueueUpdatePublicationOptions = {},
): Promise<void> {
  const snapshot = freezeQueueSnapshot(entries);
  const receiptMessageIds = [...new Set(options.receiptMessageIds ?? [])];
  const scopeKey = JSON.stringify([threadId, userId]);
  const tails = publicationTailsFor(socketManager);
  const previous = tails.get(scopeKey) ?? Promise.resolve();
  const publication = previous.then(async () => {
    const payload = await buildQueueUpdateProjectionWithinDeadline(snapshot, messageStore, receiptMessageIds);
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
