'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import { proposalCardCopy } from './proposal-card.shell-copy';
import type { useProposalApprovalRecovery } from './use-proposal-approval-recovery';

export function ProposalApprovalRecovery({ recovery }: { recovery: ReturnType<typeof useProposalApprovalRecovery> }) {
  const t = useShellCopy(proposalCardCopy);
  if (recovery.mode === 'none') return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cafe-secondary" role="status">
      <span>
        {recovery.mode === 'placement'
          ? t.approvalGroupReadback
          : recovery.mode === 'uncertain'
            ? t.approvalUnconfirmed
            : t.approvalRetryAvailable}
      </span>
      <button
        type="button"
        className="shell-nav-row shell-focusable rounded-lg border border-[var(--shell-hairline)] px-2 py-1.5 text-xs disabled:opacity-50"
        disabled={recovery.checking}
        onClick={() => void recovery.recheck()}
      >
        {recovery.checking ? t.checkingApproval : recovery.mode === 'placement' ? t.checkGroup : t.checkApproval}
      </button>
    </div>
  );
}
