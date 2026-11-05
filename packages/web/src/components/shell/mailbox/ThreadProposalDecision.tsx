import type { ApprovalHubItem, ThreadProposal } from '@cat-cafe/shared';
import { useMemo, useRef } from 'react';
import { type ApprovalHost, ApprovalHostContext, useApprovalHost } from '@/components/ApprovalHost';
import { ProposalCard } from '@/components/rich/ProposalCard';
import { useShellCopy } from '../shell-copy';
import { threadProposalCopy } from './thread-proposal.shell-copy';
import { useThreadProposalRead } from './thread-proposal-read';

/** Verify the native producer snapshot, then place the very same card and writer used in Chat. */
export function ThreadProposalDecision({ item }: { item: ApprovalHubItem }) {
  const t = useShellCopy(threadProposalCopy);
  const parentHost = useApprovalHost();
  const { proposal, checking, reread } = useThreadProposalRead(item);
  const key = `${item.ownerUserId}|${item.proposalId}`;
  const lastVerified = useRef<{ key: string; proposal: ThreadProposal } | null>(null);
  if (proposal) lastVerified.current = { key, proposal };
  const displayed = proposal ?? (lastVerified.current?.key === key ? lastVerified.current.proposal : null);
  const host = useMemo<ApprovalHost>(
    () => ({
      ...parentHost,
      writesLocked: parentHost.writesLocked || proposal === null || checking,
      authorizeWrite: (kind, options) => proposal !== null && !checking && parentHost.authorizeWrite(kind, options),
    }),
    [parentHost, proposal, checking],
  );
  return (
    <>
      {displayed ? (
        <ApprovalHostContext.Provider value={host}>
          <ProposalCard key={key} proposal={displayed} />
        </ApprovalHostContext.Provider>
      ) : null}
      {!proposal ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <output>{checking ? t.checking : t.unavailable}</output>
          {!checking ? (
            <button type="button" onClick={reread} className="shell-nav-row shell-focusable rounded-lg px-2 py-1">
              {t.reread}
            </button>
          ) : null}
          {!displayed ? parentHost.originalPlaceAction : null}
        </div>
      ) : null}
    </>
  );
}
