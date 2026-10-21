'use client';

import type { CollectiveMediaSurfaceRefV1 } from '@cat-cafe/shared';
import { ContentReviewSurface } from '@/components/workbench/content-review/ContentReviewSurface';
import type { ContentLandingCapabilities } from '@/components/workbench/content-review/content-review-contract';
import { WorkspaceContentReviewComments } from '@/components/workbench/content-review/WorkspaceContentReviewComments';
import { API_URL } from '@/utils/api-client';
import { CollectiveMediaEdit } from './CollectiveMediaEdit';
import { useCollectiveMediaReview } from './use-collective-media-review';
import type { CollectiveMediaRpc } from './use-collective-media-rpc';

export function CollectiveMediaSurface({
  reference,
  rpc,
  onBack,
}: {
  readonly reference: CollectiveMediaSurfaceRefV1;
  readonly rpc: CollectiveMediaRpc;
  readonly onBack: () => void;
}) {
  const { controller, value, key, act, more } = useCollectiveMediaReview(reference, rpc);
  const unavailable = { state: 'unavailable' as const, reason: '此处仅查看与讨论共同作品。' };
  const capabilities: ContentLandingCapabilities = {
    annotate: value?.view.canWrite ? { state: 'available' } : { state: 'read_only', reason: '当前版本只读。' },
    reply: value?.view.canReply ? { state: 'available' } : unavailable,
    markup: unavailable,
    requestModification: { ...unavailable, medium: value?.media.kind ?? 'image' },
    versions: unavailable,
    decide: unavailable,
    historyReadOnly: value?.view.historyReadOnly ?? true,
  };
  const url = `${API_URL}/api/plugins/official.collective-connector/connections/${encodeURIComponent(reference.connectionId)}/artifacts/${encodeURIComponent(reference.artifactId)}/media/${reference.ownerRevision}?sourceEventId=${encodeURIComponent(reference.sourceEventId)}`;
  return (
    <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-cafe-surface" data-testid="collective-media-surface">
      <ContentReviewSurface
        review={controller}
        path="共同作品"
        title={`${value?.title ?? '共同作品'} · 第 ${reference.ownerRevision} 版`}
        sourceText=""
        sourceTextRevision={value?.view.currentSource.revision ?? ''}
        onBack={onBack}
        leadingAction={
          <button type="button" className="px-2 text-xs text-cafe-accent" onClick={onBack}>
            返回原讨论
          </button>
        }
        capabilities={capabilities}
        workflow={{
          chatMedia: null,
          modification: null,
          canvasDraftKey: `${key}:canvas`,
          mediaSource: { src: value ? url : null, error: controller.error },
          status: value?.view.historyReadOnly ? (
            <p className="px-3 py-2 text-xs text-cafe-muted">历史版本 · 可查看与继续原讨论，新批注请回最新版。</p>
          ) : undefined,
          discussion: (controls) =>
            value && (
              <>
                <WorkspaceContentReviewComments
                  reviewId={value.view.review.reviewId}
                  draftPrefix={key}
                  renderActor={(actor) => (
                    <span data-collective-human={actor.actorId}>
                      {actor.actorId === reference.humanId ? '我' : (value.actors?.[actor.actorId] ?? '共同体成员')}
                    </span>
                  )}
                  annotations={value.view.review.annotations}
                  renderAnnotationActions={(annotation) => (
                    <>
                      {value.view.canWrite &&
                      annotation.author.kind === 'human' &&
                      annotation.author.actorId === reference.humanId ? (
                        <CollectiveMediaEdit
                          draftKey={`${key}:edit:${annotation.id}`}
                          body={annotation.body}
                          busy={controller.busy}
                          onSave={(body) => act({ kind: 'edit_annotation', annotationId: annotation.id, body })}
                        />
                      ) : null}
                      {value.view.replyPages.find((page) => page.annotationId === annotation.id)?.nextOffset !==
                        undefined && (
                        <button
                          type="button"
                          disabled={controller.busy}
                          className="ml-3 text-xs text-cafe-accent"
                          onClick={() => void more(annotation.id)}
                        >
                          {annotation.replies?.length ? '更多回复' : '查看回复'}
                        </button>
                      )}
                    </>
                  )}
                  renderReplyActions={(annotation, reply) =>
                    value.view.canWrite &&
                    reply.author.kind === 'human' &&
                    reply.author.actorId === reference.humanId ? (
                      <CollectiveMediaEdit
                        reply
                        draftKey={`${key}:edit:${annotation.id}:${reply.id}`}
                        body={reply.body}
                        busy={controller.busy}
                        onSave={(body) =>
                          act({ kind: 'edit_reply', annotationId: annotation.id, replyId: reply.id, body })
                        }
                      />
                    ) : null
                  }
                  resolutions={value.view.annotationResolutions}
                  {...controls}
                  canWrite={value.view.canWrite && !controller.busy}
                  canReply={value.view.canReply && !controller.busy}
                  onReply={(annotationId, body) => act({ kind: 'reply', annotationId, body })}
                  onSetState={(annotationId, state) => act({ kind: 'set_annotation_state', annotationId, state })}
                />
                {value.view.annotationPage.nextOffset !== undefined && (
                  <button
                    type="button"
                    disabled={controller.busy}
                    className="mt-3 text-xs text-cafe-accent"
                    onClick={() => void more()}
                  >
                    更多批注
                  </button>
                )}
              </>
            ),
          panel: (
            <button
              type="button"
              disabled={controller.busy}
              className="shrink-0 px-3 py-2 text-left text-xs text-cafe-accent"
              onClick={() => void controller.refreshSource()}
            >
              重新读取作品与讨论
            </button>
          ),
        }}
      />
    </div>
  );
}
