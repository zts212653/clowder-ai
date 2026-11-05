'use client';
import type { ArtifactReviewAnchor, PublicationReviewContext, WorkReference } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { checked, json } from '@/components/content-review/modification-http';
import { ReviewResponseJudgments } from '@/components/content-review/ReviewResponseJudgments';
import { useArtifactReview } from '@/components/content-review/useArtifactReview';
import { useShellCopy } from '@/components/shell/shell-copy';
import { apiFetch } from '@/utils/api-client';
import { publicationContextCatalogueSchema, publicationContextLabel } from '../publication-context';
import { videoWorkResponsesCopy } from './video-work-responses.shell-copy';

/** Reads original authorized review contexts; neither copies opinions nor creates a review on opening Works. */
export function VideoWorkResponses({
  reference,
  onVersion,
  onResult,
}: {
  reference: WorkReference;
  onVersion?: (revision: number) => void;
  onResult: (anchor: ArtifactReviewAnchor) => void;
}) {
  const copy = useShellCopy(videoWorkResponsesCopy);
  const [contexts, setContexts] = useState<PublicationReviewContext[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const read = async () => {
      try {
        const raw = await checked<unknown>(
          await apiFetch('/api/content-reviews/resolve', {
            ...json({ contentRef: reference.contentRef, ownerRevision: reference.ownerRevision }),
            signal: abort.signal,
          }),
        );
        const result = publicationContextCatalogueSchema.parse(raw);
        if (!abort.signal.aborted) {
          setContexts(result.contexts);
          setError(false);
        }
      } catch {
        if (!abort.signal.aborted) {
          setContexts([]);
          setError(true);
        }
      }
    };
    void read();
    const refresh = () => void read();
    window.addEventListener('cat-cafe:artifact-review-changed', refresh);
    return () => {
      abort.abort();
      window.removeEventListener('cat-cafe:artifact-review-changed', refresh);
    };
  }, [reference.contentRef, reference.ownerRevision, attempt]);
  const context =
    contexts.find((item) => item.reviewId === selected) ?? (contexts.length === 1 ? contexts[0] : undefined);
  if (error)
    return (
      <p role="alert" className="p-2 text-xs text-cafe-error">
        {copy.unavailable}
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          {copy.reread}
        </button>
      </p>
    );
  if (!contexts.length) return null;
  return (
    <div className="mb-3">
      {contexts.length > 1 ? (
        <select
          aria-label={copy.select}
          value={context?.reviewId ?? ''}
          className="max-w-full bg-cafe-surface text-xs"
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">{copy.choose}</option>
          {contexts.map((item) => (
            <option key={item.reviewId} value={item.reviewId}>
              {publicationContextLabel(item)}
            </option>
          ))}
        </select>
      ) : null}
      {context ? (
        <OriginalResponses
          key={context.reviewId}
          context={context}
          reference={reference}
          onVersion={onVersion}
          onResult={onResult}
        />
      ) : null}
    </div>
  );
}
function OriginalResponses({
  context,
  reference,
  onVersion,
  onResult,
}: {
  context: PublicationReviewContext;
  reference: WorkReference;
  onVersion?: (revision: number) => void;
  onResult: (anchor: ArtifactReviewAnchor) => void;
}) {
  const copy = useShellCopy(videoWorkResponsesCopy);
  const controller = useArtifactReview(context.reviewId);
  const { view } = controller;
  const round = view?.review.rounds.find(
    (item) => item.asset.contentRef === reference.contentRef && item.asset.ownerRevision === reference.ownerRevision,
  );
  return (
    <>
      {controller.error ? (
        <p role="alert" className="text-xs text-cafe-error">
          {controller.error}
        </p>
      ) : null}
      {controller.pending ? (
        <button type="button" disabled={controller.saving} onClick={() => void controller.retry()}>
          {copy.retry}
        </button>
      ) : null}
      {view && round ? (
        <ReviewResponseJudgments
          review={view.review}
          round={round}
          canJudge={
            !controller.saving &&
            !controller.pending &&
            !view.pendingVersion &&
            (view.authority.state === 'current' || view.authority.state === 'asset_changed')
          }
          onJudge={controller.act}
          onResult={onResult}
          onSource={(number) => {
            const source = view.review.rounds.find((item) => item.number === number);
            if (source) onVersion?.(source.asset.ownerRevision);
          }}
        />
      ) : null}
    </>
  );
}
