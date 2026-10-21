import type { WorkspaceContentReviewAction } from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { artworkActionsCopy } from '@/components/content-review/artwork-actions.shell-copy';
import { GalleryPlaceEditor } from '@/components/content-review/GalleryPlaceEditor';
import { ImageWorkProgress } from '@/components/content-review/ImageWorkProgress';
import { mediaChatMime } from '@/components/content-review/media-chat-selection';
import { modificationStorageKey } from '@/components/content-review/modification-draft';
import { modificationFocusStanding, usePendingModificationFocus } from '@/components/content-review/modification-focus';
import { ReviewToolbarIcon } from '@/components/content-review/ReviewToolbarIcon';
import commentStyles from '@/components/content-review/review-comment.module.css';
import toolbarStyles from '@/components/content-review/review-toolbar.module.css';
import styles from '@/components/content-review/review-workspace.module.css';
import { reviewMediaDisplayPath } from '@/components/content-review/useReviewMediaSource';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { isChatWorkElementVisible } from '../WorkspaceChatWorkScope';
import type { ContentLandingCapabilities, ContentReviewView, ContentReviewWorkflow } from './content-review-contract';
import type { WorkspaceAnnotationTarget } from './useWorkspaceContentReview';
import { useWorkspaceMediaChat } from './useWorkspaceMediaChat';
import { WorkspaceContentReviewComments } from './WorkspaceContentReviewComments';
import { WorkspaceContentReviewMedia } from './WorkspaceContentReviewMedia';
import { WorkspaceContentReviewSourceState } from './WorkspaceContentReviewSourceState';
import { WorkspaceContentReviewText } from './WorkspaceContentReviewText';
import { WorkspaceLegacyTextNotes } from './WorkspaceLegacyTextNotes';
import { AddToChatButton, AddToChatNotice, WholeWorkChatButton } from './WorkspaceMediaChatControls';
import { WorkspaceModificationEntry } from './WorkspaceModificationEntry';
import { workspaceReviewRequestSource } from './workspace-modification-source';
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
  fileReader,
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
  readonly fileReader?: {
    selection: { revision: string; quote: string } | null;
    openRequest: number;
    modificationDisabled: boolean;
  };
}) {
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionFocusRequest, setDiscussionFocusRequest] = useState<FocusRequest | null>(null);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState<FocusRequest | null>(null);
  const [modificationOpenRequest, setModificationOpenRequest] = useState(0);
  // A conversation receipt asked to see one returned candidate: it then takes the room the artwork had, and the
  // artwork comes back on request. Only layout changes, so nothing the artwork holds (marks, draft, selection) is lost.
  // It belongs to the one Workspace navigation that carried the ask: this surface keeps its instance when the same file
  // is opened again, so a newer navigation (a link, the file tree, a receipt that only opens the file) ends it.
  const [comparingAt, setComparingAt] = useState<number | null>(null);
  const openRevision = useChatStore((state) => state.workspaceOpenRevision);
  const comparing = comparingAt !== null && comparingAt === openRevision;
  const threadId = useChatStore((state) => state.currentThreadId);
  const pendingFocus = usePendingModificationFocus();
  const privateOwner = view.review.ownerUserId;
  const openingComparison =
    !!pendingFocus?.candidateRef &&
    view.review.source.kind !== 'video-project' &&
    view.review.source.kind !== 'collective-artifact' &&
    view.review.source.kind !== 'collective-media' &&
    typeof privateOwner === 'string' &&
    modificationFocusStanding(pendingFocus, { threadId: threadId ?? null, revision: openRevision }) === 'ours' &&
    modificationStorageKey(privateOwner, workspaceReviewRequestSource(view)) ===
      modificationStorageKey(pendingFocus.record.ownerUserId, pendingFocus.record.payload.source);
  // A text selection is live, like the card built on it: it targets "请猫修改" but is never stored as a draft,
  // so it cannot overwrite the quote of an old unsubmitted text draft.
  const [textSelection, setTextSelection] = useState<{ revision: string; quote: string } | null>(null);
  const selectedText = fileReader ? fileReader.selection : textSelection;
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
  const isV2 = useShellPresentation() === 'v2';
  const artworkCopy = useShellCopy(artworkActionsCopy);
  const canAuthor = view.canWrite && view.sourceState === 'current' && capabilities.annotate.state === 'available';
  const canWrite = canAuthor && !busy;
  const imageChatPrimary =
    source.kind !== 'text' &&
    source.kind !== 'video-project' &&
    source.kind !== 'collective-artifact' &&
    source.kind !== 'collective-media' &&
    !!mediaChatMime(source.mime) &&
    (source.media.kind === 'image' || isV2 || Boolean(workflow?.videoWork));
  const mediaRoot = useRef<HTMLDivElement>(null);
  const mediaChat = useWorkspaceMediaChat({
    view,
    path,
    workflow,
    target,
    draft,
    setDraft,
    setTarget,
    referenceOnOpen: imageChatPrimary && !comparing && !openingComparison,
    isWorkVisible: () => isChatWorkElementVisible(mediaRoot.current),
  });
  if (source.kind === 'collective-artifact')
    return <p className="p-3 text-sm text-cafe-muted">共同作品请从它所在的共同体打开。</p>;
  if (source.kind === 'video-project')
    return <p className="p-3 text-sm text-cafe-muted">当前文件视图尚不支持视频项目审阅。</p>;
  const saveAnnotation = (
    <button
      type="submit"
      aria-label="保存批注"
      className={imageChatPrimary ? commentStyles.secondarySave : commentStyles.send}
      disabled={!canWrite || !target || !draft.trim()}
    >
      {imageChatPrimary ? '保存批注' : <ReviewToolbarIcon name="send" />}
      {!imageChatPrimary ? <span className="sr-only">保存批注</span> : null}
    </button>
  );
  const composer = (
    <>
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
        <AddToChatButton chat={mediaChat} />
        {imageChatPrimary ? (
          <details className={commentStyles.annotationActions}>
            <summary aria-label="批注操作" title="批注操作">
              <ReviewToolbarIcon name="more" />
              <span className="sr-only">批注操作</span>
            </summary>
            <div className={commentStyles.annotationActionsBody}>{saveAnnotation}</div>
          </details>
        ) : (
          saveAnnotation
        )}
      </form>
      <AddToChatNotice chat={mediaChat} />
    </>
  );
  const comments = workflow?.discussion ? (
    workflow.discussion({
      activeAnnotationId,
      focusRequest: discussionFocusRequest,
      onActive: openDiscussion,
      onReturnToCanvas: returnToCanvas,
    })
  ) : privateOwner ? (
    <WorkspaceContentReviewComments
      reviewId={view.review.reviewId}
      ownerUserId={privateOwner}
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
  ) : null;
  const sourceState = <WorkspaceContentReviewSourceState view={view} busy={busy} refreshSource={refreshSource} />;
  const modification =
    source.kind === 'collective-media' || !privateOwner ? null : workflow && 'modification' in workflow ? (
      workflow.modification
    ) : (
      <WorkspaceModificationEntry
        view={{ ...view, review: { ...view.review, ownerUserId: privateOwner } }}
        path={path}
        target={
          source.kind === 'text'
            ? selectedText?.revision === source.revision
              ? { kind: 'text_quote', quote: selectedText.quote }
              : null
            : target
        }
        allowNewRequest={source.kind === 'evolution' || (!imageChatPrimary && source.kind !== 'text')}
        chatRequest={source.kind === 'text' ? { content: sourceText, revision: sourceTextRevision } : undefined}
        disabled={
          !canWrite ||
          capabilities.requestModification.state !== 'available' ||
          !!fileReader?.modificationDisabled ||
          (source.kind === 'text' && sourceTextRevision !== source.revision)
        }
        openRequest={fileReader?.openRequest}
        hideTrigger={!!fileReader}
        compact={imageChatPrimary}
        onApplied={onApplied}
        onExpanded={() => setModificationOpenRequest((request) => request + 1)}
        onComparing={setComparingAt}
      />
    );
  if (source.kind === 'text')
    return (
      <>
        {sourceState}
        <div className="max-h-[70%] min-h-0 shrink-0 overflow-auto" data-workspace-text-comparison>
          {modification}
        </div>
        {legacyText ? (
          <WorkspaceLegacyTextNotes
            legacy={legacyText}
            locator={source.locator}
            markdown={/.mdx?$/i.test(path)}
            currentRevision={source.revision}
            onShowRecord={openDiscussion}
          />
        ) : null}
        {!fileReader && view.sourceState === 'current' ? (
          sourceTextRevision === source.revision ? (
            <WorkspaceContentReviewText
              text={sourceText}
              revision={sourceTextRevision}
              locator={source.locator}
              scrollToLine={scrollToLine}
              markdown={/.mdx?$/i.test(path)}
              onQuoteSelected={(quote) => setTextSelection(quote ? { revision: source.revision, quote } : null)}
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
  const originalMediaSrc = workflow?.mediaSource
    ? (workflow.mediaSource.downloadSrc ?? workflow.mediaSource.src ?? '')
    : source.kind === 'publication'
      ? `${API_URL}/api/content-publications/${encodeURIComponent(source.publication.contentRef)}/media/${source.publication.ownerRevision}`
      : `${API_URL}/api/${source.kind === 'evolution' ? '' : 'workspace/'}content-reviews/${encodeURIComponent(view.review.reviewId)}/media?expectedSourceRevision=${encodeURIComponent(source.revision)}`;
  return (
    <div
      ref={mediaRoot}
      className={`${styles.workspace} ${imageChatPrimary ? styles.imageWorkspace : ''} ${workflow?.videoWork ? styles.videoWorkspace : ''}`}
      data-comparing={comparing ? 'true' : undefined}
      data-video-work-canvas={workflow?.videoWork ? '' : undefined}
      data-video-discussion-open={workflow?.videoWork ? String(discussionOpen) : undefined}
      style={workflow?.playbackHidden ? { display: 'none' } : undefined}
    >
      {workflow?.videoWork ? (
        <div className="flex shrink-0 justify-end px-3 pt-2">
          <button
            type="button"
            className="rounded border border-cafe-subtle px-2 py-1 text-xs"
            aria-expanded={discussionOpen}
            onClick={() => setDiscussionOpen(!discussionOpen)}
          >
            一起讨论{view.review.annotations.length ? ` · ${view.review.annotations.length}` : ''}
          </button>
        </div>
      ) : null}
      {sourceState}
      {imageChatPrimary ? <ImageWorkProgress target={mediaChat.target} /> : null}
      {imageChatPrimary && draft.trim() ? (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-cafe-muted">
          <span className="whitespace-pre-wrap">未发送的批注：{draft}</span>
          <AddToChatButton chat={mediaChat} />
        </div>
      ) : null}
      {view.sourceState === 'current' ? (
        <WorkspaceContentReviewMedia
          seekRequest={workflow?.seekRequest}
          markRequest={workflow?.markRequest}
          selectionRequest={workflow?.selectionRequest}
          playbackHidden={workflow?.playbackHidden}
          onPlaybackTime={workflow?.onPlaybackTime}
          chapterNavigation={workflow?.chapterNavigation}
          draftKey={workflow?.canvasDraftKey}
          canMarkup={capabilities.markup.state === 'available'}
          key={`${view.review.reviewId}:${source.revision}`}
          originalUrl={originalMediaSrc}
          filename={path.split('/').at(-1) || path}
          mime={source.mime}
          byteLength={'byteLength' in source ? source.byteLength : undefined}
          reviewId={view.review.reviewId}
          sourceRevision={source.revision}
          src={workflow?.mediaSource ? workflow.mediaSource.src : reviewMediaDisplayPath(originalMediaSrc, source.mime)}
          download={{
            src: originalMediaSrc,
            filename: `作品.${source.mime === 'image/jpeg' ? 'jpg' : source.mime.split('/')[1]}`,
          }}
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
          chatPlaceEditor={
            mediaChat.editor
              ? {
                  anchor: mediaChat.editor.anchor,
                  cancel: mediaChat.editor.cancel,
                  content: <GalleryPlaceEditor key={mediaChat.editor.selectionId} editor={mediaChat.editor} />,
                }
              : undefined
          }
          imageChatPrimary={imageChatPrimary}
          wholeWorkAction={
            !comparing && !openingComparison ? (
              <WholeWorkChatButton
                chat={mediaChat}
                menuItem={isV2}
                label={
                  isV2 ? (source.media.kind === 'video' ? artworkCopy.wholeVideo : artworkCopy.wholeImage) : undefined
                }
              />
            ) : undefined
          }
          onOpenDiscussion={() => {
            setDiscussionOpen(true);
          }}
          onAnchorSelected={(anchor) => {
            setDiscussionOpen(false);
            mediaChat.clearNotice();
            if (imageChatPrimary && mediaChat.wholeWorkOffered) {
              if (!mediaChat.addSelection(anchor)) setTarget({ kind: 'media_anchor', anchor });
            } else setTarget({ kind: 'media_anchor', anchor });
          }}
          pendingChatMarks={mediaChat.marks}
          onAnnotationActive={openDiscussion}
          discussionFocusRequest={discussionFocusRequest}
          canvasFocusRequest={canvasFocusRequest}
          onSaveVisualMarks={(marks) => act({ kind: 'add_visual_marks', marks: [...marks] })}
          onDeleteVisualMark={(markId) => act({ kind: 'delete_visual_mark', markId })}
          modificationOpenRequest={modificationOpenRequest}
        />
      ) : null}
      {comparing ? (
        <div
          className={`${styles.comparingBar} sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-t border-cafe-subtle bg-cafe-surface px-3 text-xs`}
        >
          <span className="text-cafe-muted">对照新版</span>
          <button
            type="button"
            data-testid="workspace-return-to-artwork"
            onClick={() => setComparingAt(null)}
            className="rounded-md border border-cafe-subtle px-3 py-1.5 font-semibold text-cafe-accent"
          >
            回到作品画面
          </button>
        </div>
      ) : !imageChatPrimary && source.kind !== 'collective-media' ? (
        <p className="shrink-0 border-t border-cafe-subtle px-3 pt-2 text-xs text-cafe-muted">
          修改想法 · {target?.kind === 'media_anchor' ? '当前选区' : '整图'}
        </p>
      ) : null}
      {!comparing && !imageChatPrimary ? (
        <div className="flex shrink-0 justify-end px-3 py-2">
          <WholeWorkChatButton
            chat={mediaChat}
            label={isV2 ? (source.media.kind === 'video' ? artworkCopy.wholeVideo : artworkCopy.wholeImage) : undefined}
          />
        </div>
      ) : null}
      {imageChatPrimary || !mediaChat.offered ? <AddToChatNotice chat={mediaChat} /> : null}
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
          <div className={styles.drawerBody}>
            {workflow?.videoWork && !view.review.annotations.length ? (
              <p className="p-3 text-xs text-cafe-muted">没标的都算通过。</p>
            ) : null}
            {workflow?.responseDiscussion}
            {comments}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
