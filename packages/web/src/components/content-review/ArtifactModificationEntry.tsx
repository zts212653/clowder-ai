import type { ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { useState } from 'react';
import { ContentModificationLanding } from './ContentModificationLanding';
import { modificationSourceVersion } from './modification-draft';
import type { ReviewDraft } from './useReviewDraft';

/** Task is already owned. Confirming a new request records it without re-admitting or rewriting that Task. */
export function ArtifactModificationEntry({
  view,
  round,
  draft,
  disabled,
  onRegionHandedOff,
}: {
  view: ArtifactReviewView;
  round: ArtifactReviewRound;
  draft: ReviewDraft;
  disabled: boolean;
  /** The chosen region now belongs to a recorded erase request; the canvas selection is released. */
  onRegionHandedOff?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (round.ledgerRef && round.ledgerRevision === undefined)
    return (
      <p role="alert" className="p-3 text-xs text-cafe-error">
        原讨论版本尚未核对，请刷新后继续修改。
      </p>
    );
  const source = round.ledgerRef
    ? {
        kind: 'publication' as const,
        contentRef: round.asset.contentRef,
        ownerRevision: round.asset.ownerRevision,
        ledgerRef: round.ledgerRef,
        expectedLedgerRevision: round.ledgerRevision ?? 0,
      }
    : {
        kind: 'artifact-review' as const,
        reviewId: view.review.reviewId,
        round: round.number,
        expectedReviewRevision: view.review.revision,
      };
  const taskContext = {
    kind: 'media' as const,
    taskId: view.review.task.taskId,
    expectedTaskRevision: view.authority.taskRevision,
    reviewId: view.review.reviewId,
    expectedReviewRevision: view.review.revision,
    round: round.number,
  };
  return (
    <>
      <div className="flex justify-end px-3 py-2">
        <button
          type="button"
          data-testid="content-modification-entry"
          onClick={() => setOpen(true)}
          className="rounded-md border border-cafe-subtle px-3 py-1.5 text-xs font-semibold text-cafe-accent"
        >
          {disabled ? '修改记录' : '请猫修改'}
        </button>
      </div>
      {open ? (
        <ContentModificationLanding
          title={view.review.title}
          ownerUserId={view.review.task.ownerUserId}
          source={source}
          mediaType={round.asset.mediaType}
          taskContext={taskContext}
          suggestedCatId={view.authority.ownerCatId ?? undefined}
          suggestedThreadId={view.review.task.threadId}
          initialIntent={draft.anchor ? { selection: draft.anchor } : {}}
          initialIntentSourceVersion={modificationSourceVersion(source)}
          allowNewRequest={!disabled}
          onRequestKnown={(request) => {
            const { imageEdit, selection } = request.record.payload.intent;
            if (
              imageEdit?.kind === 'erase-region' &&
              draft.anchor &&
              JSON.stringify(selection) === JSON.stringify(draft.anchor)
            )
              onRegionHandedOff?.();
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
