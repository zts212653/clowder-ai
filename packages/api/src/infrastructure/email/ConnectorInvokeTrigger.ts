/**
 * Canonical Queue ingress for connector, scheduler, and managed-wake messages.
 *
 * This boundary owns no provider execution. It binds the already-persisted
 * source message to one durable Queue entry, then asks QueueProcessor to drain.
 */

import { type CatId, type MessageContent } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultCatId } from '../../config/cat-config-loader.js';
import { waitContinuationCarrierFromStoredMessage } from '../../domains/ball-custody/wait-continuation-carrier.js';
import type { InvocationQueue, QueueEntry } from '../../domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  type QueuedMessageCustodyCoordinator,
} from '../../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../../domains/cats/services/agents/invocation/QueueProcessor.js';
import {
  type IMessageStore,
  initializeQueueCustodyWithLifecycleRetry,
  type StoredMessage,
} from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated, enrichQueueEntries } from '../../utils/queue-enrichment.js';

export type TriggerOutcome = 'enqueued' | 'full';

export interface ConnectorInvokeTriggerOptions {
  readonly socketManager: SocketManager;
  readonly invocationQueue: InvocationQueue;
  readonly queueProcessor: QueueProcessor;
  /** Exact queued-source CAS used when recovery replaces an absent carrier. */
  readonly queueCustodyCoordinator?: QueuedMessageCustodyCoordinator;
  readonly messageStore: IMessageStore;
  readonly log: FastifyBaseLogger;
}

export interface ConnectorTriggerPolicy {
  /** Urgent entries sort ahead of normal entries without preempting a run. */
  readonly priority?: 'urgent' | 'normal';
  readonly reason?: string;
  readonly sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  readonly suggestedSkill?: string;
  /** Connector bursts may share one still-queued carrier. */
  readonly coalesceKey?: string;
}

export class ConnectorInvokeTrigger {
  constructor(private readonly opts: ConnectorInvokeTriggerOptions) {}

  /**
   * Bind one stored connector message to Queue and schedule the canonical drain.
   * Resolution means durable Queue custody exists; it never means that a
   * provider was launched directly from this producer boundary.
   */
  async trigger(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    _contentBlocks?: readonly MessageContent[],
    policy?: ConnectorTriggerPolicy,
    sender?: { id: string; name?: string },
  ): Promise<TriggerOutcome> {
    const outcome = await this.enqueueCanonical({
      threadId,
      catId,
      userId,
      message,
      messageId,
      sender,
      priority: policy?.priority ?? 'normal',
      sourceCategory: policy?.sourceCategory,
      suggestedSkill: policy?.suggestedSkill,
      coalesceKey: policy?.coalesceKey,
    });
    if (outcome === 'full') return outcome;

    const exactEntry = this.opts.invocationQueue.findEntryWithMessageId(threadId, messageId);
    if (!exactEntry) {
      throw new Error(`connector Queue admission lost exact source binding for ${messageId}`);
    }
    if (await this.isQueueEntryCustodyReady(exactEntry, messageId)) {
      await this.opts.queueProcessor.requestDrain(threadId);
    }
    return outcome;
  }

