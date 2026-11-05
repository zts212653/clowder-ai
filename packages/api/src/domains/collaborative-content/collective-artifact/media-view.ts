import { createHash } from 'node:crypto';
import { collectiveArtifactReadPageSchema, type WorkspaceContentReview } from '@cat-cafe/shared';
import { contentModificationPage } from '../modification/inspection.js';
import { resolveMediaWorkspaceReviewAnnotations } from '../workspace-review/workspace-review-annotation-resolution.js';
import type { AdmittedCollectiveMedia } from './media-authority.js';
import { collectiveMediaSource } from './media-source.js';

export function collectiveMediaView(
  admitted: AdmittedCollectiveMedia,
  review: WorkspaceContentReview,
  unsafe: unknown,
) {
  const page = collectiveArtifactReadPageSchema.parse(unsafe);
  const source = collectiveMediaSource(admitted.asset);
  const annotations = page.annotationId
    ? review.annotations.filter((item) => item.id === page.annotationId)
    : review.annotations.slice(page.annotationOffset, page.annotationOffset + page.annotationLimit);
  const selected = { ...review, annotations };
  const { ownerUserId: _private, sourceHistory: _history, ...publicReview } = selected;
  const retained = new Set([
    source.revision,
    review.source.revision,
    ...annotations.map((item) => item.anchor.baseRevision),
  ]);
  const value = {
    kind: 'collective-media',
    ...admitted.asset,
    view: {
      review: {
        ...publicReview,
        annotations: annotations.map((item) => ({
          ...item,
          replies: (item.replies ?? []).slice(page.replyOffset, page.replyOffset + (page.annotationId ? 1 : 0)),
        })),
        sourceHistory: (review.sourceHistory ?? [review.source]).filter((item) => retained.has(item.revision)),
      },
      currentSource: source,
      sourceState: source.revision === review.source.revision ? 'current' : 'changed',
      canWrite:
        admitted.asset.ownerRevision === admitted.currentOwnerRevision &&
        (admitted.constraint.catalogueOwnerRevision === undefined ||
          admitted.constraint.catalogueOwnerRevision === admitted.asset.ownerRevision),
      canReply: true,
      historyReadOnly: admitted.asset.ownerRevision !== admitted.currentOwnerRevision,
      annotationPage: {
        offset: page.annotationOffset,
        total: review.annotations.length,
        ...(!page.annotationId && page.annotationOffset + annotations.length < review.annotations.length
          ? { nextOffset: page.annotationOffset + annotations.length }
          : {}),
      },
      replyPages: annotations.map((item) => ({
        annotationId: item.id,
        offset: page.replyOffset,
        total: item.replies?.length ?? 0,
        ...(page.replyOffset + (page.annotationId ? 1 : 0) < (item.replies?.length ?? 0)
          ? { nextOffset: page.replyOffset + (page.annotationId ? 1 : 0) }
          : {}),
      })),
      annotationResolutions: resolveMediaWorkspaceReviewAnnotations(selected, source),
    },
  };
  const serialized = JSON.stringify(value);
  if (!page.cursor && !page.expectedSnapshot && Buffer.byteLength(serialized) <= 180 * 1024) return value;
  return contentModificationPage(
    {
      requestId: admitted.operationId,
      view: 'collective-media',
      cursor: page.cursor,
      expectedSnapshot: page.expectedSnapshot,
    },
    `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
    value,
  );
}
