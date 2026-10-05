'use client';
import type { ContentSourceDiscussion, WorkspaceContentAnchor, WorkspaceContentSource } from '@cat-cafe/shared';
import { createEvolutionMediaSurface } from '@/components/workbench/evolution-media-surface';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { useChatStore } from '@/stores/chatStore';
import { ReviewActor } from './ReviewActor';
import { anchorLabel } from './review-geometry';

/** Immutable lineage evidence; its old coordinates never become editable marks on the returned work. */
export function ContentSourceDiscussions({ discussions }: { discussions: ContentSourceDiscussion[] }) {
  return (
    <section className="mb-3 space-y-2 text-sm" aria-label="原件讨论" data-testid="content-source-discussions">
      {discussions.map(({ title, review }) => (
        <details key={`${review.reviewId}:${review.revision}`} className="rounded border border-cafe-subtle p-2">
          <summary className="cursor-pointer">提交时的原件讨论 · {title}</summary>
          <p className="my-2 text-xs text-cafe-muted">保留原意见与原位置，只读。后续讨论请在原件中查看。</p>
          {review.source.kind !== 'publication' ? (
            <button type="button" className="mb-2 text-xs underline" onClick={() => openOriginal(review.source, title)}>
              {review.source.kind === 'evolution' ? '打开实验原件' : '打开当前原文件'}
            </button>
          ) : null}
          {!review.annotations.length && !review.visualMarks?.length ? (
            <p className="text-cafe-muted">提交时没有原件批注。</p>
          ) : null}
          <ol className="space-y-3">
            {review.annotations.map((annotation) => (
              <li key={annotation.id} className="border-l border-cafe-subtle pl-2">
                <ReviewActor actor={annotation.author} ownerUserId={review.ownerUserId} />
                <p className="mt-1 whitespace-pre-wrap break-words">{annotation.body}</p>
                <p className="text-xs text-cafe-muted">
                  原件位置：{originalPosition(annotation.anchor, review.source)} ·{' '}
                  {annotation.state === 'resolved' ? '已解决' : '讨论中'}
                </p>
                <time dateTime={annotation.createdAt} className="text-xs text-cafe-muted">
                  {new Date(annotation.createdAt).toLocaleString()}
                </time>
                {annotation.replies?.map((reply) => (
                  <div key={reply.id} className="ml-3 mt-2 border-l border-cafe-subtle pl-2">
                    <ReviewActor actor={reply.author} ownerUserId={review.ownerUserId} />
                    <p className="whitespace-pre-wrap break-words">{reply.body}</p>
                    <time dateTime={reply.createdAt} className="text-xs text-cafe-muted">
                      {new Date(reply.createdAt).toLocaleString()}
                    </time>
                  </div>
                ))}
              </li>
            ))}
          </ol>
          {review.visualMarks?.length ? (
            <div className="mt-2 space-y-1 text-xs text-cafe-muted">
              <p>原件留有 {review.visualMarks.length} 条圈画记录；位置记录见来源详情。</p>
              {review.visualMarks.map((mark) => (
                <div key={mark.drawing.id}>
                  <ReviewActor actor={mark.author} ownerUserId={review.ownerUserId} />
                  <span>
                    {' '}
                    · {markNames[mark.drawing.kind]} · {mark.state === 'deleted' ? '已删除的历史记录' : '保留'}{' '}
                  </span>
                  <time dateTime={mark.createdAt}>{new Date(mark.createdAt).toLocaleString()}</time>
                  {mark.drawing.kind === 'text' ? (
                    <p className="whitespace-pre-wrap break-words">{mark.drawing.text}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <details className="mt-2 text-xs text-cafe-muted" data-testid="content-source-discussion-provenance">
            <summary>来源详情</summary>
            <p className="break-all">
              {review.reviewId} · 讨论版本 {review.revision}
            </p>
            <p className="break-all">原件版本：{review.source.revision}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(
                {
                  source: review.source,
                  annotations: review.annotations.map(({ id, anchor, imageEdit }) => ({ id, anchor, imageEdit })),
                  visualMarks: review.visualMarks ?? [],
                },
                null,
                2,
              )}
            </pre>
          </details>
        </details>
      ))}
    </section>
  );
}

const markNames = { stroke: '画笔', rectangle: '矩形', ellipse: '椭圆', arrow: '箭头', text: '文字标记' } as const;

function originalPosition(anchor: WorkspaceContentAnchor, source: WorkspaceContentSource): string {
  if ('kind' in anchor) return `“${anchor.quote}”`;
  return source.kind === 'text' ? '原媒体位置' : anchorLabel(anchor.anchor, source.media);
}

function openOriginal(source: WorkspaceContentSource, title: string) {
  const chat = useChatStore.getState();
  chat.setWorkspaceMode('dev');
  if (source.kind === 'evolution') {
    const workspace = useF307ExperienceWorkbenchStore.getState();
    workspace.exitMainAreaAttention();
    workspace.dispatch({
      type: 'open-surface',
      surface: createEvolutionMediaSurface(source.locator, title),
      entitlement: { kind: 'user', reason: 'open-from-chat' },
    });
  } else if (source.kind === 'text' || source.kind === 'media')
    chat.setWorkspaceOpenFile(source.locator.path, null, source.locator.worktreeId);
}
