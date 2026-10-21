'use client';
import type { ArtifactReviewAnchor, ReviewedMediaAsset } from '@cat-cafe/shared';
import { type ReactNode, useState } from 'react';
import { browserTimeToTick, tickToBrowserTime } from '@/components/content-review/review-geometry';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { ContentReviewSurface } from './ContentReviewSurface';
import type { ContentReviewController } from './content-review-contract';
import { useVideoWorkContext } from './useVideoWorkContext';
import { VideoWorkChapters } from './VideoWorkChapters';
import { VideoWorkComparison } from './VideoWorkComparison';
import { VideoWorkResponses } from './VideoWorkResponses';
import { VideoWorkSidebar } from './VideoWorkSidebar';
import styles from './video-work-layout.module.css';

export function VideoWorkReview({
  asset,
  latest,
  review,
  title,
  onBack,
  onVersionChange,
  leadingAction,
  fullWindowAction,
  navigationOrigin,
}: {
  asset: ReviewedMediaAsset;
  latest: number;
  review: ContentReviewController;
  title: string;
  onBack: () => void;
  onVersionChange?: (revision: number) => void;
  leadingAction?: ReactNode;
  fullWindowAction?: { active: boolean; onToggle: () => void };
  navigationOrigin?: WorkspaceFileNavigationOrigin;
}) {
  const context = useVideoWorkContext(asset.contentRef, asset.ownerRevision);
  const threadId = useChatStore((state) => state.currentThreadId);
  const [comparison, setComparison] = useState(false);
  const [leftActive, setLeftActive] = useState(false);
  const [seek, setSeek] = useState<{ id: number; seconds: number }>();
  const [seconds, setSeconds] = useState(0);
  const [mark, setMark] = useState(0);
  const [selection, setSelection] = useState<{ id: number; anchor: ArtifactReviewAnchor }>();
  const versionControl = (
    <>
      <select
        aria-label="作品版本"
        value={asset.ownerRevision}
        onChange={(event) => onVersionChange?.(Number(event.target.value))}
        className="max-w-44 rounded-md bg-transparent p-1 text-xs"
      >
        {Array.from({ length: latest }, (_, index) => index + 1).map((revision) => (
          <option key={revision} value={revision}>
            第 {revision} 版 · {revision === latest ? '当前' : '历史'}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={latest < 2}
        aria-pressed={comparison}
        onClick={() => {
          setComparison(!comparison);
          setLeftActive(false);
        }}
        className="rounded-md border border-cafe-subtle px-2 py-1 text-xs"
      >
        对比版本
      </button>
      <button
        type="button"
        disabled={
          !review.view ||
          review.view.sourceState !== 'current' ||
          review.busy ||
          leftActive ||
          !(review.view.canReply ?? review.view.canWrite)
        }
        onClick={() => setMark((n) => n + 1)}
        className="rounded-md bg-cafe-accent px-3 py-1 text-xs text-white"
      >
        标记问题
      </button>
    </>
  );
  return (
    <div className={styles.desk}>
      <ContentReviewSurface
        review={review}
        path={title}
        title={title}
        sourceText=""
        sourceTextRevision=""
        onBack={onBack}
        navigationOrigin={navigationOrigin}
        leadingAction={leadingAction}
        fullWindowAction={fullWindowAction}
        publication={{ contentRef: asset.contentRef, ownerRevision: asset.ownerRevision, asset }}
        versionControl={versionControl}
        sidebar={
          comparison ? (
            <VideoWorkComparison
              reference={asset}
              latest={latest}
              rightContext={context.record}
              onAlignRight={(row) => {
                const media = asset.media;
                if (media.kind === 'video' && row.streamId === media.streamId)
                  setSeek((previous) => ({
                    id: (previous?.id ?? 0) + 1,
                    seconds: tickToBrowserTime(row.startPts, media),
                  }));
              }}
              onLeftActiveChange={setLeftActive}
              onClose={() => {
                setComparison(false);
                setLeftActive(false);
              }}
            />
          ) : (
            <VideoWorkSidebar
              {...context}
              clock={asset.media.kind === 'video' ? asset.media : undefined}
              currentTick={asset.media.kind === 'video' ? browserTimeToTick(seconds, asset.media) : undefined}
              onAnnotate={
                review.view?.sourceState === 'current' && !review.busy && (review.view.canReply ?? review.view.canWrite)
                  ? (row, metadataRevision) => {
                      setSelection((previous) => ({
                        id: (previous?.id ?? 0) + 1,
                        anchor: {
                          kind: 'video-range',
                          streamId: row.streamId,
                          startTick: row.startPts,
                          endTick: row.endPts,
                          storyEvidence: { paragraphId: row.id, metadataRevision, quote: row.text || row.title },
                        },
                      }));
                    }
                  : undefined
              }
              onSeek={(row) => {
                const media = asset.media;
                if (media.kind === 'video')
                  setSeek((previous) => ({
                    id: (previous?.id ?? 0) + 1,
                    seconds: tickToBrowserTime(row.startPts, media),
                  }));
              }}
              assetUrl={
                threadId
                  ? (assetId, metadataRevision) =>
                      `${API_URL}/api/works/${encodeURIComponent(asset.contentRef)}/video-assets/${asset.ownerRevision}/${metadataRevision}/${encodeURIComponent(assetId)}?threadId=${encodeURIComponent(threadId)}`
                  : undefined
              }
            />
          )
        }
        workflow={{
          videoWork: true,
          onPlaybackTime: setSeconds,
          chapterNavigation:
            asset.media.kind === 'video' ? (
              <VideoWorkChapters
                chapters={context.record?.context.chapters ?? []}
                clock={asset.media}
                currentTick={browserTimeToTick(seconds, asset.media)}
                onSeek={(chapter) => {
                  const media = asset.media;
                  if (media.kind === 'video')
                    setSeek((previous) => ({
                      id: (previous?.id ?? 0) + 1,
                      seconds: tickToBrowserTime(chapter.startPts, media),
                    }));
                }}
              />
            ) : null,
          responseDiscussion: (
            <VideoWorkResponses
              reference={{ contentRef: asset.contentRef, ownerRevision: asset.ownerRevision }}
              onVersion={onVersionChange}
              onResult={(anchor) => {
                const media = asset.media;
                setComparison(false);
                setLeftActive(false);
                if (media.kind === 'video' && anchor.kind === 'video-range' && anchor.streamId === media.streamId)
                  setSeek((previous) => ({
                    id: (previous?.id ?? 0) + 1,
                    seconds: tickToBrowserTime(anchor.startTick, media),
                  }));
              }}
            />
          ),
          playbackHidden: leftActive,
          seekRequest: seek,
          markRequest: mark,
          selectionRequest: selection,
          modification: null,
        }}
      />
    </div>
  );
}
