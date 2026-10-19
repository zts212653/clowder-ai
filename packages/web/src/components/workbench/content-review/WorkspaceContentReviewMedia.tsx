'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArtworkActions } from '@/components/content-review/ArtworkActions';
import { ArtworkGalleryArrows } from '@/components/content-review/ArtworkGalleryNavigation';
import { useArtworkGallery } from '@/components/content-review/ArtworkGalleryScope';
import { ArtworkMediaFooter } from '@/components/content-review/ArtworkMediaFooter';
import { ImageArtworkControls } from '@/components/content-review/ImageArtworkControls';
import { ReviewCanvasPopover } from '@/components/content-review/ReviewCanvasPopover';
import { type ReviewCanvasMode } from '@/components/content-review/ReviewCanvasToolbar';
import { ReviewMediaOverlay } from '@/components/content-review/ReviewMediaOverlay';
import { browserTimeToTick } from '@/components/content-review/review-geometry';
import {
  MARKUP_COLORS,
  MARKUP_STROKE_WIDTHS,
  type ReviewMarkupTool,
  useReviewMarkupDraft,
} from '@/components/content-review/review-markup-draft';
import styles from '@/components/content-review/review-workspace.module.css';
import { useArtworkSave } from '@/components/content-review/useArtworkSave';
import { useArtworkViewport } from '@/components/content-review/useArtworkViewport';
import { usePresentedVideoFrame } from '@/components/content-review/usePresentedVideoFrame';
import { useReviewMediaSelection } from '@/components/content-review/useReviewMediaSelection';
import { VideoArtworkControls } from '@/components/content-review/VideoArtworkControls';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { useWorkspacePreviewIntent } from '../WorkspacePreviewIntent';
import { WorkspaceReviewMarkupToolbar } from './WorkspaceReviewMarkupToolbar';
import { WorkspaceReviewMediaElement } from './WorkspaceReviewMediaElement';
import { workspaceFrameAnchor } from './workspace-content-review-anchors';
import { useCanvasFocus, useDiscussionVideoSeek } from './workspace-review-media-focus';
import type { WorkspaceReviewMediaProps } from './workspace-review-media-props';

