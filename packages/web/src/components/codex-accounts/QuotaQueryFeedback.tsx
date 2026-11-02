'use client';
import type { AccountQuotaObservation } from '@cat-cafe/shared';
import { HelpTip } from '../settings/HelpTip';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { quotaCopy } from './quota.shell-copy';
import { quotaFailureKind } from './quota-state';

export function quotaQueryTime(at: number, language: 'zh' | 'en') {
  const date = new Date(at),
    now = new Date(Date.now());
  const time = date.toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
export function QuotaQueryFeedback({
  observation,
  readingAt,
  busy,
  query,
  onRelogin,
  inUse = false,
}: {
  observation: AccountQuotaObservation;
  readingAt?: number;
  busy: boolean;
  query: () => void;
  onRelogin?: () => void;
  inUse?: boolean;
}) {
  const t = useShellCopy(quotaCopy),
    language = useShellLanguage();
  const kind = quotaFailureKind(observation);
  const title =
    kind === 'renewal_required'
      ? inUse
        ? t.renewal
        : t.idleRenewal
      : kind === 'signin_required'
        ? t.signin
        : t.offline;
  const time = quotaQueryTime(observation.observedAt, language);
  const reason =
    kind === 'renewal_required'
      ? t.renewalReason(time)
      : `${time} · ${kind === 'signin_required' ? t.signinReason : t.offlineReason}`;
  const status = (
    <HelpTip
      topic={title}
      trigger={
        <>
          <span className="account-quota-dot" aria-hidden="true" />
          {title}
        </>
      }
      triggerClassName="account-quota-failure-title"
    >
      {observation.failure?.officialDetail ?? t.noOfficialDetail}
    </HelpTip>
  );
  const action =
    kind === 'signin_required' ? (
      onRelogin ? (
        <button type="button" disabled={busy} onClick={onRelogin}>
          {t.signinAction}
        </button>
      ) : (
        <span>{t.signinApp}</span>
      )
    ) : (
      <button type="button" disabled={busy} onClick={query}>
        {kind === 'renewal_required' && !readingAt ? t.checkAgain : t.retry}
      </button>
    );
  return (
    <div className="account-quota-failure" data-kind={kind} data-active={inUse} role="status">
      {readingAt !== undefined ? (
        <small>
          {t.stale(quotaQueryTime(readingAt, language))} · {status} · {action}
        </small>
      ) : (
        <>
          {status}
          <div className="account-quota-failure-reason">
            {reason} {action}
          </div>
        </>
      )}
    </div>
  );
}
export function QuotaQueryDetails({ observation }: { observation?: AccountQuotaObservation }) {
  const t = useShellCopy(quotaCopy),
    language = useShellLanguage();
  if (!observation) return null;
  const kind = quotaFailureKind(observation);
  const result =
    observation.status === 'ok'
      ? t.querySucceeded
      : kind === 'renewal_required'
        ? t.renewal
        : kind === 'signin_required'
          ? t.signin
          : t.offline;
  return (
    <details className="account-quota-query-details">
      <summary>{t.latestQuery}</summary>
      <p>
        {quotaQueryTime(observation.observedAt, language)} · {result}
      </p>
      {observation.status !== 'ok' && <p>{observation.failure?.officialDetail ?? t.noOfficialDetail}</p>}
    </details>
  );
}
