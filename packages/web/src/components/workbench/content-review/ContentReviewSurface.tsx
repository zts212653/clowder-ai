'use client';

import { type ReactNode, useRef, useState } from 'react';
import { ArtworkChromeProvider } from '@/components/content-review/ArtworkChrome';
import {
  ArtworkGalleryNavigation,
  useArtworkGalleryNavigation,
} from '@/components/content-review/ArtworkGalleryNavigation';
import { useArtworkGallery } from '@/components/content-review/ArtworkGalleryScope';
import { useArtworkWorkMode } from '@/components/content-review/ArtworkWorkModeScope';
import { TextWorkProgress } from '@/components/content-review/TextWorkProgress';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useWorkspacePreviewIntent } from '../WorkspacePreviewIntent';
import { ContentLandingHeader } from './ContentLandingHeader';
import { contentReviewCapabilities } from './content-review-capabilities';
import type {
  ContentLandingCapabilities,
  ContentReviewController,
  ContentReviewWorkflow,
} from './content-review-contract';
import { type PublicationDisplayRequest, usePublicationDisplay } from './usePublicationDisplay';
import { WorkspaceContentReviewProjection } from './WorkspaceContentReviewProjection';

export interface ContentFileReaderControls {
  readonly onRequestModification: () => void;
  readonly modificationDisabled: boolean;
  readonly onQuoteSelected: (quote: string) => void;
}

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
  leadingAction,
  fullWindowAction,
  title,
  titleInHost = false,
  capabilities,
  workflow,
  publication,
  fileReader,
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
  readonly leadingAction?: ReactNode;
  readonly fullWindowAction?: { active: boolean; onToggle: () => void };
  readonly title?: string;
  /** The active Workspace host already names this work; retain only its version and return controls here. */
  readonly titleInHost?: boolean;
  readonly capabilities?: ContentLandingCapabilities;
  readonly workflow?: ContentReviewWorkflow;
  readonly publication?: PublicationDisplayRequest;
  readonly fileReader?: (controls: ContentFileReaderControls) => ReactNode;
}) {
  const draftStarted = useWorkspacePreviewIntent();
  const root = useRef<HTMLElement>(null);
  const galleryContext = useArtworkGallery();
  const workMode = useArtworkWorkMode();
  const gallery = workMode ? galleryContext : undefined;
  useArtworkGalleryNavigation(gallery, root);
  const [openRequest, setOpenRequest] = useState(0);
  const [selection, setSelection] = useState<{ revision: string; quote: string } | null>(null);
  const currentCapabilities = review.view ? (capabilities ?? contentReviewCapabilities(review.view)) : null;
  const modificationDisabled =
    !review.view?.canWrite ||
    review.busy ||
    review.view.sourceState !== 'current' ||
    currentCapabilities?.requestModification.state !== 'available' ||
    (review.view.currentSource ?? review.view.review.source).revision !== sourceTextRevision;
  const textSource = review.view?.currentSource ?? review.view?.review.source;
  usePublicationDisplay(root, publication, review.view, review.error);
  return (
    <ArtworkChromeProvider>
      <section
        ref={root}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="workspace-content-review-surface"
        data-navigation-origin={navigationOrigin?.kind ?? 'unknown'}
      >
        {!fileReader && (
          <ContentLandingHeader
            title={titleInHost ? undefined : (title ?? (path.split('/').at(-1) || path))}
            navigationOrigin={navigationOrigin}
            onBack={onBack}
            onOpenFileTools={onOpenFileTools}
            versionControl={versionControl}
            leadingAction={leadingAction}
            fullWindowAction={fullWindowAction}
          />
        )}
        {workflow?.status}
        {fileReader || textSource?.kind === 'text' ? (
          // The reader is already interactive before its progress read finishes.
          // Keep one document-sized slot; extra requests scroll without moving the text under a native selection.
          <div className="h-8 shrink-0 overflow-y-auto overscroll-contain" data-testid="text-work-progress-slot">
            {review.view?.sourceState === 'current' &&
            textSource?.kind === 'text' &&
            textSource.revision === sourceTextRevision ? (
              <TextWorkProgress locator={textSource.locator} revision={textSource.revision} />
            ) : null}
          </div>
        ) : null}
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
        {fileReader?.({
          onRequestModification: () => {
            if (!modificationDisabled) setOpenRequest((request) => request + 1);
          },
          modificationDisabled,
          onQuoteSelected: (quote) => setSelection(quote ? { revision: sourceTextRevision, quote } : null),
        })}
        {!fileReader && !review.view && !review.error ? (
          <p className="p-4 text-sm text-cafe-muted">正在打开作品…</p>
        ) : null}
        {review.view ? (
          <WorkspaceContentReviewProjection
            capabilities={capabilities ?? contentReviewCapabilities(review.view)}
            workflow={workflow}
            view={review.view}
            path={path}
            sourceText={sourceText}
            sourceTextRevision={sourceTextRevision}
            scrollToLine={scrollToLine}
            fileReader={fileReader ? { selection, openRequest, modificationDisabled } : undefined}
            draft={review.draft}
            target={review.target}
            busy={review.busy}
            activeAnnotationId={review.activeAnnotationId}
            setDraft={(body) => {
              review.setDraft(body);
              if (body.length > 0) draftStarted?.();
            }}
            setTarget={(target) => {
              review.setTarget(target);
              if (target !== null) draftStarted?.();
            }}
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
        {gallery?.items[gallery.index]?.caption ? (
          <p className="shrink-0 px-3 text-center text-xs text-cafe-muted">{gallery.items[gallery.index].caption}</p>
        ) : null}
        {gallery ? <ArtworkGalleryNavigation gallery={gallery} arrows={false} /> : null}
      </section>
    </ArtworkChromeProvider>
  );
}
