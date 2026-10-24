'use client';
import type { ArtifactReviewAnnotation, ArtifactReviewView, PublicationReviewContext } from '@cat-cafe/shared';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { ContentLandingHeader } from '@/components/workbench/content-review/ContentLandingHeader';
import { useWorkspaceContentReview } from '@/components/workbench/content-review/useWorkspaceContentReview';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { ArtifactRoundLanding, type ArtifactRoundProps } from './ArtifactRoundLanding';
import { artworkTitle } from './artwork-title';
import { ReviewContextSelector } from './ReviewContextSelector';
import { startArtifactReanchor } from './startArtifactReanchor';
import { reviewDraftPrefix, useArtifactReview } from './useArtifactReview';

export function ArtifactReviewSurface({
  reviewId,
  onBack,
  initialRound,
  onVersionChange,
  onContextChange,
  leadingAction,
  titleInHost = false,
  title,
  navigationOrigin,
  fullWindowAction,
}: {
  reviewId: string;
  onBack: () => void;
  initialRound?: number;
  onVersionChange?: (round: number) => void;
  onContextChange?: (context: PublicationReviewContext) => void;
  leadingAction?: ReactNode;
  titleInHost?: boolean;
  title?: string;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  fullWindowAction?: { active: boolean; onToggle: () => void };
}) {
  const controller = useArtifactReview(reviewId);
  if (!controller.view)
    return (
      <section
        className="p-4"
        data-testid="artifact-review-surface"
        data-content-opening-state={controller.error ? 'blocked' : undefined}
      >
        <ContentLandingHeader
          title={title}
          navigationOrigin={navigationOrigin}
          fullWindowAction={fullWindowAction}
          leadingAction={leadingAction}
          onBack={onBack}
          versionControl={
            <button type="button" onClick={() => void controller.refresh()}>
              刷新
            </button>
          }
        />
        {controller.error ? <p role="alert">{controller.error}</p> : <p>正在从原任务恢复作品…</p>}
      </section>
    );
  return (
    <AuthorizedReview
      key={reviewId}
      view={controller.view}
      controller={controller}
      onBack={onBack}
      initialRound={initialRound}
      onVersionChange={onVersionChange}
      onContextChange={onContextChange}
      leadingAction={leadingAction}
      titleInHost={titleInHost}
      title={title}
      navigationOrigin={navigationOrigin}
      fullWindowAction={fullWindowAction}
    />
  );
}
function AuthorizedReview({
  view,
  controller,
  onBack,
  initialRound,
  onVersionChange,
  onContextChange,
  leadingAction,
  titleInHost,
  title,
  navigationOrigin,
  fullWindowAction,
}: {
  view: ArtifactReviewView;
  controller: ReturnType<typeof useArtifactReview>;
  onBack: () => void;
  initialRound?: number;
  onVersionChange?: (round: number) => void;
  onContextChange?: (context: PublicationReviewContext) => void;
  leadingAction?: ReactNode;
  titleInHost: boolean;
  title?: string;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  fullWindowAction?: { active: boolean; onToggle: () => void };
}) {
  const latest = view.review.rounds.at(-1);
  const [selected, setSelected] = useState(initialRound ?? latest?.number ?? 1);
  const [notice, setNotice] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (initialRound !== undefined) setSelected(initialRound);
  }, [initialRound]);
  const selectVersion = (number: number) => {
    setSelected(number);
    onVersionChange?.(number);
  };
  const round = view.review.rounds.find((item) => item.number === selected);
  if (!latest || !round)
    return (
      <section className="p-4" data-testid="artifact-review-surface" data-content-opening-state="blocked">
        <ContentLandingHeader
          title={titleInHost ? undefined : artworkTitle(title ?? view.review.title, '作品')}
          navigationOrigin={navigationOrigin}
          fullWindowAction={fullWindowAction}
          leadingAction={leadingAction}
          onBack={onBack}
          versionControl={
            <>
              {latest ? (
                <button type="button" className="text-cafe-accent" onClick={() => selectVersion(latest.number)}>
                  查看当前第 {latest.number} 版
                </button>
              ) : null}
            </>
          }
        />
        <p role="status">第 {selected} 版暂不可读取。</p>
      </section>
    );
  const prefix = reviewDraftPrefix(view.review.task.ownerUserId, view.review.reviewId);
  const reanchor =
    round.number !== latest.number && view.authority.canWrite && latest.state !== 'approved' && !controller.pending
      ? async (annotation: ArtifactReviewAnnotation) => {
          const result = await startArtifactReanchor(prefix, latest, {
            body: annotation.body,
            anchor: null,
            reanchoredFrom: { round: round.number, annotationId: annotation.id },
          });
          setNotice(
            result === 'existing'
              ? '新版还有未保存的标注，已为你保留。请先保存或清空后再重新圈选。'
              : result === 'unavailable'
                ? '暂时无法保存重新圈选的草稿，原标注仍保留。'
                : null,
          );
          if (result !== 'unavailable') selectVersion(latest.number);
        }
      : undefined;
  return (
    <ArtifactRoundEntry
      key={round.number}
      {...{
        view,
        round,
        controller,
        onBack,
        prefix,
        notice,
        leadingAction,
        titleInHost,
        title,
        navigationOrigin,
        fullWindowAction,
      }}
      onReanchor={reanchor}
      onVersion={selectVersion}
      contextControl={
        onContextChange ? <ReviewContextSelector view={view} round={round} onChange={onContextChange} /> : undefined
      }
    />
  );
}
function ArtifactRoundEntry(props: ArtifactRoundProps) {
  return props.round.ledgerRef ? <LinkedArtifactRoundLanding {...props} /> : <ArtifactRoundLanding {...props} />;
}
function LinkedArtifactRoundLanding(props: ArtifactRoundProps) {
  const linked = useWorkspaceContentReview({
    publication: { contentRef: props.round.asset.contentRef, ownerRevision: props.round.asset.ownerRevision },
  });
  return <ArtifactRoundLanding {...props} linked={linked} />;
}
