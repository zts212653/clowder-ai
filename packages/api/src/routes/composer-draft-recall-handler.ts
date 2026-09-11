import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationQueue, QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type {
  IMessageStore,
  RecallMessageToComposerDraftResult,
  StoredMessage,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { IIndexBuilder, MessageRecallSuppressionLease } from '../domains/memory/interfaces.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { enrichQueueEntries } from '../utils/queue-enrichment.js';
import { projectRecallMessage, recallBodySchema } from './composer-draft-recall-helpers.js';
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
  entries: QueueEntry[];
}

type RecallCommitResult = RecallMessageToComposerDraftResult | { kind: 'carrier_changed' };

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
  const claim = await context.opts.invocationQueue.claimMessageEntriesForWithdrawal(
    context.threadId,
    context.ownerUserId,
    context.messageId,
  );
  if (claim.outcome === 'processing') {
    return reject(reply, 409, { error: 'Message is already processing', code: 'ENTRY_PROCESSING' });
  }
  if (claim.outcome === 'not_found') {
    return reject(reply, 409, { error: 'Message is not recallable', code: 'MESSAGE_NOT_RECALLABLE' });
  }
  if (claim.outcome !== 'claimed') {
    return reject(reply, 409, { error: 'Queue carrier changed concurrently', code: 'QUEUE_CARRIER_CHANGED' });
  }
  return { ok: true, value: { entries: claim.entries } };
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
): Promise<RecallCommitResult> {
  const entryIds = carrier.entries.map((entry) => entry.id);
  try {
    const result = await context.opts.messageStore.recallMessageToComposerDraft(context.messageId, {
      ownerUserId: context.ownerUserId,
      threadId: context.threadId,
      expectedDraftRevision: context.expectedDraftRevision,
      merge: context.merge,
      recalledAt: Date.now(),
    });
    if (result.kind === 'recalled' || result.kind === 'already_recalled') {
      if (!(await context.opts.invocationQueue.commitClaimedMessageWithdrawal(context.threadId, entryIds))) {
        context.request.log.error(
          { threadId: context.threadId, messageId: context.messageId, entryIds },
          'true recall committed; claimed Queue withdrawal deferred to restart hydration',
        );
      }
      return result;
    }
    return (await context.opts.invocationQueue.restoreClaimedEntries(context.threadId, entryIds))
      ? result
      : { kind: 'carrier_changed' };
  } catch (error) {
    await context.opts.invocationQueue.restoreClaimedEntries(context.threadId, entryIds);
    await releasePreparation(context, preparation, 'canonical_recall_rejected');
    throw error;
  }
}

async function projectRecallFailure(
  context: RecallContext,
  preparation: RecallPreparation,
  reply: FastifyReply,
  result: Exclude<RecallCommitResult, { kind: 'recalled' } | { kind: 'already_recalled' }>,
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
  for (const entry of carrier.entries) {
    context.opts.queueProcessor?.unregisterEntryCompleteHook(entry.id);
    try {
      await context.opts.queueProcessor?.finalizeRemovedEntry(entry, 'user_cancel');
    } catch (error) {
      context.request.log.error(
        { error, entryId: entry.id },
        'true recall committed; Queue record finalization deferred to recovery',
      );
    }
  }
}

async function finalizeRecallResult(
  context: RecallContext,
  carrier: CarrierContext,
  preparation: RecallPreparation,
  reply: FastifyReply,
  result: RecallCommitResult,
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
    const prepared = await prepareSuppression(context, reply);
    if (!prepared.ok) return prepared.body;
    const preparation = prepared.value;
    const carrier = await resolveCarrier(context, reply);
    if (!carrier.ok) {
      await releasePreparation(context, preparation, 'queue_claim_rejected');
      return carrier.body;
    }
    const result = await commitRecall(context, carrier.value, preparation);
    return finalizeRecallResult(context, carrier.value, preparation, reply, result);
  };
}
