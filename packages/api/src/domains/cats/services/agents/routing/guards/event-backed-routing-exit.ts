import type { AwaitStateV1, TaskItem, TaskKind, TaskStatus } from '@cat-cafe/shared';
import type { ITaskStore } from '../../../stores/ports/TaskStore.js';

export type EventBackedRoutingExitRejectReason =
  | 'state_source_unavailable'
  | 'missing_invocation'
  | 'no_candidate'
  | 'task_done'
  | 'owner_mismatch'
  | 'thread_mismatch'
  | 'subject_mismatch'
  | 'generation_mismatch'
  | 'predicate_missing'
  | 'query_failed';

export type EventBackedRoutingExitResolution =
  | {
      kind: 'bypass';
      taskId: string;
      subjectKey: string;
      expectedSignal: 'review_posted';
      proof: EventBackedRoutingExitProof;
    }
  | { kind: 'reject'; reason: EventBackedRoutingExitRejectReason };

export interface EventBackedRoutingExitProof {
  task: {
    kind: TaskKind;
    status: TaskStatus;
    ownerCatId: string | null;
    threadId: string;
    subjectKey: string | null;
    generation: number;
  };
  predicate: {
    kind: 'pr_review_result_available';
    triggerCommentId: number;
  };
}

interface ResolveEventBackedRoutingExitInput {
  taskStore: Pick<ITaskStore, 'listByThread'> | undefined;
  threadId: string;
  catId: string;
  invocationId: string | undefined;
}

type EventBackedRoutingExitIdentity = Omit<ResolveEventBackedRoutingExitInput, 'taskStore'>;

function reviewResultPredicate(active: AwaitStateV1) {
  return active.continuation.when.find(
    (
      predicate,
    ): predicate is Extract<AwaitStateV1['continuation']['when'][number], { kind: 'pr_review_result_available' }> & {
      triggerCommentId: number;
    } => predicate.kind === 'pr_review_result_available' && predicate.triggerCommentId !== undefined,
  );
}

export function isEventBackedRoutingBypassProofValid(
  resolution: EventBackedRoutingExitResolution,
  identity: EventBackedRoutingExitIdentity,
): boolean {
  if (resolution.kind !== 'bypass' || !identity.invocationId) return false;
  const { task, predicate } = resolution.proof;
  return (
    task.kind === 'pr_tracking' &&
    task.status !== 'done' &&
    task.ownerCatId === identity.catId &&
    task.threadId === identity.threadId &&
    task.subjectKey === resolution.subjectKey &&
    task.generation > 0 &&
    predicate.kind === 'pr_review_result_available' &&
    Number.isSafeInteger(predicate.triggerCommentId) &&
    predicate.triggerCommentId > 0
  );
}

function rejectCandidate(
  task: TaskItem,
  active: AwaitStateV1,
  input: Omit<ResolveEventBackedRoutingExitInput, 'taskStore'> & { invocationId: string },
): EventBackedRoutingExitRejectReason | null {
  if (task.kind !== 'pr_tracking') return 'no_candidate';
  if (task.status === 'done') return 'task_done';
  if (task.ownerCatId !== input.catId) return 'owner_mismatch';
  if (task.threadId !== input.threadId) return 'thread_mismatch';
  if (!task.subjectKey || active.subjectRef !== task.subjectKey) return 'subject_mismatch';
  if (active.ownerFence.kind !== 'containing_task' || active.ownerFence.generation !== active.generation) {
    return 'generation_mismatch';
  }
  if (!reviewResultPredicate(active)) return 'predicate_missing';
  return null;
}

/**
 * Resolve an invocation exit from the live typed wait.
 *
 * Coverage is verified by the registration route before this state exists. The
 * wait never copies invocation/cat/thread identity; this resolver binds the
 * authenticated invocation to the containing task at read time.
 */
export async function resolveEventBackedRoutingExit(
  input: ResolveEventBackedRoutingExitInput,
): Promise<EventBackedRoutingExitResolution> {
  if (!input.taskStore) return { kind: 'reject', reason: 'state_source_unavailable' };
  if (!input.invocationId) return { kind: 'reject', reason: 'missing_invocation' };

  let tasks: TaskItem[];
  try {
    tasks = await input.taskStore.listByThread(input.threadId);
  } catch {
    return { kind: 'reject', reason: 'query_failed' };
  }

  let firstReject: EventBackedRoutingExitRejectReason | null = null;
  for (const task of tasks) {
    const active = task.automationState?.await;
    if (!active) continue;
    const reason = rejectCandidate(task, active, {
      threadId: input.threadId,
      catId: input.catId,
      invocationId: input.invocationId,
    });
    const predicate = reviewResultPredicate(active);
    if (!reason && predicate) {
      return {
        kind: 'bypass',
        taskId: task.id,
        subjectKey: active.subjectRef,
        expectedSignal: 'review_posted',
        proof: {
          task: {
            kind: task.kind,
            status: task.status,
            ownerCatId: task.ownerCatId,
            threadId: task.threadId,
            subjectKey: task.subjectKey,
            generation: active.generation,
          },
          predicate: {
            kind: predicate.kind,
            triggerCommentId: predicate.triggerCommentId,
          },
        },
      };
    }
    firstReject ??= reason;
  }

  return { kind: 'reject', reason: firstReject ?? 'no_candidate' };
}
