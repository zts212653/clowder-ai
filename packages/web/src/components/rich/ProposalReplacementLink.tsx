import type { ThreadProposal } from '@cat-cafe/shared';
import { useState } from 'react';
import type { ApprovalHost } from '@/components/ApprovalHost';
import { useShellCopy } from '@/components/shell/shell-copy';
import { navigateToEntrustedWorkAction } from '@/hooks/useWorkspaceNavigate';
import { apiFetch } from '@/utils/api-client';
import { proposalResultCopy } from './proposal-result.shell-copy';

export function ProposalReplacementLink({ proposal, host }: { proposal: ThreadProposal; host: ApprovalHost }) {
  const t = useShellCopy(proposalResultCopy);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={host.writesLocked || opening}
        className="shell-focusable ml-2 text-[var(--shell-primary-text)] hover:underline"
        onClick={async () => {
          if (!host.authorizeWrite('producer-card', { continuation: true })) return;
          setOpening(true);
          setError(false);
          try {
            const response = await apiFetch(
              `/api/proposals/${encodeURIComponent(proposal.supersededByProposalId!)}`,
              undefined,
              { afterCurrentGet: true },
            );
            if (!response.ok) throw new Error('unavailable');
            const { proposal: next } = (await response.json()) as { proposal?: ThreadProposal };
            if (
              !next?.cardMessageId ||
              next.proposalId !== proposal.supersededByProposalId ||
              next.supersedesProposalId !== proposal.proposalId ||
              next.createdBy !== proposal.createdBy ||
              next.sourceThreadId !== proposal.sourceThreadId
            )
              throw new Error('mismatch');
            if (host.authorizeWrite('producer-card', { continuation: true }))
              navigateToEntrustedWorkAction(`message:${next.sourceThreadId}:${next.cardMessageId}`);
          } catch {
            setError(true);
          } finally {
            setOpening(false);
          }
        }}
      >
        {t.replacement}
      </button>
      {error ? <output className="ml-2 text-xs">{t.replacementUnavailable}</output> : null}
    </>
  );
}
