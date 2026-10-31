import type { ActionSuccessorLease } from '../ball-custody/action-successor-state-machine.js';
import type { IInvocationRecordStore, InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { ITurnExecutionStore, TurnExecutionRecord } from '../cats/services/stores/ports/TurnExecutionStore.js';
import {
  carrierForTaskLease,
  type ExactTaskExecutionControl,
  exactParentCat,
} from './EntrustedWorkTaskExecutionEvidence.js';

export type TaskExecutionCandidate = ExactTaskExecutionControl & {
  readonly reason: 'exact_parent_running' | 'exact_child_running';
  readonly generation: number;
};

type CandidateFailure = 'execution_truth_unavailable' | 'carrier_generation_mismatch' | 'binding_task_mismatch';

export type TaskExecutionCandidateResult =
  | { readonly kind: 'ready'; readonly candidates: Map<string, TaskExecutionCandidate> }
  | { readonly kind: 'failed'; readonly reason: CandidateFailure };

function addParentCandidates(
  userId: string,
  lease: ActionSuccessorLease,
  runningParents: readonly InvocationRecord[],
  candidates: Map<string, TaskExecutionCandidate>,
): Exclude<CandidateFailure, 'execution_truth_unavailable'> | null {
  for (const record of runningParents) {
    const carrier = carrierForTaskLease(record, lease.leaseId);
    if (!carrier) continue;
    const catId = exactParentCat(record, lease);
    if (carrier.generation !== lease.generation) return 'carrier_generation_mismatch';
    if (!catId) return 'binding_task_mismatch';
    candidates.set(`${record.id}\u0000${catId}`, {
      parentInvocationId: record.id,
      threadId: lease.holderThreadId,
      userId,
      catId,
      reason: 'exact_parent_running',
      generation: carrier.generation,
    });
  }
  return null;
}

async function addChildCandidates(
  userId: string,
  lease: ActionSuccessorLease,
  runningChildren: readonly TurnExecutionRecord[],
  invocationRecords: Pick<IInvocationRecordStore, 'get'>,
  candidates: Map<string, TaskExecutionCandidate>,
): Promise<CandidateFailure | null> {
  const sameThreadChildren = runningChildren.filter(
    (child) => child.threadId === lease.holderThreadId && child.userId === userId && child.status === 'running',
  );
  const parentIds = [...new Set(sameThreadChildren.map((child) => child.parentInvocationId))];
  let parentRecords: Array<InvocationRecord | null>;
  try {
    parentRecords = await Promise.all(parentIds.map((id) => invocationRecords.get(id)));
  } catch {
    return 'execution_truth_unavailable';
  }
  const parentsById = new Map(parentIds.map((id, index) => [id, parentRecords[index] ?? null]));
  if (sameThreadChildren.some((child) => !parentsById.get(child.parentInvocationId))) {
    return 'execution_truth_unavailable';
  }

  for (const child of sameThreadChildren) {
    const parent = parentsById.get(child.parentInvocationId);
    if (!parent) continue;
    const carrier = carrierForTaskLease(parent, lease.leaseId);
    if (!carrier) continue;
    if (carrier.generation !== lease.generation) return 'carrier_generation_mismatch';
    const parentCatId = exactParentCat(parent, lease);
    if (
      parent.threadId !== lease.holderThreadId ||
      parent.userId !== userId ||
      !parentCatId ||
      child.catId !== parentCatId
    ) {
      return 'binding_task_mismatch';
    }
    candidates.set(`${parent.id}\u0000${child.catId}`, {
      parentInvocationId: parent.id,
      childInvocationId: child.invocationId,
      threadId: lease.holderThreadId,
      userId,
      catId: child.catId,
      reason: 'exact_child_running',
      generation: carrier.generation,
    });
  }
  return null;
}

export async function collectTaskExecutionCandidates(input: {
  readonly userId: string;
  readonly lease: ActionSuccessorLease;
  readonly invocationRecords: Pick<IInvocationRecordStore, 'listRunningByThread' | 'get'>;
  readonly turnExecutions: Pick<ITurnExecutionStore, 'listRunningByUser'>;
}): Promise<TaskExecutionCandidateResult> {
  let runningParents: InvocationRecord[];
  let runningChildren: TurnExecutionRecord[];
  try {
    [runningParents, runningChildren] = await Promise.all([
      input.invocationRecords.listRunningByThread(input.lease.holderThreadId, input.userId),
      input.turnExecutions.listRunningByUser(input.userId),
    ]);
  } catch {
    return { kind: 'failed', reason: 'execution_truth_unavailable' };
  }

  const candidates = new Map<string, TaskExecutionCandidate>();
  const parentFailure = addParentCandidates(input.userId, input.lease, runningParents, candidates);
  if (parentFailure) return { kind: 'failed', reason: parentFailure };
  const childFailure = await addChildCandidates(
    input.userId,
    input.lease,
    runningChildren,
    input.invocationRecords,
    candidates,
  );
  return childFailure ? { kind: 'failed', reason: childFailure } : { kind: 'ready', candidates };
}
