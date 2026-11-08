import type { InvocationRecord } from '../../../cats/services/agents/invocation/InvocationRegistry.js';
import { contextEpochScopeKey } from '../../../cats/services/session/context/ContextEpochOwner.js';
import type { IContextEpochStore } from '../../../cats/services/stores/ports/ContextEpochStore.js';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import {
  canViewMessage,
  isInternalNonQuotableParent,
  passesManagedHoldViewerBoundary,
} from '../../../cats/services/stores/visibility.js';
import type { WorkPreparationRecord } from './WorkPreparationOpportunityStore.js';

export class WorkPreparationAuthority {
  constructor(
    private readonly deps: {
      threads: Pick<IThreadStore, 'get'>;
      messages: Pick<IMessageStore, 'getById'>;
      epochs: Pick<IContextEpochStore, 'get'>;
    },
  ) {}

  async bind(auth: InvocationRecord) {
    if (auth.ownerAuthProvenance !== 'strict' || auth.state !== 'active') return null;
    const sourceMessageId = auth.originTriggerMessageId ?? auth.a2aTriggerMessageId;
    if (!sourceMessageId) return null;
    const scope = { ownerUserId: auth.userId, threadId: auth.threadId, invocationId: auth.invocationId };
    const frame = { scope, consumerCatId: auth.catId, sourceMessageId };
    const context = await this.current(frame);
    return context ? { ...frame, ...context } : null;
  }

  private async current(record: Pick<WorkPreparationRecord, 'scope' | 'consumerCatId' | 'sourceMessageId'>) {
    const thread = await this.deps.threads.get(record.scope.threadId);
    const message = await this.deps.messages.getById(record.sourceMessageId);
    if (
      !thread ||
      thread.deletedAt ||
      thread.createdBy !== record.scope.ownerUserId ||
      !message ||
      message.threadId !== thread.id ||
      message.userId !== record.scope.ownerUserId ||
      message.deletedAt ||
      message._tombstone ||
      message.deliveryStatus === 'canceled' ||
      isInternalNonQuotableParent(message) ||
      !canViewMessage(message, { type: 'cat', catId: record.consumerCatId as InvocationRecord['catId'] }) ||
      !passesManagedHoldViewerBoundary(message, record.scope.ownerUserId)
    )
      return null;
    const epoch = await this.deps.epochs.get(
      contextEpochScopeKey({
        userId: record.scope.ownerUserId,
        catId: record.consumerCatId,
        threadId: record.scope.threadId,
      }),
    );
    return epoch ? { contextEpoch: epoch.contextEpoch, projectPath: thread.projectPath } : null;
  }

  async validate(record: WorkPreparationRecord): Promise<boolean> {
    const current = await this.current(record);
    return current?.contextEpoch === record.contextEpoch && current.projectPath === record.projectPath;
  }
}
