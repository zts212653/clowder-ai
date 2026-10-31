import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import { MediaOwnerError } from '../../../video-studio/content-owner/media-errors.js';
import { WorkspaceWritebackError } from '../../../workspace/writeback/journal.js';
import type { WorkspaceWritebackService } from '../../../workspace/writeback/service.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import { assertModificationSourceAuthority, requireModificationSourceMessage } from '../request-authority.js';
import { textCompletionTaskBinding } from './text-completion-task-binding.js';
import { type TextWritebackCompletionIntent, textCompletionBinding } from './text-writeback-completion-intent.js';

/** Reconciles real text effects into the original return outbox. It cannot write files or close Tasks. */
export class TextWritebackCompletionService {
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      tasks: Pick<ITaskStore, 'get'>;
      messages: Pick<IMessageStore, 'getById'>;
      writer: Pick<WorkspaceWritebackService, 'findApplied'>;
    },
  ) {}

  async recordApplied(requestId: string, ownerUserId: string, writebackReceiptRef: string): Promise<void> {
    const revision = this.deps.store.requests.get(requestId, ownerUserId)?.revision;
    if (revision === undefined) return;
    const intent = await this.currentIntent(requestId, ownerUserId, writebackReceiptRef);
    if (!intent) return;
    this.deps.store.returns.recordTextCompletion(intent, revision);
  }

  async isCurrent(intent: TextWritebackCompletionIntent): Promise<boolean> {
    const current = await this.currentIntent(intent.requestId, intent.ownerUserId, intent.writebackReceiptRef);
    if (!current) return false;
    return isDeepStrictEqual(textCompletionBinding(intent), textCompletionBinding(current));
  }

  private async currentIntent(
    requestId: string,
    ownerUserId: string,
    writebackReceiptRef: string,
  ): Promise<TextWritebackCompletionIntent | null> {
    const record = this.deps.store.requests.get(requestId, ownerUserId);
    if (
      !record ||
      record.control ||
      record.progress.prepared?.kind !== 'text' ||
      record.payload.source.kind !== 'workspace'
    )
      return null;
    const source = this.deps.store.text.source(requestId);
    const acceptance = this.deps.store.acceptances
      .list(requestId, ownerUserId)
      .find((item) => item.fileReceiptRef === writebackReceiptRef);
    const proposal =
      acceptance &&
      this.deps.store.text.proposals(requestId).find((item) => item.proposalRef === acceptance.candidateRef);
    if (
      !acceptance ||
      !source ||
      source.ownerUserId !== ownerUserId ||
      !proposal ||
      proposal.authorCatId !== record.payload.targetCatId ||
      proposal.baseRevision !== source.source.revision
    )
      return null;
    try {
      await assertModificationSourceAuthority(this.deps.messages, record);
      const original = await requireModificationSourceMessage(this.deps.messages, record);
      const audience =
        record.progress.sourceVisibility ??
        (original.visibility === 'whisper'
          ? { visibility: 'whisper' as const, whisperTo: original.whisperTo ?? [] }
          : { visibility: 'public' as const });
      if (audience.visibility === 'whisper' && !audience.whisperTo.includes(record.payload.targetCatId)) return null;
      const receipt = await this.deps.writer.findApplied(writebackReceiptRef, { userId: ownerUserId });
      if (
        !receipt ||
        receipt.state !== 'applied' ||
        !receipt.writtenRevision ||
        typeof receipt.appliedAt !== 'number' ||
        receipt.ownerUserId !== ownerUserId ||
        receipt.requestId !== requestId ||
        receipt.candidateRef !== acceptance.candidateRef ||
        receipt.acceptOperationId !== acceptance.acceptOperationId ||
        receipt.baseRevision !== acceptance.baseRevision ||
        receipt.candidateRevision !== proposal.resultRevision ||
        receipt.writtenRevision !== receipt.candidateRevision ||
        !isDeepStrictEqual(receipt.locator, acceptance.locator) ||
        !isDeepStrictEqual(acceptance.locator, record.payload.source.locator)
      )
        return null;
      const taskId = record.progress.task?.taskId;
      const task = taskId ? await this.deps.tasks.get(taskId) : null;
      const binding = textCompletionTaskBinding(this.deps.store, record, task);
      if (!binding || !task?.entrustedWork || !record.progress.sourceMessageId) return null;
      return {
        kind: 'text_writeback_completion',
        receiptRef: `f309-text-writeback:${createHash('sha256')
          .update(JSON.stringify([requestId, acceptance.humanReceiptRef, writebackReceiptRef]))
          .digest('hex')}`,
        requestId,
        sourceMessageId: record.progress.sourceMessageId,
        ownerUserId,
        threadId: record.payload.threadId,
        taskId: task.id,
        targetCatId: record.payload.targetCatId,
        observedTaskRevision: task.entrustedWork.revision,
        ...binding,
        candidateRef: acceptance.candidateRef,
        humanReceiptRef: acceptance.humanReceiptRef,
        writebackReceiptRef,
        writtenRevision: receipt.writtenRevision,
        audience,
        createdAt: new Date(receipt.appliedAt).toISOString(),
        state: 'pending',
      };
    } catch (error) {
      if (error instanceof MediaOwnerError && error.code === 'access_denied') return null;
      if (error instanceof WorkspaceWritebackError && error.code === 'access_denied') return null;
      throw error;
    }
  }
}
