'use client';

import type { PawFeelInboxItem } from '@cat-cafe/shared';
import { pawFeelCopy, usePawFeelCopy, usePawFeelLanguage } from '../paw-feel/paw-feel.shell-copy';
import { pawFeelDutyDetail } from '../paw-feel/paw-feel-duty-presentation';
import { pawFeelIssueDetail, pawFeelIssueStatus } from '../paw-feel/paw-feel-issue-presentation';

function responsibilityLabel(item: PawFeelInboxItem, language: 'zh' | 'en'): string {
  const t = pawFeelCopy[language];
  const label = t.responsibility[item.responsibility.state];
  return item.responsibility.validExit ? label : `${label} · ${t.noExit}`;
}

function formatAge(ageMs: number, language: 'zh' | 'en'): string {
  const t = pawFeelCopy[language];
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return t.lessHour;
  if (hours < 48) return `${hours} ${t.hours}`;
  return `${Math.floor(hours / 24)} ${t.days}`;
}

function formatTimestamp(value: string, language: 'zh' | 'en'): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return pawFeelCopy[language].unreadableTime;
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function rowTone(item: PawFeelInboxItem, issueOverdue: boolean): string {
  if (item.overdue || issueOverdue) return 'border-conn-red-ring bg-conn-red-bg text-conn-red-text';
  if (!item.responsibility.validExit || item.issue.resolution === 'open') {
    return 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text';
  }
  return 'border-cafe bg-cafe-surface text-cafe-secondary';
}

export function PawFeelInboxRow({ item }: { item: PawFeelInboxItem }) {
  const t = usePawFeelCopy();
  const language = usePawFeelLanguage();
  const detail = pawFeelDutyDetail(item, language);
  const issueDetail = pawFeelIssueDetail(item, language);
  const issueOverdue = item.issue.resolution === 'open' && item.issue.ageMs >= 72 * 3_600_000;
  const stateTone = rowTone(item, issueOverdue);

  return (
    <article
      className={`rounded-lg border px-3 py-3 ${stateTone}`}
      data-testid="paw-feel-inbox-row"
      data-state={item.responsibility.state}
      data-valid-exit={item.responsibility.validExit ? 'true' : 'false'}
      data-disposition-state={item.disposition.state}
      data-resolution={item.issue.resolution}
      data-continuation={item.issue.continuation.kind}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-micro font-semibold">
            <span>
              {t.receipt} · {responsibilityLabel(item, language)}
            </span>
            {item.disposition.backfilled ? (
              <span className="rounded-full border border-current px-1.5 py-0.5">{t.backfill}</span>
            ) : null}
            {item.overdue || issueOverdue ? (
              <span className="rounded-full border border-current px-1.5 py-0.5">72h+</span>
            ) : null}
          </div>
          <div className="mt-1 text-xs font-semibold">{pawFeelIssueStatus(item, language)}</div>
          <div className="mt-1 text-xs opacity-75">
            {t.reportCat} @{item.disposition.sourceCatId}
            {item.disposition.lastActorCatId ? ` · ${t.reviewCat} @${item.disposition.lastActorCatId}` : ''}
          </div>
          <div className="mt-1 text-micro opacity-70">
            {t.sourceTime} {item.sourceOccurredAt ? formatTimestamp(item.sourceOccurredAt, language) : t.unreadable} ·{' '}
            {t.intakeTime} {formatTimestamp(item.disposition.discoveredAt, language)} ·
            {item.responsibility.validExit
              ? ` ${t.actionDuration} ${formatAge(item.ageMs, language)}`
              : ` ${t.runningDuration} ${formatAge(item.ageMs, language)}`}
          </div>
          <div className="mt-1 text-micro opacity-70">
            {item.issue.resolution === 'resolved'
              ? `${t.resolutionDuration} ${formatAge(item.issue.ageMs, language)}`
              : `${t.issueDuration} ${formatAge(item.issue.ageMs, language)}`}
          </div>
        </div>
        <span className="max-w-full truncate font-mono text-micro opacity-70" title={item.disposition.signalId}>
          {item.disposition.sourceMessageId}
        </span>
      </div>

      {item.source.availability === 'available' ? (
        <a
          href={item.source.sourceHref}
          className="mt-2 block text-sm font-medium leading-relaxed text-cafe hover:underline"
        >
          {item.source.preview}
        </a>
      ) : (
        <output className="mt-2 block rounded-md border border-current/30 px-2 py-1.5 text-xs">
          {t.sourceMissing(item.source.reason)}
        </output>
      )}

      {detail ? <p className="mt-2 text-xs leading-relaxed opacity-80">{detail}</p> : null}
      {issueDetail ? <p className="mt-2 text-xs leading-relaxed opacity-80">{issueDetail}</p> : null}
      {item.deterministicGroupKey ? (
        <div className="mt-2 text-micro opacity-60">{t.groupKey(item.deterministicGroupKey)}</div>
      ) : null}
    </article>
  );
}
