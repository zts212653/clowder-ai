'use client';

import type { ReactNode } from 'react';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { ContentLandingHeader } from './ContentLandingHeader';
import { contentReviewCapabilities } from './content-review-capabilities';
import type {
  ContentLandingCapabilities,
  ContentReviewController,
  ContentReviewWorkflow,
} from './content-review-contract';
import { WorkspaceContentReviewProjection } from './WorkspaceContentReviewProjection';

export function ContentReviewSurface({
  review,
  path,
  sourceText,
  sourceTextRevision,
  scrollToLine,
  navigationOrigin,
  onBack,
  onApplied,
  onOpenFileTools,
  versionControl,
  title,
  capabilities,
  workflow,
}: {
  readonly review: ContentReviewController;
  readonly path: string;
  readonly sourceText: string;
  readonly sourceTextRevision: string;
  readonly scrollToLine?: number | null;
  readonly navigationOrigin?: WorkspaceFileNavigationOrigin;
  readonly onBack: () => void;
  readonly onApplied?: (writtenRevision?: string) => Promise<void> | void;
  readonly onOpenFileTools?: () => void;
  readonly versionControl?: ReactNode;
  readonly title?: string;
  readonly capabilities?: ContentLandingCapabilities;
  readonly workflow?: ContentReviewWorkflow;
}) {
  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="workspace-content-review-surface"
      data-navigation-origin={navigationOrigin?.kind ?? 'unknown'}
    >
      <ContentLandingHeader
        title={title ?? (path.split('/').at(-1) || path)}
        navigationOrigin={navigationOrigin}
        onBack={onBack}
        onOpenFileTools={onOpenFileTools}
        versionControl={versionControl}
      />
      {workflow?.status}
      {review.error ? (
        <p role="alert" className="rounded bg-[var(--semantic-critical-surface)] p-2 text-xs text-cafe-error">
          {review.error}
        </p>
      ) : null}
      {review.pending ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-cafe-muted" role="status">
          <span>保存结果待核对，输入仍保留。</span>
          <button
            type="button"
            disabled={review.busy}
            onClick={() => void review.retryPending()}
            className="font-semibold text-cafe-accent"
          >
            核对并重试保存
          </button>
        </div>
      ) : null}
      {!review.view && !review.error ? <p className="p-4 text-sm text-cafe-muted">正在打开作品…</p> : null}
      {review.view ? (
        <WorkspaceContentReviewProjection
          capabilities={capabilities ?? contentReviewCapabilities(review.view)}
          workflow={workflow}
          view={review.view}
          path={path}
          sourceText={sourceText}
          sourceTextRevision={sourceTextRevision}
          scrollToLine={scrollToLine}
          draft={review.draft}
          target={review.target}
          busy={review.busy}
          activeAnnotationId={review.activeAnnotationId}
          setDraft={review.setDraft}
          setTarget={review.setTarget}
          setActiveAnnotationId={review.setActiveAnnotationId}
          submitAnnotation={review.submitAnnotation}
          legacyText={review.legacyText}
          refreshSource={review.refreshSource}
          act={review.act}
          onApplied={async (writtenRevision) => {
            await onApplied?.(writtenRevision);
            // Accepting confirms exactly the written revision. Move only onto that one; if it is unknown, or
            // the file has since become something else, the drift banner stays and asks the person.
            if (writtenRevision) await review.refreshSource({ expectedSourceRevision: writtenRevision });
          }}
        />
      ) : null}
      {workflow?.panel}
    </section>
  );
}
