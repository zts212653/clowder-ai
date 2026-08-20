import type { RichPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { PersonMemoryStore, StoredPersonMemoryCandidate } from '../domains/memory/people/PersonMemoryStore.js';

export function publishPersonMemoryCandidate(
  ingress: Pick<ApprovalIngress, 'publish'>,
  store: PersonMemoryStore,
  candidate: StoredPersonMemoryCandidate,
  cardBlock: RichPersonMemoryProposalCardBlock,
) {
  return ingress.publish(
    {
      producerId: 'F276',
      canonicalProposalId: candidate.candidateId,
      ownerUserId: candidate.ownerUserId,
      requesterCatId: candidate.requesterCatId,
      originRef: candidate.sourceMessageRef,
      cardThreadId: candidate.sourceMessageRef.threadId,
      cardContent: `提议将 ${candidate.personDraft?.displayName ?? '这位人物'} 写入你的私人关系记忆`,
      cardBlock,
      createdAt: candidate.createdAt,
    },
    store,
  );
}
