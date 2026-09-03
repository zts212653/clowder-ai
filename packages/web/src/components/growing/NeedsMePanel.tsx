'use client';

import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO, ProducerAttentionReceiptV1 } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef } from 'react';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';
import { type PreparedArtifactCoordinate, PreparedArtifactPreview } from './PreparedArtifactPreview';

type EligibleReceipt = Extract<ProducerAttentionReceiptV1, { eligible: true }>;

export function needsMeItemRef(ownerRead: EntrustedWorkOwnerReadV1, receipt: ProducerAttentionReceiptV1): string {
  return [
    ownerRead.envelope.subjectRef,
    ownerRead.envelope.revision,
    receipt.producer.producerId,
    receipt.producer.subjectRef,
    receipt.producer.revision,
  ].join('|');
}

function whyNow(receipt: EligibleReceipt): string {
  if (receipt.salience === 'near_deadline') return '临近业务时间，需要你现在判断';
  if (receipt.salience === 'high_risk') return '来源 owner 标记为高风险，需要你判断';
  return receipt.kind === 'repair' ? '来源卡住了，需要你补齐信息' : '猫已准备到需要你定方向的地方';
}

export function NeedsMePanel({
  artifacts,
  selectedItemRef,
  onOpenArtifact,
  onOpenAction,
}: {
  artifacts: GlobalArtifactDTO[];
  selectedItemRef?: string | null;
  onOpenArtifact?: (artifact: PreparedArtifactCoordinate, itemRef: string) => void;
  onOpenAction?: (actionRef: string, itemRef: string) => void;
}) {
  const projection = useEntrustedWorkProjection('needs-me');
  const selectedRef = useRef<HTMLElement | null>(null);
  const items = useMemo(
    () =>
      projection.ownerReads.flatMap((ownerRead) =>
        ownerRead.attentionReceipts.flatMap((receipt) =>
          receipt.eligible && ownerRead.envelope.freshness.state === 'current' && ownerRead.preparedArtifact
            ? [{ ownerRead, receipt, itemRef: needsMeItemRef(ownerRead, receipt) }]
            : [],
        ),
      ),
    [projection.ownerReads],
  );

  useEffect(() => {
    if (!selectedItemRef) return;
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedItemRef]);

  return (
    <section className="min-w-0 overflow-x-hidden p-4 sm:p-5" data-testid="needs-me-panel" aria-label="Needs Me">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-micro font-bold uppercase tracking-[0.16em] text-cafe-accent">Needs Me · {items.length}</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-cafe-black">只留下真正需要你的判断</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-cafe-secondary">
            猫先把能推进的部分做好；这里返回原 owner 的判断或修复入口，不复制一份审批状态。
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

      {projection.loading ? <p className="mt-6 text-sm text-cafe-muted">正在读取当前判断…</p> : null}
      {projection.error ? (
        <div className="mt-6 rounded-xl border border-cafe-error/30 bg-cafe-error/5 p-4 text-sm text-cafe-secondary">
          Needs Me 暂时读不到 owner truth；原 Task、Artifact 与判断记录没有被改写。
        </div>
      ) : null}
      {!projection.loading && !projection.error && items.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-cafe-subtle p-6 text-center">
          <p className="text-sm font-medium text-cafe-black">现在没有必须由你判断的事项</p>
          <p className="mt-1 text-xs text-cafe-muted">安静推进中的托付仍在 Schedule，不会为了提醒而挪进来。</p>
        </div>
      ) : null}

      <div className="mt-5 grid min-w-0 gap-3">
        {items.map(({ ownerRead, receipt, itemRef }) => {
          const coordinate = ownerRead.preparedArtifact;
          if (!coordinate) return null;
          const artifact = artifacts.find((candidate) => (candidate.ref ?? candidate.url) === coordinate.artifactRef);
          const selected = selectedItemRef === itemRef;
          return (
            <article
              key={itemRef}
              ref={selected ? selectedRef : undefined}
              className={`min-w-0 rounded-xl border bg-[var(--console-card-bg)] p-4 ${
                selected ? 'border-cafe-accent ring-2 ring-cafe-accent/15' : 'border-cafe-subtle/80'
              }`}
              data-testid="needs-me-item"
              data-item-ref={itemRef}
              data-selected={selected}
              data-task-subject-ref={ownerRead.envelope.subjectRef}
              data-task-revision={ownerRead.envelope.revision}
              data-producer-id={receipt.producer.producerId}
              data-producer-revision={receipt.producer.revision}
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-micro font-bold uppercase tracking-[0.12em] text-cafe-muted">为什么现在需要你</p>
                  <h3 className="mt-1 text-sm font-semibold text-cafe-black">{whyNow(receipt)}</h3>
                  <p className="mt-2 text-xs leading-5 text-cafe-secondary">建议：{receipt.recommendation}</p>
                  <p className="mt-1 break-words text-micro text-cafe-muted">来源判断：{receipt.reasonCode}</p>
                </div>
                <button
                  type="button"
                  data-testid="needs-me-open-action"
                  data-action-ref={receipt.action.actionRef}
                  className="shrink-0 rounded-lg border border-cafe-accent/30 bg-cafe-accent/10 px-3 py-2 text-xs font-semibold text-cafe-accent hover:bg-cafe-accent/15"
                  onClick={() => onOpenAction?.(receipt.action.actionRef, itemRef)}
                >
                  {receipt.kind === 'repair' ? '回到原处修复' : '回到原处判断'}
                </button>
              </div>
              <div className="mt-3">
                <PreparedArtifactPreview
                  coordinate={coordinate}
                  artifact={artifact}
                  onOpen={() => onOpenArtifact?.(coordinate, itemRef)}
                />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
