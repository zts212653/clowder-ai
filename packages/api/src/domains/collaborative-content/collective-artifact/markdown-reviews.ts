import {
  collectiveArtifactAnnotationCommandSchema,
  collectiveArtifactReadPageSchema,
  type WorkspaceContentSource,
} from '@cat-cafe/shared';
import { collectiveContentScopeRef } from '../../video-studio/content-owner/collective-scope.js';
import {
  resolveWorkspaceTextQuote,
  resolveWorkspaceTextQuoteBatch,
  workspaceTextAnchorAt,
} from '../../workspace/workspace-content-text-resolver.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewStore, WorkspaceReviewMutation } from '../workspace-review/store.js';
import {
  isWorkspaceTextAnchor,
  validateWorkspaceReviewBody,
  workspaceAnnotationId,
} from '../workspace-review/workspace-review-anchors.js';
import { resolveTextWorkspaceReviewAnnotations } from '../workspace-review/workspace-review-annotation-resolution.js';
import { prepareCanonicalWorkspaceReview } from '../workspace-review/workspace-review-preparation.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import { actOnCollectiveMarkdownReview } from './markdown-review-actions.js';
import { importCollectiveSelections } from './markdown-selection-import.js';

export class CollectiveMarkdownReviews {
  constructor(
    private readonly store: WorkspaceContentReviewStore,
    private readonly ownerUserId: string,
  ) {}
  importSelections(admitted: AdmittedCollectiveMarkdown, payload: unknown) {
    return importCollectiveSelections(admitted, payload, this.store, this);
  }
  act(admitted: AdmittedCollectiveMarkdown, payload: unknown) {
    return actOnCollectiveMarkdownReview(admitted, payload, this.store, this);
  }
  prepare(admitted: AdmittedCollectiveMarkdown) {
    const { scope, content, constraint } = admitted;
    return prepareCanonicalWorkspaceReview(
      this.store,
      { contentRef: content.contentRef, source: this.source(admitted) },
      {
        principal: { userId: this.ownerUserId, actor: { kind: 'human', actorId: constraint.humanId } },
        collaborationScope: {
          kind: 'collective-artifact',
          scopeRef: collectiveContentScopeRef(scope),
          serviceInstanceId: scope.serviceInstanceId,
          collectiveId: scope.collectiveId,
          artifactId: scope.artifactId,
        },
        operationId: `prepare:${scope.artifactId}`,
        request: { scopeRef: collectiveContentScopeRef(scope) },
      },
      new Date().toISOString(),
    );
  }

