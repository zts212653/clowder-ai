import type {
  ContentModificationRecord,
  ContentModificationRequestView,
  ContentModificationTakeover,
} from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../../video-studio/content-owner/published-media-access.js';
import { WorkspaceContentReviewError } from '../../workspace-review/errors.js';
import type {
  ProjectMessageGrantWitness,
  ProjectMessageTakeoverGrantPort,
} from '../../workspace-review/project-message/cat-grants.js';
import {
  ContentModificationJournalError,
  modificationMessageRequestId,
  modificationOperationKeys,
} from '../journal.js';
import { admitModificationTask } from '../task-admission.js';
import { validateProjectTakeoverRecord } from './record.js';
import { bindProjectTakeoverReview } from './review-binding.js';
import { resolveProjectMessageTakeover } from './source.js';
import type { ProjectCatPrincipal, ProjectMessageTakeoverDeps, ProjectMessageTakeoverPort } from './types.js';

/** Actual explicit Cat takeover continues the existing canonical F309 journal; importing a mark never calls this service. */
export class ProjectMessageTakeoverService implements ProjectMessageTakeoverPort, ProjectMessageTakeoverGrantPort {
  constructor(private readonly deps: ProjectMessageTakeoverDeps) {}

  resolve(input: ContentModificationTakeover, principal: ProjectCatPrincipal, existing?: ContentModificationRecord) {
    return resolveProjectMessageTakeover(this.deps, input, principal, existing);
  }

