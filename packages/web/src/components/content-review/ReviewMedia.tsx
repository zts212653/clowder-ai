'use client';
import type {
  ArtifactReviewAnchor,
  ArtifactReviewAnnotation,
  ArtifactReviewVisualMark,
  ReviewedMediaAsset,
} from '@cat-cafe/shared';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { ReviewAnnotationNavigation } from './ReviewAnnotationNavigation';
import { ReviewCanvasAnnotations } from './ReviewCanvasAnnotations';
import type { ReviewCanvasMode } from './ReviewCanvasToolbar';
import { ReviewMarkupLayer } from './ReviewMarkupLayer';
import { ReviewMediaControls } from './ReviewMediaControls';
import { ReviewSavedMarkupLayer } from './ReviewSavedMarkupLayer';
import { browserTimeToTick, tickToBrowserTime } from './review-geometry';
import type { ReviewMarkupMark, ReviewMarkupTool } from './review-markup-draft';
import styles from './review-workspace.module.css';
import { usePresentedVideoFrame } from './usePresentedVideoFrame';
import { useReviewMediaSelection } from './useReviewMediaSelection';
import { useReviewMediaSource } from './useReviewMediaSource';

export function ReviewMedia({
  reviewId,
  round,
  asset,
  annotations,
  selected,
  focusRequest,
  canAnnotate,
  onSelect,
  onActive,
  onOpenDiscussion,
  canvasFocusRequest,
  mode = 'view',
  selectionKey,
  showSelectionControls = true,
  markup,
  onUnavailable,
  canvasRef,
  savedMarks,
}: {
  reviewId: string;
  round: number;
  asset: ReviewedMediaAsset;
  annotations: ArtifactReviewAnnotation[];
  selected: ArtifactReviewAnchor | null;
  focusRequest: { annotationId: string } | null;
  canAnnotate: boolean;
  onSelect: (anchor: ArtifactReviewAnchor) => void;
  onActive: (id: string) => void;
  onOpenDiscussion?: ((id: string) => void) | undefined;
  canvasFocusRequest?: { annotationId: string; requestId: number } | null;
  mode?: ReviewCanvasMode;
  selectionKey: string;
  showSelectionControls?: boolean;
  markup?:
    | {
        marks: ReviewMarkupMark[];
        savedMarkIds?: string[];
        drawingKey: string;
        selectedId: string | null;
        tool: ReviewMarkupTool;
        color: ReviewMarkupMark['color'];
        strokeWidth: ReviewMarkupMark['strokeWidth'];
        text: string;
        canAdd: boolean;
        onAdd: (mark: ReviewMarkupMark) => void;
        onSelect: (id: string | null) => void;
        onRemove: (id: string) => void;
        onTextRequired: () => void;
        onNotice: (kind: 'frame' | 'stroke-limit' | 'mark-limit') => void;
      }
    | undefined;
  onUnavailable: () => void;
  canvasRef?: RefObject<HTMLDivElement>;
  savedMarks?: ArtifactReviewVisualMark[];
}) {
  const { src, error, setError } = useReviewMediaSource(reviewId, round, onUnavailable);
  const [seconds, setSeconds] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { frameTime, onSeeking, onSeeked, seekTo } = usePresentedVideoFrame(videoRef, src);
  const internalStage = useRef<HTMLDivElement | null>(null);
  const stage = canvasRef ?? internalStage;
  const media = asset.media;
  const commentMode = mode === 'comment';
  const presentedSelectionFrame =
    media.kind === 'video' && frameTime !== null
      ? { streamId: media.streamId, tick: browserTimeToTick(frameTime, media) }
      : null;
  const selectionIdentity = `${selectionKey}:${reviewId}:${round}:${asset.contentRef}:${asset.ownerRevision}:${asset.blobDigest}:${src ?? 'pending'}`;
  const activeId = focusRequest?.annotationId ?? null;
  const anchor = annotations.find((item) => item.id === activeId)?.anchor;
  const seekTarget =
    media.kind === 'video' && anchor?.kind === 'video-range'
      ? tickToBrowserTime(anchor.frameRegion?.tick ?? anchor.framePoint?.tick ?? anchor.startTick, media)
      : null;
  useEffect(() => {
    if (src && focusRequest && seekTarget !== null) seekTo(seekTarget);
  }, [src, focusRequest, seekTarget, seekTo]);
  useEffect(() => {
    if (!canvasFocusRequest) return;
    const marks = stage.current?.querySelectorAll<SVGGElement>('[data-annotation-id]');
    const mark = [...(marks ?? [])].find((item) => item.dataset.annotationId === canvasFocusRequest.annotationId);
    mark?.focus();
  }, [canvasFocusRequest]);
  useEffect(() => {
    if (commentMode) videoRef.current?.pause();
  }, [commentMode]);

  const {
    selecting,
    setSelecting,
    drag,
    selectionActive,
    handlers: selectionHandlers,
  } = useReviewMediaSelection({
    media,
    mode,
    canAnnotate,
    selected,
    onSelect,
    stage,
    frame: presentedSelectionFrame,
    identity: selectionIdentity,
  });
  const selection = drag ?? selected;
  const region =
    selection?.kind === 'image-region'
      ? selection
      : selection?.kind === 'video-range'
        ? selection.frameRegion
        : undefined;
  const selectedPoint =
    selection?.kind === 'image-point'
      ? selection
      : selection?.kind === 'video-range'
        ? selection.framePoint
        : undefined;

  return (
    <section className={styles.media} aria-label="产物画面">
      <div
        ref={stage}
        data-testid="review-media-stage"
        className={styles.stage}
        style={{ aspectRatio: media.width / media.height }}
      >
        {src ? (
          media.kind === 'image' ? (
            // biome-ignore lint/performance/noImgElement: authorized retained-media blob; revoked on version change/unmount.
            <img
              src={src}
              alt={`第 ${round} 版待审阅图片`}
              className="absolute inset-0 h-full w-full object-contain"
              onError={() => setError('此浏览器无法显示这张图片。你可以下载原文件查看。')}
            />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: immutable publications retain original tracks; no fabricated captions.
            <video
              ref={videoRef}
              src={src}
              controls={!selectionActive}
              playsInline
              preload="metadata"
              aria-label={`第 ${round} 版待审阅视频`}
              className="absolute inset-0 h-full w-full object-contain"
              onTimeUpdate={(event) => setSeconds(event.currentTarget.currentTime)}
              onSeeking={onSeeking}
              onSeeked={onSeeked}
              onError={() => setError('此浏览器无法播放这份视频。你可以下载原文件，或使用支持此格式的浏览器。')}
            />
          )
        ) : (
          <p className="p-5 text-sm text-cafe-muted">{error ?? '正在核对并读取原版媒体…'}</p>
        )}
        {src && savedMarks && !markup ? (
          <ReviewSavedMarkupLayer marks={savedMarks} media={media} frame={presentedSelectionFrame} />
        ) : null}
        {src ? (
          <svg
            viewBox={`0 0 ${media.width} ${media.height}`}
            role="group"
            aria-label="标注区域"
            className={`absolute inset-0 h-full w-full ${selectionActive ? 'touch-none cursor-crosshair' : 'pointer-events-none'}`}
            {...selectionHandlers}
          >
            <title>标注位置；选择图上的标记可打开同一讨论</title>
            <ReviewCanvasAnnotations
              annotations={annotations}
              media={media}
              activeId={activeId}
              seconds={seconds}
              interactive={mode !== 'markup' && (!selecting || commentMode)}
              onActive={onOpenDiscussion ?? onActive}
            />
            {region ? (
              <rect
                x={region.x}
                y={region.y}
                width={region.width}
                height={region.height}
                fill="var(--cafe-accent)"
                fillOpacity={0.16}
                stroke="var(--cafe-accent)"
                strokeDasharray="6 4"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {selectedPoint ? (
              <circle
                cx={selectedPoint.x}
                cy={selectedPoint.y}
                r={Math.max(5, media.width / 100)}
                fill="var(--cafe-accent)"
                stroke="var(--cafe-surface)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
        ) : null}
        {src && markup ? (
          <ReviewMarkupLayer
            media={media}
            frame={
              media.kind === 'video'
                ? frameTime === null
                  ? null
                  : { streamId: media.streamId, tick: browserTimeToTick(frameTime, media) }
                : undefined
            }
            onDrawStart={() => videoRef.current?.pause()}
            {...markup}
          />
        ) : null}
      </div>
      {error && src ? (
        <p role="alert" className="text-xs text-cafe-error">
          {error}
        </p>
      ) : null}
      <div className={styles.mediaFooter}>
        <ReviewMediaControls
          media={media}
          round={round}
          selected={selected}
          canAnnotate={canAnnotate}
          src={src}
          error={error}
          selectionActive={selectionActive}
          selecting={selecting}
          showSelectionControls={showSelectionControls}
          frameTime={frameTime}
          seconds={seconds}
          videoRef={videoRef}
          onSelect={onSelect}
          onSelectingChange={setSelecting}
        />
        <ReviewAnnotationNavigation annotations={annotations} activeId={activeId} onActive={onActive} />
      </div>
    </section>
  );
}