  private async enqueueCanonical(input: {
    threadId: string;
    catId: CatId;
    userId: string;
    message: string;
    messageId: string;
    sender?: { id: string; name?: string };
    priority: 'urgent' | 'normal';
    sourceCategory?: ConnectorTriggerPolicy['sourceCategory'];
    suggestedSkill?: string;
    coalesceKey?: string;
  }): Promise<TriggerOutcome> {
    const { invocationQueue, socketManager, messageStore, log } = this.opts;
    const sourceMessage = await messageStore.getById(input.messageId);
    this.assertExactSource(sourceMessage, input);

    const existing = invocationQueue.findEntryWithMessageId(input.threadId, input.messageId);
    if (existing) {
      log.info(
        { threadId: input.threadId, messageId: input.messageId, entryId: existing.id },
        '[ConnectorInvokeTrigger] Exact connector source already queued',
      );
      return 'enqueued';
    }

    const waitContinuationCarrier = waitContinuationCarrierFromStoredMessage(sourceMessage);
    if (!sourceMessage.from) {
      throw new Error(`connector Queue ingress requires canonical MessageFrom: ${input.messageId}`);
    }
    const result = invocationQueue.enqueue({
      from: structuredClone(sourceMessage.from),
      threadId: input.threadId,
      userId: input.userId,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: input.message,
      messageId: input.messageId,
      ...(input.coalesceKey
        ? {
            idempotencyKey: `connector:${input.sourceCategory ?? 'generic'}:${input.coalesceKey}${
              waitContinuationCarrier
                ? `:wait:${waitContinuationCarrier.waitId}:${waitContinuationCarrier.outcomeId}`
                : ''
            }`,
            dedupeProcessing: false,
          }
        : {}),
      targetCats: [input.catId],
      intent: 'execute',
      priority: input.priority,
      autoExecute: true,
      ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
      ...(input.suggestedSkill ? { suggestedSkill: input.suggestedSkill } : {}),
      ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
    });

    if (result.outcome === 'full') {
      const fullQueue = await enrichQueueEntries(invocationQueue.list(input.threadId, input.userId), messageStore);
      socketManager.emitToUser(input.userId, 'queue_full_warning', {
        threadId: input.threadId,
        source: 'connector',
        queueSize: invocationQueue.size(input.threadId, input.userId),
        queue: fullQueue,
      });
      socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: getDefaultCatId(),
          content: JSON.stringify({ type: 'connector_skip', reason: 'queue_full', threadId: input.threadId }),
          timestamp: Date.now(),
        },
        input.threadId,
      );
      log.warn(
        { threadId: input.threadId, catId: input.catId, userId: input.userId },
        '[ConnectorInvokeTrigger] Queue full, connector message not enqueued',
      );
      return 'full';
    }

    const entry = result.entry
      ? invocationQueue.getEntrySnapshot(input.threadId, input.userId, result.entry.id)
      : undefined;
    if (!entry) throw new Error(`connector Queue admission did not return an entry for ${input.messageId}`);

    invocationQueue.backfillMessageId(input.threadId, input.userId, entry.id, input.messageId);
    const prepared = await messageStore.prepareQueueAdmission(input.messageId);
    if (prepared.kind !== 'prepared' && prepared.kind !== 'existing') {
      if (!result.deduped) invocationQueue.rollbackEnqueue(input.threadId, input.userId, entry.id);
      throw new Error(`connector source ${input.messageId} could not enter Queue custody: ${prepared.kind}`);
    }

    const queuedSource = prepared.message;
    if (!queuedSource.queueCustody) {
      const initialized = await initializeQueueCustodyWithLifecycleRetry(
        messageStore,
        input.messageId,
        createInitialQueuedMessageCustody(entry),
      );
      if (initialized.kind !== 'initialized' && initialized.kind !== 'existing') {
        throw new Error(`connector Queue custody initialization failed for ${input.messageId}: ${initialized.kind}`);
      }
    } else if (queuedSource.queueCustody.entryId !== entry.id) {
      if (!this.opts.queueCustodyCoordinator) {
        if (!result.deduped) invocationQueue.rollbackEnqueue(input.threadId, input.userId, entry.id);
        throw new Error('Queue custody coordinator unavailable for verified connector replacement');
      }
      try {
        await this.opts.queueCustodyCoordinator.transferEntryCustody(entry, {
          kind: 'verified',
          previousEntryId: queuedSource.queueCustody.entryId,
          replacementEntryId: entry.id,
          sourceMessageId: input.messageId,
        });
      } catch (error) {
        if (!result.deduped) invocationQueue.rollbackEnqueue(input.threadId, input.userId, entry.id);
        throw error;
      }
    }

    await emitQueueUpdated(
      socketManager,
      input.userId,
      input.threadId,
      invocationQueue.list(input.threadId, input.userId),
      messageStore,
      result.outcome,
    );
    log.info(
      { threadId: input.threadId, catId: input.catId, entryId: entry.id, outcome: result.outcome },
      '[ConnectorInvokeTrigger] Canonical Queue admission committed',
    );
    return result.outcome;
  }

  private assertExactSource(
    sourceMessage: StoredMessage | null,
    expected: { threadId: string; userId: string; messageId: string },
  ): asserts sourceMessage is StoredMessage {
    if (!sourceMessage) throw new Error(`connector source message ${expected.messageId} does not exist`);
    if (sourceMessage.threadId !== expected.threadId || sourceMessage.userId !== expected.userId) {
      throw new Error(`connector source message ${expected.messageId} owner/thread mismatch`);
    }
  }

  private async isQueueEntryCustodyReady(entry: QueueEntry, sourceMessageId: string): Promise<boolean> {
    let sourceMessage: StoredMessage | null;
    try {
      sourceMessage = await this.opts.messageStore.getById(sourceMessageId);
    } catch (error) {
      this.opts.log.warn(
        { err: error, threadId: entry.threadId, queueEntryId: entry.id, sourceMessageId },
        '[ConnectorInvokeTrigger] Queue custody readiness lookup failed; deferring drain',
      );
      return false;
    }
    if (!sourceMessage?.queueCustody) return false;
    if (sourceMessage.queueCustody.status === 'terminal') return false;

    const targetCarriers = sourceMessage.queueCustody.carrierByTargetCatId;
    return targetCarriers
      ? entry.targetCats.every((catId) => targetCarriers[catId]?.entryId === entry.id)
      : sourceMessage.queueCustody.entryId === entry.id;
  }
}
