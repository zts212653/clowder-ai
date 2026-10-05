import { basename } from 'node:path';
import type { ContentModificationRequest } from '@cat-cafe/shared';
import type {
  MediaReviewPrincipal,
  PublishedMediaAccess,
} from '../../../video-studio/content-owner/published-media-access.js';
import type { WorkspaceContentSourceService } from '../../../workspace/workspace-content-source.js';
import { isWorkspaceTextEditable } from '../../../workspace/workspace-text-policy.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import type { WorkspaceContentReviewService } from '../../workspace-review/service.js';
import type { ContentModificationProgress, ContentModificationRecord } from '../journal.js';
import type { ModificationContentPort } from '../service.js';
import { ModificationTextError } from './text-store.js';

type Prepared = Extract<NonNullable<ContentModificationProgress['prepared']>, { kind: 'text' }>;

export class ModificationTextBinding implements ModificationContentPort {
  constructor(
    private readonly deps: {
      source: WorkspaceContentSourceService;
      files: WorkspaceContentReviewService;
      store: ArtifactReviewStore;
      access: PublishedMediaAccess;
    },
  ) {}

  async inspect(payload: ContentModificationRequest, principal: MediaReviewPrincipal, resuming: boolean) {
    if (payload.source.kind !== 'workspace' || principal.actor.kind !== 'human')
      throw new ModificationTextError('not_found');
    const source = payload.source;
    const description = await this.deps.files.describeSource({
      principal,
      reviewId: source.reviewId,
      locator: source.locator,
    });
    const view = await this.deps.files.read({ principal, reviewId: source.reviewId });
    if (
      description.kind !== 'text' ||
      !isWorkspaceTextEditable(description.locator.path) ||
      view.sourceState === 'unavailable'
    )
      throw new ModificationTextError('not_found');
    if (
      !resuming &&
      (!view.canWrite ||
        view.review.revision !== source.expectedReviewRevision ||
        description.revision !== source.expectedSourceRevision)
    )
      throw new ModificationTextError('source_changed');
    if (
      payload.intent.imageEdit ||
      (payload.intent.selection && payload.intent.selection.kind !== 'text_quote') ||
      (payload.taskContext && payload.taskContext.kind !== 'text')
    )
      throw new ModificationTextError('invalid_patch');
    return { title: basename(description.locator.path), completionRule: 'file-writeback-applied' as const };
  }

  async prepare(record: ContentModificationRecord, principal: MediaReviewPrincipal): Promise<Prepared> {
    const input = record.payload.source;
    if (input.kind !== 'workspace') throw new ModificationTextError('not_found');
    const old = this.deps.store.text.source(record.requestId);
    if (old) {
      await this.deps.source.describe({ principal, locator: old.source.locator });
      return { kind: 'text', reviewId: old.reviewId, sourceRevision: old.source.revision };
    }
    await this.deps.files.describeSource({ principal, reviewId: input.reviewId, locator: input.locator });
    const ledger = await this.deps.files.retainRevision({
      principal,
      reviewId: input.reviewId,
      expectedRevision: input.expectedReviewRevision,
    });
    if (ledger.source.kind !== 'text' || ledger.source.revision !== input.expectedSourceRevision)
      throw new ModificationTextError('source_changed');
    const { text, ...description } = await this.deps.source.readText({
      principal,
      locator: input.locator,
      expectedRevision: input.expectedSourceRevision,
    });
    const selection = record.payload.intent.selection;
    if (
      selection?.kind === 'text_quote' &&
      (selection.baseRevision !== description.revision ||
        text.slice(selection.start, selection.end) !== selection.quote)
    )
      throw new ModificationTextError('invalid_patch');
    this.deps.store.text.retain({
      requestId: record.requestId,
      ownerUserId: record.ownerUserId,
      source: description,
      text,
      reviewId: input.reviewId,
      reviewRevision: input.expectedReviewRevision,
    });
    return { kind: 'text', reviewId: input.reviewId, sourceRevision: description.revision };
  }

  async validatePrepared(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    const source = this.deps.store.text.source(record.requestId);
    if (
      !source ||
      source.ownerUserId !== principal.userId ||
      record.progress.prepared?.kind !== 'text' ||
      source.source.revision !== record.progress.prepared.sourceRevision
    )
      throw new ModificationTextError('not_found');
    await this.deps.source.describe({ principal, locator: source.source.locator });
  }

  async prepareCommit(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    const source = this.deps.store.text.source(record.requestId),
      ref = record.progress.task;
    if (!source || !ref || !record.progress.sourceMessageId) throw new ModificationTextError('not_found');
    const task = await this.deps.access.authorize(ref.taskId, principal, { expectedRevision: ref.revision });
    if (task.ownerCatId !== record.payload.targetCatId || task.threadId !== record.payload.threadId)
      throw new ModificationTextError('task_changed');
    const receiptRef = `${record.requestId}#request`,
      now = Date.now(),
      sourceMessageId = record.progress.sourceMessageId;
    return () => {
      this.deps.store.text.decide({
        receiptRef,
        requestId: record.requestId,
        actorId: principal.userId,
        sourceMessageId,
        taskId: task.id,
        createdAt: now,
      });
      this.deps.store.returns.recordText({
        kind: 'request_text_edit',
        receiptRef,
        requestId: record.requestId,
        sourceMessageId,
        ownerUserId: record.ownerUserId,
        threadId: task.threadId,
        taskId: task.id,
        targetCatId: record.payload.targetCatId,
        expectedTaskRevision: ref.revision,
        locator: source.source.locator,
        baseRevision: source.source.revision,
        state: 'pending',
        createdAt: new Date(now).toISOString(),
      });
      return { reviewId: source.reviewId, receiptRef };
    };
  }
}
