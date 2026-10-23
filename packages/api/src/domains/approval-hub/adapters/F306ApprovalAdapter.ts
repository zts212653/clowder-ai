import type { ApprovalItem, CatId, RuntimeInteractionRecord, SettledApprovalItem } from '@cat-cafe/shared';
import { runtimePublicSelectedLabels, runtimeTerminalDisposition } from '@cat-cafe/shared';
import type { RuntimeInteractionStore } from '../../runtime-interaction/ports/RuntimeInteractionStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';

export class F306ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F306' as const;

  constructor(private readonly store: Pick<RuntimeInteractionStore, 'listPendingByUser' | 'listSettledByUser'>) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    const records = await this.store.listPendingByUser(userId);
    return records.flatMap((record) => (isProjectableApproval(record) ? [project(record)] : []));
  }
  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    if (!this.store.listSettledByUser) throw new Error('runtime interaction history unavailable');
    const records = await this.store.listSettledByUser(userId, opts?.limit ?? 50);
    return records.flatMap((record) => {
      const card = record.cardRef,
        terminal = record.terminal;
      if (
        !card ||
        !terminal ||
        record.request.owner.userId !== userId ||
        card.threadId !== record.request.owner.threadId ||
        record.status === 'pending' ||
        record.status === 'staged' ||
        terminal.status !== record.status
      )
        return [];
      const status = runtimeTerminalDisposition(record);
      return [
        {
          proposalId: record.request.interactionId,
          sourceFeatureId: 'F306',
          requesterCatId: record.request.owner.catId as CatId,
          ownerUserId: userId,
          status,
          summary: record.request.title,
          createdAt: record.request.createdAt,
          decidedAt: terminal.settledAt,
          decidedBy: status === 'approved' || status === 'rejected' ? userId : '',
          detail: {
            runtimeKind: record.request.kind,
            runtimeReason: terminal.reasonCode,
            runtimeSelectedLabels: runtimePublicSelectedLabels(record),
            runtimeRevision: record.revision,
            runtimeUpdatedAt: record.updatedAt,
            runtimeCardRef: card,
            runtimeSource: record.source,
            runtimeReturnBinding: record.returnBinding,
          },
          navigation: {
            state: 'anchored',
            originRef: { kind: 'message', threadId: card.threadId, messageId: card.messageId },
            approvalCardRef: { threadId: card.threadId, messageId: card.messageId },
          },
        } satisfies SettledApprovalItem,
      ];
    });
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
    needsMeDecisionRefs: [
      { producerId: 'f306.runtime_interaction', subjectRef: record.request.interactionId, revision: record.updatedAt },
    ],
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
