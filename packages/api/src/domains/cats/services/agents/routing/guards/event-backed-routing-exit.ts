import type { PrEventWaitState, PrEventWaitUncoveredReason, TaskItem, TaskKind, TaskStatus } from '@cat-cafe/shared';
import type { ITaskStore } from '../../../stores/ports/TaskStore.js';

export type EventBackedRoutingExitRejectReason =
  | 'state_source_unavailable'
  | 'missing_invocation'
  | 'no_candidate'
  | 'task_done'
  | 'owner_mismatch'
  | 'thread_mismatch'
  | 'subject_mismatch'
  | 'invocation_mismatch'
  | 'intent_mismatch'
  | 'coverage_unconfirmed'
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
    intent: string | undefined;
  };
  eventWait: {
    invocationId: string;
    ownerCatId: string;
    threadId: string;
    subjectKey: string;
    coverageStatus: PrEventWaitState['coverage']['status'];
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
 * Consumer-side defense against a future resolver regression returning `bypass`
 * for stale or mismatched source state. The proof values are copied from the live
 * task and eventWait records, then independently checked at the side-effect boundary.
 */
export function isEventBackedRoutingBypassProofValid(
  resolution: EventBackedRoutingExitResolution,
  identity: EventBackedRoutingExitIdentity,
): boolean {
  if (resolution.kind !== 'bypass' || !identity.invocationId) return false;
  const { task, eventWait } = resolution.proof;
  return (
    task.kind === 'pr_tracking' &&
    task.status !== 'done' &&
    task.ownerCatId === identity.catId &&
    task.threadId === identity.threadId &&
    task.subjectKey === resolution.subjectKey &&
    task.intent === 'review' &&
    eventWait.invocationId === identity.invocationId &&
    eventWait.ownerCatId === identity.catId &&
    eventWait.threadId === identity.threadId &&
    eventWait.subjectKey === task.subjectKey &&
    eventWait.coverageStatus === 'covered'
  );
}

function isPrEventWaitState(value: unknown): value is PrEventWaitState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PrEventWaitState>;
  return (
    state.v === 1 &&
    typeof state.invocationId === 'string' &&
    typeof state.threadId === 'string' &&
    typeof state.ownerCatId === 'string' &&
    typeof state.subjectKey === 'string' &&
    state.expectedSignal === 'review_posted' &&
    isPrEventWaitCoverage(state.coverage)
  );
}

const PR_EVENT_WAIT_UNCOVERED_REASONS = new Set<PrEventWaitUncoveredReason>([
  'subject_mismatch',
  'not_review_trigger',
  'review_not_accepted',
  'feedback_already_posted',
]);

function isPrEventWaitCoverage(value: unknown): value is PrEventWaitState['coverage'] {
  if (!value || typeof value !== 'object') return false;
  const coverage = value as Record<string, unknown>;
  if (
    coverage.kind !== 'github_review_trigger_eyes' ||
    !Number.isSafeInteger(coverage.triggerCommentId) ||
    Number(coverage.triggerCommentId) <= 0 ||
    typeof coverage.observedAt !== 'number' ||
    !Number.isFinite(coverage.observedAt)
  ) {
    return false;
  }
  if (coverage.status === 'covered') return true;
  return (
    coverage.status === 'uncovered' &&
    typeof coverage.reason === 'string' &&
    PR_EVENT_WAIT_UNCOVERED_REASONS.has(coverage.reason as PrEventWaitUncoveredReason)
  );
}

function rejectCandidate(
  task: TaskItem,
  eventWait: PrEventWaitState,
  input: Omit<ResolveEventBackedRoutingExitInput, 'taskStore'> & { invocationId: string },
): EventBackedRoutingExitRejectReason | null {
  if (task.kind !== 'pr_tracking') return 'no_candidate';
  if (task.status === 'done') return 'task_done';
  if (task.ownerCatId !== input.catId || eventWait.ownerCatId !== input.catId) return 'owner_mismatch';
  if (task.threadId !== input.threadId || eventWait.threadId !== input.threadId) return 'thread_mismatch';
  if (!task.subjectKey || eventWait.subjectKey !== task.subjectKey) return 'subject_mismatch';
  if (eventWait.invocationId !== input.invocationId) return 'invocation_mismatch';
  if (task.automationState?.intent !== 'review') return 'intent_mismatch';
  if (eventWait.coverage.status !== 'covered') return 'coverage_unconfirmed';
  return null;
}

/**
 * Resolve an event-backed routing exit from live task state.
 *
 * Fail-closed by design: missing identity/store, malformed state, and store errors all
 * return a reject verdict so the caller keeps the original F177 remedial path.
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
    const eventWait = task.automationState?.eventWait;
    if (!isPrEventWaitState(eventWait)) continue;
    const reason = rejectCandidate(task, eventWait, {
      threadId: input.threadId,
      catId: input.catId,
      invocationId: input.invocationId,
    });
    if (!reason) {
      return {
        kind: 'bypass',
        taskId: task.id,
        subjectKey: eventWait.subjectKey,
        expectedSignal: eventWait.expectedSignal,
        proof: {
          task: {
            kind: task.kind,
            status: task.status,
            ownerCatId: task.ownerCatId,
            threadId: task.threadId,
            subjectKey: task.subjectKey,
            intent: task.automationState?.intent,
          },
          eventWait: {
            invocationId: eventWait.invocationId,
            ownerCatId: eventWait.ownerCatId,
            threadId: eventWait.threadId,
            subjectKey: eventWait.subjectKey,
            coverageStatus: eventWait.coverage.status,
          },
        },
      };
    }
    firstReject ??= reason;
  }

  return { kind: 'reject', reason: firstReject ?? 'no_candidate' };
}
