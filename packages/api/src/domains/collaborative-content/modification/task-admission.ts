import { createHash } from 'node:crypto';
import { CONTENT_MODIFICATION_CLOSURES, contentModificationOutcome } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { EntrustedWorkLifecycleService } from '../../growing/EntrustedWorkLifecycleService.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { admissionSourceContext, assertDirectAdmissionSourceCustody } from './entrusted-work-source-custody.js';
import {
  type ContentModificationProgress,
  type ContentModificationRecord,
  modificationOperationKeys,
} from './journal.js';
import { ContentModificationJournalError } from './journal-errors.js';
import type { ModificationLabels } from './request-source.js';

export class ModificationAdmissionError extends Error {
  constructor(
    readonly code: 'needs_clarification' | 'task_changed' | 'source_not_ready',
    message: string = code,
  ) {
    super(message);
  }
}

/** New responsibility is admitted only against the already persisted human request. */
export async function admitModificationTask(
  deps: {
    messages: IMessageStore;
    tasks: Pick<ITaskStore, 'get' | 'getBySubject'>;
    lifecycle: EntrustedWorkLifecycleService;
    store?: ArtifactReviewStore;
  },
  record: ContentModificationRecord,
  labels: ModificationLabels,
): Promise<NonNullable<ContentModificationProgress['task']>> {
  const { sourceMessageId, prepared } = record.progress;
  if (!sourceMessageId || !prepared) throw new ModificationAdmissionError('source_not_ready');
  const keys = modificationOperationKeys(record.requestId);
  const admission = {
    basis: 'explicit_entrustment' as const,
    idempotencyKey: keys.admit,
    sourceRefs: [`message:${sourceMessageId}`],
    intendedOutcome: contentModificationOutcome(record.payload.intent),
  };
  const source = await assertDirectAdmissionSourceCustody(
    deps.messages,
    { userId: record.ownerUserId, threadId: record.payload.threadId },
    admission,
  );
  const context = record.payload.taskContext;
  if (context) {
    const existing = await deps.tasks.get(context.taskId);
    const rootKey = existing?.entrustedWork?.admission.idempotencyKey.match(
      /^f309-modification:([a-f0-9]{64}):admit$/,
    )?.[1];
    const original = rootKey ? deps.store?.requests.get(`f309-modification-${rootKey}`, record.ownerUserId) : undefined;
    if (
      !existing?.entrustedWork ||
      existing.entrustedWork.revision !== context.expectedTaskRevision ||
      existing.userId !== record.ownerUserId ||
      existing.threadId !== record.payload.threadId ||
      existing.ownerCatId !== record.payload.targetCatId ||
      existing.status === 'done' ||
      existing.entrustedWork.closure.state !== 'open'
    )
      throw new ModificationAdmissionError('task_changed');
    deps.store?.requests.cancellations.assertTaskAvailable(record.ownerUserId, context.taskId);
    if (original?.control && original.control.taskResolution !== 'preserved')
      throw new ContentModificationJournalError('task_cancellation_pending');
    return {
      taskId: existing.id,
      revision: existing.entrustedWork.revision,
      receiptRef: existing.entrustedWork.admission.receiptRef,
    };
  }
  const rule = record.payload.source.kind === 'workspace' ? 'file-writeback-applied' : 'published-result-ready';
  if (labels.completionRule !== rule) throw new ModificationAdmissionError('source_not_ready');
  const sourceRef = `message:${sourceMessageId}`;
  const time = record.payload.time;
  const result = await deps.lifecycle.admitOrResume(
    {
      task: {
        userId: record.ownerUserId,
        threadId: record.payload.threadId,
        ownerCatId: record.payload.targetCatId,
        createdBy: 'user',
        title: `修改《${labels.title.slice(0, 180)}》`,
        why: '按已确认的作品修改请求返回可审阅的结果',
      },
      admission,
      closure: {
        condition: CONTENT_MODIFICATION_CLOSURES[rule],
        expectedSignal: `${record.requestId}#${rule === 'published-result-ready' ? 'result-ready' : 'file-writeback-applied'}`,
      },
      artifactRefs: [
        prepared.kind === 'media' ? `content:${prepared.contentRef}` : `content-modification:${record.requestId}`,
      ],
      time: {
        ...(time?.businessDeadline ? { businessDeadline: { value: time.businessDeadline, sourceRef } } : {}),
        ...(time?.reviewBy ? { reviewBy: { value: time.reviewBy, sourceRef } } : {}),
      },
    },
    admissionSourceContext(source),
  );
  if (result.result === 'needs_clarification')
    throw new ModificationAdmissionError('needs_clarification', result.clarificationReason);
  const subjectKey = `entrusted:${createHash('sha256').update(keys.admit).digest('hex')}`;
  const task = await deps.tasks.getBySubject(subjectKey);
  if (
    !task?.entrustedWork ||
    task.userId !== record.ownerUserId ||
    task.ownerCatId !== record.payload.targetCatId ||
    task.threadId !== record.payload.threadId ||
    task.entrustedWork.admission.idempotencyKey !== keys.admit ||
    task.status === 'done' ||
    task.entrustedWork.closure.state !== 'open' ||
    result.ownerRef !== `task:item:${task.id}`
  )
    throw new ModificationAdmissionError('task_changed');
  return {
    taskId: task.id,
    revision: task.entrustedWork.revision,
    receiptRef: task.entrustedWork.admission.receiptRef,
  };
}
