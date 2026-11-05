import type { ThreadProposal } from '@cat-cafe/shared';
import type { ApprovalHost } from '@/components/ApprovalHost';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ApprovalMember } from './ApprovalMember';
import { ProposalCardDetails } from './ProposalCardDetails';
import { ProposalCardEditor } from './ProposalCardEditor';
import { proposalCardCopy } from './proposal-card.shell-copy';
import { proposalResultCopy } from './proposal-result.shell-copy';
import { ThreadProposalResult } from './ThreadProposalResult';
import type { ProposalCardState } from './useProposalCardState';

const secondary =
  'shell-nav-row shell-focusable rounded-lg border border-[var(--shell-hairline)] px-2 py-1.5 text-xs disabled:opacity-50';

/** A compact placement of the original card; no separate approval or override writer. */
export function ProposalCardMailbox({
  proposal,
  state,
  host,
  showTitle = false,
}: {
  proposal: ThreadProposal;
  state: ProposalCardState;
  host: ApprovalHost;
  showTitle?: boolean;
}) {
  const t = useShellCopy(proposalCardCopy);
  const receiptCopy = useShellCopy(proposalResultCopy);
  if (state.status === 'approved' || state.status === 'rejected' || state.status === 'withdrawn') {
    return (
      <article data-testid={`approval-item-${proposal.proposalId}`} className="min-w-0">
        <ThreadProposalResult
          status={state.status}
          decidedAt={proposal.rejectedAt}
          threadId={state.resultThreadId}
          openLocked={host.writesLocked}
          authorizeOpen={() => host.authorizeWrite('producer-card', { continuation: true })}
        >
          <h3 className="break-words text-sm font-semibold">{proposal.title}</h3>
          <div className="flex items-center gap-2 text-xs">
            <span>{receiptCopy.proposer}:</span>
            <ApprovalMember catId={proposal.sourceCatId} />
          </div>
          <ProposalCardDetails
            proposal={proposal}
            workMode={state.effectiveDeclaredWorkMode || undefined}
            reportingMode={state.effectiveReportingMode}
          />
          {host.originalPlaceAction}
        </ThreadProposalResult>
        {state.error ? <output className="block text-xs text-[var(--semantic-critical)]">{state.error}</output> : null}
      </article>
    );
  }
  return (
    <article data-testid={`approval-item-${proposal.proposalId}`} className="min-w-0 space-y-3 text-sm">
      {showTitle ? <h3 className="break-words text-sm font-semibold">{proposal.title}</h3> : null}
      {state.editing ? (
        <ProposalCardEditor state={state} />
      ) : (
        <ProposalCardDetails
          proposal={proposal}
          workMode={state.effectiveDeclaredWorkMode || undefined}
          reportingMode={state.effectiveReportingMode}
        />
      )}
      {state.status === 'pending' ? (
        <>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={state.pinOnApprove}
              onChange={(e) => state.setPinOnApprove(e.target.checked)}
              disabled={state.loading}
            />
            {t.pin}
          </label>
          <div className="flex flex-wrap items-center gap-2" data-testid="proposal-actions">
            <button
              type="button"
              data-testid="approve-btn"
              disabled={state.writeBlocked}
              onClick={state.approve}
              className="shell-focusable rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
            >
              {state.loading ? t.submitting : state.editing ? t.approveEdited : t.approve}
            </button>
            <button
              type="button"
              data-testid="reject-btn"
              disabled={state.writeBlocked}
              onClick={state.reject}
              className={secondary}
            >
              {host.decisionWords?.reject ?? t.reject}
            </button>
            <button
              type="button"
              disabled={state.loading}
              onClick={() => state.setEditing((v) => !v)}
              className={secondary}
            >
              {state.editing ? t.cancel : t.edit}
            </button>
            {host.originalPlaceAction}
          </div>
        </>
      ) : (
        <output className="flex flex-wrap items-center gap-2">
          <span>{t.submitting}</span>
          {host.originalPlaceAction}
        </output>
      )}
      {state.error ? <output className="block text-xs text-[var(--semantic-critical)]">{state.error}</output> : null}
    </article>
  );
}
