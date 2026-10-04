import type { WorkspaceContentAnnotationResolution } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { ReviewActor } from '@/components/content-review/ReviewActor';
import { useReviewDraft } from '@/components/content-review/useReviewDraft';
import type { ContentReviewAnnotation } from './content-review-contract';

export function WorkspaceContentReviewComments({
  reviewId,
  ownerUserId,
  annotations,
  resolutions,
  activeAnnotationId = null,
  focusRequest,
  canWrite,
  canReply = canWrite,
  onActive,
  onReturnToCanvas,
  onReply,
  onSetState,
}: {
  readonly reviewId: string;
  readonly ownerUserId: string;
  readonly annotations: readonly ContentReviewAnnotation[];
  readonly resolutions: readonly WorkspaceContentAnnotationResolution[];
  readonly activeAnnotationId?: string | null;
  readonly focusRequest?: { readonly annotationId: string; readonly requestId: number } | null;
  readonly canWrite: boolean;
  readonly canReply?: boolean;
  readonly onActive: (annotationId: string) => void;
  readonly onReturnToCanvas?: (annotationId: string) => void;
  readonly onReply: (annotationId: string, body: string) => Promise<boolean>;
  readonly onSetState: (annotationId: string, state: 'open' | 'resolved') => Promise<boolean>;
}) {
  const resolutionById = new Map(resolutions.map((item) => [item.annotationId, item.status]));
  if (!annotations.length)
    return <p className="text-xs leading-5 text-cafe-muted">在内容上点选位置或选中文字，然后写下第一条批注。</p>;
  return (
    <ol className="space-y-2" data-testid="workspace-content-review-comments">
      {annotations.map((annotation) => (
        <WorkspaceCommentThread
          key={annotation.id}
          annotation={annotation}
          ownerUserId={ownerUserId}
          status={resolutionById.get(annotation.id) ?? 'orphaned'}
          active={activeAnnotationId === annotation.id}
          focusRequest={focusRequest}
          canWrite={canWrite}
          canReply={canReply}
          draftKey={`workspace-content-review:${reviewId}:reply:${annotation.id}`}
          onActive={onActive}
          onReturnToCanvas={onReturnToCanvas}
          onReply={onReply}
          onSetState={onSetState}
        />
      ))}
    </ol>
  );
}

function WorkspaceCommentThread({
  annotation,
  ownerUserId,
  status,
  active,
  focusRequest,
  canWrite,
  canReply,
  draftKey,
  onActive,
  onReturnToCanvas,
  onReply,
  onSetState,
}: {
  readonly annotation: ContentReviewAnnotation;
  readonly ownerUserId: string;
  readonly status: WorkspaceContentAnnotationResolution['status'];
  readonly active: boolean;
  readonly focusRequest?: { readonly annotationId: string; readonly requestId: number } | null;
  readonly canWrite: boolean;
  readonly canReply: boolean;
  readonly draftKey: string;
  readonly onActive: (annotationId: string) => void;
  readonly onReturnToCanvas?: (annotationId: string) => void;
  readonly onReply: (annotationId: string, body: string) => Promise<boolean>;
  readonly onSetState: (annotationId: string, state: 'open' | 'resolved') => Promise<boolean>;
}) {
  const reply = useReviewDraft(draftKey);
  const article = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusRequest?.annotationId !== annotation.id) return;
    article.current?.scrollIntoView?.({ block: 'nearest' });
    article.current?.focus();
  }, [annotation.id, focusRequest]);
  const quote = anchorLabel(annotation.anchor);
  return (
    <li
      ref={article}
      tabIndex={-1}
      className={`rounded-lg border px-3 py-2 ${active ? 'border-cafe-accent bg-cafe-accent/5' : 'border-cafe-subtle bg-cafe-surface'}`}
      data-annotation-id={annotation.id}
      data-active={active}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onReturnToCanvas) {
          event.preventDefault();
          onReturnToCanvas(annotation.id);
          return;
        }
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onActive(annotation.id);
      }}
    >
      <div className="flex items-center justify-between gap-2 text-micro text-cafe-muted">
        <ReviewActor actor={annotation.author} ownerUserId={ownerUserId} />
        <button
          type="button"
          data-resolution={status}
          className="rounded px-1 text-left hover:bg-cafe-surface-sunken"
          onClick={() => onActive(annotation.id)}
        >
          {resolutionLabel(status)}
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-xs text-cafe">{annotation.body}</p>
      <p className="mt-1 truncate text-micro text-cafe-muted" title={quote}>
        {quote}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-micro text-cafe-muted">
        <span>{annotation.state === 'resolved' ? '已解决' : '待回应'}</span>
        {canWrite ? (
          <button
            type="button"
            className="rounded px-1 text-cafe-accent hover:bg-cafe-accent/10"
            onClick={() => void onSetState(annotation.id, annotation.state === 'open' ? 'resolved' : 'open')}
          >
            {annotation.state === 'open' ? '标为已解决' : '重新打开'}
          </button>
        ) : null}
      </div>
      {(annotation.replies ?? []).length ? (
        <ol className="mt-3 space-y-2 border-l-2 border-cafe-subtle pl-3">
          {(annotation.replies ?? []).map((item) => (
            <li key={item.id} className="text-xs text-cafe">
              <ReviewActor actor={item.author} ownerUserId={ownerUserId} />
              {item.body}
            </li>
          ))}
        </ol>
      ) : null}
      {canReply ? (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onReply(annotation.id, reply.draft.body);
          }}
        >
          <textarea
            aria-label={`回复批注 ${annotation.id}`}
            rows={1}
            maxLength={8000}
            placeholder="一起讨论…"
            value={reply.draft.body}
            onChange={(event) => reply.update({ anchor: null, body: event.target.value })}
            className="min-w-0 flex-1 resize-y rounded-lg border border-cafe-subtle bg-cafe-surface p-2 text-xs text-cafe"
          />
          <button
            type="submit"
            disabled={!reply.draft.body.trim()}
            className="rounded px-2 py-1.5 text-xs font-medium text-cafe-accent hover:bg-cafe-accent/10 disabled:opacity-40"
          >
            回复
          </button>
        </form>
      ) : null}
      {reply.storageError ? (
        <p role="alert" className="mt-2 text-xs text-cafe-error">
          草稿尚未保存到浏览器。
        </p>
      ) : null}
    </li>
  );
}

function anchorLabel(anchor: ContentReviewAnnotation['anchor']): string {
  if ('anchor' in anchor) {
    if (anchor.anchor.kind === 'image-point') return '画面中的位置';
    if (anchor.anchor.kind === 'image-region') return '圈选的区域';
    return anchor.anchor.framePoint || anchor.anchor.frameRegion ? '视频中的画面' : '视频片段';
  }
  return anchor.quote;
}

function resolutionLabel(status: WorkspaceContentAnnotationResolution['status']): string {
  if (status === 'attached') return '已定位';
  if (status === 'moved') return '已唯一重定位';
  if (status === 'ambiguous') return '位置有歧义';
  return '原位置不可用';
}
