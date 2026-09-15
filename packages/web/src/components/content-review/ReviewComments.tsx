'use client';
import type { ArtifactReviewAction, ArtifactReviewAnnotation, ArtifactReviewRound } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { ReviewActor } from './ReviewActor';
import { ReviewReply } from './ReviewReply';
import { anchorLabel } from './review-geometry';
import { useReviewDraft } from './useReviewDraft';

const smallButton =
  'rounded-md px-2 py-1.5 text-xs font-medium text-cafe-accent hover:bg-cafe-accent/10 disabled:opacity-40';
export function ReviewComments({
  round,
  ownerUserId,
  draftPrefix,
  activeId,
  canWrite,
  historical,
  saving,
  onActive,
  focusRequest,
  onReturnToCanvas,
  act,
  onReanchor,
}: {
  round: ArtifactReviewRound;
  ownerUserId: string;
  draftPrefix: string;
  activeId: string | null;
  canWrite: boolean;
  historical: boolean;
  saving: boolean;
  onActive: (id: string) => void;
  focusRequest?: { annotationId: string; requestId: number } | null;
  onReturnToCanvas?: ((annotationId: string) => void) | undefined;
  act: (action: ArtifactReviewAction, round: number) => Promise<boolean>;
  onReanchor?: ((annotation: ArtifactReviewAnnotation) => void) | undefined;
}) {
  return (
    <div className="space-y-3" data-testid="review-comments">
      {!round.annotations.length ? (
        <div className="rounded-xl border border-dashed border-cafe-subtle p-5 text-center text-sm leading-6 text-cafe-muted">
          圈出画面或选一段时间，写下第一条意见。
          <br />
          人和猫的讨论会一起留在这一版。
        </div>
      ) : null}
      {round.annotations.map((annotation, index) => (
        <CommentThread
          key={annotation.id}
          annotation={annotation}
          index={index}
          round={round}
          ownerUserId={ownerUserId}
          draftPrefix={draftPrefix}
          active={activeId === annotation.id}
          canWrite={canWrite}
          historical={historical}
          saving={saving}
          onActive={onActive}
          focusRequest={focusRequest}
          onReturnToCanvas={onReturnToCanvas}
          act={act}
          onReanchor={onReanchor}
        />
      ))}
    </div>
  );
}

