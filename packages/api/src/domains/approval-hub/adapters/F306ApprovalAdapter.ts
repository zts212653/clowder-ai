import type { ApprovalItem, CatId, RuntimeInteractionRecord } from '@cat-cafe/shared';
import type { RuntimeInteractionStore } from '../../runtime-interaction/ports/RuntimeInteractionStore.js';
import type { IApprovalAdapter } from '../ports/IApprovalAdapter.js';

export class F306ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F306' as const;

  constructor(private readonly store: Pick<RuntimeInteractionStore, 'listPendingByUser'>) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    const records = await this.store.listPendingByUser(userId);
    return records.flatMap((record) => (isProjectableApproval(record) ? [project(record)] : []));
  }
}

function isProjectableApproval(record: RuntimeInteractionRecord): boolean {
  return record.status === 'pending' && record.request.kind === 'approval' && record.cardRef !== undefined;
}

function project(record: RuntimeInteractionRecord): ApprovalItem {
  const cardRef = record.cardRef;
  if (!cardRef || record.request.kind !== 'approval') {
    throw new Error(`F306 interaction ${record.request.interactionId} is not an anchored approval`);
  }
  const messageRef = { kind: 'message' as const, threadId: cardRef.threadId, messageId: cardRef.messageId };
  return {
    proposalId: record.request.interactionId,
    sourceFeatureId: 'F306',
    requesterCatId: record.request.owner.catId as CatId,
    ownerUserId: record.request.owner.userId,
    status: 'pending',
    summary: record.request.title,
    detail: {
      ...(record.request.description ? { description: record.request.description } : {}),
      providerId: record.request.provider.providerId,
      providerMethod: record.request.provider.method,
      providerRequestId: record.request.provider.requestId,
      providerThreadId: record.request.provider.threadId,
      providerTurnId: record.request.provider.turnId,
      providerItemId: record.request.provider.itemId,
    },
    navigation: {
      state: 'anchored',
      originRef: messageRef,
      approvalCardRef: { threadId: cardRef.threadId, messageId: cardRef.messageId },
    },
    inlineApprovable: false,
    createdAt: record.request.createdAt,
  };
}
