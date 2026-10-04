'use client';
import type { ArtifactReviewAnnotation, ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { type ReactNode, useRef, useState } from 'react';
import { ContentReviewSurface } from '@/components/workbench/content-review/ContentReviewSurface';
import type { ContentReviewController } from '@/components/workbench/content-review/content-review-contract';
import type { useWorkspaceContentReview } from '@/components/workbench/content-review/useWorkspaceContentReview';
import { ArtifactModificationEntry } from './ArtifactModificationEntry';
import { artifactLandingCapabilities, artifactReviewProjection } from './artifact-review-adapter';
import { ArtifactMediaCompare } from './media-compare/ArtifactMediaCompare';
import { reviewAuthorityMessages } from './media-compare/review-authority-messages';
import { ReviewComments } from './ReviewComments';
import { ReviewDiscussionPanel } from './ReviewDiscussionPanel';
import { ReviewVersionDetails } from './ReviewVersionDetails';
import type { useArtifactReview } from './useArtifactReview';
import { useReviewDraft } from './useReviewDraft';
import { useReviewMediaSource } from './useReviewMediaSource';

export type ArtifactRoundProps = {
  view: ArtifactReviewView;
  round: ArtifactReviewRound;
  controller: ReturnType<typeof useArtifactReview>;
  onBack: () => void;
  prefix: string;
  notice: string | null;
  onReanchor?: ((annotation: ArtifactReviewAnnotation) => void) | undefined;
  onVersion: (number: number) => void;
  contextControl?: ReactNode;
};
export function ArtifactRoundLanding({
  view,
  round,
  controller,
  onBack,
  prefix,
  notice,
  onReanchor,
  onVersion,
  contextControl,
  linked,
}: ArtifactRoundProps & { linked?: ReturnType<typeof useWorkspaceContentReview> }) {
  const draft = useReviewDraft(`${prefix}round:${round.number}:annotation`);
  const source = useReviewMediaSource(view.review.reviewId, round.number, controller.revokeAccess);
  const [active, setActive] = useState<string | null>(null);
  const [panel, setPanel] = useState<'decision' | 'details' | null>(null);
  const [comparing, setComparing] = useState(false);
  const originalSurface = useRef<HTMLDivElement>(null);
  const projection = artifactReviewProjection(view, round);
  const capabilities = artifactLandingCapabilities(view, round);
  const history = capabilities.historyReadOnly;
  const canWrite = view.authority.canWrite && !controller.pending && !linked?.pending;
  const adapter: ContentReviewController = {
    view: linked
      ? linked.view
      : {
          ...projection,
          canWrite: projection.canWrite,
          canReply: projection.canReply && !controller.pending,
        },
    error: linked?.error ?? controller.error,
    draft: draft.draft.body,
    target: draft.draft.anchor ? { kind: 'media_anchor', anchor: draft.draft.anchor } : null,
    activeAnnotationId: active,
    busy: controller.saving || Boolean(linked?.busy),
    pending: Boolean(controller.pending) || Boolean(linked?.pending),
    setDraft: (body) => draft.update({ ...draft.draft, body }),
    setTarget: (target) => {
      if (target?.kind === 'text_quote') return;
      draft.update({ ...draft.draft, anchor: target?.anchor ?? null });
    },
    setActiveAnnotationId: setActive,
    refreshSource: controller.refresh,
    retryPending: async () => {
      if (controller.pending) await controller.retry();
      else await linked?.retryPending();
    },
    submitAnnotation: async () => {
      if (!projection.canWrite || !draft.draft.anchor) return;
      await controller.act(
        {
          kind: 'annotate',
          annotationId: crypto.randomUUID(),
          anchor: draft.draft.anchor,
          body: draft.draft.body,
          ...(draft.draft.reanchoredFrom ? { reanchoredFrom: draft.draft.reanchoredFrom } : {}),
        },
        round.number,
      );
    },
    act: (action) => controller.act(action, round.number),
  };
  const useOriginalReanchor = Boolean(draft.draft.reanchoredFrom || controller.pending?.action.kind === 'annotate');
  const effective: ContentReviewController =
    linked && !useOriginalReanchor
      ? {
          ...linked,
          view: linked.view
            ? {
                ...linked.view,
                canWrite: linked.view.canWrite && projection.canWrite,
                canReply: (linked.view.canReply ?? linked.view.canWrite) && view.authority.canWrite,
              }
            : null,
          error: linked.error ?? controller.error,
          busy: linked.busy || controller.saving,
          pending: linked.pending || Boolean(controller.pending),
          retryPending: async () => {
            if (controller.pending) await controller.retry();
            else await linked.retryPending();
          },
        }
      : adapter;
  const selectedDraft = {
    body: effective.draft,
    anchor: effective.target?.kind === 'media_anchor' ? effective.target.anchor : null,
  };
  const actOnDiscussion: typeof controller.act = async (action, number) => {
    if (linked && (action.kind === 'reply' || action.kind === 'set_annotation_state')) return linked.act(action);
    const ok = await controller.act(action, number);
    if (ok && linked) await linked.refreshSource();
    return ok;
  };
  const delivery = view.continuation.returnDelivery;
  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="artifact-review-surface">
      <div ref={originalSurface} hidden={comparing} className={comparing ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <ContentReviewSurface
          review={effective}
          path={view.review.title}
          title={view.review.title}
          sourceText=""
          sourceTextRevision=""
          onBack={onBack}
          capabilities={capabilities}
          versionControl={
            <>
              {view.review.rounds.some((item) => item.number < round.number) ? (
                <button
                  type="button"
                  aria-label="对比版本"
                  className="shrink-0 text-xs text-cafe-accent"
                  onClick={() => {
                    originalSurface.current?.querySelectorAll('video').forEach((video) => {
                      video.pause();
                    });
                    setPanel(null);
                    setComparing(true);
                  }}
                >
                  对比
                </button>
              ) : null}
              <select
                aria-label="审阅版本"
                value={round.number}
                onChange={(event) => onVersion(Number(event.target.value))}
                className="max-w-28 rounded bg-transparent text-xs"
              >
                {view.review.rounds.map((item) => (
                  <option key={item.number} value={item.number}>
                    第 {item.number} 版{item.number === view.review.rounds.at(-1)?.number ? ' · 当前' : ' · 历史'}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="完成审阅"
                onClick={() => setPanel(panel === 'decision' ? null : 'decision')}
                className="shrink-0 text-xs text-cafe-accent"
              >
                审阅
              </button>
              <button
                type="button"
                aria-label="审阅详情"
                onClick={() => setPanel(panel === 'details' ? null : 'details')}
                className="shrink-0 text-xs text-cafe-muted"
              >
                详情
              </button>
              <button
                type="button"
                aria-label="刷新"
                onClick={() => void controller.refresh()}
                className="shrink-0 text-xs text-cafe-muted"
              >
                刷新
              </button>
            </>
          }
          workflow={{
            mediaSource: source,
            canvasDraftKey: linked ? undefined : `${prefix}round:${round.number}:markup`,
            annotationMaxLength: 8000,
            modification: (
              <ArtifactModificationEntry
                view={view}
                round={round}
                draft={selectedDraft}
                disabled={!projection.canWrite || !canWrite}
                onRegionHandedOff={() => effective.setTarget(null)}
              />
            ),
            status: (
              <div className="space-y-1 px-3 text-xs text-cafe-muted">
                {contextControl}
                {view.authority.state !== 'current' ? (
                  <p role="status">{reviewAuthorityMessages[view.authority.state]}</p>
                ) : null}
                {view.pendingVersion ? <p role="status">新版正在保存和恢复，旧版讨论仍然完整保留。</p> : null}
                {history ? (
                  <p>
                    第 {round.number} 版 ·{' '}
                    {capabilities.reply.state === 'available' ? '可继续讨论，画面不可改。' : '历史只读。'}
                    <button
                      type="button"
                      className="ml-2 text-cafe-accent"
                      onClick={() => onVersion(view.review.rounds.at(-1)!.number)}
                    >
                      查看最新版本
                    </button>
                  </p>
                ) : null}
                {delivery ? (
                  <p role="status" data-testid="review-return-state">
                    {delivery.state === 'pending'
                      ? '意见已保存，投递尚未完成；关闭页面后仍会继续。'
                      : delivery.state === 'queued'
                        ? '意见已交还原任务队列。'
                        : '原任务或版本已变化，旧回流已撤回，历史结论保留。'}
                  </p>
                ) : null}
                {notice ? <p role="status">{notice}</p> : null}
                {draft.storageError ? <p role="alert">草稿尚未保存到浏览器，请保留页面。</p> : null}
              </div>
            ),
            discussion: (controls) => (
              <ReviewComments
                round={round}
                ownerUserId={view.review.task.ownerUserId}
                draftPrefix={
                  linked ? `workspace-content-review:${round.ledgerRef}:` : `${prefix}round:${round.number}:`
                }
                activeId={controls.activeAnnotationId}
                focusRequest={controls.focusRequest}
                onActive={controls.onActive}
                onReturnToCanvas={controls.onReturnToCanvas}
                canWrite={canWrite}
                historical={history}
                saving={controller.saving}
                act={actOnDiscussion}
                onReanchor={onReanchor}
              />
            ),
            panel:
              panel === 'decision' ? (
                <ReviewDiscussionPanel
                  panel="decision"
                  round={round}
                  view={view}
                  prefix={prefix}
                  canWrite={canWrite}
                  historical={history}
                  controller={controller}
                  activeId={active}
                  focusRequest={null}
                  onActive={setActive}
                  onReturnToCanvas={() => setPanel(null)}
                  onClose={() => setPanel(null)}
                />
              ) : panel === 'details' ? (
                <ReviewVersionDetails
                  round={round}
                  reviewId={view.review.reviewId}
                  revision={view.review.revision}
                  ownerUserId={view.review.task.ownerUserId}
                  onClose={() => setPanel(null)}
                  onPreviousRound={() => {
                    onVersion(round.number - 1);
                  }}
                />
              ) : null,
          }}
        />
      </div>
      {comparing ? (
        <ArtifactMediaCompare
          view={view}
          round={round}
          controller={controller}
          recovery={effective}
          prefix={prefix}
          canWrite={canWrite && !history}
          onClose={() => setComparing(false)}
          onBack={onBack}
        />
      ) : null}
    </section>
  );
}
