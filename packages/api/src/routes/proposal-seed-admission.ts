import type { CatId, MessageContent } from '@cat-cafe/shared';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { messageFrom } from '../domains/cats/services/stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import type { AppendApprovedInitialMessageResult } from './proposal-approve-dispatch.js';
import { admitThreadParticipants } from './thread-participant-admission.js';

type ProposalInvocationQueue = Pick<InvocationQueue, 'appendAndEnqueueDurable' | 'enqueueExistingMessageDurable'>;
type ProposalQueueProcessor = Pick<QueueProcessor, 'processNext'>;

/**
 * Lossless source envelope delivered to a child thread when the proposal has no
 * explicit initialMessage. It carries the exact proposal fields (title, reason,
 * sourceMessageId) so the child can verify the original input instead of parsing
 * it out of the thread title.
 */
export interface SourceEnvelope {
  title: string;
  reason: string;
  /** Exact trigger message in the parent thread, if known. */
  sourceMessageId?: string | null;
}

export function buildSourceEnvelopeContent(envelope: SourceEnvelope): string {
  const lines = [`**来源**: ${envelope.title}`, '', envelope.reason];
  if (envelope.sourceMessageId) {
    lines.push('', `**源消息**: \`${envelope.sourceMessageId}\``);
  }
  return lines.join('\n');
}

export async function resolveSourceContentBlocks(
  sourceEnvelope: SourceEnvelope,
  messageStore: IMessageStore,
): Promise<readonly MessageContent[] | undefined> {
  if (!sourceEnvelope.sourceMessageId) {
    return undefined;
  }
  try {
    const sourceMessage = await messageStore.getById(sourceEnvelope.sourceMessageId);
    if (sourceMessage?.contentBlocks && sourceMessage.contentBlocks.length > 0) {
      return sourceMessage.contentBlocks;
    }
  } catch {
    // P2: source-block lookup is best-effort. The approve route has already
    // finalized the proposal; a transient storage failure here must not drop
    // the dispatch. The text envelope is sufficient to wake the assigned cat.
  }
  return undefined;
}

/**
 * Cancel an existing seed so the materialization-vs-wake invariant stays terminal.
 * Legacy rows have deliveryStatus=undefined, which MessageStore.markCanceled treats
 * as a no-op, so we first adopt them into queued state via prepareQueueAdmission and
 * verify the cancel actually won.
 */
export async function cancelExistingSeed(
  existingSeed: StoredMessage,
  messageStore: IMessageStore,
  reason: string,
): Promise<AppendApprovedInitialMessageResult> {
  const seedId = existingSeed.id;

  if (existingSeed.deliveryStatus === 'delivered' || existingSeed.deliveryStatus === 'canceled') {
    return { messageId: seedId };
  }

  if (existingSeed.deliveryStatus === undefined) {
    const prepared = await messageStore.prepareQueueAdmission(seedId);
    if (prepared.kind === 'conflict' || prepared.kind === 'not_found') {
      const refreshed = await messageStore.getById(seedId);
      if (refreshed?.deliveryStatus === 'delivered' || refreshed?.deliveryStatus === 'canceled') {
        return { messageId: refreshed.id };
      }
      return {
        messageId: seedId,
        warning: `initialMessage dispatch skipped: ${reason} (existing seed could not be canceled)`,
      };
    }
  }

  const canceled = await messageStore.markCanceled(seedId);
  if (!canceled || !canceled.deliveryTransitioned) {
    return {
      messageId: seedId,
      warning: `initialMessage dispatch skipped: ${reason} (existing seed cancel failed)`,
    };
  }

  return {
    messageId: seedId,
    warning: `initialMessage dispatch skipped: ${reason} (existing seed canceled)`,
  };
}

export interface ExecuteQueuedDispatchInput {
  proposalId: string;
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  threadId: string;
  content: string;
  targetCats: readonly CatId[];
  intentName: string;
  sourceCatId: CatId | null | undefined;
  crossPostExtra: Record<string, unknown>;
  sourceContentBlocks: readonly MessageContent[] | undefined;
  messageStore: IMessageStore;
  threadStore: Pick<IThreadStore, 'addParticipants' | 'get'>;
  socketManager: Pick<SocketManager, 'emitToUser'>;
  invocationQueue: ProposalInvocationQueue;
  queueProcessor: ProposalQueueProcessor;
  /** A previously materialized seed (legacy or queue-full) to reuse instead of appending a new message. */
  existingSeed?: StoredMessage;
}

