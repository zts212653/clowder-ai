import { isDeepStrictEqual } from 'node:util';
import type { RespondWithMediaVersion } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { acceptedVersionSchema } from '../artifact-review/accepted-version-response.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import { assertVersionResponses } from '../artifact-review/reducer.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { receiptReference } from '../artifact-review/store-support.js';
import type { MediaPublicationReturnIntent } from './media-publication/media-publication-return.js';

export function assertRecoveryResponse(
  store: ArtifactReviewStore,
  intent: MediaPublicationReturnIntent,
  response: RespondWithMediaVersion,
) {
  const review = store.get(intent.reviewId);
  const round = review?.rounds.at(-1);
  if (!review || !round) throw new ArtifactReviewError('not_found');
  const pending = store.pendingVersion(intent.reviewId);
  if (pending) {
    const { publicationSource: _source, ...accepted } = acceptedVersionSchema.parse(pending.payload);
    if (
      pending.input.actor.kind !== 'cat' ||
      pending.input.actor.actorId !== intent.targetCatId ||
      !isDeepStrictEqual(accepted, response) ||
      !isDeepStrictEqual(pending.input.request, response)
    )
      throw new ArtifactReviewError('operation_reused');
  }
  if (store.reviewReceipt(intent.reviewId, receiptReference(intent.reviewId, response.operationId)))
    throw new ArtifactReviewError('operation_reused');
  if (
    response.requestId !== intent.requestId ||
    response.reviewId !== intent.reviewId ||
    response.expectedRevision !== intent.reviewRevision ||
    review.revision !== intent.reviewRevision ||
    response.expectedTaskRevision !== intent.expectedTaskRevision ||
    review.task.observedRevision !== intent.expectedTaskRevision ||
    response.expectedOwnerRevision !== intent.ownerRevision ||
    round.asset.ownerRevision !== intent.ownerRevision ||
    round.number !== intent.round ||
    response.expectedLedgerRevision !== round.ledgerRevision ||
    response.artifactRef !== intent.source.artifactRef ||
    response.expectedArtifactRevision !== intent.source.artifactRevision
  )
    throw new ArtifactReviewError('revision_conflict');
  assertVersionResponses(round, response.responses);
}

/** Request/review/ledger check, immutable return insertion and generation CAS share their existing database. */
export function registerPublicationRecovery(
  store: ArtifactReviewStore,
  database: Database.Database,
  intent: MediaPublicationReturnIntent,
  requestRevision: number,
  fingerprint: string,
) {
  return database
    .transaction(() => {
      const recovery = intent.recovery;
      if (!recovery || intent.state !== 'pending') throw new ArtifactReviewError('invalid_action');
      const replay = store.returns.publications.replay(intent.ownerUserId, recovery.operationId, fingerprint);
      if (replay) return { intent: store.returns.get(replay) as MediaPublicationReturnIntent, replayed: true };
      const record = store.requests.get(intent.requestId, intent.ownerUserId);
      const previous = store.returns.publicationForRequest(intent.requestId);
      if (
        !record ||
        record.control ||
        record.revision !== requestRevision ||
        record.progress.review?.receiptRef !== intent.source.requestReceiptRef ||
        !previous ||
        previous.state !== 'queued' ||
        previous.receiptRef !== recovery.recoveryOfReceiptRef ||
        (previous.recovery?.generation ?? 0) !== recovery.generation - 1 ||
        !isDeepStrictEqual(previous.source, intent.source) ||
        previous.ownerUserId !== intent.ownerUserId ||
        previous.threadId !== intent.threadId ||
        previous.targetCatId !== intent.targetCatId ||
        previous.taskId !== intent.taskId ||
        previous.visibility !== intent.visibility ||
        !isDeepStrictEqual(previous.whisperTo, intent.whisperTo)
      )
        throw new ArtifactReviewError('revision_conflict');
      assertRecoveryResponse(store, intent, recovery.response);
      store.returns.recordPublicationRecovery(intent, fingerprint);
      return { intent, replayed: false };
    })
    .immediate();
}
