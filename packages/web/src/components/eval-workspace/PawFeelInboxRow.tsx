'use client';

import type { PawFeelInboxItem } from '@cat-cafe/shared';
import { pawFeelDutyDetail } from '../paw-feel/paw-feel-duty-presentation';
import { pawFeelIssueDetail, pawFeelIssueStatus } from '../paw-feel/paw-feel-issue-presentation';

const RESPONSIBILITY_LABELS: Record<PawFeelInboxItem['responsibility']['state'], string> = {
  unreviewed: 'unreviewed · 尚无业务出口',
  bound_in_repair: 'bound-in-repair · 修复责任已绑定',
  signature_waiting: 'signature-waiting · 等待独立签署',
  blocked: 'blocked · 有结构化阻塞',
  terminal: 'terminal · 已终结',
};

function responsibilityLabel(item: PawFeelInboxItem): string {
  const label = RESPONSIBILITY_LABELS[item.responsibility.state];
  return item.responsibility.validExit ? label : `${label} · 尚未形成有效出口`;
}

function formatAge(ageMs: number): string {
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return '不到 1 小时';
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '时间不可读';
  return new Intl.DateTimeFormat('zh-CN', {
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
  const detail = pawFeelDutyDetail(item);
  const issueDetail = pawFeelIssueDetail(item);
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
            <span>值班回执 · {responsibilityLabel(item)}</span>
            {item.disposition.backfilled ? (
              <span className="rounded-full border border-current px-1.5 py-0.5">历史回填</span>
            ) : null}
            {item.overdue || issueOverdue ? (
              <span className="rounded-full border border-current px-1.5 py-0.5">72h+</span>
            ) : null}
          </div>
          <div className="mt-1 text-xs font-semibold">{pawFeelIssueStatus(item)}</div>
          <div className="mt-1 text-xs opacity-75">
            报告猫 @{item.disposition.sourceCatId}
            {item.disposition.lastActorCatId ? ` · 审阅猫 @${item.disposition.lastActorCatId}` : ''}
          </div>
          <div className="mt-1 text-micro opacity-70">
            原消息时间 {item.sourceOccurredAt ? formatTimestamp(item.sourceOccurredAt) : '暂不可读'} · 入箱 / SLA{' '}
            {formatTimestamp(item.disposition.discoveredAt)} ·
            {item.responsibility.validExit ? ` 处置耗时 ${formatAge(item.ageMs)}` : ` 已运行 ${formatAge(item.ageMs)}`}
          </div>
          <div className="mt-1 text-micro opacity-70">
            {item.issue.resolution === 'resolved'
              ? `问题闭环耗时 ${formatAge(item.issue.ageMs)}`
              : `问题已持续 ${formatAge(item.issue.ageMs)}`}
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
          原始证据暂不可读：{item.source.reason}
        </output>
      )}

      {detail ? <p className="mt-2 text-xs leading-relaxed opacity-80">{detail}</p> : null}
      {issueDetail ? <p className="mt-2 text-xs leading-relaxed opacity-80">{issueDetail}</p> : null}
      {item.deterministicGroupKey ? (
        <div className="mt-2 text-micro opacity-60">确定性分组：{item.deterministicGroupKey}</div>
      ) : null}
    </article>
  );
}
