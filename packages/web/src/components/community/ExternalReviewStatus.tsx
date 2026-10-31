import type { ExternalReviewAggregate } from '@cat-cafe/shared';

const LIFECYCLE_LABELS: Record<ExternalReviewAggregate['lifecycle'], string> = {
  assigned: '已接单',
  awaiting_author: '等作者',
  awaiting_ci: '等 CI',
  awaiting_cloud_review: '等云端',
  rereview_required: '待复审',
  pending_delivery: '待送达',
  delivered: '已送达',
  terminal: '已终止',
};

const CLOUD_LABELS: Record<NonNullable<ExternalReviewAggregate['cloud']>['status'], string> = {
  not_requested: '云端未请求',
  running: '云端进行中',
  blocking: '云端阻塞',
  clean: '云端通过',
  failed_or_timeout: '云端失败',
};

function shortSha(sha: string | null): string | null {
  return sha?.slice(0, 7) ?? null;
}

function pendingAge(createdAt: number): string {
  const elapsedMs = Math.max(0, Date.now() - createdAt);
  if (elapsedMs < 60_000) return '刚刚';
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}分钟`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}小时`;
  return `${Math.floor(elapsedMs / 86_400_000)}天`;
}

function Chip({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const toneClass = {
    neutral: 'border-cafe-border/30 bg-cafe-surface-elevated/30 text-cafe-muted',
    good: 'border-conn-green-ring bg-conn-green-bg text-conn-green-text',
    warn: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
    bad: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
  }[tone];
  return <span className={`rounded-full border px-1.5 py-0.5 text-micro leading-none ${toneClass}`}>{label}</span>;
}

type ChipTone = 'neutral' | 'good' | 'warn' | 'bad';

interface StatusChip {
  readonly key: string;
  readonly label: string;
  readonly tone?: ChipTone;
}

function ciChip(status: NonNullable<ExternalReviewAggregate['ci']>['status']): StatusChip {
  const labels = { pending: '运行中', pass: '绿', fail: '红' } as const;
  const tones = { pending: 'warn', pass: 'good', fail: 'bad' } as const;
  return { key: 'ci', label: `CI ${labels[status]}`, tone: tones[status] };
}

function cloudChip(status: NonNullable<ExternalReviewAggregate['cloud']>['status']): StatusChip {
  const tone: ChipTone =
    status === 'clean' ? 'good' : status === 'running' || status === 'not_requested' ? 'warn' : 'bad';
  return { key: 'cloud', label: CLOUD_LABELS[status], tone };
}

function statusChips(aggregate: ExternalReviewAggregate): StatusChip[] {
  const pending = aggregate.delivery?.kind === 'pending_delivery' ? aggregate.delivery : null;
  const chips: StatusChip[] = [
    { key: 'lifecycle', label: LIFECYCLE_LABELS[aggregate.lifecycle], tone: pending ? 'warn' : 'neutral' },
  ];
  const currentHead = shortSha(aggregate.currentHeadSha);
  if (currentHead) chips.push({ key: 'head', label: `HEAD ${currentHead}` });
  if (aggregate.ci?.headSha === aggregate.currentHeadSha) chips.push(ciChip(aggregate.ci.status));
  if (aggregate.cloud?.headSha === aggregate.currentHeadSha) chips.push(cloudChip(aggregate.cloud.status));
  const deliveredHead = shortSha(aggregate.lastDeliveredHeadSha);
  if (deliveredHead) {
    const deliveredForCurrentGeneration = aggregate.lastDeliveredHeadGeneration === aggregate.headGeneration;
    chips.push({
      key: 'delivered',
      label: `${deliveredForCurrentGeneration ? '已送达' : '历史送达'} ${deliveredHead}`,
      tone: deliveredForCurrentGeneration ? 'good' : 'neutral',
    });
  }
  if (pending) chips.push({ key: 'pending', label: `待送达 ${pendingAge(pending.createdAt)}`, tone: 'warn' });
  return chips;
}

function statusTitle(aggregate: ExternalReviewAggregate): string {
  if (aggregate.delivery?.kind === 'pending_delivery') {
    return `待送达由 ${aggregate.delivery.ownerCatId} 持球：${aggregate.delivery.reason}`;
  }
  if (aggregate.delivery?.kind === 'delivered') return `送达证据：${aggregate.delivery.githubUrl}`;
  return `外部复审状态：${LIFECYCLE_LABELS[aggregate.lifecycle]}`;
}

export function ExternalReviewStatus({ aggregate }: { aggregate: ExternalReviewAggregate | null | undefined }) {
  if (!aggregate) return null;

  return (
    <div
      data-testid="external-review-status"
      className="flex flex-wrap items-center gap-1 px-3 pb-1.5 pl-8"
      title={statusTitle(aggregate)}
    >
      {statusChips(aggregate).map((chip) => (
        <Chip key={chip.key} label={chip.label} tone={chip.tone} />
      ))}
    </div>
  );
}
