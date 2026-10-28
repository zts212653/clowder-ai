import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import { apiFetch } from '@/utils/api-client';
import type { SettledResultItem } from './settled-results-source';
import { isRecord } from './thread-proposal-read';

/** The same finalized producer binding as Chat. Legacy unknowns retain the original exact child check. */
export function useCreatedThreadResult(item: SettledResultItem) {
  const key = { owner: item.ownerUserId, producer: 'F128', proposalId: item.proposalId };
  return useApprovalResult<string | null>(
    'F128',
    item.sourceFeatureId === 'F128' && item.resolution === 'accepted' ? item.proposalId : null,
    'thread-binding',
    async (signal) => {
      const verified = approvalResultRead.isCurrent(key, 'verified-thread')
        ? approvalResultRead.snapshot<string>(key, 'verified-thread').value
        : undefined;
      if (verified) return verified;
      const binding = item.detail.createdThreadId;
      if (
        item.materialization.state === 'succeeded' &&
        typeof binding === 'string' &&
        binding.trim() &&
        item.materialization.effectProofRef === `thread:${binding}` &&
        item.detail.canonicalEffectProofRef === item.materialization.effectProofRef
      ) {
        approvalResultRead.terminal(key);
        return binding;
      }
      const body = await readApprovalProducerBody(key, `/api/proposals/${encodeURIComponent(item.proposalId)}`, {
        signal,
      });
      const proposal = isRecord(body) ? body.proposal : null;
      if (
        !isRecord(proposal) ||
        proposal.proposalId !== item.proposalId ||
        proposal.createdBy !== item.ownerUserId ||
        proposal.status !== 'approved' ||
        typeof proposal.createdThreadId !== 'string' ||
        !proposal.createdThreadId.trim()
      )
        return null;
      const version = approvalResultRead.factsVersion(key);
      const response = await apiFetch(
        `/api/threads/${encodeURIComponent(proposal.createdThreadId)}`,
        { signal },
        { afterCurrentGet: true },
      );
      const child: unknown = response.ok ? await response.json() : null;
      if (
        !isRecord(child) ||
        child.id !== proposal.createdThreadId ||
        child.createdBy !== item.ownerUserId ||
        child.createdFromProposalId !== item.proposalId
      )
        return null;
      if (signal.aborted || version !== approvalResultRead.factsVersion(key)) return null;
      approvalResultRead.seed(key, 'verified-thread', proposal.createdThreadId);
      approvalResultRead.terminal(key);
      return proposal.createdThreadId;
    },
    item.ownerUserId,
  );
}
