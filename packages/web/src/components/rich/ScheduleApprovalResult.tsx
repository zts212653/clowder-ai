import type { ScheduleMutationProposal } from '@cat-cafe/shared';
import { useApprovalHost } from '../ApprovalHost';
import { describeReconcile, type Terminal } from '../shell/mailbox/approval-reconcile';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { ApprovalMember } from './ApprovalMember';
import { ApprovalResultRow } from './ApprovalResultRow';
import type { scheduleEffect } from './read-schedule-approval';
import { ScheduleApprovalContent } from './ScheduleApprovalContent';
import { scheduleApprovalCopy } from './schedule-approval.shell-copy';

export function ScheduleApprovalResult({
  proposal,
  terminal,
  effect,
  error,
  unknown,
  reread,
}: {
  proposal: ScheduleMutationProposal;
  terminal: Terminal;
  effect: ReturnType<typeof scheduleEffect>;
  error: string | null;
  unknown: boolean;
  reread: () => void;
}) {
  const t = useShellCopy(scheduleApprovalCopy),
    language = useShellLanguage(),
    host = useApprovalHost();
  const line =
    describeReconcile(
      { kind: 'decided', terminal },
      { language, ownerUserId: proposal.ownerUserId, originalEffect: effect },
    ).line ?? '';
  return (
    <div data-testid={`schedule-approval-${proposal.proposalId}`}>
      <ApprovalResultRow status={proposal.status === 'approved' ? 'approved' : 'rejected'} label={line}>
        <header className="flex items-center gap-2 text-xs">
          <span>{t.kind}</span>
          <ApprovalMember catId={proposal.requesterCatId} />
        </header>
        <ScheduleApprovalContent proposal={proposal} />
        {error ? <p role="alert">{error}</p> : null}
        {error || unknown || !effect ? (
          <button type="button" className="shell-focusable text-xs hover:underline" onClick={reread}>
            {t.reread}
          </button>
        ) : null}
        {host.originalPlaceAction}
      </ApprovalResultRow>
    </div>
  );
}