export async function executeQueuedDispatch({
  proposalId,
  userId,
  ownerAuthProvenance,
  threadId,
  content,
  targetCats,
  intentName,
  sourceCatId,
  crossPostExtra,
  sourceContentBlocks,
  messageStore,
  threadStore,
  socketManager,
  invocationQueue,
  queueProcessor,
  existingSeed,
}: ExecuteQueuedDispatchInput): Promise<AppendApprovedInitialMessageResult> {
  const idempotencyKey = `proposal-initial:${proposalId}`;
  const from = sourceCatId ? ({ kind: 'agent', catId: sourceCatId } as const) : ({ kind: 'user', userId } as const);
  let enqueueResult: Awaited<ReturnType<ProposalInvocationQueue['appendAndEnqueueDurable']>>;
  if (existingSeed) {
    try {
      enqueueResult = await invocationQueue.enqueueExistingMessageDurable(messageStore, existingSeed.id, {
        from: messageFrom(existingSeed),
        threadId,
        userId,
        kind: 'conversation_input',
        ownerAuthProvenance,
        content: existingSeed.content,
        messageId: existingSeed.id,
        sourceId: existingSeed.id,
        targetCats: targetCats as CatId[],
        intent: intentName,
      });
    } catch (error) {
      // The ledger admission and Message transition are one CAS. If another
      // worker terminalized the seed after our reconcile read, the losing
      // admission leaves no orphan row and should converge as a clean replay.
      const refreshed = await messageStore.getById(existingSeed.id);
      if (refreshed?.deliveryStatus === 'delivered' || refreshed?.deliveryStatus === 'canceled') {
        return { messageId: refreshed.id };
      }
      throw error;
    }
  } else {
    enqueueResult = await invocationQueue.appendAndEnqueueDurable(
      messageStore,
      {
        from,
        userId,
        content,
        mentions: [...targetCats],
        timestamp: Date.now(),
        threadId,
        idempotencyKey,
        deliveryStatus: 'queued',
        extra: crossPostExtra,
        contentBlocks: sourceContentBlocks,
      },
      {
        from,
        threadId,
        userId,
        kind: 'conversation_input',
        ownerAuthProvenance,
        idempotencyKey,
        content,
        targetCats: targetCats as CatId[],
        intent: intentName,
      },
    );
  }

  if (enqueueResult.outcome === 'full' || !enqueueResult.entry) {
    // Queue-full: if we already have a materialized seed (legacy or prior
    // fallback), leave it in place so reconcile can retry later. Otherwise
    // persist a new materialized seed without queue custody. It is intentionally
    // NOT dispatch-complete so reconcile can CAS-admit it later.
    if (existingSeed) {
      return {
        messageId: existingSeed.id,
        warning: 'initialMessage dispatch skipped: queue is full',
      };
    }
    const stored = await messageStore.append({
      from,
      userId,
      content,
      mentions: [...targetCats],
      timestamp: Date.now(),
      threadId,
      idempotencyKey,
      extra: crossPostExtra, // AC-AA5
      contentBlocks: sourceContentBlocks,
    });
    return {
      messageId: stored.id,
      warning: 'initialMessage dispatch skipped: queue is full',
    };
  }

  const storedMessageId = enqueueResult.message.id;

  // F128 owns the final dispatch plan: preferredCats ordering and explicit
  // parallel intent can differ from raw-message mentions. Admit only those
  // final targets, after Queue accepted a durable carrier and before the
  // processor can start, so Sidebar C2 and C10 cannot contradict each other.
  await admitThreadParticipants({
    userId,
    threadId,
    targetCats,
    threadStore,
    socketManager,
    emitPolicy: 'membership-changed',
  });

  try {
    const started = await queueProcessor.processNext(threadId, userId);
    if (!started.started) {
      return {
        messageId: storedMessageId,
        warning: 'initialMessage queued but did not start automatically',
      };
    }
  } catch (err) {
    return {
      messageId: storedMessageId,
      warning: `initialMessage queued but auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { messageId: storedMessageId };
}