  async read(
    record: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<ContentModificationRequestView> {
    if (
      principal.actor.kind !== 'human' ||
      principal.actor.actorId !== record.ownerUserId ||
      principal.userId !== record.ownerUserId
    )
      throw new WorkspaceContentReviewError('access_denied');
    await validateProjectTakeoverRecord(this.deps, record, 'read');
    return this.view(record);
  }

  async resume(
    initial: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<ContentModificationRequestView> {
    if (
      principal.userId !== initial.ownerUserId ||
      principal.actor.kind !== 'human' ||
      principal.actor.actorId !== principal.userId
    )
      throw new WorkspaceContentReviewError('access_denied');
    const journal = this.deps.store.requests;
    const lease = journal.acquire(initial.requestId, initial.ownerUserId);
    if (!lease) return this.read(journal.get(initial.requestId, initial.ownerUserId) ?? initial, principal);
    let record = lease.record;
    try {
      const source = record.payload.source;
      if (source.kind !== 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
      await validateProjectTakeoverRecord(this.deps, record);
      const target = await this.deps.authorizeTarget(record.payload, record.ownerUserId);
      const frozen = await this.deps.projects.load({
        principal,
        contentRef: source.contentRef,
        ownerRevision: source.input.ownerRevision,
      });
      if (!record.progress.prepared)
        record = journal.advance(record.requestId, lease.token, {
          prepared: {
            kind: 'project',
            contentRef: source.contentRef,
            ownerRevision: source.input.ownerRevision,
            ledgerRef: source.reviewId,
          },
        });
      if (!record.progress.task) {
        await validateProjectTakeoverRecord(this.deps, record);
        const task = await admitModificationTask(this.deps, record, {
          ...target,
          title: frozen.document.title,
          completionRule: 'published-result-ready',
        });
        record = journal.advance(record.requestId, lease.token, { task });
      }
      await this.requireTask(record);
      await validateProjectTakeoverRecord(this.deps, record);
      await this.requireTask(record);
      if (!record.progress.review)
        record = journal.bindReview(record.requestId, lease.token, () => bindProjectTakeoverReview(this.deps, record));
      return this.view(record);
    } catch (error) {
      this.recordIssue(record, lease.token, error);
      this.deps.onError(error);
      throw error;
    } finally {
      journal.release(initial.requestId, lease.token);
    }
  }

  async authorizeCommand(requestId: string, principal: ProjectCatPrincipal) {
    const record = this.deps.store.requests.get(requestId, principal.userId);
    if (!record || record.payload.source.kind !== 'video-project' || !record.progress.sourceMessageId)
      throw new WorkspaceContentReviewError('not_found');
    await this.resolve(
      { sourceMessageId: record.progress.sourceMessageId, operationId: record.payload.operationId },
      principal,
      record,
    );
    const accepted = await this.hasGrant({
      principal,
      contentRef: record.payload.source.contentRef,
      threadId: principal.threadId,
      sourceMessageId: record.progress.sourceMessageId,
      sourceMessageRevision: record.progress.sourceMessageRevision ?? '',
      annotationIds: record.payload.source.annotationIds,
    });
    if (!accepted) throw new WorkspaceContentReviewError('access_denied');
    return record;
  }

  /** The internally resumed Human view is never sent as the Cat's ledger audience. */
  async viewForCat(record: ContentModificationRecord, principal: ProjectCatPrincipal) {
    const accepted = await this.authorizeCommand(record.requestId, principal);
    if (accepted.payload.source.kind !== 'video-project') throw new WorkspaceContentReviewError('not_found');
    const view = await this.deps.importer.reviews.read({ principal, reviewId: accepted.payload.source.reviewId });
    const current = await this.authorizeCommand(record.requestId, principal);
    if (current.payload.source.kind !== 'video-project') throw new WorkspaceContentReviewError('not_found');
    return projectModificationView({
      ...current,
      payload: {
        ...current.payload,
        source: { ...current.payload.source, expectedReviewRevision: view.review.revision },
      },
    });
  }

  async hasGrant(witness: ProjectMessageGrantWitness): Promise<boolean> {
    const record = this.deps.store.requests.get(
      modificationMessageRequestId(witness.principal.userId, witness.sourceMessageId),
      witness.principal.userId,
    );
    if (
      !record ||
      record.control ||
      record.issue ||
      record.payload.source.kind !== 'video-project' ||
      record.payload.source.contentRef !== witness.contentRef ||
      record.payload.targetCatId !== witness.principal.actor.actorId ||
      record.payload.threadId !== witness.threadId ||
      record.progress.sourceMessageRevision !== witness.sourceMessageRevision ||
      !record.progress.review ||
      record.progress.prepared?.kind !== 'project' ||
      record.progress.prepared.contentRef !== witness.contentRef ||
      record.progress.prepared.ownerRevision !== record.payload.source.input.ownerRevision ||
      record.progress.prepared.ledgerRef !== record.payload.source.reviewId ||
      !record.payload.source.annotationIds.every((id) => witness.annotationIds.includes(id))
    )
      return false;
    try {
      await this.requireTask(record);
      await validateProjectTakeoverRecord(this.deps, record);
      await this.requireTask(record);
      const receipt = this.deps.store.ledgers.operationReceipt(
        record.payload.source.reviewId,
        modificationOperationKeys(record.requestId).request,
      );
      return Boolean(
        receipt &&
          receipt.receiptRef === record.progress.review.receiptRef &&
          receipt.reviewId === record.progress.review.reviewId &&
          receipt.actor.kind === 'cat' &&
          receipt.actor.actorId === record.payload.targetCatId &&
          receipt.preparationSource?.messageId === witness.sourceMessageId &&
          receipt.preparationSource.messageRevision === witness.sourceMessageRevision,
      );
    } catch (error) {
      if (['access_denied', 'source_changed', 'task_changed', 'not_found'].includes(errorCode(error))) return false;
      throw error;
    }
  }

  private recordIssue(record: ContentModificationRecord, token: string, error: unknown) {
    const journal = this.deps.store.requests;
    const code = errorCode(error);
    // Permission/source changes remain visible and terminal; transient owner errors recover from the original durable request.
    const retryable = ![
      'access_denied',
      'source_changed',
      'task_changed',
      'not_found',
      'invalid_action',
      'operation_reused',
    ].includes(code);
    try {
      journal.noteIssue(record.requestId, token, { code, retryable });
    } catch (leaseError) {
      if (!(leaseError instanceof ContentModificationJournalError) || leaseError.code !== 'lease_changed')
        throw leaseError;
    }
  }

  private async requireTask(record: ContentModificationRecord) {
    const task = record.progress.task && (await this.deps.tasks.get(record.progress.task.taskId));
    if (
      !task?.entrustedWork ||
      task.userId !== record.ownerUserId ||
      task.ownerCatId !== record.payload.targetCatId ||
      task.threadId !== record.payload.threadId ||
      task.status === 'done' ||
      task.entrustedWork.closure.state !== 'open' ||
      task.entrustedWork.admission.idempotencyKey !== modificationOperationKeys(record.requestId).admit ||
      task.entrustedWork.admission.receiptRef !== record.progress.task?.receiptRef
    )
      throw new WorkspaceContentReviewError('source_changed');
  }

  private view(record: ContentModificationRecord): ContentModificationRequestView {
    return projectModificationView(record);
  }
}
function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'recovery_pending';
}

export function projectModificationView(record: ContentModificationRecord): ContentModificationRequestView {
  if (record.control) return { record, stage: 'cancelled' };
  if (!record.progress.prepared) return { record, stage: 'preparing_content' };
  if (!record.progress.task) return { record, stage: 'admitting_task' };
  if (!record.progress.review) return { record, stage: 'binding_request' };
  return { record, stage: 'accepted' };
}
