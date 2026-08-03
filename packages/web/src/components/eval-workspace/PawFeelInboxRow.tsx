'use client';

import type { PawFeelInboxItem } from '@cat-cafe/shared';

const STATE_LABELS: Record<PawFeelInboxItem['disposition']['state'], string> = {
  new: '未看',
  seen: '已看',
  route_pending: '等待接单',
  routed: '已移交',
  closed: '已关闭',
  duplicate: '重复',
  no_action: '无需行动',
  fix: '已确认要修',
};

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

function dispositionDetail(item: PawFeelInboxItem): string | undefined {
  const { disposition } = item;
  if (disposition.state === 'routed') {
    const target = disposition.targetThreadId ?? disposition.proposalId ?? '目标责任面';
    return `已移交至 ${target}，不代表已经修复`;
  }
  if (disposition.state === 'route_pending') {
    return disposition.targetThreadId
      ? `等待 ${disposition.targetThreadId} 接单`
      : `等待 F128 proposal ${disposition.proposalId ?? ''} 获批`;
  }
  if (disposition.state === 'duplicate' && disposition.duplicateOf) {
    return `重复于 ${disposition.duplicateOf}`;
  }
  if (disposition.state === 'fix') {
    return `由 @${disposition.ownerCatId ?? 'unknown'} 负责 · 任务 ${disposition.taskId ?? 'unavailable'} · F167 lease ${
      disposition.actionLeaseRef?.leaseId ?? 'unavailable'
    }`;
  }
  if (disposition.reasonCode) return `理由：${disposition.reasonCode}`;
  return undefined;
}

export function PawFeelInboxRow({ item }: { item: PawFeelInboxItem }) {
  const detail = dispositionDetail(item);
  const stateTone = item.overdue
    ? 'border-conn-red-ring bg-conn-red-bg text-conn-red-text'
    : item.disposition.state === 'new'
      ? 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text'
      : 'border-cafe bg-cafe-surface text-cafe-secondary';

  return (
    <article
      className={`rounded-lg border px-3 py-3 ${stateTone}`}
      data-testid="paw-feel-inbox-row"
      data-state={item.disposition.state}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-micro font-semibold">
            <span>{STATE_LABELS[item.disposition.state]}</span>
            {item.disposition.backfilled ? (
              <span className="rounded-full border border-current px-1.5 py-0.5">历史回填</span>
            ) : null}
            {item.overdue ? <span className="rounded-full border border-current px-1.5 py-0.5">72h+</span> : null}
          </div>
          <div className="mt-1 text-xs opacity-75">
            报告猫 @{item.disposition.sourceCatId}
            {item.disposition.lastActorCatId ? ` · 审阅猫 @${item.disposition.lastActorCatId}` : ''}
          </div>
          <div className="mt-1 text-micro opacity-70">
            原消息时间 {item.sourceOccurredAt ? formatTimestamp(item.sourceOccurredAt) : '暂不可读'} · 入箱 / SLA{' '}
            {formatTimestamp(item.disposition.discoveredAt)} ·
            {item.disposition.state === 'routed' ||
            item.disposition.state === 'closed' ||
            item.disposition.state === 'duplicate' ||
            item.disposition.state === 'no_action' ||
            item.disposition.state === 'fix'
              ? ` 处置耗时 ${formatAge(item.ageMs)}`
              : ` 已运行 ${formatAge(item.ageMs)}`}
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
        <div className="mt-2 rounded-md border border-current/30 px-2 py-1.5 text-xs" role="status">
          原始证据暂不可读：{item.source.reason}
        </div>
      )}

      {detail ? <p className="mt-2 text-xs leading-relaxed opacity-80">{detail}</p> : null}
      {item.deterministicGroupKey ? (
        <div className="mt-2 text-micro opacity-60">确定性分组：{item.deterministicGroupKey}</div>
      ) : null}
    </article>
  );
}
