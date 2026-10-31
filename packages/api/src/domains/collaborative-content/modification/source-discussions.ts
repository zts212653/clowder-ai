import type { ContentModificationRecord, ContentSourceDiscussion } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import {
  type MediaReviewPrincipal,
  type PublishedMediaAccess,
  withContentTask,
} from '../../video-studio/content-owner/published-media-access.js';
import { WorkspaceContentSourceError } from '../../workspace/workspace-content-source.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import type { ArtifactReviewService } from '../artifact-review/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewService } from '../workspace-review/service.js';
import { assertModificationSourceAuthority } from './request-authority.js';

export class ModificationSourceDiscussions {
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      files: WorkspaceContentReviewService;
      ledgers: WorkspaceContentReviewService;
      reviews: ArtifactReviewService;
      access: PublishedMediaAccess;
      messages: Pick<IMessageStore, 'getById'>;
    },
  ) {}

  async forRequest(requestId: string, principal: MediaReviewPrincipal): Promise<ContentSourceDiscussion[]> {
    const record = this.deps.store.requests.get(requestId, principal.userId);
    if (!record) throw new MediaOwnerError('not_found');
    if (!record.progress.prepared || !record.progress.task || !record.progress.review) return [];
    await this.authorize(record, principal);
    const originals =
      record.payload.source.kind === 'workspace' || record.payload.source.kind === 'evolution'
        ? [record]
        : record.progress.prepared.kind === 'media'
          ? this.deps.store.requests
              .publicationTaskBindings(
                principal.userId,
                record.progress.task.taskId,
                record.progress.prepared.contentRef,
              )
              .filter((item) => item.payload.source.kind === 'workspace' || item.payload.source.kind === 'evolution')
          : [];
    const discussions: ContentSourceDiscussion[] = [];
    for (const original of originals) discussions.push(await this.readOriginal(original, principal));
    return discussions;
  }

  async forReview(reviewId: string, principal: MediaReviewPrincipal, expectedRevision?: number) {
    const view = await this.deps.reviews.read(reviewId, principal);
    if (expectedRevision !== undefined && expectedRevision !== view.review.revision)
      throw new ArtifactReviewError('revision_conflict');
    const records = this.deps.store.requests.forSource(principal.userId, {
      kind: 'artifact-review',
      reviewId,
      round: view.review.rounds.at(-1)!.number,
      expectedReviewRevision: view.review.revision,
    });
    const results = new Map<string, ContentSourceDiscussion | { state: 'source_unavailable' }>();
    for (const record of records) {
      if (
        record.progress.review?.reviewId !== reviewId ||
        record.progress.task?.taskId !== view.review.task.taskId ||
        (record.payload.source.kind !== 'workspace' && record.payload.source.kind !== 'evolution')
      )
        continue;
      // The current review has already passed its own owner authorization. Only
      // actual original-file evidence adds a source check; another old request
      // with no original discussion must not revoke this independent read.
      const key = `${record.payload.source.reviewId}:${record.payload.source.expectedReviewRevision}`;
      try {
        const discussion = await this.readOriginal(record, principal);
        results.set(key, discussion);
      } catch (error) {
        const unavailable =
          (error instanceof MediaOwnerError && error.code === 'access_denied') ||
          (error instanceof WorkspaceContentSourceError &&
            ['access_denied', 'not_found', 'revision_changed'].includes(error.code)) ||
          (error instanceof WorkspaceContentReviewError &&
            ['access_denied', 'not_found', 'source_unavailable', 'source_changed'].includes(error.code));
        if (!unavailable) throw error;
        // Existence of an unavailable source is visible to this independent review owner;
        // its body, source coordinates, title and request identity are not projected.
        if (!results.has(key)) results.set(key, { state: 'source_unavailable' });
      }
    }
    return [...results.values()];
  }

  private async readOriginal(
    record: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<ContentSourceDiscussion> {
    await this.authorize(record, principal);
    const source = record.payload.source;
    if (source.kind !== 'workspace' && source.kind !== 'evolution') throw new MediaOwnerError('publication_changed');
    const owner = source.kind === 'workspace' ? this.deps.files : this.deps.ledgers;
    const review = await owner.retainedRevision(
      {
        principal: withContentTask(principal, record.progress.task!.taskId),
        reviewId: source.reviewId,
        revision: source.expectedReviewRevision,
      },
      principal.actor.kind === 'cat' ? () => this.authorize(record, principal) : undefined,
    );
    if (review.source.kind === 'publication' || review.source.revision !== source.expectedSourceRevision)
      throw new MediaOwnerError('publication_changed');
    if (source.kind === 'workspace') {
      if (
        (review.source.kind !== 'media' && review.source.kind !== 'text') ||
        review.source.locator.worktreeId !== source.locator.worktreeId ||
        review.source.locator.path !== source.locator.path
      )
        throw new MediaOwnerError('publication_changed');
    } else if (
      review.source.kind !== 'evolution' ||
      JSON.stringify(review.source.locator) !== JSON.stringify(source.locator)
    )
      throw new MediaOwnerError('publication_changed');
    return {
      requestId: record.requestId,
      title:
        review.source.kind === 'evolution'
          ? review.source.label
          : (review.source.locator.path.split('/').at(-1) ?? '原文件'),
      readOnly: true,
      review,
    };
  }

  private async authorize(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    if (record.ownerUserId !== principal.userId || !record.progress.task || !record.progress.review)
      throw new MediaOwnerError('access_denied');
    const task = await this.deps.access.authorize(record.progress.task.taskId, principal, { allowClosed: true });
    if (
      task.ownerCatId !== record.payload.targetCatId ||
      task.threadId !== record.payload.threadId ||
      (principal.actor.kind === 'cat' && principal.actor.actorId !== task.ownerCatId)
    )
      throw new MediaOwnerError('access_denied');
    await assertModificationSourceAuthority(this.deps.messages, record);
  }
}
