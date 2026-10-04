import type { WorkspaceContentReviewAction } from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { ReviewToolbarIcon } from '@/components/content-review/ReviewToolbarIcon';
import commentStyles from '@/components/content-review/review-comment.module.css';
import toolbarStyles from '@/components/content-review/review-toolbar.module.css';
import styles from '@/components/content-review/review-workspace.module.css';
import { API_URL } from '@/utils/api-client';
import type { ContentLandingCapabilities, ContentReviewView, ContentReviewWorkflow } from './content-review-contract';
import type { WorkspaceAnnotationTarget } from './useWorkspaceContentReview';
import { WorkspaceContentReviewComments } from './WorkspaceContentReviewComments';
import { WorkspaceContentReviewMedia } from './WorkspaceContentReviewMedia';
import { WorkspaceContentReviewText } from './WorkspaceContentReviewText';
import { WorkspaceLegacyTextNotes } from './WorkspaceLegacyTextNotes';
import { WorkspaceModificationEntry } from './WorkspaceModificationEntry';
import type { LegacyTextNotes } from './workspace-review-legacy-text';

type Act = (action: WorkspaceContentReviewAction) => Promise<boolean>;
type FocusRequest = { readonly annotationId: string; readonly requestId: number };

export function WorkspaceContentReviewProjection({
  view,
  path,
  sourceText,
  sourceTextRevision,
  scrollToLine,
  draft,
  target,
  busy,
  activeAnnotationId,
  setDraft,
  setTarget,
  setActiveAnnotationId,
  submitAnnotation,
  refreshSource,
  act,
  onApplied,
  capabilities,
  workflow,
  legacyText,
}: {
  readonly legacyText?: LegacyTextNotes;
  readonly capabilities: ContentLandingCapabilities;
  readonly workflow?: ContentReviewWorkflow;
  readonly view: ContentReviewView;
  readonly path: string;
  readonly sourceText: string;
  readonly sourceTextRevision: string;
  readonly scrollToLine?: number | null;
  readonly draft: string;
  readonly target: WorkspaceAnnotationTarget | null;
  readonly busy: boolean;
  readonly activeAnnotationId: string | null;
  readonly setDraft: (draft: string) => void;
  readonly setTarget: (target: WorkspaceAnnotationTarget | null) => void;
  readonly setActiveAnnotationId: (annotationId: string | null) => void;
  readonly submitAnnotation: () => Promise<void>;
  readonly refreshSource: () => Promise<void>;
  readonly act: Act;
  readonly onApplied?: (writtenRevision?: string) => Promise<void> | void;
}) {
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionFocusRequest, setDiscussionFocusRequest] = useState<FocusRequest | null>(null);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState<FocusRequest | null>(null);
  const [modificationOpenRequest, setModificationOpenRequest] = useState(0);
  // A text selection is live, like the card built on it: it targets "请猫修改" but is never stored as a draft,
  // so it cannot overwrite the quote of an old unsubmitted text draft.
  const [textSelection, setTextSelection] = useState<{ revision: string; quote: string } | null>(null);
  const focusSequence = useRef(0);
  const requestFocus = (annotationId: string): FocusRequest => ({ annotationId, requestId: ++focusSequence.current });
  const openDiscussion = (annotationId: string) => {
    setDiscussionOpen(true);
    setActiveAnnotationId(annotationId);
    setDiscussionFocusRequest(requestFocus(annotationId));
  };
  const returnToCanvas = (annotationId: string) => {
    setDiscussionOpen(false);
    setActiveAnnotationId(annotationId);
    setCanvasFocusRequest(requestFocus(annotationId));
  };
  const closeDiscussion = () => {
    if (activeAnnotationId) returnToCanvas(activeAnnotationId);
    else setDiscussionOpen(false);
  };
  const source = view.currentSource ?? view.review.source;
  const canAuthor = view.canWrite && view.sourceState === 'current' && capabilities.annotate.state === 'available';
  const canWrite = canAuthor && !busy;
  const composer = (
    <form
      className={commentStyles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        void submitAnnotation();
      }}
    >
      <label>
        <span className="sr-only">评论内容</span>
        <textarea
          value={draft}
          maxLength={workflow?.annotationMaxLength ?? 8000}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="写下这条批注…"
        />
      </label>
      <button
        type="submit"
        aria-label="保存批注"
        className={commentStyles.send}
        disabled={!canWrite || !target || !draft.trim()}
      >
        <ReviewToolbarIcon name="send" />
        <span className="sr-only">保存批注</span>
      </button>
    </form>
  );
  const comments = workflow?.discussion ? (
    workflow.discussion({
      activeAnnotationId,
      focusRequest: discussionFocusRequest,
      onActive: openDiscussion,
      onReturnToCanvas: returnToCanvas,
    })
  ) : (
    <WorkspaceContentReviewComments
      reviewId={view.review.reviewId}
      ownerUserId={view.review.ownerUserId}
      annotations={view.review.annotations}
      resolutions={view.annotationResolutions}
      activeAnnotationId={activeAnnotationId}
      focusRequest={discussionFocusRequest}
      onActive={openDiscussion}
      onReturnToCanvas={returnToCanvas}
      canWrite={canWrite}
      canReply={!busy && capabilities.reply.state === 'available'}
      onReply={(annotationId, body) => act({ kind: 'reply', annotationId, replyId: crypto.randomUUID(), body })}
      onSetState={(annotationId, state) => act({ kind: 'set_annotation_state', annotationId, state })}
    />
  );
  const sourceState = <WorkspaceContentReviewSourceState view={view} busy={busy} refreshSource={refreshSource} />;
  const modification =
    workflow && 'modification' in workflow ? (
      workflow.modification
    ) : (
      <WorkspaceModificationEntry
        view={view}
        path={path}
        target={
          source.kind === 'text'
            ? textSelection?.revision === source.revision
              ? { kind: 'text_quote', quote: textSelection.quote }
              : null
            : target
        }
        disabled={!canWrite || capabilities.requestModification.state !== 'available'}
        onApplied={onApplied}
        onExpanded={() => setModificationOpenRequest((request) => request + 1)}
      />
    );
  if (source.kind === 'text')
    return (
      <>
        {sourceState}
        {modification}
        {legacyText ? (
          <WorkspaceLegacyTextNotes
            legacy={legacyText}
            locator={source.locator}
            markdown={/.mdx?$/i.test(path)}
            currentRevision={source.revision}
            onShowRecord={openDiscussion}
          />
        ) : null}
        {view.sourceState === 'current' ? (
          sourceTextRevision === source.revision ? (
            <WorkspaceContentReviewText
              text={sourceText}
              revision={sourceTextRevision}
              locator={source.locator}
              scrollToLine={scrollToLine}
              markdown={/.mdx?$/i.test(path)}
              onQuoteSelected={(quote) => setTextSelection({ revision: source.revision, quote })}
            />
          ) : (
            <p className="p-3 text-sm text-cafe-muted">文件预览版本已过期；返回文件重新加载后再批注。</p>
          )
        ) : null}
        {/* New text annotations go through the selection card into chat (CVO095/098); only existing
            discussions keep their place here, readable and repliable under their original authorization. */}
        {view.review.annotations.length > 0 ? <div className="border-t border-cafe-subtle p-3">{comments}</div> : null}
      </>
    );
  return (
    <div className={styles.workspace}>
      {sourceState}
      {view.sourceState === 'current' ? (
        <WorkspaceContentReviewMedia
          draftKey={workflow?.canvasDraftKey}
          canMarkup={capabilities.markup.state === 'available'}
          key={`${view.review.reviewId}:${source.revision}`}
          reviewId={view.review.reviewId}
          sourceRevision={source.revision}
          src={
            workflow?.mediaSource
              ? workflow.mediaSource.src
              : source.kind === 'publication'
                ? `${API_URL}/api/content-publications/${encodeURIComponent(source.publication.contentRef)}/media/${source.publication.ownerRevision}`
                : `${API_URL}/api/${source.kind === 'evolution' ? '' : 'workspace/'}content-reviews/${encodeURIComponent(view.review.reviewId)}/media?expectedSourceRevision=${encodeURIComponent(source.revision)}`
          }
          media={source.media}
          sourceError={workflow?.mediaSource?.error}
          annotations={view.review.annotations}
          annotationResolutions={view.annotationResolutions}
          visualMarks={view.review.visualMarks ?? []}
          visualMarkResolutions={view.visualMarkResolutions ?? []}
          activeAnnotationId={activeAnnotationId}
          canWrite={canAuthor}
          saveBlocked={busy}
          selected={target?.kind === 'media_anchor' ? target.anchor : null}
          restoreComment={canWrite && draft.trim() !== ''}
          composer={composer}
          onOpenDiscussion={() => {
            setDiscussionOpen(true);
          }}
          onAnchorSelected={(anchor) => {
            setDiscussionOpen(false);
            setTarget({ kind: 'media_anchor', anchor });
          }}
          onAnnotationActive={openDiscussion}
          discussionFocusRequest={discussionFocusRequest}
          canvasFocusRequest={canvasFocusRequest}
          onSaveVisualMarks={(marks) => act({ kind: 'add_visual_marks', marks: [...marks] })}
          onDeleteVisualMark={(markId) => act({ kind: 'delete_visual_mark', markId })}
          modificationOpenRequest={modificationOpenRequest}
        />
      ) : null}
      <p className="shrink-0 border-t border-cafe-subtle px-3 pt-2 text-xs text-cafe-muted">
        修改想法 · {target?.kind === 'media_anchor' ? '当前选区' : '整图'}
      </p>
      <div className={styles.modificationRegion}>{modification}</div>
      {discussionOpen || view.sourceState !== 'current' ? (
        <aside className={styles.drawer} aria-label="作品讨论">
          <div className={styles.drawerHeader}>
            <h3 className={styles.drawerTitle}>
              <ReviewToolbarIcon name="comment" />
              一起讨论
            </h3>
            <button type="button" className={toolbarStyles.iconButton} aria-label="关闭讨论" onClick={closeDiscussion}>
              <ReviewToolbarIcon name="close" />
            </button>
          </div>
          <div className={styles.drawerBody}>{comments}</div>
        </aside>
      ) : null}
    </div>
  );
}

function WorkspaceContentReviewSourceState({
  view,
  busy,
  refreshSource,
}: {
  readonly view: ContentReviewView;
  readonly busy: boolean;
  readonly refreshSource: () => Promise<void>;
}) {
  if (view.sourceState === 'unavailable')
    return <p className="p-3 text-sm text-cafe-muted">原内容当前不可读取；协作历史保留，但不展示旧内容缓存。</p>;
  if (view.sourceState !== 'changed') return null;
  return (
    <div className="rounded border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] p-3 text-sm text-cafe-muted">
      <p>原文件已改动。已有批注会如实显示重定位或失联状态；确认后才切换到当前版本。</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void refreshSource()}
        className="mt-2 text-xs font-semibold text-cafe-accent hover:underline"
      >
        切换到当前版本
      </button>
    </div>
  );
}
