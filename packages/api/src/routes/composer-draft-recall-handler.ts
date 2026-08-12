import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationQueue, QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type {
  QueuedMessageCustodyCoordinator,
  RecallMessageToComposerDraftCoordinatorResult,
} from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { IIndexBuilder, MessageRecallSuppressionLease } from '../domains/memory/interfaces.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { enrichQueueEntries } from '../utils/queue-enrichment.js';
import {
  projectRecallMessage,
  queueEntryMessageIds,
  rebuildCarrierWithout,
  recallBodySchema,
} from './composer-draft-recall-helpers.js';
import { buildRecallSuccessResponse, emitRecallProjection } from './composer-draft-recall-projection.js';
import {
  type DerivedTitleSuppression,
  prepareDerivedTitleSuppression,
  restoreDerivedTitleSuppression,
} from './composer-draft-recall-title.js';

type RecallRequest = FastifyRequest<{ Params: { id: string } }>;

export interface RecallMessageRouteOptions {
  messageStore: IMessageStore;
  threadStore: Pick<IThreadStore, 'get' | 'compareAndSetTitle'>;
  socketManager: SocketManager;
  invocationQueue: InvocationQueue;
  queueCustodyCoordinator: Pick<QueuedMessageCustodyCoordinator, 'recallMessageToComposerDraft'>;
  queueProcessor?: Pick<QueueProcessor, 'unregisterEntryCompleteHook' | 'finalizeRemovedEntry'>;
  indexBuilder: Pick<
    IIndexBuilder,
    'suppressMessagePassage' | 'releaseMessagePassageSuppression' | 'finalizeMessagePassageSuppression'
  >;
}

interface RecallContext {
  request: RecallRequest;
  ownerUserId: string;
  messageId: string;
  threadId: string;
  expectedDraftRevision: number;
  merge: 'replace' | 'append';
  target: StoredMessage;
  opts: RecallMessageRouteOptions;
}

interface CarrierContext {
  entryId: string;
  current: QueueEntry | null;
  nextEntryId?: string;
  storedMembers: ReadonlyMap<string, { id: string; content: string }>;
}

interface RecallPreparation {
  indexLease: MessageRecallSuppressionLease;
  titleSuppression: DerivedTitleSuppression | null;
}

type Resolution<T> = { ok: true; value: T } | { ok: false; body: Record<string, unknown> };

function reject(reply: FastifyReply, status: number, body: Record<string, unknown>): Resolution<never> {
  reply.status(status);
  return { ok: false, body };
}

