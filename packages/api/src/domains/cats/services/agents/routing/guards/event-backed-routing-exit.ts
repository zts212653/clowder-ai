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
    kind: 'pr_bot_interaction';
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

/**
 * F280 section 4b: the proof that an event will come back is an OPEN bot interaction turn —
 * this cat asked a known bot something, and a live subscription will wake it when the bot
 * answers or when the turn times out unanswered. Previously the proof was a typed
 * `pr_review_result_available` predicate the caller had to register by hand; the turn is the
 * same fact, produced by normalization instead of asked of the caller.
 */
function openBotTurnProof(
  active: AwaitStateV1,
  invocationId: string,
): { readonly triggerCommentId: number } | undefined {
  if (!active.continuation.when.some((predicate) => predicate.kind === 'pr_bot_interaction')) return undefined;
  const baseline = active.baseline;
  if (!('headSha' in baseline)) return undefined;
  // `shared-rules.md` 2b: the guard honours a wait belonging to THIS invocation/owner/thread/
  // subject. "Some pending summon exists on this PR" is not an exit — accepting that let a
  // foreign invocation clean-stop on a round it never opened.
  // The grant is the whole proof: a round carrying THIS invocation id was verified during THIS
  // invocation's registration, so it cannot be stale. Comparing it against `baseline.headSha`
  // additionally would compare it against a deliberately HELD frontier (section 2.5b) rather
  // than against the live HEAD, and reject a clean stop that was just earned. "Is this verdict
  // about the current diff" is a real question, but it belongs where the live HEAD is known
  // (F168 / CloudReviewObservation), not here.
  const openTurn = Object.values(baseline.botTurns ?? {}).find(
    (turn) => turn.triggerId > 0 && turn.grantInvocationId === invocationId,
  );
  return openTurn ? { triggerCommentId: openTurn.triggerId } : undefined;
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
    predicate.kind === 'pr_bot_interaction' &&
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
  if (!openBotTurnProof(active, input.invocationId)) return 'predicate_missing';
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
    const predicate = openBotTurnProof(active, input.invocationId);
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
            kind: 'pr_bot_interaction',
            triggerCommentId: predicate.triggerCommentId,
          },
        },
      };
    }
    firstReject ??= reason;
  }

  return { kind: 'reject', reason: firstReject ?? 'no_candidate' };
}
