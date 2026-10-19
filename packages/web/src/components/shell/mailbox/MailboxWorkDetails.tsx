import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useShellCopy } from '../shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import { readWorkDetail, readWorkSystemRecommendation } from './work-detail';

function DetailLine({ testId, label, children }: { testId: string; label: string; children: string }) {
  return (
    <p className="m-0 text-sm" data-testid={testId}>
      <span className="font-medium">{label}</span>
      <span style={{ color: 'var(--shell-body)' }}> {children}</span>
    </p>
  );
}

export function MailboxWorkDetails({ item }: { item: UnifiedAttentionItemV1 }) {
  const t = useShellCopy(mailboxEntryCopy);
  const accountability = item.collectiveAccountabilityRequest;
  if (accountability) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="mailbox-accountability-details">
        <DetailLine testId="mailbox-accountability-project" label={t.accountabilityProject}>
          {accountability.projectTitle}
        </DetailLine>
        <DetailLine testId="mailbox-accountability-requester" label={t.accountabilityRequester}>
          {accountability.requestedByDisplayName}
        </DetailLine>
        <p className="m-0 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.accountabilityHint}
        </p>
      </div>
    );
  }
  const detail = readWorkDetail(item);
  const recommendation =
    readWorkSystemRecommendation(item) === 'collective_result_ready' ? t.collectiveResultReady : detail.recommendation;
  return (
    <div className="flex flex-col gap-1.5">
      {recommendation ? (
        <DetailLine testId="mailbox-detail-recommendation" label={t.suggestion}>
          {recommendation}
        </DetailLine>
      ) : null}
      {detail.goal ? (
        <DetailLine testId="mailbox-detail-goal" label={t.goal}>
          {detail.goal}
        </DetailLine>
      ) : null}
      {detail.preparedWork ? (
        <DetailLine testId="mailbox-detail-prepared" label={t.artwork}>
          {detail.preparedWork}
        </DetailLine>
      ) : null}
    </div>
  );
}
