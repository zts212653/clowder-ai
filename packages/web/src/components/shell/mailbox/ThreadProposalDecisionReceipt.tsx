import type { ThreadProposal, UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ApprovalMember } from '@/components/rich/ApprovalMember';
import { ProposalCardDetails, type ProposalDetails } from '@/components/rich/ProposalCardDetails';
import { proposalResultCopy } from '@/components/rich/proposal-result.shell-copy';
import { ThreadProposalResult } from '@/components/rich/ThreadProposalResult';
import { useShellCopy } from '../shell-copy';
import { useApprovalHeading } from './approval-heading';
import type { Terminal } from './approval-reconcile';
import { readableProposedDetails } from './thread-proposal-read';

/** Only a canonical decided session reaches this receipt; snapshots below are read-only context. */
export function ThreadProposalDecisionReceipt({
  approval,
  terminal,
  line,
  children,
  authorizeOpen,
  onExpandedChange,
  resolveThreadId,
}: {
  approval: UnifiedAttentionVisibleApproval;
  terminal: Terminal;
  line: string | null;
  children?: ReactNode;
  authorizeOpen?: () => boolean;
  onExpandedChange?: (expanded: boolean) => void;
  resolveThreadId?: () => Promise<string | null>;
}) {
  const { lead, title } = useApprovalHeading(approval);
  const t = useShellCopy(proposalResultCopy);
  const fields = approval.detail;
  const proposal = readableProposedDetails(fields)
    ? (fields as unknown as ProposalDetails & Pick<ThreadProposal, 'declaredWorkMode' | 'reportingMode'>)
    : null;
  return (
    <ThreadProposalResult
      status={
        terminal.resolution === 'accepted'
          ? 'approved'
          : terminal.resolution === 'rejected'
            ? 'rejected'
            : (terminal.closedReason ?? 'closed')
      }
      decidedAt={terminal.decidedAt}
      effectUnknown={terminal.effectUnknown}
      threadId={terminal.effectUnknown ? undefined : terminal.threadId}
      authorizeOpen={authorizeOpen}
      onExpandedChange={onExpandedChange}
      resolveThreadId={resolveThreadId}
    >
      <div>
        <span className="font-semibold">{lead} </span>
        <MarkdownContent content={title} className="!text-sm [&_p]:mb-0" disableCommandPrefix />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span>{t.proposer}:</span>
        <ApprovalMember catId={approval.requesterCatId} />
      </div>
      {proposal ? (
        <ProposalCardDetails
          proposal={proposal}
          workMode={proposal.declaredWorkMode}
          reportingMode={proposal.reportingMode ?? 'final-only'}
        />
      ) : null}
      {line ? (
        <output data-testid="mailbox-retained-line" className="block text-xs text-[var(--shell-muted)]">
          {line}
        </output>
      ) : null}
      {children}
    </ThreadProposalResult>
  );
}
