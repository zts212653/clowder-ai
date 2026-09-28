'use client';
import type {
  ArtifactReviewAnnotation,
  ArtifactReviewImageEdit,
  ArtifactReviewRound,
  ArtifactReviewView,
} from '@cat-cafe/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ReviewCanvasPopover } from './ReviewCanvasPopover';
import { type ReviewCanvasMode, ReviewCanvasToolbar } from './ReviewCanvasToolbar';
import { ReviewCommentComposer } from './ReviewCommentComposer';
import { ReviewDiscussionPanel } from './ReviewDiscussionPanel';
import { ReviewImageMenu } from './ReviewImageMenu';
import { ReviewMedia } from './ReviewMedia';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import {
  MARKUP_COLORS,
  MARKUP_STROKE_WIDTHS,
  type ReviewMarkupTool,
  useReviewMarkupDraft,
} from './review-markup-draft';
import styles from './review-workspace.module.css';
import type { useArtifactReview } from './useArtifactReview';
import { useReviewDraft } from './useReviewDraft';

type ReviewRoundWorkspaceProps = {
  view: ArtifactReviewView;
  roundNumber: number;
  historical: boolean;
  prefix: string;
  controller: ReturnType<typeof useArtifactReview>;
  onReanchor?: ((annotation: ArtifactReviewAnnotation) => void) | undefined;
  panel: 'comments' | 'decision' | 'details' | null;
  onPanelChange: (panel: 'comments' | 'decision' | 'details' | null) => void;
};

export function ReviewRoundWorkspace(props: ReviewRoundWorkspaceProps) {
  const round = props.view.review.rounds.find((item) => item.number === props.roundNumber);
  return round ? <ReviewRoundWorkspaceContent {...props} round={round} /> : null;
}

