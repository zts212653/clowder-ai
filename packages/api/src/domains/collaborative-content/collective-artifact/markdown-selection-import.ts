import { createHash } from 'node:crypto';
import { collectiveArtifactModificationRequestCommandSchema } from '@cat-cafe/shared';
import { workspaceTextAnchorAt } from '../../workspace/workspace-content-text-resolver.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewStore } from '../workspace-review/store.js';
import { workspaceAnnotationId } from '../workspace-review/workspace-review-anchors.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import type { CollectiveMarkdownReviews } from './markdown-reviews.js';

/** Complete the Human's sealed send before reserving its Cat request. No Cat-supplied quote or author is admitted. */
export async function importCollectiveSelections(
  admitted: AdmittedCollectiveMarkdown,
  unsafe: unknown,
  store: WorkspaceContentReviewStore,
  reviews: CollectiveMarkdownReviews,
) {
  const input = collectiveArtifactModificationRequestCommandSchema.parse(unsafe);
  if (!input.selections) return input;
  if (
    input.annotationIds.length + input.selections.length > 12 ||
    input.expectedReviewRevision > reviews.prepare(admitted).revision
  )
    throw new WorkspaceContentReviewError('source_changed');
  const text = admitted.content.bytes.toString('utf8');
  // Validate the entire batch before creating any annotation.
  const anchors = input.selections.map((selection) => {
    if (selection.end > text.length) throw new WorkspaceContentReviewError('source_changed');
    const anchor = workspaceTextAnchorAt(text, selection.start, selection.end);
    const digest = `sha256:${createHash('sha256').update(anchor.quote).digest('hex')}`;
    if (digest !== selection.quoteDigest) throw new WorkspaceContentReviewError('source_changed');
    return anchor;
  });
  const ids = [...input.annotationIds];
  let revision = input.expectedReviewRevision;
  for (const [index, anchor] of anchors.entries()) {
    await admitted.authorize();
    const review = reviews.prepare(admitted);
    const operationId = `collective-selection:${admitted.scope.artifactId}:${input.messageEventId}:${index}`;
    const id = workspaceAnnotationId(review.reviewId, operationId);
    const now = new Date().toISOString();
    const result = store.mutate(
      {
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        fingerprintRevision: input.expectedReviewRevision,
        operationId,
        actor: { kind: 'human', actorId: admitted.constraint.humanId },
        now,
        kind: 'collective:annotate',
        request: { eventId: input.messageEventId, anchor, body: input.instruction, location: input.location },
      },
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        annotations: [
          ...current.annotations,
          {
            id,
            operationId,
            author: { kind: 'human', actorId: admitted.constraint.humanId },
            body: input.instruction,
            anchor: { kind: 'text_quote', baseRevision: admitted.content.blobDigest, ...anchor },
            createdAt: now,
            updatedAt: now,
            state: 'open',
            replies: [],
            collectiveMessage: {
              serviceInstanceId: admitted.scope.serviceInstanceId,
              collectiveId: admitted.scope.collectiveId,
              eventId: input.messageEventId,
              ownerRevision: admitted.content.ownerRevision,
              blobDigest: admitted.content.blobDigest,
              channelId: input.location.channelId,
              rootEventId: input.location.rootEventId ?? admitted.scope.sourceEventId,
            },
          },
        ],
      }),
    );
    ids.push(id);
    revision = result.receipt.revision;
  }
  const { selections: _selections, ...request } = input;
  return { ...request, annotationIds: ids, expectedReviewRevision: revision };
}
