'use client';
import { useApprovalHost } from '@/components/ApprovalHost';
import { ApprovalMember } from './ApprovalMember';
import { scheduleEffect } from './read-schedule-approval';
import { ScheduleApprovalContent } from './ScheduleApprovalContent';
import { ScheduleApprovalResult } from './ScheduleApprovalResult';
import { type ScheduleApprovalProps, useScheduleApprovalController } from './useScheduleApprovalController';

export { isScheduleMutationProposalCardBlock } from './read-schedule-approval';

/** The original F139 card and writer, shared by Chat, Hub and Inbox. Original owner re-reads supply content and results. */
export function ScheduleMutationProposalCard(props: ScheduleApprovalProps) {
  const { t, language, proposal, checking, busy, error, unknown, blocked, decide, reread } =
    useScheduleApprovalController(props);
  const host = useApprovalHost();
  if (!proposal)
    return (
      <div className="space-y-2 text-sm text-cafe-muted">
        <p role={checking ? 'status' : 'alert'}>{checking ? t.checking : (error ?? t.unavailable)}</p>
        {checking ? null : (
          <button type="button" className="shell-focusable rounded px-2 py-1 text-xs" onClick={reread}>
            {t.reread}
          </button>
        )}
      </div>
    );
  const settled = proposal.status === 'approved' || proposal.status === 'rejected',
    effect = scheduleEffect(proposal);
  const terminal = settled
    ? {
        resolution: proposal.status === 'approved' ? ('accepted' as const) : ('rejected' as const),
        decidedAt: proposal.approvedAt ?? proposal.rejectedAt,
        decidedBy: proposal.approvedBy ?? proposal.rejectedBy,
        ...(proposal.status === 'approved' && !effect ? { effectUnknown: true } : {}),
      }
    : null;
  if (terminal)
    return (
      <ScheduleApprovalResult
        proposal={proposal}
        terminal={terminal}
        effect={effect}
        error={error}
        unknown={unknown}
        reread={reread}
      />
    );

  return (
    <article
      data-testid={`schedule-approval-${proposal.proposalId}`}
      className="space-y-3 rounded-xl p-3 text-sm"
      style={{ color: 'var(--shell-ink)', background: 'var(--shell-paper)', border: '1px solid var(--shell-hairline)' }}
    >
      <header className="flex flex-wrap items-center gap-2 text-xs text-cafe-muted">
        <span>{t.kind}</span>
        <ApprovalMember catId={proposal.requesterCatId} />
        <time className="ml-auto whitespace-nowrap">
          {new Date(proposal.createdAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
        </time>
      </header>
      <ScheduleApprovalContent proposal={proposal} />
      {proposal.status === 'applying' ? <output className="block">{t.applying}</output> : null}
      {error ? (
        <p role="alert" className="text-conn-red-text">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!settled ? (
          <button
            type="button"
            data-testid="schedule-approve"
            disabled={blocked}
            className="shell-focusable rounded-md px-3 py-1.5 disabled:opacity-50"
            style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
            onClick={() => {
              void decide('approve');
            }}
          >
            {busy
              ? t.submitting
              : proposal.status === 'applying'
                ? t.resume
                : proposal.mutation.kind === 'create'
                  ? t.approveCreate
                  : t.approveDelete}
          </button>
        ) : null}
        {proposal.status === 'pending' ? (
          <button
            type="button"
            data-testid="schedule-reject"
            disabled={blocked}
            className="shell-focusable rounded-md border border-[var(--shell-hairline)] px-3 py-1.5 disabled:opacity-50"
            onClick={() => {
              void decide('reject');
            }}
          >
            {t.reject}
          </button>
        ) : null}
        {error || unknown || (settled && !effect) ? (
          <button type="button" className="shell-focusable rounded px-2 py-1 text-xs" onClick={reread}>
            {t.reread}
          </button>
        ) : null}
        <div className="ml-auto flex items-center justify-end gap-2">{host.originalPlaceAction}</div>
      </div>
    </article>
  );
}