async function resolveRecallContext(
  request: RecallRequest,
  reply: FastifyReply,
  ownerUserId: string,
  opts: RecallMessageRouteOptions,
): Promise<Resolution<RecallContext>> {
  const parsed = recallBodySchema.safeParse(request.body);
  if (!parsed.success) return reject(reply, 400, { error: 'Invalid request body', details: parsed.error.issues });
  const target = await opts.messageStore.getById(request.params.id);
  if (!target) return reject(reply, 404, { error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
  if (target.userId !== ownerUserId || target.threadId !== parsed.data.threadId) {
    return reject(reply, 403, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
  return {
    ok: true,
    value: {
      request,
      ownerUserId,
      messageId: request.params.id,
      target,
      opts,
      ...parsed.data,
    },
  };
}

async function resolveCarrier(context: RecallContext, reply: FastifyReply): Promise<Resolution<CarrierContext>> {
  const entryId = context.target.queueCustody?.entryId;
  if (!entryId) return reject(reply, 409, { error: 'Message is not recallable', code: 'MESSAGE_NOT_RECALLABLE' });
  const entries = context.opts.invocationQueue.list(context.threadId, context.ownerUserId);
  const entryIndex = entries.findIndex((entry) => entry.id === entryId);
  const current =
    entryIndex >= 0
      ? context.opts.invocationQueue.getEntrySnapshot(context.threadId, context.ownerUserId, entryId)
      : null;
  if (current && !queueEntryMessageIds(current).includes(context.messageId)) {
    return reject(reply, 409, { error: 'Message carrier mismatch', code: 'QUEUE_CARRIER_MISMATCH' });
  }
  const members = current
    ? await Promise.all(queueEntryMessageIds(current).map((messageId) => context.opts.messageStore.getById(messageId)))
    : [];
  if (members.some((message) => !message)) {
    return reject(reply, 503, { error: 'Queue carrier is incomplete', code: 'QUEUE_CARRIER_INCOMPLETE' });
  }
  return {
    ok: true,
    value: {
      entryId,
      current,
      nextEntryId: entryIndex >= 0 ? entries[entryIndex + 1]?.id : undefined,
      storedMembers: new Map(
        members
          .filter((message): message is StoredMessage => message !== null)
          .map(({ id, content }) => [id, { id, content }]),
      ),
    },
  };
}

async function releasePreparation(
  context: RecallContext,
  preparation: RecallPreparation,
  stage: string,
): Promise<void> {
  let restoredFinalLease = false;
  try {
    restoredFinalLease = await context.opts.indexBuilder.releaseMessagePassageSuppression(preparation.indexLease);
  } catch (error) {
    context.request.log.error(
      { error, threadId: context.threadId, messageId: context.messageId, stage },
      'true recall rejection could not release index suppression',
    );
  }
  const title = preparation.titleSuppression;
  if (title && restoredFinalLease) {
    try {
      await restoreDerivedTitleSuppression(context.opts.threadStore, context.threadId, title);
    } catch (error) {
      context.request.log.error(
        { error, threadId: context.threadId, messageId: context.messageId, stage },
        'true recall rejection could not restore derived thread title',
      );
    }
  }
}

async function prepareSuppression(context: RecallContext, reply: FastifyReply): Promise<Resolution<RecallPreparation>> {
  let indexLease: MessageRecallSuppressionLease | null = null;
  let titleSuppression: DerivedTitleSuppression | null = null;
  try {
    indexLease = await context.opts.indexBuilder.suppressMessagePassage(context.threadId, context.messageId);
    titleSuppression = await prepareDerivedTitleSuppression(
      context.opts.threadStore,
      context.threadId,
      context.target.content,
    );
    return { ok: true, value: { indexLease, titleSuppression } };
  } catch (error) {
    if (indexLease) {
      await releasePreparation(context, { indexLease, titleSuppression }, 'index_or_title_prepare');
    }
    context.request.log.error(
      { error, threadId: context.threadId, messageId: context.messageId },
      'true recall index suppression failed',
    );
    return reject(reply, 503, {
      error: 'True recall index preparation failed',
      code: 'RECALL_INDEX_PREPARE_FAILED',
    });
  }
}

async function buildAlreadyRecalledResponse(
  context: RecallContext,
  message: StoredMessage,
  existingLease?: MessageRecallSuppressionLease,
) {
  const lease =
    existingLease ?? (await context.opts.indexBuilder.suppressMessagePassage(context.threadId, context.messageId));
  await context.opts.indexBuilder.finalizeMessagePassageSuppression(lease);
  const draft = await context.opts.messageStore.getOwnerComposerDraft(context.ownerUserId, context.threadId);
  return {
    verdict: 'already_recalled',
    message: projectRecallMessage(message),
    draft,
    insertedRange: null,
    queue: await enrichQueueEntries(
      context.opts.invocationQueue.list(context.threadId, context.ownerUserId),
      context.opts.messageStore,
    ),
  };
}

async function commitRecall(
  context: RecallContext,
  carrier: CarrierContext,
  preparation: RecallPreparation,
): Promise<RecallMessageToComposerDraftCoordinatorResult> {
  const restoreCurrent = () => {
    if (carrier.current) {
      context.opts.invocationQueue.restoreDurableEntry(carrier.current, { beforeEntryId: carrier.nextEntryId });
    }
  };
  try {
    return await context.opts.queueCustodyCoordinator.recallMessageToComposerDraft(
      carrier.entryId,
      context.messageId,
      {
        ownerUserId: context.ownerUserId,
        threadId: context.threadId,
        expectedDraftRevision: context.expectedDraftRevision,
        merge: context.merge,
        recalledAt: Date.now(),
      },
      carrier.current
        ? {
            freeze: () => context.opts.invocationQueue.removeEntrySnapshotIfUnchanged(carrier.current as QueueEntry),
            restore: restoreCurrent,
          }
        : undefined,
    );
  } catch (error) {
    await releasePreparation(context, preparation, 'canonical_recall_rejected');
    throw error;
  }
}

async function projectRecallFailure(
  context: RecallContext,
  preparation: RecallPreparation,
  reply: FastifyReply,
  result: Exclude<RecallMessageToComposerDraftCoordinatorResult, { kind: 'recalled' } | { kind: 'already_recalled' }>,
): Promise<Record<string, unknown>> {
  await releasePreparation(context, preparation, 'canonical_recall_rejected');
  if (result.kind === 'draft_revision_mismatch') {
    reply.status(409);
    return { code: 'DRAFT_REVISION_MISMATCH', actualRevision: result.actualRevision };
  }
  if (result.kind === 'carrier_changed') {
    reply.status(409);
    return { error: 'Queue carrier changed concurrently', code: 'QUEUE_CARRIER_CHANGED' };
  }
  reply.status(result.kind === 'not_found' ? 404 : result.kind === 'unauthorized' ? 403 : 409);
  return {
    error: 'Message is not recallable',
    code: result.kind === 'not_found' ? 'MESSAGE_NOT_FOUND' : 'MESSAGE_NOT_RECALLABLE',
  };
}

async function finalizeCarrier(context: RecallContext, carrier: CarrierContext): Promise<void> {
  const replacement = carrier.current
    ? rebuildCarrierWithout(carrier.current, context.messageId, carrier.storedMembers)
    : null;
  if (replacement) {
    context.opts.invocationQueue.restoreDurableEntry(replacement, { beforeEntryId: carrier.nextEntryId });
    return;
  }
  if (!carrier.current) return;
  context.opts.queueProcessor?.unregisterEntryCompleteHook(carrier.entryId);
  try {
    await context.opts.queueProcessor?.finalizeRemovedEntry(carrier.current, 'user_cancel');
  } catch (error) {
    context.request.log.error(
      { error, entryId: carrier.entryId },
      'true recall committed; Queue record finalization deferred to recovery',
    );
  }
}

async function finalizeRecallResult(
  context: RecallContext,
  carrier: CarrierContext,
  preparation: RecallPreparation,
  reply: FastifyReply,
  result: RecallMessageToComposerDraftCoordinatorResult,
) {
  if (result.kind === 'already_recalled') {
    return buildAlreadyRecalledResponse(context, result.message, preparation.indexLease);
  }
  if (result.kind !== 'recalled') return projectRecallFailure(context, preparation, reply, result);
  try {
    await context.opts.indexBuilder.finalizeMessagePassageSuppression(preparation.indexLease);
  } catch (error) {
    context.request.log.error(
      { error, threadId: context.threadId, messageId: context.messageId },
      'true recall committed; index suppression finalization deferred to startup reconciliation',
    );
  }
  await finalizeCarrier(context, carrier);
  const projectionContext = {
    socketManager: context.opts.socketManager,
    messageStore: context.opts.messageStore,
    invocationQueue: context.opts.invocationQueue,
    ownerUserId: context.ownerUserId,
    threadId: context.threadId,
    messageId: context.messageId,
    result,
  };
  await emitRecallProjection(projectionContext, preparation.titleSuppression, (error) => {
    context.request.log.error(
      { error, threadId: context.threadId, messageId: context.messageId },
      'true recall committed; realtime projection failed',
    );
  });
  return buildRecallSuccessResponse(projectionContext);
}

export function createRecallMessageHandler(
  opts: RecallMessageRouteOptions,
  resolveOwner: (request: RecallRequest, reply: FastifyReply) => string | null,
) {
  return async (request: RecallRequest, reply: FastifyReply) => {
    const ownerUserId = resolveOwner(request, reply);
    if (!ownerUserId) return { error: 'Authentication required', code: 'AUTH_REQUIRED' };
    const resolved = await resolveRecallContext(request, reply, ownerUserId, opts);
    if (!resolved.ok) return resolved.body;
    const context = resolved.value;
    if (context.target.recall) return buildAlreadyRecalledResponse(context, context.target);
    const carrier = await resolveCarrier(context, reply);
    if (!carrier.ok) return carrier.body;
    const prepared = await prepareSuppression(context, reply);
    if (!prepared.ok) return prepared.body;
    const preparation = prepared.value;
    const result = await commitRecall(context, carrier.value, preparation);
    return finalizeRecallResult(context, carrier.value, preparation, reply, result);
  };
}