function ReviewRoundWorkspaceContent({
  view,
  roundNumber,
  historical,
  prefix,
  controller,
  onReanchor,
  round,
  panel,
  onPanelChange,
}: ReviewRoundWorkspaceProps & {
  round: ArtifactReviewRound;
}) {
  const canWrite = view.authority.canWrite && !controller.pending;
  const canAnnotate = canWrite && !historical && round.state !== 'approved';
  const draft = useReviewDraft(`${prefix}round:${roundNumber}:annotation`);
  const confirmedMarks = round.visualMarks?.map((mark) => mark.drawing) ?? [];
  const savedMarks = round.visualMarks?.filter((mark) => mark.state === 'active') ?? [];
  const markup = useReviewMarkupDraft(`${prefix}round:${roundNumber}:markup`, round.asset.media, confirmedMarks);
  const [mode, setMode] = useState<ReviewCanvasMode>(canAnnotate && draft.hasDraft ? 'comment' : 'view');
  const [markupTool, setMarkupTool] = useState<ReviewMarkupTool>('select');
  const [markupColor, setMarkupColor] = useState<(typeof MARKUP_COLORS)[number]>(MARKUP_COLORS[0]);
  const [markupStrokeWidth, setMarkupStrokeWidth] = useState<(typeof MARKUP_STROKE_WIDTHS)[number]>(
    MARKUP_STROKE_WIDTHS[1],
  );
  const [markupText, setMarkupText] = useState('');
  const [markupNotice, setMarkupNotice] = useState<string | null>(null);
  const requestImageEdit = (edit: ArtifactReviewImageEdit, note = '') => {
    if (!canAnnotate) return;
    if (note.trim().length > 7600) {
      setMarkupNotice('修改说明请控制在 7600 字以内，再交给猫处理。');
      return;
    }
    void controller
      .act(
        { kind: 'request_image_edit', annotationId: crypto.randomUUID(), edit, ...(note.trim() ? { note } : {}) },
        roundNumber,
      )
      .then((ok) => {
        if (!ok) return;
        if (edit.kind === 'erase-region') draft.clear();
        setComposerDismissed(true);
        setMode('view');
        onPanelChange(null);
      });
  };
  const removeMark = (id: string) => {
    if (!canAnnotate) return;
    if (markup.marks.some((mark) => mark.id === id)) {
      markup.remove(id);
      return;
    }
    const saved = savedMarks.find((mark) => mark.drawing.id === id);
    // PublishedMediaAccess.authorizeScope/authorize guarantees a human viewer's actorId equals this ownerUserId.
    if (!saved || saved.author.kind !== 'human' || saved.author.actorId !== view.review.task.ownerUserId) {
      setMarkupNotice('只能删除自己保存的标记。');
      return;
    }
    void controller.act({ kind: 'delete_visual_mark', markId: id }, roundNumber);
  };
  const [composerDismissed, setComposerDismissed] = useState(false);
  const canvas = useRef<HTMLDivElement | null>(null);
  const artwork = useRef<HTMLDivElement | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ annotationId: string; requestId: number } | null>(null);
  const [discussionFocusRequest, setDiscussionFocusRequest] = useState<{
    annotationId: string;
    requestId: number;
  } | null>(null);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState<{ annotationId: string; requestId: number } | null>(
    null,
  );
  const focusSequence = useRef(0);
  const requestFocus = (annotationId: string) => ({ annotationId, requestId: ++focusSequence.current });
  const activate = (annotationId: string) => setFocusRequest(requestFocus(annotationId));
  const openDiscussion = (annotationId: string) => {
    onPanelChange('comments');
    const request = requestFocus(annotationId);
    setFocusRequest(request);
    setDiscussionFocusRequest(request);
  };
  const returnToCanvas = (annotationId: string) => {
    onPanelChange(null);
    const request = requestFocus(annotationId);
    setFocusRequest(request);
    setCanvasFocusRequest(request);
  };
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!canAnnotate && mode !== 'view') setMode('view');
  }, [canAnnotate, mode]);
  useLayoutEffect(() => {
    if (mode !== 'markup' && draft.draft.anchor && !composerDismissed) textarea.current?.focus({ preventScroll: true });
  }, [draft.draft.anchor, mode, composerDismissed]);
  const showComposer = canAnnotate && mode !== 'markup' && !composerDismissed && (mode === 'comment' || draft.hasDraft);
  const composer = showComposer ? (
    <ReviewCommentComposer
      mode={mode}
      media={round.asset.media}
      draft={draft}
      saving={controller.saving}
      textareaRef={textarea}
      onClose={() => {
        setMode('view');
        setComposerDismissed(true);
      }}
      onSave={() => {
        if (!draft.draft.anchor) return;
        void controller
          .act(
            {
              kind: 'annotate',
              annotationId: crypto.randomUUID(),
              anchor: draft.draft.anchor,
              body: draft.draft.body,
              ...(draft.draft.reanchoredFrom ? { reanchoredFrom: draft.draft.reanchoredFrom } : {}),
            },
            roundNumber,
          )
          .then((ok) => {
            if (ok) {
              draft.clear();
              onPanelChange('comments');
            }
          });
      }}
    />
  ) : null;
  return (
    <div className={styles.workspace}>
      <div ref={artwork} className={`${styles.artwork} ${round.asset.media.kind === 'video' ? styles.video : ''}`}>
        <ReviewCanvasToolbar
          mode={mode}
          canAnnotate={canAnnotate}
          canEditMarkup={canAnnotate && markup.canEdit}
          onModeChange={(next) => {
            setMode(next);
            setComposerDismissed(next === 'view');
            onPanelChange(null);
            setMarkupNotice(null);
          }}
          tool={markupTool}
          onToolChange={setMarkupTool}
          color={markupColor}
          onColorChange={setMarkupColor}
          strokeWidth={markupStrokeWidth}
          onStrokeWidthChange={setMarkupStrokeWidth}
          text={markupText}
          onTextChange={setMarkupText}
          canUndo={markup.canUndo}
          canRedo={markup.canRedo}
          hasMarks={markup.marks.length > 0}
          onUndo={markup.undo}
          onRedo={markup.redo}
          onClear={markup.clear}
          composer={!draft.draft.anchor ? composer : null}
          imageMenu={
            round.asset.media.kind === 'image' ? (
              <ReviewImageMenu disabled={!canAnnotate} onRequest={requestImageEdit} />
            ) : null
          }
        />
        {mode === 'markup' && !markupNotice && !markup.readError && !markup.storageError ? (
          <div className={styles.hint}>
            <span>{markup.marks.length ? `${markup.marks.length} 笔待保存` : '保存后伙伴可见'}</span>
            <button
              type="button"
              className="ml-3 rounded-full bg-cafe-accent px-3 py-1 text-cafe-accent-foreground disabled:opacity-40"
              disabled={!canAnnotate || !markup.canEdit || !markup.marks.length}
              onClick={() => void controller.act({ kind: 'add_visual_marks', marks: markup.marks }, roundNumber)}
            >
              保存标记
            </button>
          </div>
        ) : null}
        {markupNotice ? (
          // biome-ignore lint/a11y/useSemanticElements: This announces required next input, not a form calculation.
          <p role="status" className={`${styles.hint} ${styles.hintError}`}>
            {markupNotice}
          </p>
        ) : null}
        <ReviewMedia
          reviewId={view.review.reviewId}
          round={roundNumber}
          asset={round.asset}
          annotations={round.annotations}
          savedMarks={round.visualMarks}
          selected={draft.draft.anchor}
          focusRequest={focusRequest}
          canAnnotate={canAnnotate}
          onSelect={(anchor) => {
            draft.update({ ...draft.draft, anchor });
            setComposerDismissed(false);
            onPanelChange(null);
          }}
          onActive={activate}
          onOpenDiscussion={openDiscussion}
          canvasFocusRequest={canvasFocusRequest}
          mode={mode}
          canvasRef={canvas}
          selectionKey={`${prefix}round:${roundNumber}:annotation`}
          showSelectionControls={mode === 'view'}
          markup={
            mode === 'markup' && canAnnotate && markup.canEdit
              ? {
                  marks: [
                    ...savedMarks.map((mark) => mark.drawing),
                    ...markup.marks.filter((mark) => !confirmedMarks.some((saved) => saved.id === mark.id)),
                  ],
                  savedMarkIds: savedMarks.map((mark) => mark.drawing.id),
                  drawingKey: `${prefix}round:${roundNumber}:markup:${round.asset.contentRef}:${round.asset.ownerRevision}:${round.asset.blobDigest}`,
                  selectedId: markup.selectedId,
                  tool: markupTool,
                  color: markupColor,
                  strokeWidth: markupStrokeWidth,
                  text: markupText,
                  canAdd: markup.canAdd,
                  onAdd: markup.add,
                  onSelect: markup.select,
                  onRemove: removeMark,
                  onTextRequired: () => setMarkupNotice('先输入标注文字，再点在画面上。'),
                  onNotice: (kind) =>
                    setMarkupNotice(
                      kind === 'frame'
                        ? '请等视频显示稳定的一帧后再标注。'
                        : kind === 'stroke-limit'
                          ? '画笔达到 300 个点的本机草稿上限，已停止这一笔；可撤销后重新画。'
                          : '一次最多提交 100 个标记；请先保存，再继续绘制。',
                    ),
                }
              : undefined
          }
          onUnavailable={controller.revokeAccess}
        />
        {showComposer && draft.draft.anchor ? (
          <ReviewCanvasPopover
            anchor={draft.draft.anchor}
            media={round.asset.media}
            canvasRef={canvas}
            containerRef={artwork}
            onClose={() => setComposerDismissed(true)}
          >
            {composer}
            {draft.draft.anchor.kind === 'image-region' ? (
              <button
                type="button"
                className="mt-7 flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-cafe-accent hover:bg-cafe-surface disabled:opacity-40"
                disabled={!canAnnotate || controller.saving}
                onClick={() => {
                  const anchor = draft.draft.anchor;
                  if (anchor?.kind !== 'image-region') return;
                  const { x, y, width, height } = anchor;
                  requestImageEdit({ kind: 'erase-region', region: { x, y, width, height } }, draft.draft.body);
                }}
              >
                <ReviewToolbarIcon name="eraser" />
                让猫移除这里
              </button>
            ) : null}
          </ReviewCanvasPopover>
        ) : null}
        {mode === 'markup' && markup.readError ? (
          <p role="alert" className={`${styles.hint} ${styles.hintError}`}>
            本地标注草稿暂时无法读取，未覆盖原记录。{' '}
            <button type="button" className="underline" onClick={markup.retry}>
              重新读取草稿
            </button>
          </p>
        ) : null}
        {mode === 'markup' && markup.storageError ? (
          <p role="alert" className={`${styles.hint} ${styles.hintError}`}>
            本地标注草稿暂未保存到浏览器，请保留当前页面。
          </p>
        ) : null}
      </div>
      {panel === 'comments' || panel === 'decision' ? (
        <ReviewDiscussionPanel
          panel={panel}
          round={round}
          view={view}
          prefix={prefix}
          canWrite={canWrite}
          historical={historical}
          controller={controller}
          activeId={focusRequest?.annotationId ?? null}
          focusRequest={discussionFocusRequest}
          onActive={activate}
          onReturnToCanvas={returnToCanvas}
          onReanchor={onReanchor}
          onClose={() => onPanelChange(null)}
        />
      ) : null}
    </div>
  );
}
