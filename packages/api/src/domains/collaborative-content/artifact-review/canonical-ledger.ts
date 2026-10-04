import { isDeepStrictEqual } from 'node:util';
import type {
  ArtifactReview,
  ArtifactReviewAuditActor,
  ArtifactReviewRound,
  ReviewedMediaAsset,
  WorkspaceContentReview,
} from '@cat-cafe/shared';
import { publicationLedgerSource } from '../workspace-review/publication-review-source.js';
import type { WorkspaceContentReviewStore } from '../workspace-review/store.js';
import { workspaceReviewIdentity } from '../workspace-review/workspace-review-anchors.js';
import { ArtifactReviewError } from './errors.js';

export function publicationLedgerId(ownerUserId: string, asset: ReviewedMediaAsset): string {
  return workspaceReviewIdentity(ownerUserId, `${asset.contentRef}#version:${asset.ownerRevision}`);
}

/** Used only inside new-review creation. Existing inline bodies are never migrated or merged. */
export function bindExistingPublicationLedgers(
  review: ArtifactReview,
  store: WorkspaceContentReviewStore,
): ArtifactReview {
  let linked = false;
  const rounds = review.rounds.map((round) => {
    if (round.ledgerRef) return round;
    const ledger = store.get(publicationLedgerId(review.task.ownerUserId, round.asset));
    if (!ledger) return round;
    if (round.annotations.length || round.visualMarks?.length || round.responses.length)
      throw new ArtifactReviewError('asset_changed');
    const bound = { ...round, ledgerRef: ledger.reviewId };
    requireRoundLedger(store, review, bound);
    linked = true;
    return bound;
  });
  return linked ? { ...review, version: 3, rounds } : review;
}

export function requireRoundLedger(
  store: WorkspaceContentReviewStore,
  review: ArtifactReview,
  round: ArtifactReviewRound,
): WorkspaceContentReview {
  const ledger = round.ledgerRef ? store.get(round.ledgerRef) : null;
  if (
    !ledger ||
    ledger.ownerUserId !== review.task.ownerUserId ||
    ledger.source.kind !== 'publication' ||
    ledger.reviewId !== publicationLedgerId(review.task.ownerUserId, round.asset) ||
    !isDeepStrictEqual(ledger.source, publicationLedgerSource(round.asset))
  )
    throw new ArtifactReviewError('asset_changed');
  return ledger;
}

/** Only freshly authenticated immutable owner assets may create an empty version ledger. */
export function ensureRoundLedgers(
  store: WorkspaceContentReviewStore,
  review: ArtifactReview,
  actor: ArtifactReviewAuditActor,
): void {
  for (const round of review.rounds) {
    if (!round.ledgerRef) continue;
    if (!store.get(round.ledgerRef)) {
      if (actor.kind === 'owner') throw new ArtifactReviewError('owner_required');
      if (
        round.ledgerRef !== publicationLedgerId(review.task.ownerUserId, round.asset) ||
        round.annotations.length ||
        round.visualMarks?.length
      )
        throw new ArtifactReviewError('asset_changed');
      const source = publicationLedgerSource(round.asset);
      store.create(
        {
          version: 1,
          reviewId: round.ledgerRef,
          ownerUserId: review.task.ownerUserId,
          contentRef: `${round.asset.contentRef}#version:${round.asset.ownerRevision}`,
          source,
          sourceHistory: [source],
          revision: 1,
          annotations: [],
          createdAt: round.openedAt,
          updatedAt: round.openedAt,
        },
        {
          operationId: `publication-version:${round.asset.ownerRevision}`,
          actor,
          kind: 'prepare',
          request: { publication: round.asset },
          now: round.openedAt,
        },
      );
    }
    requireRoundLedger(store, review, round);
  }
}

export function projectRoundLedger(round: ArtifactReviewRound, ledger: WorkspaceContentReview): ArtifactReviewRound {
  return {
    ...round,
    ledgerRevision: ledger.revision,
    annotations: ledger.annotations.map(({ operationId: _operationId, anchor, replies, ...annotation }) => {
      if (!('anchor' in anchor) || anchor.baseRevision !== ledger.source.revision)
        throw new ArtifactReviewError('asset_changed');
      return { ...annotation, anchor: anchor.anchor, replies: replies ?? [] };
    }),
    ...(ledger.visualMarks
      ? {
          visualMarks: ledger.visualMarks.map(({ baseRevision, ...mark }) => {
            if (baseRevision !== ledger.source.revision) throw new ArtifactReviewError('asset_changed');
            return mark;
          }),
        }
      : {}),
  };
}

/** Legacy inline records keep their original IDs and read path. New records resolve by reference. */
export function projectLinkedReview(review: ArtifactReview, store: WorkspaceContentReviewStore): ArtifactReview {
  return {
    ...review,
    rounds: review.rounds.map((round) =>
      round.ledgerRef ? projectRoundLedger(round, requireRoundLedger(store, review, round)) : round,
    ),
  };
}

export function serializeLinkedReview(review: ArtifactReview, store: WorkspaceContentReviewStore): string {
  const stored = structuredClone(review);
  for (const round of stored.rounds) {
    if (!round.ledgerRef) continue;
    const projection = projectRoundLedger(round, requireRoundLedger(store, review, round));
    if (
      !isDeepStrictEqual(round.annotations, projection.annotations) ||
      !isDeepStrictEqual(round.visualMarks ?? [], projection.visualMarks ?? [])
    )
      throw new ArtifactReviewError(
        'invalid_action',
        'Linked annotations must be written through their canonical ledger',
      );
    round.annotations = [];
    delete round.visualMarks;
    delete round.ledgerRevision;
  }
  return JSON.stringify(stored);
}

export function ledgerFromRound(
  ledger: WorkspaceContentReview,
  round: ArtifactReviewRound,
  operationId: string,
  now: string,
): WorkspaceContentReview {
  return {
    ...ledger,
    revision: ledger.revision + 1,
    updatedAt: now,
    annotations: round.annotations.map(({ anchor, ...annotation }) => ({
      ...annotation,
      operationId: ledger.annotations.find((item) => item.id === annotation.id)?.operationId ?? operationId,
      anchor: { baseRevision: ledger.source.revision, anchor },
    })),
    ...(round.visualMarks
      ? { visualMarks: round.visualMarks.map((mark) => ({ ...mark, baseRevision: ledger.source.revision })) }
      : {}),
  };
}
