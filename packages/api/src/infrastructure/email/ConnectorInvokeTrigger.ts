/**
 * Canonical Queue ingress for connector, scheduler, and managed-wake messages.
 *
 * This boundary owns no provider execution. It binds the already-persisted
 * source message to one durable Queue entry, then asks QueueProcessor to drain.
 */

import { type CatId, type MessageContent } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultCatId } from '../../config/cat-config-loader.js';
import type { ActionSuccessorLeaseStore } from '../../domains/ball-custody/ActionSuccessorLeaseStore.js';
import {
  hasManagedCommandWakeActionLeaseRef,
  resolveManagedCommandWakeActionLeaseAdmission,
} from '../../domains/ball-custody/managed-command-wake-action-lease-admission.js';
import {
  assertCurrentWaitContinuationCarrier,
  waitContinuationCarrierFromStoredMessage,
} from '../../domains/ball-custody/wait-continuation-carrier.js';
import type { InvocationQueue } from '../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../../domains/cats/services/agents/invocation/QueueProcessor.js';
import { messageFrom } from '../../domains/cats/services/stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated, enrichQueueEntries } from '../../utils/queue-enrichment.js';

export type TriggerOutcome = 'enqueued' | 'full';

export interface ConnectorInvokeTriggerOptions {
  readonly socketManager: SocketManager;
  readonly invocationQueue: InvocationQueue;
  readonly queueProcessor: QueueProcessor;
  readonly messageStore: IMessageStore;
  /** Canonical owner used to validate a managed-command wake's frozen action generation. */
  readonly actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'get'>;
  /** Canonical wait generation/outcome truth for github-wait continuation admission. */
  readonly waitTaskStore?: Pick<ITaskStore, 'get'>;
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
    // A deterministic replay may resolve to a terminal ledger tombstone. It is
    // successful idempotency, not new work, so there is deliberately no drain.
    if (!exactEntry) return outcome;
    await this.opts.queueProcessor.requestDrain(threadId);
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
    if (waitContinuationCarrier) {
      await assertCurrentWaitContinuationCarrier(this.opts.waitTaskStore, waitContinuationCarrier, {
        threadId: input.threadId,
        userId: input.userId,
        catId: input.catId,
      });
    }
    const actionLeaseAdmission = hasManagedCommandWakeActionLeaseRef(sourceMessage)
      ? await resolveManagedCommandWakeActionLeaseAdmission(
          sourceMessage,
          { threadId: input.threadId, catId: input.catId, tenantScope: input.userId },
          this.opts.actionSuccessorLeaseStore,
        )
      : ({ actionLeaseCarrier: { kind: 'none' } } as const);
    const from = messageFrom(sourceMessage);
    const result = await invocationQueue.enqueueExistingMessageDurable(messageStore, input.messageId, {
      from: structuredClone(from),
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
      ...(actionLeaseAdmission.actionSuccessorFence
        ? { actionSuccessorFence: actionLeaseAdmission.actionSuccessorFence }
        : {}),
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
    if (!entry) {
      if (result.deduped) {
        log.info(
          { threadId: input.threadId, messageId: input.messageId },
          '[ConnectorInvokeTrigger] Exact connector source already terminal',
        );
        return 'enqueued';
      }
      throw new Error(`connector Queue admission did not return an entry for ${input.messageId}`);
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
}
