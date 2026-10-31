import type { ThreadProposal } from '@cat-cafe/shared';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { buildProposalCardBlock } from './proposal-card-block.js';

export async function visibleLegacyProposalResponse(
  ingress: ApprovalIngress,
  store: IProposalStore,
  proposal: ThreadProposal,
) {
  if (proposal.publication) return null;
  const cardMessageId =
    proposal.cardMessageId ??
    (await ingress.recoverLegacyCard({
      producerId: 'F128',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.createdBy,
      cardThreadId: proposal.sourceThreadId,
      cardBlockId: buildProposalCardBlock(proposal).id,
    }));
  if (!cardMessageId) return null;
  if (!proposal.cardMessageId) await store.setCardMessageId(proposal.proposalId, cardMessageId);
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    messageId: cardMessageId,
    deduped: true as const,
  };
}

export async function publishThreadApproval(
  ingress: ApprovalIngress,
  store: IProposalStore,
  proposal: ThreadProposal,
  socketManager?: SocketManager,
) {
  if (!proposal.sourceMessageId) throw new Error('F128 Phase-I proposal is missing its persisted source message');
  const envelope = await ingress.publish(
    {
      producerId: 'F128',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.createdBy,
      requesterCatId: proposal.sourceCatId,
      originRef: { kind: 'message', threadId: proposal.sourceThreadId, messageId: proposal.sourceMessageId },
      cardThreadId: proposal.sourceThreadId,
      cardContent: `提议新建 thread：${proposal.title}`,
      cardBlock: buildProposalCardBlock(proposal),
      createdAt: proposal.createdAt,
    },
    store,
  );
  if (proposal.supersedesProposalId) {
    const previous = await store.supersedePending(
      proposal.supersedesProposalId,
      proposal.proposalId,
      proposal.sourceMessageId,
    );
    if (!previous) {
      const withdrawn = await store.withdrawPending({
        proposalId: proposal.proposalId,
        withdrawnBy: proposal.sourceCatId,
      });
      if (withdrawn) socketManager?.emitToUser(proposal.createdBy, 'proposal_updated', withdrawn);
      throw Object.assign(new Error('Original proposal changed before replacement; the new proposal was withdrawn'), {
        statusCode: 409,
      });
    }
    socketManager?.emitToUser(proposal.createdBy, 'proposal_updated', previous);
  }
  return envelope;
}

export async function readProposalBeingRevised(
  store: IProposalStore,
  proposalId: string | undefined,
  source: { userId: string; catId: string; threadId: string; messageId: string },
): Promise<ThreadProposal | undefined> {
  if (!proposalId) return undefined;
  const previous = await store.get(proposalId);
  if (
    !previous ||
    previous.status !== 'pending' ||
    previous.createdBy !== source.userId ||
    previous.sourceCatId !== source.catId ||
    previous.sourceThreadId !== source.threadId ||
    previous.revisionRequest?.messageId !== source.messageId ||
    previous.revisionRequest.requestedBy !== source.userId
  )
    throw Object.assign(new Error('Replacement requires the exact owner revision request for your pending proposal'), {
      statusCode: 409,
    });
  return previous;
}
