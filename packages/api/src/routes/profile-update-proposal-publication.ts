import type { ProfileUpdateProposal } from '@cat-cafe/shared';
import { relationshipKeyFromPrimerRelativePath } from '@cat-cafe/shared/profile-contract';
import type { FastifyReply } from 'fastify';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { buildProfileUpdateCardBlock } from './profile-update-card-block.js';
import {
  isEligibleProfileOrigin,
  type ProfileUpdateInput,
  profileUpdateRetryMatches,
} from './profile-update-proposal-input.js';

export async function visibleDedupResponse(
  ingress: ApprovalIngress,
  proposalStore: IProfileUpdateProposalStore,
  proposalId: string,
  input: ProfileUpdateInput,
  record: { userId: string; catId: string; threadId: string },
  messageStore: IMessageStore,
  reply: FastifyReply,
): Promise<Record<string, unknown>> {
  const proposal = await proposalStore.get(proposalId);
  if (proposal && !profileUpdateRetryMatches(proposal, input, record)) {
    return reply.status(409).send({ error: 'client_request_conflict' });
  }
  if (proposal) {
    // A later invocation may recover this request, but cannot replace its original provenance.
    const sourceId = proposal.signalProvenance.sourceMessageId;
    const source = sourceId ? await messageStore.getById(sourceId) : null;
    if (!isEligibleProfileOrigin(source, record.userId, proposal.signalProvenance.sourceThreadId)) {
      return reply.status(409).send({ error: 'origin_not_eligible' });
    }
    if (
      input.clientRequestId &&
      (await proposalStore.reserveDedup(record.userId, input.clientRequestId, proposalId)) !== proposalId
    ) {
      return reply.status(503).send({ error: 'profile_request_reservation_changed', recovery: 'retry_same_request' });
    }
  }
  if (proposal && !proposal.publication) {
    const cardMessageId =
      proposal.cardMessageId ??
      (await ingress.recoverLegacyCard({
        producerId: 'F231',
        canonicalProposalId: proposal.proposalId,
        ownerUserId: proposal.createdBy,
        cardThreadId: proposal.sourceThreadId,
        cardBlockId: buildProfileUpdateCardBlock(proposal).id,
      }));
    if (!cardMessageId) {
      reply.status(503);
      reply.header('retry-after', '1');
      return {
        proposalId,
        error: 'Legacy profile update card is not visible; retry shortly',
        status: 'retryable',
        retryable: true,
      };
    }
    if (!proposal.cardMessageId) await proposalStore.setCardMessageId(proposal.proposalId, cardMessageId);
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: cardMessageId,
      deduped: true,
    };
  }
  if (proposal) {
    const envelope = await publishProfileUpdateApproval(ingress, proposalStore, proposal);
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: envelope.approvalCardRef.messageId,
      deduped: true,
    };
  }
  reply.status(503);
  reply.header('retry-after', '1');
  return {
    proposalId,
    error: proposal
      ? 'Profile update proposal in-flight (card not visible yet); retry shortly'
      : 'Profile update proposal reservation in-flight (card not visible yet); retry shortly',
    status: 'retryable',
    retryable: true,
  };
}

export async function releaseEmptyProfileReservation(
  store: IProfileUpdateProposalStore,
  userId: string,
  clientRequestId: string | undefined,
  proposalId: string,
): Promise<void> {
  if (!clientRequestId) return;
  try {
    if (!(await store.get(proposalId))) await store.releaseDedup(userId, clientRequestId, proposalId);
  } catch {
    // Unknown is not proof of absence. Keep the binding and preserve the caller's original error.
  }
}

export function publishProfileUpdateApproval(
  ingress: ApprovalIngress,
  store: IProfileUpdateProposalStore,
  proposal: ProfileUpdateProposal,
) {
  const sourceMessageId = proposal.signalProvenance.sourceMessageId;
  if (!sourceMessageId) throw new Error('Profile proposal has no original source message');
  let cardContent: string;
  if (proposal.targetLayer === 'capsule') {
    cardContent = '提议更新开场简介';
  } else if (proposal.targetLayer === 'corpus') {
    cardContent = '提议更新共享事实档案（corpus）';
  } else {
    const relationshipKey = relationshipKeyFromPrimerRelativePath(proposal.targetPath);
    cardContent = `提议更新 ${relationshipKey} persona 的关系档案（primer）`;
  }
  return ingress.publish(
    {
      producerId: 'F231',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.createdBy,
      requesterCatId: proposal.sourceCatId,
      originRef: { kind: 'message', threadId: proposal.signalProvenance.sourceThreadId, messageId: sourceMessageId },
      cardThreadId: proposal.sourceThreadId,
      cardContent,
      cardBlock: buildProfileUpdateCardBlock(proposal),
      createdAt: proposal.createdAt,
    },
    store,
  );
}
