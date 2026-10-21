'use client';
import type { ArtifactReviewAnnotation, ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ContentReviewSurface } from '@/components/workbench/content-review/ContentReviewSurface';
import type { ContentReviewController } from '@/components/workbench/content-review/content-review-contract';
import type { useWorkspaceContentReview } from '@/components/workbench/content-review/useWorkspaceContentReview';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { ArtifactModificationEntry } from './ArtifactModificationEntry';
import { artifactRoundChatTarget } from './artifact-modification-source';
import { artifactLandingCapabilities, artifactReviewProjection } from './artifact-review-adapter';
import { artworkActionsCopy } from './artwork-actions.shell-copy';
import { artworkTitle } from './artwork-title';
import { ArtifactMediaCompare } from './media-compare/ArtifactMediaCompare';
import { reviewAuthorityMessages } from './media-compare/review-authority-messages';
import { ReviewComments } from './ReviewComments';
import { ReviewDiscussionPanel } from './ReviewDiscussionPanel';
import { ReviewResponseJudgments } from './ReviewResponseJudgments';
import { ReviewRoundDecision } from './ReviewRoundDecision';
import { ReviewVersionDetails } from './ReviewVersionDetails';
import { useArtifactChatDiscussion } from './useArtifactChatDiscussion';
import type { useArtifactReview } from './useArtifactReview';
import { useArtifactRoundComparison } from './useArtifactRoundComparison';
import { useReviewDraft } from './useReviewDraft';
import { useReviewMediaSource } from './useReviewMediaSource';
import { WorkSubmissionRecovery } from './WorkSubmissionRecovery';

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
  leadingAction?: ReactNode;
  titleInHost?: boolean;
  title?: string;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  fullWindowAction?: { active: boolean; onToggle: () => void };
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
  leadingAction,
  titleInHost = false,
  title,
  navigationOrigin,
  fullWindowAction,
  linked,
}: ArtifactRoundProps & { linked?: ReturnType<typeof useWorkspaceContentReview> }) {
  const draft = useReviewDraft(`${prefix}round:${round.number}:annotation`);
  const isV2 = useShellPresentation() === 'v2';
  const artworkCopy = useShellCopy(artworkActionsCopy);
  const workTitle = isV2
    ? artworkTitle(title ?? view.review.title, round.asset.media.kind === 'image' ? '图片' : '作品')
    : view.review.title;
  const discussion = useArtifactChatDiscussion(view, round, workTitle);
  const source = useReviewMediaSource(
    view.review.reviewId,
    round.number,
    controller.revokeAccess,
    round.asset.mediaType,
  );
  const [active, setActive] = useState<string | null>(null);
  const [panel, setPanel] = useState<'decision' | 'details' | null>(null);
  const originalSurface = useRef<HTMLDivElement>(null);
  // Opening the comparison, by hand or because a receipt asked, puts the round's own panel and any video aside.
  const stepAside = useCallback(() => {
    originalSurface.current?.querySelectorAll('video').forEach((video) => {
      video.pause();
    });
    setPanel(null);
  }, []);
  const comparison = useArtifactRoundComparison(view, round, stepAside);
  const comparing = comparison.comparing;
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
          title={workTitle}
          navigationOrigin={navigationOrigin}
          fullWindowAction={fullWindowAction}
          titleInHost={titleInHost}
          leadingAction={comparing ? undefined : leadingAction}
          sourceText=""
          sourceTextRevision=""
          onBack={onBack}
          capabilities={capabilities}
          versionControl={
            <>
              {!isV2 && view.review.rounds.some((item) => item.number < round.number) ? (
                <button
                  type="button"
                  aria-label="对比版本"
                  className="shrink-0 text-xs text-cafe-accent"
                  onClick={comparison.open}
                >
                  对比
                </button>
              ) : null}
              <select
                aria-label={isV2 ? artworkCopy.versionLabel : '审阅版本'}
                value={round.number}
                onChange={(event) => {
                  if (event.target.value === 'details') setPanel(panel === 'details' ? null : 'details');
                  else if (event.target.value === 'compare') comparison.open();
                  else onVersion(Number(event.target.value));
                }}
                className="max-w-28 rounded bg-transparent text-xs"
              >
                {view.review.rounds.map((item) => (
                  <option key={item.number} value={item.number}>
                    {artworkCopy.versionNumber(item.number)} ·{' '}
                    {item.number === view.review.rounds.at(-1)?.number
                      ? artworkCopy.current
                      : artworkCopy.historyVersion}
                  </option>
                ))}
                {isV2 && view.review.rounds.some((item) => item.number < round.number) ? (
                  <option value="compare">{artworkCopy.compare}</option>
                ) : null}
                {isV2 ? <option value="details">{artworkCopy.details}</option> : null}
              </select>
              {!isV2 ? (
                <button
                  type="button"
                  aria-label="完成审阅"
                  onClick={() => setPanel(panel === 'decision' ? null : 'decision')}
                  className="shrink-0 text-xs text-cafe-accent"
                >
                  审阅
                </button>
              ) : null}
              {!isV2 ? (
                <button
                  type="button"
                  aria-label="审阅详情"
                  onClick={() => setPanel(panel === 'details' ? null : 'details')}
                  className="shrink-0 text-xs text-cafe-muted"
                >
                  详情
                </button>
              ) : null}
              {!isV2 ? (
                <button
                  type="button"
                  aria-label="刷新"
                  onClick={() => void controller.refresh()}
                  className="shrink-0 text-xs text-cafe-muted"
                >
                  刷新
                </button>
              ) : null}
            </>
          }
          workflow={{
            mediaSource: source,
            canvasDraftKey: linked ? undefined : `${prefix}round:${round.number}:markup`,
            annotationMaxLength: 8000,
            // 「引用到聊天」 names the same round (or ledger) and Task a modification request does.
            chatMedia: artifactRoundChatTarget(view, round, workTitle),
            modification: (
              <ArtifactModificationEntry
                view={view}
                round={round}
                draft={selectedDraft}
                disabled={!projection.canWrite || !canWrite}
                allowNewRequest={!isV2 && round.asset.media.kind !== 'image'}
                onRegionHandedOff={() => effective.setTarget(null)}
              />
            ),
            status: (
              <div className="space-y-1 px-3 text-xs text-cafe-muted">
                {!isV2 ? contextControl : null}
                {view.authority.state !== 'current' ? (
                  <p role="status">{reviewAuthorityMessages[view.authority.state]}</p>
                ) : null}
                {view.pendingVersion ? <p role="status">新版正在保存和恢复，旧版讨论仍然完整保留。</p> : null}
                {view.pendingSubmission ? (
                  <WorkSubmissionRecovery
                    key={view.pendingSubmission.operationId}
                    view={view}
                    onRecovered={controller.refresh}
                  />
                ) : null}
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
                        ? '意见已交还负责的猫。'
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
                  title={workTitle}
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
                  contextControl={isV2 ? contextControl : undefined}
                  responseControl={
                    round.responses.length ? (
                      <ReviewResponseJudgments
                        review={view.review}
                        round={round}
                        canJudge={
                          !controller.saving &&
                          !controller.pending &&
                          !view.pendingVersion &&
                          (view.authority.state === 'current' || view.authority.state === 'asset_changed')
                        }
                        onJudge={async (action, number) => {
                          const saved = await controller.act(action, number);
                          if (saved) await linked?.refreshSource();
                          return saved;
                        }}
                        onSource={onVersion}
                      />
                    ) : null
                  }
                  reviewId={view.review.reviewId}
                  revision={view.review.revision}
                  ownerUserId={view.review.task.ownerUserId}
                  onClose={() => setPanel(null)}
                />
              ) : null,
          }}
        />
        {isV2 ? (
          <div className="shrink-0 border-t border-cafe-subtle px-3 py-2">
            <ReviewRoundDecision
              round={round}
              ownerUserId={view.review.task.ownerUserId}
              canWrite={canWrite && !history}
              saving={controller.saving}
              draftKey={`${prefix}round:${round.number}:decision`}
              act={controller.act}
              onDiscuss={discussion.discuss}
              compact
            />
            {discussion.notice ? (
              <p role="status" className="text-xs">
                {discussion.notice}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {comparing ? (
        <ArtifactMediaCompare
          view={view}
          round={round}
          controller={controller}
          recovery={effective}
          prefix={prefix}
          canWrite={canWrite && !history}
          onClose={comparison.close}
          onBack={onBack}
          leadingAction={leadingAction}
          titleInHost={titleInHost}
          fullWindowAction={fullWindowAction}
          title={title}
        />
      ) : null}
    </section>
  );
}