export function WorkspaceContentReviewMedia({
  reviewId,
  sourceRevision,
  src,
  download,
  media,
  annotations,
  annotationResolutions,
  visualMarks,
  visualMarkResolutions,
  activeAnnotationId,
  canWrite,
  saveBlocked = false,
  onAnchorSelected,
  onAnnotationActive,
  discussionFocusRequest,
  canvasFocusRequest,
  modificationOpenRequest = 0,
  onSaveVisualMarks,
  onDeleteVisualMark,
  selected,
  restoreComment = false,
  composer,
  chatPlaceEditor,
  onOpenDiscussion,
  draftKey,
  canMarkup = true,
  sourceError,
  pendingChatMarks,
  imageChatPrimary = false,
  wholeWorkAction,
  originalUrl,
  filename,
  mime,
  byteLength,
}: WorkspaceReviewMediaProps) {
  const draftStarted = useWorkspacePreviewIntent();
  const isV2 = useShellPresentation() === 'v2';
  const gallery = useArtworkGallery();
  const chatSelection = imageChatPrimary && isV2;
  const artwork = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const [seconds, setSeconds] = useState(0);
  // Only a writable round reopens its composer; read-only history always starts in view mode.
  const startsInComment = (canWrite || chatSelection) && Boolean(selected || restoreComment);
  const [mode, setMode] = useState<ReviewCanvasMode>(startsInComment ? 'comment' : 'view');
  const lastModificationOpenRequest = useRef(modificationOpenRequest);
  useEffect(() => {
    if (modificationOpenRequest === lastModificationOpenRequest.current) return;
    lastModificationOpenRequest.current = modificationOpenRequest;
    setMode((current) => (current === 'comment' ? 'view' : current));
  }, [modificationOpenRequest]);
  // A draft that arrives with a later owner read reopens its composer once; later exits are the reader's.
  const commentRestored = useRef(startsInComment);
  useEffect(() => {
    if (commentRestored.current || !restoreComment) return;
    commentRestored.current = true;
    setMode('comment');
  }, [restoreComment]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const error = sourceError ?? loadError;
  const writable = canWrite && Boolean(src) && !error;
  const selectable = chatSelection ? Boolean(src) && !error : writable;
  useEffect(() => {
    setLoadError(null);
  }, [src]);
  const [tool, setTool] = useState<ReviewMarkupTool>('select');
  const [color, setColor] = useState<(typeof MARKUP_COLORS)[number]>(MARKUP_COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState<(typeof MARKUP_STROKE_WIDTHS)[number]>(MARKUP_STROKE_WIDTHS[1]);
  const [markupNotice, setMarkupNotice] = useState<string | null>(null);
  const [textEditing, setTextEditing] = useState(false);
  const activeSurfaceId = useF307ExperienceWorkbenchStore((state) => state.layout.activeSurfaceId);
  const enterMainAreaAttention = useF307ExperienceWorkbenchStore((state) => state.enterMainAreaAttention);
  const { frameTime, onSeeking, onSeeked, seekTo } = usePresentedVideoFrame(
    video,
    src,
    media.kind === 'video' ? JSON.stringify([reviewId, sourceRevision, media.streamId]) : undefined,
  );
  const frame =
    media.kind === 'video' && frameTime !== null
      ? { streamId: media.streamId, tick: browserTimeToTick(frameTime, media) }
      : media.kind === 'video'
        ? null
        : undefined;
  const attachedAnnotations = useMemo(() => {
    const resolutionById = new Map(annotationResolutions.map((item) => [item.annotationId, item.status]));
    return annotations.flatMap((annotation) =>
      resolutionById.get(annotation.id) === 'attached' && 'anchor' in annotation.anchor
        ? [{ id: annotation.id, anchor: annotation.anchor.anchor }]
        : [],
    );
  }, [annotationResolutions, annotations]);
  const attachedMarks = useMemo(() => {
    const resolutionById = new Map(visualMarkResolutions.map((item) => [item.markId, item.status]));
    return visualMarks.filter((mark) => mark.state === 'active' && resolutionById.get(mark.drawing.id) === 'attached');
  }, [visualMarkResolutions, visualMarks]);
  useDiscussionVideoSeek({
    media,
    annotations: [
      ...attachedAnnotations,
      ...(pendingChatMarks ?? []).map((item) => ({ id: `pending:${item.id}`, anchor: item.anchor })),
    ],
    activeAnnotationId: pendingChatMarks?.find((item) => item.active)
      ? `pending:${pendingChatMarks.find((item) => item.active)!.id}`
      : activeAnnotationId,
    discussionFocusRequest,
    src: src ?? '',
    seekTo,
    setSeconds,
  });
  useCanvasFocus(stage, canvasFocusRequest);
  const focusedPlace = pendingChatMarks?.find((item) => item.active)?.id;
  useEffect(() => {
    if (!focusedPlace) return;
    const mark = [...(stage.current?.querySelectorAll<SVGGElement>('[data-selection-id]') ?? [])].find(
      (item) => item.dataset.selectionId === focusedPlace,
    );
    mark?.focus();
  }, [focusedPlace, src]);
  const markup = useReviewMarkupDraft(
    draftKey ?? `workspace-content-review:${reviewId}:${sourceRevision}:markup`,
    media,
    attachedMarks.map((mark) => mark.drawing),
  );
  const markSave = useArtworkSave(markup.marks, onSaveVisualMarks, () => {
    setMode('view');
    setTool('select');
  });
  const { saving, savingIds, notice: saveNotice } = markSave;
  const drawingKey = draftKey ?? `workspace-content-review:${reviewId}:${sourceRevision}`;
  const viewport = useArtworkViewport(
    viewportRef,
    media,
    imageChatPrimary ? 1 : Number.POSITIVE_INFINITY,
    imageChatPrimary,
    (gallery?.items.length ?? 0) > 1,
  );
  const selection = useReviewMediaSelection({
    media,
    mode,
    canAnnotate: selectable,
    selected,
    onSelect: (anchor) => {
      setMode('comment');
      onAnchorSelected(workspaceFrameAnchor(anchor));
    },
    stage,
    frame: frame ?? null,
    identity: `${drawingKey}:${src ?? 'pending'}`,
  });
  const onModeChange = (next: ReviewCanvasMode) => {
    if (next === 'markup' && !canMarkup) return;
    if (next !== 'view') video.current?.pause();
    setMode(next);
    setMarkupNotice(null);
  };
  const saveMarks = () => {
    if (!writable || saveBlocked || !canMarkup || textEditing) return;
    markSave.save();
  };
  const focusArtwork = (next: 'view' | 'markup' | 'select') => {
    if (activeSurfaceId) enterMainAreaAttention(activeSurfaceId);
    if (next === 'markup') {
      onModeChange('markup');
      setTool('select');
    }
    if (next === 'select') selection.setSelecting(true);
  };
  const removeMark = (markId: string) => {
    if (!writable || !canMarkup) return;
    if (savingIds.includes(markId)) {
      setMarkupNotice('这笔正在保存，请等回执后再调整。');
      return;
    }
    if (markup.marks.some((mark) => mark.id === markId)) {
      markup.remove(markId);
      return;
    }
    void onDeleteVisualMark(markId);
  };
  const overlay = (
    <ReviewMediaOverlay
      media={media}
      frame={frame}
      marks={attachedMarks}
      annotations={attachedAnnotations}
      activeAnnotationId={activeAnnotationId}
      seconds={seconds}
      mode={mode}
      selected={selected}
      selection={selection}
      onAnnotationActive={onAnnotationActive}
      pendingChatMarks={pendingChatMarks}
      markup={
        mode === 'markup' && markup.canEdit
          ? {
              media,
              marks: [
                ...attachedMarks.map((mark) => mark.drawing),
                ...markup.marks.filter((mark) => !attachedMarks.some((saved) => saved.drawing.id === mark.id)),
              ],
              drawingKey,
              selectedId: markup.selectedId,
              frame,
              canAdd: writable && canMarkup && markup.canAdd,
              canEdit: writable && canMarkup && markup.canEdit,
              tool,
              color,
              strokeWidth,
              screenScale: viewport.renderedScale,
              onAdd: markup.add,
              onUpdate: markup.replace,
              onSelect: markup.select,
              onRemove: removeMark,
              onTextComplete: () => setTool('select'),
              onEditingChange: setTextEditing,
              onNotice: (kind) =>
                setMarkupNotice(
                  kind === 'frame'
                    ? '请等视频显示稳定的一帧后再标注。'
                    : kind === 'stroke-limit'
                      ? '一笔最多 300 个点；请结束这一笔后继续。'
                      : kind === 'pending'
                        ? '这笔正在保存，请等回执后再调整。'
                        : '一次最多保存 100 个标记；请先保存当前标注。',
                ),
              onDrawStart: () => {
                draftStarted?.();
                setMarkupNotice(null);
              },
              savedMarkIds: attachedMarks.map((mark) => mark.drawing.id),
              lockedMarkIds: savingIds,
            }
          : null
      }
    />
  );
  const toolbar = (
    <WorkspaceReviewMarkupToolbar
      mode={mode}
      writable={writable}
      canMarkup={canMarkup}
      markup={markup}
      saving={saving}
      saveDisabled={saveBlocked || textEditing}
      onSave={saveMarks}
      onModeChange={onModeChange}
      tool={tool}
      onToolChange={setTool}
      color={color}
      onColorChange={setColor}
      strokeWidth={strokeWidth}
      onStrokeWidthChange={setStrokeWidth}
      onFocus={imageChatPrimary ? undefined : focusArtwork}
      composer={mode === 'comment' && !selected ? composer : null}
    />
  );
  return (
    <div
      ref={artwork}
      className={`${styles.artwork} ${imageChatPrimary ? styles.imageArtwork : ''}`}
      data-testid="workspace-review-artwork"
    >
      {saveNotice ? <output className="px-3 text-xs text-cafe-muted">{saveNotice}</output> : null}
      {markup.readError || markup.storageError ? (
        <p role="alert" className={`${styles.artworkNotice} px-3 text-xs text-cafe-error`}>
          {markup.readError ? (
            <>
              原标记草稿暂时无法读取，原记录保留；恢复浏览器存储后重试。{' '}
              <button type="button" className="underline" onClick={markup.retry}>
                重新读取草稿
              </button>
            </>
          ) : (
            '标记草稿尚未保存到浏览器，请保留页面。'
          )}
        </p>
      ) : null}
      {isV2 && originalUrl ? (
        <ArtworkActions
          src={src}
          originalUrl={originalUrl}
          filename={filename ?? download?.filename ?? '作品'}
          mime={mime}
          byteLength={byteLength}
          width={media.width}
          height={media.height}
          root={viewportRef}
          viewport={viewport}
          wholeWorkAction={wholeWorkAction}
        />
      ) : null}
      <section
        ref={viewportRef}
        className={styles.media}
        aria-label="作品画面"
        {...viewport.handlers}
        style={{
          cursor: viewport.canPan ? 'grab' : undefined,
          alignItems: imageChatPrimary && viewport.fitsVertically ? 'start' : undefined,
        }}
      >
        <div ref={stage} data-testid="review-media-stage" className={styles.stage} style={viewport.stageStyle}>
          <WorkspaceReviewMediaElement
            src={src}
            error={error}
            media={media}
            video={video}
            selectionActive={selection.selectionActive}
            customControls={imageChatPrimary}
            onSeeking={onSeeking}
            onSeeked={onSeeked}
            onSeconds={setSeconds}
            onError={setLoadError}
          />
          {src && !error ? overlay : null}
        </div>
        {gallery ? <ArtworkGalleryArrows gallery={gallery} /> : null}
      </section>
      {imageChatPrimary && media.kind === 'video' ? (
        <VideoArtworkControls
          media={media}
          video={video}
          seconds={seconds}
          frameReady={frame !== null}
          mode={mode}
          canAnnotate={selectable}
          canMarkup={writable && canMarkup && markup.canEdit}
          onModeChange={onModeChange}
          onRange={onAnchorSelected}
          onFrame={() => selection.setSelecting(true)}
          seekTo={seekTo}
          annotations={attachedAnnotations}
          onAnnotationActive={onAnnotationActive}
        >
          {toolbar}
        </VideoArtworkControls>
      ) : imageChatPrimary ? (
        <ImageArtworkControls
          unifiedActions={isV2 && !!originalUrl}
          mode={mode}
          canAnnotate={selectable}
          canMarkup={writable && canMarkup && markup.canEdit}
          onModeChange={(next) => {
            if (next === 'markup') setTool('brush');
            onModeChange(next);
          }}
          viewport={viewport}
          src={src}
          download={download}
          discussionCount={annotations.length}
          onOpenDiscussion={onOpenDiscussion}
          wholeWorkAction={wholeWorkAction}
        >
          {toolbar}
        </ImageArtworkControls>
      ) : (
        toolbar
      )}
      {error && src ? (
        <p role="alert" className="px-3 text-xs text-cafe-error">
          {error}
        </p>
      ) : null}
      {markupNotice ? <output className="px-3 text-xs text-cafe-muted">{markupNotice}</output> : null}
      {!imageChatPrimary ? (
        <ArtworkMediaFooter
          viewport={viewport}
          discussionCount={annotations.length}
          onOpenDiscussion={onOpenDiscussion}
          controls={{
            media,
            round: 1,
            selected,
            canAnnotate: writable,
            src,
            download,
            error,
            selectionActive: selection.selectionActive,
            selecting: selection.selecting,
            showSelectionControls: mode !== 'markup',
            frameTime,
            seconds,
            videoRef: video,
            onSelect: (anchor) => {
              setMode('comment');
              onAnchorSelected(anchor);
            },
            onSelectingChange: selection.setSelecting,
          }}
        />
      ) : null}
      {chatPlaceEditor ? (
        <ReviewCanvasPopover
          anchor={chatPlaceEditor.anchor}
          media={media}
          canvasRef={stage}
          containerRef={artwork}
          viewKey={`${viewport.renderedScale}:${viewport.offset.x}:${viewport.offset.y}`}
          onClose={chatPlaceEditor.cancel}
        >
          {chatPlaceEditor.content}
        </ReviewCanvasPopover>
      ) : !imageChatPrimary && writable && mode === 'comment' && selected ? (
        <ReviewCanvasPopover
          anchor={selected}
          media={media}
          canvasRef={stage}
          containerRef={artwork}
          viewKey={`${viewport.renderedScale}:${viewport.offset.x}:${viewport.offset.y}`}
          onClose={() => setMode('view')}
        >
          {composer}
        </ReviewCanvasPopover>
      ) : null}
    </div>
  );
}
