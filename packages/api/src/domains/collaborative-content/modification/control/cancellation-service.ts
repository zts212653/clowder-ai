import { createHash } from 'node:crypto';
import type { ContentModificationRecord } from '@cat-cafe/shared';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { EntrustedWorkLifecycleService } from '../../../growing/EntrustedWorkLifecycleService.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import { modificationOperationKeys } from '../journal.js';

/** Cancelling a request persists first. Only a real F310 human disposition can cancel its sole new Task. */
export class ContentModificationCancellationService {
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      tasks: Pick<ITaskStore, 'get' | 'getBySubject'>;
      lifecycle: EntrustedWorkLifecycleService;
      onError: (error: unknown) => void;
      attemptBudgetMs?: number;
    },
  ) {}

  async cancel(requestId: string, ownerUserId: string) {
    const record = this.deps.store.requests.cancellations.cancel(requestId, ownerUserId);
    await this.attempt(record);
    return this.deps.store.requests.get(requestId, ownerUserId)!;
  }

  async recover() {
    // Distinct from admission recovery: bound review rows also need cancellation reconciliation.
    const until = Date.now() + 10000;
    for (const record of this.deps.store.requests.cancellations.pending()) {
      if (Date.now() >= until) break;
      await this.attempt(record);
    }
  }

  private async attempt(record: ContentModificationRecord) {
    if (!record.control || !['unknown', 'closing'].includes(record.control.taskResolution)) return;
    // Rotate before awaiting an external owner, including owners that never return.
    this.deps.store.requests.cancellations.observe(record.requestId, record.ownerUserId, {
      taskResolution: record.control.taskResolution,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.reconcile(record),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.deps.attemptBudgetMs ?? 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    // A late same-subject F310 receipt may still settle the journal; expiry never asserts "no Task".
  }

  private async reconcile(record: ContentModificationRecord) {
    const control = record.control;
    if (!control || !['unknown', 'closing'].includes(control.taskResolution)) return;
    const cancellations = this.deps.store.requests.cancellations;
    const observe = (patch: Parameters<typeof cancellations.observe>[2]) =>
      cancellations.observe(record.requestId, record.ownerUserId, patch);
    try {
      const keys = modificationOperationKeys(record.requestId);
      const context = record.payload.taskContext;
      const taskId = control.task?.taskId ?? record.progress.task?.taskId ?? context?.taskId;
      const task = taskId
        ? await this.deps.tasks.get(taskId)
        : await this.deps.tasks.getBySubject(`entrusted:${createHash('sha256').update(keys.admit).digest('hex')}`);
      if (!task) {
        observe({ taskResolution: 'unknown' });
        return;
      }
      if (
        task.userId !== record.ownerUserId ||
        task.threadId !== record.payload.threadId ||
        task.ownerCatId !== record.payload.targetCatId ||
        !task.entrustedWork ||
        (!context && task.entrustedWork.admission.idempotencyKey !== keys.admit)
      ) {
        observe({ taskResolution: 'owner_changed' });
        return;
      }
      // Persist the exact subject before the cross-owner call; later admissions cannot reuse a closing Task.
      const bound = cancellations.bindTask(record.requestId, record.ownerUserId, task.id, task.entrustedWork.revision);
      if (bound.control?.taskResolution !== 'closing' || !bound.control.task) return;
      const taskRef = bound.control.task;
      if (task.entrustedWork.closure.state !== 'open') {
        const closure = task.entrustedWork.closure;
        observe({
          taskResolution: 'closed',
          task: {
            ...taskRef,
            ...('disposition' in closure ? { dispositionRef: closure.disposition.dispositionRef } : {}),
          },
        });
        return;
      }
      const closed = await this.deps.lifecycle.close({
        taskId: task.id,
        expectedRevision: task.entrustedWork.revision,
        closure: {
          ...task.entrustedWork.closure,
          state: 'cancelled',
          disposition: {
            kind: 'cancelled',
            actorKind: 'human',
            actorRef: `user:${record.ownerUserId}`,
            authorityRef: control.receiptRef,
            dispositionRef: control.receiptRef,
            disposedAt: control.cancelledAt,
          },
        },
      });
      if (closed.entrustedWork?.closure.state === 'cancelled')
        observe({
          taskResolution: 'closed',
          task: {
            ...taskRef,
            observedRevision: closed.entrustedWork.revision,
            dispositionRef: closed.entrustedWork.closure.disposition.dispositionRef,
          },
        });
    } catch (error) {
      // Unknown is durable. Neither a lease timeout nor a missing subject proves no Task was admitted.
      this.deps.onError(error);
      const latest = this.deps.store.requests.get(record.requestId, record.ownerUserId)?.control;
      if (latest && ['unknown', 'closing'].includes(latest.taskResolution))
        observe({ taskResolution: latest.taskResolution }); // Rotate a failed lookup through the bounded sweep too.
    }
  }
}
