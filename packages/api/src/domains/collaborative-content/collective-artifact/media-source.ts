import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveMediaShareScope,
  collectiveMediaShareScopeSchema,
  type ReviewedMediaAsset,
  type WorkspaceContentReview,
  type WorkspaceContentSource,
} from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';

export type SharedPublishedMediaAsset = Omit<ReviewedMediaAsset, 'sourcePublication'> & {
  mediaType: 'image/png' | 'video/mp4';
};
export type CollectiveMediaSource = Extract<WorkspaceContentSource, { kind: 'collective-media' }>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function sharedMediaAsset(asset: ReviewedMediaAsset): SharedPublishedMediaAsset {
  if (asset.mediaType !== 'image/png' && asset.mediaType !== 'video/mp4')
    throw new WorkspaceContentReviewError('unsupported_content');
  const { sourcePublication: _private, ...publicAsset } = asset;
  return { ...publicAsset, mediaType: asset.mediaType };
}
export function collectiveMediaBinding(scope: CollectiveMediaShareScope, contentRef: string) {
  const parsed = collectiveMediaShareScopeSchema.parse(scope);
  const scopeRef = `collective-media-scope:${hash([parsed.serviceInstanceId, parsed.collectiveId, parsed.artifactId, parsed.sourceEventId, contentRef])}`;
  return {
    scope: { kind: 'collective-artifact' as const, scopeRef, ...parsed },
    // A ledger namespace, not a new content object. The retained F138 identity remains in source.contentRef.
    ledgerRef: `collective-media-ledger:${hash([scopeRef, contentRef])}`,
  };
}
export function collectiveMediaSource(asset: SharedPublishedMediaAsset): CollectiveMediaSource {
  return {
    kind: 'collective-media',
    contentRef: asset.contentRef,
    ownerRevision: asset.ownerRevision,
    blobDigest: asset.blobDigest,
    ownerReceiptRef: asset.ownerReceiptRef,
    revision: `sha256:${hash([asset.contentRef, asset.ownerRevision, asset.blobDigest])}`,
    mime: asset.mediaType,
    media: structuredClone(asset.media),
  };
}
export function mediaShareOperation(source: CollectiveMediaSource) {
  return `share-media:${hash(source)}`;
}
export function sameMediaBinding(review: WorkspaceContentReview, scope: CollectiveMediaShareScope, contentRef: string) {
  const expected = collectiveMediaBinding(scope, contentRef);
  return (
    review.source.kind === 'collective-media' &&
    review.contentRef === expected.ledgerRef &&
    isDeepStrictEqual(review.collaborationScope, expected.scope)
  );
}
