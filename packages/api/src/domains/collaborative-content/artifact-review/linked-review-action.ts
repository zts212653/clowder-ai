import type { ArtifactReview } from '@cat-cafe/shared';
import { ledgerFromRound, requireRoundLedger } from './canonical-ledger.js';
import { ArtifactReviewError } from './errors.js';
import type { ArtifactReviewStore, ReviewMutation, ReviewMutationResult } from './store.js';
import { receiptReference } from './store-support.js';

export function commitReviewAction(
  store: ArtifactReviewStore,
  input: ReviewMutation,
  transition: (review: ArtifactReview, receiptRef: string) => ArtifactReview,
  expectedLedgerRevision?: number,
): ReviewMutationResult {
  const current = store.get(input.reviewId);
  if (!current) throw new ArtifactReviewError('not_found');
  const round = current.rounds.find((item) => item.number === input.round);
  if (!round?.ledgerRef) return store.mutate(input, transition);
  if (round !== current.rounds.at(-1) && input.kind !== 'reply') throw new ArtifactReviewError('asset_changed');
  if (input.actor.kind === 'owner') throw new ArtifactReviewError('invalid_action');
  const ledger = requireRoundLedger(store.ledgers, current, round);
  if (ledger.revision !== expectedLedgerRevision) throw new ArtifactReviewError('revision_conflict');
  const next = transition(current, receiptReference(input.reviewId, input.operationId));
  const nextRound = next.rounds.find((item) => item.number === input.round);
  if (!nextRound) throw new ArtifactReviewError('invalid_action');
  return store.mutateWithLedger(
    input,
    {
      reviewId: ledger.reviewId,
      expectedRevision: ledger.revision,
      operationId: input.operationId,
      actor: input.actor,
      now: input.now,
      kind: input.kind,
      request: input.request,
    },
    {
      ledger: (stored) => ledgerFromRound(stored, nextRound, input.operationId, input.now),
      review: () => next,
    },
  ).review;
}