function CommentThread({
  annotation,
  index,
  round,
  ownerUserId,
  draftPrefix,
  active,
  canWrite,
  historical,
  saving,
  onActive,
  focusRequest,
  onReturnToCanvas,
  act,
  onReanchor,
}: {
  annotation: ArtifactReviewAnnotation;
  index: number;
  round: ArtifactReviewRound;
  ownerUserId: string;
  draftPrefix: string;
  active: boolean;
  canWrite: boolean;
  historical: boolean;
  saving: boolean;
  onActive: (id: string) => void;
  focusRequest?: { annotationId: string; requestId: number } | null;
  onReturnToCanvas?: ((annotationId: string) => void) | undefined;
  act: (action: ArtifactReviewAction, round: number) => Promise<boolean>;
  onReanchor?: ((annotation: ArtifactReviewAnnotation) => void) | undefined;
}) {
  const reply = useReviewDraft(`${draftPrefix}reply:${annotation.id}`);
  const edit = useReviewDraft(`${draftPrefix}edit:${annotation.id}`);
  const [editing, setEditing] = useState(false);
  const article = useRef<HTMLElement | null>(null);
  const own = annotation.author.kind === 'human' && annotation.author.actorId === ownerUserId;
  useEffect(() => {
    if (focusRequest?.annotationId !== annotation.id) return;
    article.current?.scrollIntoView?.({ block: 'nearest' });
    article.current?.focus();
  }, [annotation.id, focusRequest]);
  return (
    <article
      ref={article}
      tabIndex={-1}
      className={`scroll-mt-3 rounded-xl border p-3 ${active ? 'border-cafe-accent bg-cafe-accent/5' : 'border-cafe-subtle bg-cafe-surface'}`}
      data-testid="review-comment"
      data-annotation-id={annotation.id}
      data-state={annotation.state}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !onReturnToCanvas) return;
        event.preventDefault();
        onReturnToCanvas(annotation.id);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ReviewActor actor={annotation.author} ownerUserId={ownerUserId} />
        <button type="button" className={smallButton} onClick={() => onActive(annotation.id)} aria-pressed={active}>
          #{index + 1} · {anchorLabel(annotation.anchor, round.asset.media)}
        </button>
      </div>
      {editing ? (
        <form
          className="mt-3 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void act({ kind: 'edit', annotationId: annotation.id, body: edit.draft.body }, round.number).then((ok) => {
              if (ok) {
                setEditing(false);
                edit.clear();
              }
            });
          }}
        >
          <textarea
            aria-label={`修改标注 ${index + 1}`}
            disabled={saving}
            maxLength={8000}
            value={edit.draft.body}
            onChange={(event) => edit.update({ ...edit.draft, body: event.target.value })}
            className="min-h-20 rounded-lg border border-cafe-subtle bg-cafe-surface p-2 text-sm text-cafe-black"
          />
          <div>
            <button type="submit" disabled={saving || !edit.draft.body.trim()} className={smallButton}>
              保存修改
            </button>
            <button type="button" className={smallButton} onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-cafe-black">{annotation.body}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-micro text-cafe-muted">
        <time dateTime={annotation.updatedAt}>{new Date(annotation.updatedAt).toLocaleString()}</time>
        <span>· {annotation.state === 'resolved' ? '已解决' : '待回应'}</span>
        {annotation.reanchoredFrom ? <span>· 从第 {annotation.reanchoredFrom.round} 版重新圈选</span> : null}
        {canWrite && !historical && round.state !== 'approved' ? (
          <>
            {own ? (
              <button
                type="button"
                className={smallButton}
                onClick={() => {
                  edit.initialize({ anchor: null, body: annotation.body });
                  setEditing(true);
                }}
              >
                修改
              </button>
            ) : null}
            <button
              type="button"
              disabled={saving}
              className={smallButton}
              onClick={() =>
                void act(
                  {
                    kind: 'set_annotation_state',
                    annotationId: annotation.id,
                    state: annotation.state === 'open' ? 'resolved' : 'open',
                  },
                  round.number,
                )
              }
            >
              {annotation.state === 'open' ? '标为已解决' : '重新打开'}
            </button>
          </>
        ) : null}
        {onReanchor ? (
          <button type="button" className={smallButton} onClick={() => onReanchor(annotation)}>
            在新版重新圈选
          </button>
        ) : null}
      </div>
      {annotation.replies.length ? (
        <ol className="mt-3 space-y-3 border-l-2 border-cafe-subtle pl-3">
          {annotation.replies.map((item) => (
            <ReviewReply
              key={item.id}
              reply={item}
              ownerUserId={ownerUserId}
              canEdit={canWrite && !historical && round.state !== 'approved'}
              saving={saving}
              draftKey={`${draftPrefix}edit:${annotation.id}:${item.id}`}
              onSave={(body) =>
                act({ kind: 'edit', annotationId: annotation.id, replyId: item.id, body }, round.number)
              }
            />
          ))}
        </ol>
      ) : null}
      {canWrite ? (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              { kind: 'reply', annotationId: annotation.id, replyId: crypto.randomUUID(), body: reply.draft.body },
              round.number,
            ).then((ok) => {
              if (ok) reply.clear();
            });
          }}
        >
          <textarea
            aria-label={`回复标注 ${index + 1}`}
            disabled={saving}
            placeholder="一起讨论…"
            maxLength={8000}
            rows={1}
            value={reply.draft.body}
            onChange={(event) => reply.update({ ...reply.draft, body: event.target.value })}
            className="min-w-0 flex-1 resize-y rounded-lg border border-cafe-subtle bg-cafe-surface p-2 text-xs text-cafe-black"
          />
          <button type="submit" disabled={saving || !reply.draft.body.trim()} className={smallButton}>
            回复
          </button>
        </form>
      ) : null}
      {reply.storageError || edit.storageError ? (
        <p role="alert" className="mt-2 text-xs text-cafe-error">
          草稿尚未保存到浏览器，请保留当前页面。
        </p>
      ) : null}
    </article>
  );
}
