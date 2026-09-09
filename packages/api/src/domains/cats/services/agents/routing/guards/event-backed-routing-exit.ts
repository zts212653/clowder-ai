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
 * F280 section 4b closed this exit, and this is the honest shape of that.
 *
 * The proof used to be a `pr_review_result_available` predicate the registering invocation
 * declared by hand — "I asked codex in comment N" — coverage-verified at the registration
 * route before it was stored. Whatever else that was, it was the invocation's OWN act.
 * #1394 retired `when` from the registration surface, so no caller can declare it any more.
 *
 * The replacement tried here was an open bot round in the tracking baseline. It does not carry
 * the same fact. A round belongs to the tracking OWNER, not to an invocation, so any later
 * invocation of the same cat could clean-stop on a round it never opened. Stamping the
 * registering invocation onto the round only moved the lie one level down: registration probed
 * HISTORY, so the stamp landed on a summon written by an earlier turn.
 *
 * F280 section 4b therefore forbids F177 from taking its exit credential out of tracking at
 * all — "a tracker exists in this thread" was never an exit, and borrowing from tracking is
 * how it becomes one again. Until F177 carries an invocation-owned credential of its own,
 * there is no proof to find and this resolver fails closed: the cat holds the ball instead of
 * clean-stopping. One held ball is the cheap side of this trade; a false bypass is a turn that
 * ends with nobody holding anything.
 *
 * `bypass` and `isEventBackedRoutingBypassProofValid` are not deleted, but they are not a
 * standing safeguard either — see the seal on the validator itself. This exit is closed with no
 * conditions attached: `bypass_total` and `false_bypass_total` both read zero, and the second
 * one is what would break if any path ever synthesized a bypass anyway.
 */

/**
 * SEALED. Every bypass is invalid, and it has to be this function that says so.
 *
 * sol R25 executed the counterexample the previous version of this file only claimed to guard:
 * one hand-built proof, two different `invocationId`s, both `true`. That is not a bug in the
 * field list — the proof has no invocation field at all, so no amount of checking task, thread,
 * cat or subject can answer "does an event come back to THIS invocation". Invocation binding was
 * exactly what `grantInvocationId` pretended to supply, and #1394 deleted it for lying.
 *
 * So "the false-bypass invariant stays armed" was the wrong reading of my own code: a validator
 * that accepts an unbindable proof does not arm anything, it pre-approves the next reintroduction
 * of the same hole. Sealing it inverts that. `resolveEventBackedRoutingExit` already rejects
 * everything, so nothing reaches here today; if some future path ever synthesizes a `bypass`,
 * this returns false, `event_wait.false_bypass_total` fires, and F192 raises it as the
 * zero-tolerance regression it would be.
 *
 * Unsealing is not "restore the field list". It requires a server-issued coordination credential
 * that F177 owns and that names the invocation it was issued to — and the checks then belong to
 * THAT credential, not to this shape. The parameters stay so the seam and its call site keep
 * their types while the door is shut.
 */
export function isEventBackedRoutingBypassProofValid(
  _resolution: EventBackedRoutingExitResolution,
  _identity: EventBackedRoutingExitIdentity,
): boolean {
  return false;
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
  return 'predicate_missing';
}

/**
 * Resolve an invocation exit from the live typed wait — which, since F280 section 4b, is always
 * a rejection.
 *
 * Registration no longer verifies coverage of anything: the EYES verifier and the whole typed
 * `when` surface are gone. What survives here is ownership accounting, so the bounded reject
 * reason still distinguishes "no candidate at all" from "the candidate belonged to another cat".
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

  // The ownership checks still run and still report which one failed: "there was no candidate
  // at all" and "the candidate belonged to another cat" are different operational facts, and
  // collapsing them would hide a real misrouting behind the closed exit.
  let firstReject: EventBackedRoutingExitRejectReason | null = null;
  for (const task of tasks) {
    const active = task.automationState?.await;
    if (!active) continue;
    firstReject ??= rejectCandidate(task, active, {
      threadId: input.threadId,
      catId: input.catId,
      invocationId: input.invocationId,
    });
  }

  return { kind: 'reject', reason: firstReject ?? 'no_candidate' };
}
