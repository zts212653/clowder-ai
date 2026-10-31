import type { ContentModificationRecord, TaskItem } from '@cat-cafe/shared';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';

/** A continuation may keep A's Task signal while B supplies its actual adopted result. */
export function textCompletionTaskBinding(
  store: ArtifactReviewStore,
  record: ContentModificationRecord,
  task: TaskItem | null,
) {
  if (
    !task?.entrustedWork ||
    task.userId !== record.ownerUserId ||
    task.threadId !== record.payload.threadId ||
    task.ownerCatId !== record.payload.targetCatId ||
    task.status === 'done' ||
    task.entrustedWork.closure.state !== 'open'
  )
    return null;
  const expectedSignal = task.entrustedWork.closure.expectedSignal;
  const closureRequestId = expectedSignal?.match(/^(f309-modification-[a-f0-9]{64})#file-writeback-applied$/)?.[1];
  if (!closureRequestId) return null;
  const admitted = store.requests.get(closureRequestId, record.ownerUserId);
  const rootFile = store.text.source(closureRequestId);
  const currentFile = store.text.source(record.requestId);
  if (
    !admitted ||
    admitted.payload.source.kind !== 'workspace' ||
    admitted.progress.prepared?.kind !== 'text' ||
    admitted.progress.task?.taskId !== task.id ||
    admitted.payload.threadId !== task.threadId ||
    admitted.progress.task.receiptRef !== task.entrustedWork.admission.receiptRef ||
    record.progress.task?.receiptRef !== task.entrustedWork.admission.receiptRef ||
    !rootFile ||
    !currentFile ||
    rootFile.ownerUserId !== currentFile.ownerUserId ||
    rootFile.source.contentRef !== currentFile.source.contentRef
  )
    return null;
  if (
    record.requestId !== closureRequestId &&
    (record.payload.taskContext?.kind !== 'text' || record.payload.taskContext.taskId !== task.id)
  )
    return null;
  if (admitted.control && admitted.control.taskResolution !== 'preserved') return null;
  return { closureRequestId, expectedSignal };
}
