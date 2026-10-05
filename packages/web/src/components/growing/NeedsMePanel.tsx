'use client';

import type { ArtifactReviewView, EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { ReviewArtifactButton } from '@/components/content-review/ReviewArtifactButton';
import { reviewSurfaceFromPreparedRef } from '@/components/workbench/artifact-review-surface';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';
import { useChatStore } from '@/stores/chatStore';
import { EntrustedWorkBrief } from './EntrustedWorkBrief';
import { type EligibleNeedsMeReceipt, selectNeedsMeItems } from './needs-me-items';
import { type PreparedArtifactCoordinate, PreparedArtifactPreview } from './PreparedArtifactPreview';
import { preparedArtifactPresentation, preparedReviewCoordinate } from './prepared-artifact-presentation';
import { usePreparedReviewTitle } from './prepared-review-presentation';
import { resolvePreparedArtifact } from './resolve-prepared-artifact';

export { needsMeItemRef } from './needs-me-items';

function whyNow(receipt: EligibleNeedsMeReceipt): string {
  if (receipt.salience === 'near_deadline') return '临近业务时间，需要你现在判断';
  if (receipt.salience === 'high_risk') return '来源 owner 标记为高风险，需要你判断';
  return receipt.kind === 'repair' ? '来源卡住了，需要你补齐信息' : '猫已准备到需要你定方向的地方';
}

/** Brief and preview name the same work: a cat-prepared review is titled by the review itself. */
function NeedsMePreparedWork({
  ownerRead,
  coordinate,
  artifact,
  loading,
  onOpen,
  reviewAction,
}: {
  ownerRead: EntrustedWorkOwnerReadV1;
  coordinate: PreparedArtifactCoordinate;
  artifact?: GlobalArtifactDTO;
  loading: boolean;
  /** Receives the review title when known, so the opened tab carries the same name as the card. */
  onOpen: (title?: string) => void;
  reviewAction?: ReactNode;
}) {
  const review = artifact ? null : preparedReviewCoordinate(coordinate.previewRef);
  const reviewTitle = usePreparedReviewTitle(review?.reviewId ?? null);
  return (
    <>
      <EntrustedWorkBrief
        ownerRead={ownerRead}
        artifactLabel={preparedArtifactPresentation(coordinate, artifact, reviewTitle).label}
      />
      <div className="mt-3">
        <PreparedArtifactPreview
          coordinate={coordinate}
          artifact={artifact}
          reviewTitle={reviewTitle}
          loading={loading}
          onOpen={() => onOpen(reviewTitle)}
          reviewAction={reviewAction}
        />
      </div>
    </>
  );
}

export function NeedsMePanel({
  artifacts,
  artifactsLoading = false,
  selectedItemRef,
  onOpenArtifact,
  onOpenAction,
  onOpenReview,
}: {
  artifacts: GlobalArtifactDTO[];
  artifactsLoading?: boolean;
  selectedItemRef?: string | null;
  onOpenArtifact?: (artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void;
  onOpenAction?: (actionRef: string, itemRef: string) => void;
  onOpenReview?: (review: ArtifactReviewView, itemRef: string) => void;
}) {
  const projection = useEntrustedWorkProjection('needs-me');
  const selectedRef = useRef<HTMLElement | null>(null);
  const items = useMemo(() => selectNeedsMeItems(projection.ownerReads), [projection.ownerReads]);

  useEffect(() => {
    if (!selectedItemRef) return;
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedItemRef]);

  return (
    <section className="min-w-0 overflow-x-hidden p-4 sm:p-5" data-testid="needs-me-panel" aria-label="Needs Me">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-micro font-bold uppercase tracking-[0.16em] text-cafe-muted">Needs Me</p>
            {projection.loading || projection.error ? null : (
              <span
                data-testid="needs-me-count"
                className="rounded-full bg-cafe-surface px-2 py-0.5 text-micro font-semibold text-cafe-secondary"
              >
                {items.length}
              </span>
            )}
          </div>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-cafe-black">只留下真正需要你的判断</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-cafe-secondary">
            猫会先把能做的做好；只有真的需要你决定时，才带着准备好的内容回来。
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-cafe-muted transition-colors hover:bg-cafe-surface hover:text-cafe-secondary"
          onClick={projection.refetch}
        >
          刷新
        </button>
      </header>

      {projection.loading ? <p className="mt-6 text-sm text-cafe-muted">正在看看有没有需要你判断的事…</p> : null}
      {projection.error ? (
        <div className="mt-6 rounded-xl border border-cafe-error/30 bg-cafe-error/5 p-4 text-sm text-cafe-secondary">
          暂时无法读取需要你判断的事；任务和准备好的内容仍然保留，请稍后刷新。
        </div>
      ) : null}
      {!projection.loading && !projection.error && items.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-cafe-subtle px-6 py-12 text-center">
          <p
            className="text-cafe-black text-[length:var(--console-font-2xl)] leading-[1.25]"
            style={{ fontFamily: 'var(--evolution-title-font)' }}
          >
            暂时没有要你判断的事
          </p>
          <p className="mt-2 text-xs leading-5 text-cafe-muted">工作安排和进展都在工作日历。</p>
          <button
            type="button"
            data-testid="needs-me-goto-schedule"
            className="mt-4 rounded-lg px-3 py-2 text-xs font-medium text-cafe-secondary transition-colors hover:bg-cafe-surface hover:text-cafe-black"
            onClick={() => useChatStore.getState().setWorkspaceMode('product-schedule')}
          >
            去工作日历看看
          </button>
        </div>
      ) : null}

      <div className="mt-5 grid min-w-0 gap-3">
        {items.map(({ ownerRead, receipt, itemRef }) => {
          const coordinate = ownerRead.preparedArtifact;
          if (!coordinate) return null;
          const artifact = resolvePreparedArtifact(artifacts, coordinate);
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
                  <details className="mt-1 text-micro text-cafe-muted">
                    <summary className="cursor-pointer">来源判断</summary>
                    <p className="mt-1 break-all">{receipt.reasonCode}</p>
                  </details>
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
              <NeedsMePreparedWork
                ownerRead={ownerRead}
                coordinate={coordinate}
                artifact={artifact}
                loading={artifactsLoading && !reviewSurfaceFromPreparedRef(coordinate.openInWorkspaceRef)}
                onOpen={(title) => onOpenArtifact?.(coordinate, itemRef, title)}
                reviewAction={
                  onOpenReview ? (
                    <ReviewArtifactButton
                      ownerRead={ownerRead}
                      onPrepared={(review) => onOpenReview(review, itemRef)}
                    />
                  ) : undefined
                }
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}
