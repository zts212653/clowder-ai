import type { ContentModificationRecord, ContentModificationRequest } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { assertModificationSourceAuthority } from './request-authority.js';

type FileRecord = ContentModificationRecord & {
  payload: ContentModificationRequest & {
    source: Extract<ContentModificationRequest['source'], { kind: 'workspace' }>;
  };
};

/** File custody follows an exact committed snapshot/Task binding, never a filename or mutable Task ref. */
export class ModificationFileLineage {
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      media: PublishedMediaService;
      messages: Pick<IMessageStore, 'getById'>;
    },
  ) {}

  async origin(record: ContentModificationRecord, principal: MediaReviewPrincipal): Promise<FileRecord | null> {
    if (record.ownerUserId !== principal.userId) throw new MediaOwnerError('access_denied');
    if (record.payload.source.kind === 'workspace') {
      await assertModificationSourceAuthority(this.deps.messages, record);
      return record as FileRecord;
    }
    return this.forPayload(record.payload, principal);
  }

  async forPayload(payload: ContentModificationRequest, principal: MediaReviewPrincipal): Promise<FileRecord | null> {
    if (payload.source.kind !== 'publication' || !payload.taskContext) return null;
    const task = await this.deps.media.access.authorize(payload.taskContext.taskId, principal, { allowClosed: true });
    if (task.ownerCatId !== payload.targetCatId || task.threadId !== payload.threadId)
      throw new MediaOwnerError('task_changed');
    const contentRef = payload.source.contentRef;
    const origins = this.deps.store.requests
      .publicationTaskBindings(principal.userId, task.id, contentRef)
      .filter((item): item is FileRecord => item.payload.source.kind === 'workspace');
    if (!origins.length) return null;
    if (origins.length !== 1) throw new MediaOwnerError('publication_changed');
    const origin = origins[0];
    if (!origin || origin.payload.targetCatId !== payload.targetCatId || origin.payload.threadId !== payload.threadId)
      throw new MediaOwnerError('task_changed');
    await assertModificationSourceAuthority(this.deps.messages, origin);
    const { scope } = await this.deps.media.origin(contentRef, principal);
    const source = origin.payload.source;
    if (
      !('kind' in scope) ||
      scope.kind !== 'workspace-snapshot' ||
      scope.source.locator.worktreeId !== source.locator.worktreeId ||
      scope.source.locator.path !== source.locator.path ||
      scope.source.expectedSourceRevision !== source.expectedSourceRevision
    )
      throw new MediaOwnerError('publication_changed');
    return origin;
  }

  records(origin: FileRecord): ContentModificationRecord[] {
    if (origin.progress.prepared?.kind !== 'media' || !origin.progress.task) return [origin];
    return this.deps.store.requests
      .publicationTaskBindings(origin.ownerUserId, origin.progress.task.taskId, origin.progress.prepared.contentRef)
      .filter(
        (record) =>
          record.requestId === origin.requestId || record.payload.taskContext?.taskId === origin.progress.task?.taskId,
      );
  }
}
