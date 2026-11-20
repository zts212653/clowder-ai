import type { ProposalApproveOverrides, ThreadProposal } from '@cat-cafe/shared';
import { ownedThreadFromSeed } from '../domains/cats/services/stores/ports/OwnedThreadSeed.js';
import { applyProposalOverrides } from '../domains/cats/services/stores/ports/ProposalSnapshot.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

function childSeed(proposal: ThreadProposal) {
  if (proposal.status !== 'approving' || proposal.approvedBy !== proposal.createdBy || !proposal.claimedAt)
    throw new Error('Approved Task child requires the exact approval claim');
  return {
    userId: proposal.approvedBy,
    idempotencyKey: `proposal-child:${proposal.proposalId}`,
    title: proposal.title,
    participants: [],
    projectPath: proposal.projectPath,
    parentThreadId: proposal.parentThreadId,
    pinned: proposal.approvedChildPinned ?? false,
    proposalAudit: {
      createdFromProposalId: proposal.proposalId,
      sourceThreadId: proposal.sourceThreadId,
      sourceInvocationId: proposal.sourceInvocationId,
      ...(proposal.sourceMessageId ? { sourceMessageId: proposal.sourceMessageId } : {}),
      ...(proposal.declaredWorkMode ? { declaredWorkMode: proposal.declaredWorkMode } : {}),
      approvedBy: proposal.approvedBy,
      approvedAt: proposal.claimedAt,
    },
  };
}

/** Reserve the exact child and approval overrides durably before creating the thread. */
export async function createApprovedTaskChild(
  proposals: IProposalStore,
  threads: IThreadStore,
  claimed: ThreadProposal,
  overrides: ProposalApproveOverrides,
) {
  const checkpoint = { ...claimed };
  applyProposalOverrides(checkpoint, overrides);
  checkpoint.createdThreadId = ownedThreadFromSeed(childSeed(checkpoint)).id;
  await proposals.recordCreatedThread(claimed.proposalId, checkpoint.createdThreadId, overrides);
  return recoverApprovedTaskChild(threads, checkpoint);
}

export async function recoverApprovedTaskChild(threads: IThreadStore, checkpoint: ThreadProposal) {
  const seed = childSeed(checkpoint);
  if (ownedThreadFromSeed(seed).id !== checkpoint.createdThreadId)
    throw new Error('Approved Task child checkpoint does not match the approval');
  const child = await threads.ensureOwnedThread(seed);
  if (
    child.createdFromProposalId !== checkpoint.proposalId ||
    child.parentThreadId !== checkpoint.parentThreadId ||
    child.projectPath !== checkpoint.projectPath ||
    child.approvedBy !== checkpoint.approvedBy
  )
    throw new Error('Approved Task child identity drifted');
  return child;
}
