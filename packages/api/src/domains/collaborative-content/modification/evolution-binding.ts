import type { ContentModificationRequest, ReviewedMediaAsset } from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import { evolutionContentRef } from '../workspace-review/evolution-review-source.js';
import type { WorkspaceContentReviewService } from '../workspace-review/service.js';
import { mapDerivedMediaAnchor } from './derived-media-anchor.js';
import { type ContentModificationRecord, modificationOperationKeys } from './journal.js';

export async function derivedModificationIntent(
  ledgers: WorkspaceContentReviewService,
  record: ContentModificationRecord,
  asset: ReviewedMediaAsset,
  principal: MediaReviewPrincipal,
) {
  const intent = { ...record.payload.intent },
    source = record.payload.source;
  if (source.kind !== 'evolution' || !intent.selection) return intent;
  const original = await ledgers.retainedRevision({
    principal,
    reviewId: source.reviewId,
    revision: source.expectedReviewRevision,
  });
  if (original.source.kind !== 'evolution') throw new ArtifactReviewError('asset_changed');
  if (intent.selection.kind === 'text_quote') throw new ArtifactReviewError('invalid_action');
  intent.selection = mapDerivedMediaAnchor(intent.selection, original.source.media, asset.media);
  return intent;
}

type Source = Extract<ContentModificationRequest['source'], { kind: 'evolution' }>;
export async function inspectEvolutionModification(
  ledgers: WorkspaceContentReviewService,
  source: Source,
  principal: MediaReviewPrincipal,
  resuming: boolean,
) {
  const view = await ledgers.read({ principal, reviewId: source.reviewId });
  if (
    view.review.source.kind !== 'evolution' ||
    view.review.contentRef !== evolutionContentRef(source.locator) ||
    view.review.source.revision !== source.expectedSourceRevision
  )
    throw new ArtifactReviewError('asset_changed');
  if (!resuming && (!view.canWrite || view.review.revision !== source.expectedReviewRevision))
    throw new ArtifactReviewError('revision_conflict');
  return { title: view.review.source.label, completionRule: 'published-result-ready' as const };
}

export async function prepareEvolutionModification(
  ledgers: WorkspaceContentReviewService,
  media: PublishedMediaService,
  record: ContentModificationRecord,
  source: Source,
  principal: MediaReviewPrincipal,
): Promise<ReviewedMediaAsset> {
  const input = {
    principal,
    operationId: modificationOperationKeys(record.requestId).snapshot,
    source: { kind: 'evolution-snapshot' as const, threadId: record.payload.threadId, locator: source.locator },
  };
  const restored = await media.findPreparedSource(input);
  const retained = restored
    ? await ledgers.retainedRevision({ principal, reviewId: source.reviewId, revision: source.expectedReviewRevision })
    : await ledgers.retainRevision({
        principal,
        reviewId: source.reviewId,
        expectedRevision: source.expectedReviewRevision,
      });
  if (
    retained.source.kind !== 'evolution' ||
    retained.contentRef !== evolutionContentRef(source.locator) ||
    retained.source.revision !== source.expectedSourceRevision
  )
    throw new ArtifactReviewError('asset_changed');
  return restored ?? media.prepare(input);
}
