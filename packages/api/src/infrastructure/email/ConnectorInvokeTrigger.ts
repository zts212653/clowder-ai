import type { CatId, MessageContent } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultCatId } from '../../config/cat-config-loader.js';
import type { ActionSuccessorLeaseStore } from '../../domains/ball-custody/ActionSuccessorLeaseStore.js';
import {
  hasManagedCommandWakeActionLeaseRef,
  resolveManagedCommandWakeActionLeaseAdmission,
} from '../../domains/ball-custody/managed-command-wake-action-lease-admission.js';
import { waitContinuationCarrierFromStoredMessage } from '../../domains/ball-custody/wait-continuation-carrier.js';
import type { InvocationQueue } from '../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../../domains/cats/services/agents/invocation/QueueProcessor.js';
import {
  normalizeOwnerAuthProvenance,
  type OwnerAuthProvenance,
} from '../../domains/cats/services/owner-auth-provenance.js';
import { messageFrom } from '../../domains/cats/services/stores/message-from.js';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated, enrichQueueEntries } from '../../utils/queue-enrichment.js';
import type { OutboundDeliveryHook, ThreadMeta } from '../connectors/OutboundDeliveryHook.js';
import type { StreamingOutboundHook } from '../connectors/StreamingOutboundHook.js';

export type TriggerOutcome = 'enqueued' | 'full';

export interface ConnectorInvokeTriggerOptions {
  readonly socketManager: SocketManager;
  readonly invocationQueue: InvocationQueue;
  readonly queueProcessor?: QueueProcessor;
  readonly outboundHook?: OutboundDeliveryHook;
  readonly streamingHook?: StreamingOutboundHook;
  readonly threadMetaLookup?: (threadId: string) => ThreadMeta | undefined | Promise<ThreadMeta | undefined>;
  readonly deliverTimeoutMs?: number;
  readonly messageStore?: IMessageStore;
  readonly actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'get'>;
  /** Kept as a composition dependency for managed-wake callers; Queue ledger owns its state. */
  readonly waitTaskStore?: unknown;
  readonly log: FastifyBaseLogger;
}

export interface ConnectorTriggerPolicy {
  readonly priority?: 'urgent' | 'normal';
  readonly reason?: string;
  readonly sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  readonly suggestedSkill?: string;
  readonly forceQueue?: boolean;
  readonly ownerAuthProvenance?: OwnerAuthProvenance;
  readonly coalesceKey?: string;
}

/** Connector ingress always joins the same durable Queue lifecycle as user and A2A work. */
export class ConnectorInvokeTrigger {
  constructor(private readonly opts: ConnectorInvokeTriggerOptions) {}

  async trigger(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    _contentBlocks?: readonly MessageContent[],
    policy?: ConnectorTriggerPolicy,
    _sender?: { id: string; name?: string },
  ): Promise<TriggerOutcome> {
    const messageStore = this.opts.messageStore;
    if (!messageStore) throw new Error('Connector Queue admission requires MessageStore');
    const sourceMessage = await messageStore.getById(messageId);
    if (!sourceMessage) throw new Error(`Connector source message is unavailable: ${messageId}`);
    const waitContinuationCarrier = waitContinuationCarrierFromStoredMessage(sourceMessage);
    const actionLeaseAdmission = hasManagedCommandWakeActionLeaseRef(sourceMessage)
      ? await resolveManagedCommandWakeActionLeaseAdmission(
          sourceMessage,
          { threadId, catId, tenantScope: userId },
          this.opts.actionSuccessorLeaseStore,
        )
      : ({ actionLeaseCarrier: { kind: 'none' } } as const);
    const coalesceKey = policy?.coalesceKey;
    const sourceCategory = policy?.sourceCategory;
    const idempotencyKey = actionLeaseAdmission.actionSuccessorFence
      ? `action-successor:${actionLeaseAdmission.actionSuccessorFence.leaseId}:${actionLeaseAdmission.actionSuccessorFence.generation}:${catId}`
      : coalesceKey
        ? `connector:${sourceCategory ?? 'generic'}:${coalesceKey}${
            waitContinuationCarrier
              ? `:wait:${waitContinuationCarrier.waitId}:${waitContinuationCarrier.outcomeId}`
              : ''
          }`
        : undefined;
    const result = await this.opts.invocationQueue.enqueueExistingMessageDurable(messageStore, messageId, {
      threadId,
      userId,
      sourceId: idempotencyKey ?? messageId,
      kind: 'conversation_input',
      from: messageFrom(sourceMessage),
      ownerAuthProvenance: normalizeOwnerAuthProvenance(policy?.ownerAuthProvenance),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      content: message,
      messageId,
      targetCats: [catId],
      intent: 'execute',
      priority: policy?.priority ?? 'normal',
      autoExecute: policy?.forceQueue === true,
      ...(sourceCategory ? { sourceCategory } : {}),
      ...(policy?.suggestedSkill ? { suggestedSkill: policy.suggestedSkill } : {}),
      ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
      ...(actionLeaseAdmission.actionSuccessorFence
        ? { actionSuccessorFence: actionLeaseAdmission.actionSuccessorFence }
        : {}),
    });
    if (result.outcome === 'full') {
      const fullQueue = await enrichQueueEntries(this.opts.invocationQueue.list(threadId, userId), messageStore);
      this.opts.socketManager.emitToUser(userId, 'queue_full_warning', {
        threadId,
        source: 'connector',
        queueSize: this.opts.invocationQueue.size(threadId, userId),
        queue: fullQueue,
      });
      this.opts.socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: getDefaultCatId(),
          content: JSON.stringify({ type: 'connector_skip', reason: 'queue_full', threadId }),
          timestamp: Date.now(),
        },
        threadId,
      );
      this.opts.log.warn({ threadId, catId, userId }, '[ConnectorInvokeTrigger] Queue full');
      return 'full';
    }
    await emitQueueUpdated(
      this.opts.socketManager,
      userId,
      threadId,
      this.opts.invocationQueue.list(threadId, userId),
      messageStore,
      result.outcome,
    );
    void this.opts.queueProcessor?.requestDrain(threadId).catch(() => {});
    return 'enqueued';
  }
}
