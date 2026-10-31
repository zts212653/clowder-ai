import type { TaskItem } from '@cat-cafe/shared';
import type { ActionSuccessorLease } from '../ball-custody/action-successor-state-machine.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';

export interface ExactTaskExecutionControl {
  readonly parentInvocationId: string;
  readonly childInvocationId?: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
}

export interface ExactInvocationTracker {
  /** Current in-process slot owner, including pre-running admission. */
  getExecutionId?(threadId: string, catId: string): string | undefined;
  cancelExact(
    threadId: string,
    catId: string,
    executionId: string,
    requestUserId: string,
    abortReason: string,
  ): {
    state:
      | 'cancelled'
      | 'already_cancelled'
      | 'not_found'
      | 'user_mismatch'
      | 'execution_mismatch'
      | 'cancellation_conflict';
    cancelled: boolean;
    catIds: string[];
    executionIds?: string[];
  };
}

export interface TaskExecutionBindingCoordinates {
  readonly leaseId: string;
  readonly generation: number;
  readonly threadId: string;
  readonly catId: string;
}

export function taskExecutionTaskRef(task: TaskItem) {
  return {
    taskId: task.id,
    subjectRef: `task:work:${task.id}`,
    ownerRef: `task:item:${task.id}`,
    revision: task.entrustedWork?.revision ?? 1,
  };
}

export function taskExecutionIdentity(task: TaskItem) {
  return {
    tenantScope: task.userId ?? '',
    subjectRef: `subject:task:${task.id}`,
    actionFamily: 'implement' as const,
    successorSlot: 'implementer' as const,
  };
}

export function carrierForTaskLease(record: InvocationRecord, leaseId: string) {
  const carrier = record.actionLeaseCarrier;
  return carrier.kind === 'action_successor' && carrier.leaseId === leaseId ? carrier : null;
}

export function exactParentCat(record: InvocationRecord, lease: ActionSuccessorLease): string | null {
  const [holder] = lease.holderCatIds;
  return holder && record.targetCats.length === 1 && record.targetCats[0] === holder ? holder : null;
}

export function controlForTaskBindingRecord(
  record: InvocationRecord,
  binding: TaskExecutionBindingCoordinates,
  userId: string,
): ExactTaskExecutionControl | null {
  const carrier = carrierForTaskLease(record, binding.leaseId);
  if (
    !carrier ||
    carrier.generation !== binding.generation ||
    record.threadId !== binding.threadId ||
    record.userId !== userId ||
    record.targetCats.length !== 1 ||
    record.targetCats[0] !== binding.catId
  ) {
    return null;
  }
  return {
    parentInvocationId: record.id,
    threadId: binding.threadId,
    userId,
    catId: binding.catId,
  };
}

export function taskExecutionRefs(control: ExactTaskExecutionControl | undefined): string[] {
  return control ? [control.parentInvocationId, ...(control.childInvocationId ? [control.childInvocationId] : [])] : [];
}
