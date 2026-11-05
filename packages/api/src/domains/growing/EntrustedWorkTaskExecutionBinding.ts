import type { EntrustedWorkTaskExecutionV1, TaskItem } from '@cat-cafe/shared';
import type {
  ApprovedDelegate,
  TaskApprovedDelegateProvider,
} from '../ball-custody/action-subject-delegate-contract.js';
import {
  currentDelegateLineageGenerationHasExactEntry,
  delegateLineageHasProposalAnchor,
} from '../ball-custody/action-successor-delegate-lineage.js';
import type { ActionSuccessorLease } from '../ball-custody/action-successor-state-machine.js';

export type TaskExecutionBinding = NonNullable<Extract<EntrustedWorkTaskExecutionV1, { state: 'running' }>['binding']>;
export type TaskExecutionBindingResolution =
  | { readonly kind: 'ready'; readonly binding: TaskExecutionBinding }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'source_unavailable' };

function leaseMatchesTask(task: TaskItem, lease: ActionSuccessorLease): string | null {
  const [catId, secondCat] = lease.holderCatIds;
  return lease.tenantScope === task.userId &&
    lease.subjectRef === `subject:task:${task.id}` &&
    lease.actionFamily === 'implement' &&
    lease.successorSlot === 'implementer' &&
    lease.terminalPredicate?.kind === 'task_done' &&
    lease.terminalPredicate.subjectRef === `subject:task:${task.id}` &&
    catId &&
    !secondCat
    ? catId
    : null;
}

function leaseHasCurrentDelegateLineage(
  task: TaskItem,
  lease: ActionSuccessorLease,
  delegates: ReadonlyArray<ApprovedDelegate>,
): boolean {
  if (lease.claimOrigin !== 'structured_transfer' || !task.ownerCatId) return false;
  const route = {
    ownerCatId: task.ownerCatId,
    ownerThreadId: task.threadId,
    childThreadId: lease.holderThreadId,
  };
  if (!currentDelegateLineageGenerationHasExactEntry(lease, route)) return false;
  return delegates.some(
    (delegate) => delegate.threadId === lease.holderThreadId && delegateLineageHasProposalAnchor(lease, delegate),
  );
}

/** Resolve one exact canonical-owner or currently approved delegate lease. */
export async function resolveTaskExecutionBinding(
  task: TaskItem,
  lease: ActionSuccessorLease,
  delegateProvider?: TaskApprovedDelegateProvider,
): Promise<TaskExecutionBindingResolution> {
  const catId = leaseMatchesTask(task, lease);
  if (!catId) return { kind: 'mismatch' };
  const binding = {
    leaseId: lease.leaseId,
    generation: lease.generation,
    threadId: lease.holderThreadId,
    catId,
  };
  if (lease.holderThreadId === task.threadId && task.ownerCatId === catId) return { kind: 'ready', binding };
  if (!task.ownerCatId || !task.userId) return { kind: 'mismatch' };
  if (!delegateProvider) return { kind: 'source_unavailable' };

  let delegates: Awaited<ReturnType<TaskApprovedDelegateProvider['getForTask']>>;
  try {
    delegates = await delegateProvider.getForTask(
      task.id,
      task.threadId,
      task.ownerCatId,
      task.userId,
      task.entrustedWork?.developmentScope,
      task.title,
    );
  } catch {
    return { kind: 'source_unavailable' };
  }
  const delegate = delegates.find(
    (candidate) => candidate.catId === catId && candidate.threadId === lease.holderThreadId,
  );
  return (delegate && lease.evidenceRefs.includes(delegate.evidenceRef)) ||
    leaseHasCurrentDelegateLineage(task, lease, delegates)
    ? { kind: 'ready', binding }
    : { kind: 'mismatch' };
}
