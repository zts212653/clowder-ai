import {
  type ArtifactReview,
  type ArtifactReviewAuditEntry,
  artifactReviewCommandSchema,
  type ContentModificationCandidate,
  type ContentModificationReceiptV1,
  type ContentModificationRecord,
} from '@cat-cafe/shared';
import { reviewModificationBindings } from '../../artifact-review/modification-request-reference.js';
import type { ArtifactReviewService } from '../../artifact-review/service.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import type { ContentModificationResultService } from '../result-service.js';

export interface ModificationReceiptEvent {
  readonly state: ContentModificationReceiptV1['state'];
  readonly candidateRef?: string;
  readonly receiptRef: string;
  readonly observedAt: number;
}

/** Replay immutable canonical operations, bounded by this request's binding and its successor. */
export async function mediaModificationEvents(
  deps: {
    store: ArtifactReviewStore;
    reviews: ArtifactReviewService;
    results: Pick<ContentModificationResultService, 'candidates'>;
  },
  record: ContentModificationRecord,
): Promise<ModificationReceiptEvent[]> {
  const bound = record.progress.review;
  if (record.progress.prepared?.kind !== 'media' || !bound) return [];
  const principal = { userId: record.ownerUserId, actor: { kind: 'human' as const, actorId: record.ownerUserId } };
  const view = await deps.reviews.readCurrent(bound.reviewId, principal);
  const candidates = await deps.results.candidates(record, principal);
  const bindings = reviewModificationBindings(deps.store, view.review);
  const original = bindings.find((item) => item.record.requestId === record.requestId);
  if (!original) return [];
  const before = Math.min(
    Infinity,
    ...bindings.filter((item) => item.revision > original.revision).map((item) => item.revision),
  );
  return historyBefore(deps.store, bound.reviewId, original.revision, before).flatMap((entry) => {
    const candidate = candidateForEntry(view.review, candidates, entry, bound.round ?? 0);
    const state = stateForEntry(entry, record);
    if (!candidate || !state) return [];
    return [
      {
        state,
        candidateRef: candidate.candidateRef,
        receiptRef: entry.receipt.receiptRef,
        observedAt: Date.parse(entry.receipt.createdAt),
      },
    ];
  });
}

function historyBefore(store: ArtifactReviewStore, reviewId: string, after: number, before: number) {
  const history: ArtifactReviewAuditEntry[] = [];
  let cursor = after;
  for (;;) {
    const entries = store.history(reviewId, cursor, 200);
    history.push(...entries.filter((entry) => entry.receipt.revision < before));
    const lastRevision = entries.at(-1)?.receipt.revision;
    if (entries.length < 200 || lastRevision === undefined || lastRevision >= before) return history;
    cursor = lastRevision;
  }
}

function candidateForEntry(
  review: ArtifactReview,
  candidates: ContentModificationCandidate[],
  entry: ArtifactReviewAuditEntry,
  sourceRound: number,
) {
  const number = entry.round + (entry.kind === 'respond_with_version' ? 1 : 0);
  const round = review.rounds.find((item) => item.number === number);
  if (!round || number <= sourceRound) return undefined;
  return candidates.find(
    (item) =>
      item.kind === 'media' &&
      item.asset.contentRef === round.asset.contentRef &&
      item.asset.ownerRevision === round.asset.ownerRevision,
  );
}

function stateForEntry(
  entry: ArtifactReviewAuditEntry,
  record: ContentModificationRecord,
): ModificationReceiptEvent['state'] | undefined {
  const actor = entry.receipt.actor;
  if (entry.kind === 'respond_with_version')
    return actor.kind === 'cat' && actor.actorId === record.payload.targetCatId ? 'candidate' : undefined;
  if (actor.kind !== 'human' || actor.actorId !== record.ownerUserId) return undefined;
  if (entry.kind !== 'decide' && entry.kind !== 'submit_feedback') return undefined;
  const raw =
    typeof entry.detail === 'object' && entry.detail !== null && 'request' in entry.detail
      ? entry.detail.request
      : undefined;
  const command = artifactReviewCommandSchema.safeParse(raw);
  if (!command.success || command.data.action.kind !== entry.kind) return undefined;
  const action = command.data.action;
  if (action.kind === 'decide') return action.outcome;
  if (action.kind === 'submit_feedback') return 'changes_requested';
  return undefined;
}
