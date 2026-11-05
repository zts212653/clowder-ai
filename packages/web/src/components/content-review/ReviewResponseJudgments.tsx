'use client';
import type { ArtifactReview, ArtifactReviewAction, ArtifactReviewAnchor, ArtifactReviewRound } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ReviewActor } from './ReviewActor';
import { reviewResponsesCopy } from './review-responses.shell-copy';

export function ReviewResponseJudgments({
  review,
  round,
  canJudge,
  onJudge,
  onSource,
  onResult,
}: {
  review: ArtifactReview;
  round: ArtifactReviewRound;
  canJudge: boolean;
  onJudge: (action: ArtifactReviewAction, round: number) => Promise<boolean>;
  onSource: (round: number) => void;
  onResult?: (anchor: ArtifactReviewAnchor) => void;
}) {
  const copy = useShellCopy(reviewResponsesCopy);
  const sourceRound = round.responseSource?.round ?? round.number - 1;
  const source = review.rounds.find((item) => item.number === sourceRound);
  if (!source || !round.responses.length) return null;
  return (
    <section className="rounded-lg border border-cafe-subtle p-3 text-sm" aria-label={copy.title}>
      <h3 className="font-semibold">
        {copy.title} · {copy.version(round.asset.ownerRevision)}
      </h3>
      {round.responseAuthor ? <ReviewActor actor={round.responseAuthor} ownerUserId={review.task.ownerUserId} /> : null}
      <ol className="mt-2 space-y-3">
        {round.responses.map((response) => {
          const original = source.annotations.find((item) => item.id === response.annotationId);
          const resultAnchor = response.resultAnchor;
          const superseded = review.rounds.some(
            (item) =>
              item.number > round.number &&
              (item.responseSource?.round ?? item.number - 1) === sourceRound &&
              item.responses.some((row) => row.annotationId === response.annotationId),
          );
          return (
            <li key={response.annotationId}>
              <details className="text-xs text-cafe-secondary">
                <summary>
                  {copy.original} · {copy.version(source.asset.ownerRevision)}
                </summary>
                <p className="whitespace-pre-wrap break-words">{original?.body}</p>
              </details>
              <p className="mt-1 text-xs text-cafe-muted">
                {response.disposition === 'addressed' ? copy.adjusted : copy.unchanged}
              </p>
              <p className="whitespace-pre-wrap break-words">{response.explanation}</p>
              <div className="mt-1 flex flex-wrap gap-3 text-xs text-cafe-accent">
                <button type="button" onClick={() => onSource(sourceRound)}>
                  {copy.source}
                </button>
                {resultAnchor && onResult ? (
                  <button type="button" onClick={() => onResult(resultAnchor)}>
                    {copy.result}
                  </button>
                ) : (
                  <span className="text-cafe-muted">{response.resultAnchor ? copy.located : copy.unmapped}</span>
                )}
              </div>
              <output className="mt-2 block text-xs">
                {response.judgment
                  ? response.judgment.outcome === 'accepted'
                    ? copy.acceptedState
                    : copy.reopenedState
                  : copy.pending}
              </output>
              <div className="mt-1 flex gap-3">
                {(['accepted', 'reopened'] as const).map((outcome) => (
                  <button
                    key={outcome}
                    type="button"
                    disabled={!canJudge || superseded || response.judgment?.outcome === outcome}
                    className="rounded border border-cafe-subtle px-2 py-1 text-xs disabled:opacity-50"
                    onClick={() =>
                      void onJudge(
                        {
                          kind: 'judge_response',
                          sourceRound,
                          annotationId: response.annotationId,
                          resultOwnerRevision: round.asset.ownerRevision,
                          outcome,
                        },
                        round.number,
                      )
                    }
                  >
                    {outcome === 'accepted' ? copy.accepted : copy.reopened}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
