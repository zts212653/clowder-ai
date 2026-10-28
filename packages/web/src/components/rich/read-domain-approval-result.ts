import type { RichCardBlock } from '@cat-cafe/shared';
import type { Terminal } from '@/components/shell/mailbox/approval-reconcile';
import { lookupDisplayedSettled, lookupSettled } from '@/components/shell/mailbox/settled-lookup';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { readFreshApprovalResultOwner } from '@/lib/approval-result-owner';
import { producerCommittedEffect } from '@/lib/producer-result-effect';
import { type DomainApprovalEffect, domainAttemptEffect } from '@/stores/approval-domain-effect';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { type DomainCardCoordinate, domainApprovalCandidate } from './read-domain-approval-source';

const resultOwner = readFreshApprovalResultOwner;
/** Private canonical history observation, never a permission to write or a conclusion from a missing pending row. */
export async function readDomainApprovalResult(
  block: RichCardBlock,
  coordinate: DomainCardCoordinate,
  expectedOwnerUserId?: string,
  display = false,
): Promise<{ ownerUserId: string; terminal: Terminal; effect?: DomainApprovalEffect } | null> {
  const candidate = domainApprovalCandidate(block);
  if (!candidate) return null;
  try {
    const ownerUserId = await resultOwner();
    if (!ownerUserId || (expectedOwnerUserId && ownerUserId !== expectedOwnerUserId)) return null;
    const result = await (display ? lookupDisplayedSettled : lookupSettled)({
      ownerUserId,
      sourceFeatureId: candidate.feature,
      proposalId: candidate.proposalId,
      approvalCardRef: coordinate,
    });
    if (result.kind !== 'found') return null;
    const terminal = result.terminal;
    if (terminal.resolution !== 'accepted') return { ownerUserId, terminal };
    const attempt = useApprovalHubStore.getState().decisionAttempts[candidate.proposalId];
    let effect = terminal.domainEffect ?? domainAttemptEffect(attempt, ownerUserId, candidate.feature, coordinate);
    // Preserve F221's original finalized-status commit receipt, shared with other consumers.
    if (!effect && candidate.feature === 'F221') {
      const body = await readApprovalProducerBody(
        { owner: ownerUserId, producer: 'F221', proposalId: candidate.proposalId },
        `/api/taste-proposals/${encodeURIComponent(candidate.proposalId)}`,
        { fresh: !display },
      );
      const committed = producerCommittedEffect(body, 'F221', candidate.proposalId);
      if (committed === 'taste-written') effect = committed;
    }
    return {
      ownerUserId,
      terminal: { ...terminal, ...(!effect ? { effectUnknown: true } : {}) },
      ...(effect ? { effect } : {}),
    };
  } catch {
    return null;
  }
}
