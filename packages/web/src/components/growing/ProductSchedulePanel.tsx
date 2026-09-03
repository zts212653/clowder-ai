'use client';

import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef } from 'react';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';

export type PreparedArtifactCoordinate = NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>;

export function scheduleItemRef(ownerRead: EntrustedWorkOwnerReadV1): string {
  return `${ownerRead.envelope.subjectRef}|${ownerRead.envelope.revision}`;
}

const TIME_LABELS = {
  business_deadline: '业务截止',
  review_by: '请你审阅',
  execution_trigger: '执行时间',
} as const;

function primaryTime(ownerRead: EntrustedWorkOwnerReadV1) {
  return ownerRead.timeRefs.reduce<(typeof ownerRead.timeRefs)[number] | undefined>(
    (earliest, candidate) => (!earliest || candidate.value < earliest.value ? candidate : earliest),
    undefined,
  );
}

function artifactLabel(ownerRead: EntrustedWorkOwnerReadV1): string {
  const ref = ownerRead.preparedArtifact?.artifactRef;
  if (!ref) return '托付工作';
  const label = ref.split(/[/:]/).filter(Boolean).at(-1);
  return label?.replaceAll('-', ' ') || '托付工作';
}

function formatBusinessTime(value: number, currentTime: number): string {
  const formatted = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
  return value <= currentTime ? `已到时间 · ${formatted}` : formatted;
}

export function ProductSchedulePanel({
  onOpenArtifact,
  selectedItemRef,
  now = Date.now,
}: {
  onOpenArtifact?: (artifact: PreparedArtifactCoordinate, itemRef: string) => void;
  selectedItemRef?: string | null;
  now?: () => number;
}) {
  const projection = useEntrustedWorkProjection();
  const selectedRef = useRef<HTMLElement | null>(null);
  const scheduled = useMemo(
    () =>
      projection.ownerReads
        .filter((ownerRead) => ownerRead.envelope.freshness.state === 'current' && ownerRead.timeRefs.length > 0)
        .sort((left, right) => (primaryTime(left)?.value ?? 0) - (primaryTime(right)?.value ?? 0)),
    [projection.ownerReads],
  );
  const currentTime = now();

  useEffect(() => {
    if (!selectedItemRef) return;
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedItemRef]);

  return (
    <section
      className="min-w-0 overflow-x-hidden p-4 sm:p-5"
      data-testid="product-schedule-panel"
      aria-label="Schedule"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-micro font-bold uppercase tracking-[0.16em] text-cafe-accent">Schedule</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-cafe-black">我们接住的事</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-cafe-secondary">
            安静推进和需要判断的托付都在这里；时间与产物始终来自原 owner。
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-lg border border-cafe-subtle bg-cafe-surface px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:border-cafe-accent/35 hover:text-cafe-accent"
          onClick={projection.refetch}
        >
          刷新
        </button>
      </header>

      {projection.loading ? <p className="mt-6 text-sm text-cafe-muted">正在读取托付时间…</p> : null}
      {projection.error ? (
        <div className="mt-6 rounded-xl border border-cafe-error/30 bg-cafe-error/5 p-4 text-sm text-cafe-secondary">
          Schedule 暂时读不到 owner truth。原 Task 与产物没有被改写。
        </div>
      ) : null}
      {!projection.loading && !projection.error && scheduled.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-cafe-subtle p-6 text-center">
          <p className="text-sm font-medium text-cafe-black">现在没有带业务时间的托付</p>
          <p className="mt-1 text-xs text-cafe-muted">未接受的候选不会出现在这里。</p>
        </div>
      ) : null}

      <div className="mt-5 grid min-w-0 gap-3">
        {scheduled.map((ownerRead) => {
          const time = primaryTime(ownerRead);
          if (!time) return null;
          const artifact = ownerRead.preparedArtifact;
          const actionable = ownerRead.attentionReceipts.some((receipt) => receipt.eligible);
          const itemRef = scheduleItemRef(ownerRead);
          const selected = selectedItemRef === itemRef;
          return (
            <article
              key={ownerRead.envelope.subjectRef}
              ref={selected ? selectedRef : undefined}
              className={`min-w-0 rounded-xl border bg-[var(--console-card-bg)] p-4 ${
                selected ? 'border-cafe-accent ring-2 ring-cafe-accent/15' : 'border-cafe-subtle/80'
              }`}
              data-testid="product-schedule-item"
              data-item-ref={itemRef}
              data-selected={selected}
              data-subject-ref={ownerRead.envelope.subjectRef}
              data-owner-ref={ownerRead.envelope.ownerRef}
              data-owner-revision={ownerRead.envelope.revision}
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 break-words text-sm font-semibold text-cafe-black">
                      {artifactLabel(ownerRead)}
                    </h3>
                    <span className="rounded-full bg-cafe-accent/10 px-2 py-0.5 text-micro font-medium text-cafe-accent">
                      {actionable ? '需要判断' : '安静进行中'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs font-medium text-cafe-secondary">
                    {TIME_LABELS[time.role]} · {formatBusinessTime(time.value, currentTime)}
                  </p>
                  {artifact ? (
                    <p
                      className="mt-1 break-words text-micro text-cafe-muted"
                      title={artifact.completenessRef}
                      data-artifact-ref={artifact.artifactRef}
                    >
                      Artifact r{artifact.artifactRevision} · 准备状态来自产物 owner
                    </p>
                  ) : (
                    <p className="mt-1 text-micro text-cafe-muted">产物尚在准备</p>
                  )}
                </div>
                {artifact ? (
                  <button
                    type="button"
                    data-testid="product-schedule-open-artifact"
                    data-open-ref={artifact.openInWorkspaceRef}
                    className="shrink-0 rounded-lg bg-cafe-accent px-3 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover"
                    onClick={() => onOpenArtifact?.(artifact, itemRef)}
                  >
                    在 Workspace 打开
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