  /** Version bytes remain with the owner. This recoverable projection advances only to a freshly admitted current version. */
  async reconcileSource(admitted: AdmittedCollectiveMarkdown) {
    if (admitted.content.ownerRevision !== admitted.content.currentOwnerRevision) return;
    let review = this.prepare(admitted);
    if (review.source.kind !== 'collective-artifact' || review.source.ownerRevision >= admitted.content.ownerRevision)
      return;
    await admitted.authorize();
    review = this.prepare(admitted);
    if (review.source.kind !== 'collective-artifact' || review.source.ownerRevision >= admitted.content.ownerRevision)
      return;
    this.store.mutate(
      {
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        operationId: `collective-version:${admitted.content.ownerRevision}:${admitted.content.blobDigest}`,
        actor: { kind: 'human', actorId: admitted.constraint.humanId },
        now: new Date().toISOString(),
        kind: 'collective:version',
        request: this.source(admitted),
      },
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        source: this.source(admitted),
        sourceHistory: [...(current.sourceHistory ?? [current.source]), this.source(admitted)],
      }),
    );
  }

  view(
    admitted: AdmittedCollectiveMarkdown,
    review = this.prepare(admitted),
    unsafePage: Record<string, unknown> = {},
  ) {
    const page = collectiveArtifactReadPageSchema.parse(unsafePage);
    const selected = page.annotationId
      ? review.annotations.filter((annotation) => annotation.id === page.annotationId)
      : review.annotations.slice(page.annotationOffset, page.annotationOffset + page.annotationLimit);
    const paged = { ...review, annotations: selected };
    const replyCount = page.annotationId ? 1 : 0;
    const source = this.source(admitted);
    const text = admitted.content.bytes.toString('utf8');
    const batch = resolveWorkspaceTextQuoteBatch({
      text,
      sourceRevision: source.revision,
      anchors: selected.flatMap((annotation) =>
        isWorkspaceTextAnchor(annotation.anchor)
          ? [
              {
                annotationId: annotation.id,
                baseRevision: annotation.anchor.baseRevision,
                quote: annotation.anchor.quote,
                expectedQuoteDigest: annotation.anchor.quoteDigest,
                expectedContextDigest: annotation.anchor.contextDigest,
              },
            ]
          : [],
      ),
    });
    const { ownerUserId: _localOwner, sourceHistory: _history, ...projection } = paged;
    const history = selected.flatMap((annotation) => {
      const snapshot = (review.sourceHistory ?? [review.source]).find(
        (candidate) =>
          candidate.kind === 'collective-artifact' &&
          candidate.ownerRevision === annotation.collectiveMessage?.ownerRevision &&
          candidate.revision === annotation.anchor.baseRevision,
      );
      return snapshot ? [snapshot] : [];
    });
    const snapshots = [
      ...new Map(
        [source, ...history].map((snapshot) => [
          snapshot.kind === 'collective-artifact' ? snapshot.ownerRevision : snapshot.revision,
          snapshot,
        ]),
      ).values(),
    ];
    return {
      review: {
        ...projection,
        annotations: selected.map((annotation) => ({
          ...annotation,
          replies: (annotation.replies ?? []).slice(page.replyOffset, page.replyOffset + replyCount),
        })),
        sourceHistory: snapshots,
      },
      annotationPage: {
        offset: page.annotationOffset,
        total: review.annotations.length,
        ...(!page.annotationId && page.annotationOffset + selected.length < review.annotations.length
          ? { nextOffset: page.annotationOffset + selected.length }
          : {}),
      },
      replyPages: selected.map((annotation) => ({
        annotationId: annotation.id,
        offset: page.replyOffset,
        total: annotation.replies?.length ?? 0,
        ...(page.replyOffset + replyCount < (annotation.replies?.length ?? 0)
          ? { nextOffset: page.replyOffset + replyCount }
          : {}),
      })),
      currentSource: source,
      sourceState: source.revision === review.source.revision ? 'current' : 'changed',
      historyReadOnly: admitted.content.ownerRevision !== admitted.content.currentOwnerRevision,
      canReply: true,
      annotationResolutions: resolveTextWorkspaceReviewAnnotations(paged, source, batch),
      canWrite:
        admitted.content.ownerRevision === admitted.content.currentOwnerRevision &&
        source.revision === review.source.revision,
    };
  }

  async annotate(admitted: AdmittedCollectiveMarkdown, unsafe: Record<string, unknown>) {
    const input = collectiveArtifactAnnotationCommandSchema.parse(unsafe);
    const review = this.prepare(admitted);
    const mutation: WorkspaceReviewMutation = {
      reviewId: review.reviewId,
      expectedRevision: input.selection ? review.revision : input.expectedReviewRevision,
      fingerprintRevision: input.expectedReviewRevision,
      operationId: admitted.operationId,
      actor: { kind: 'human', actorId: admitted.constraint.humanId },
      now: new Date().toISOString(),
      kind: 'collective:annotate',
      request: input,
    };
    await admitted.authorize();
    const replay = this.store.replay(mutation);
    const annotationId = workspaceAnnotationId(review.reviewId, admitted.operationId);
    if (replay) return { view: this.view(admitted, replay.review, { annotationId }), receipt: replay.receipt };
    if (review.source.revision !== admitted.content.blobDigest || review.source.kind !== 'collective-artifact')
      throw new WorkspaceContentReviewError('source_changed');
    const text = admitted.content.bytes.toString('utf8');
    const located =
      input.selection && input.selection.end <= text.length
        ? workspaceTextAnchorAt(text, input.selection.start, input.selection.end)
        : undefined;
    const resolved = input.selection
      ? located && located.quote === input.quote && located.quoteDigest === input.selection.quoteDigest
        ? { status: 'attached', anchor: located }
        : { status: 'orphaned' }
      : resolveWorkspaceTextQuote({ text, quote: input.quote });
    if (resolved.status !== 'attached' || !resolved.anchor) throw new WorkspaceContentReviewError('source_changed');
    await admitted.authorize();
    const result = this.store.mutate(
      { ...mutation, expectedRevision: input.selection ? this.prepare(admitted).revision : mutation.expectedRevision },
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: mutation.now,
        annotations: [
          ...current.annotations,
          {
            id: workspaceAnnotationId(review.reviewId, admitted.operationId),
            operationId: admitted.operationId,
            author: mutation.actor,
            body: validateWorkspaceReviewBody(input.body),
            anchor: { kind: 'text_quote', baseRevision: admitted.content.blobDigest, ...resolved.anchor },
            createdAt: mutation.now,
            updatedAt: mutation.now,
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
    return { view: this.view(admitted, result.review, { annotationId }), receipt: result.receipt };
  }

  source(admitted: AdmittedCollectiveMarkdown): WorkspaceContentSource {
    return {
      kind: 'collective-artifact',
      revision: admitted.content.blobDigest,
      ownerRevision: admitted.content.ownerRevision,
      mime: 'text/markdown',
      byteLength: admitted.content.byteLength,
    };
  }
}
