import {
  parseWaitContinuationCarrier,
  type TaskItem,
  type WaitContinuationCarrierV1,
  type WaitOwnerFence,
} from '@cat-cafe/shared';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';
import { isSystemUserMessage } from '../cats/services/stores/visibility.js';
import type { ActionSuccessorLeaseStore, ActionSuccessorOutputPreflightResult } from './ActionSuccessorLeaseStore.js';

export type RetryAuthorityFailureReason =
  | 'message_missing'
  | 'authority_witness_changed'
  | 'legacy_unattributed'
  | 'invalid_wait_carrier'
  | 'task_missing'
  | 'task_identity_mismatch'
  | 'outcome_mismatch'
  | 'owner_mismatch'
  | 'lease_missing'
  | 'stale_generation'
  | 'lease_not_active'
  | 'holder_not_assigned'
  | 'holder_terminal'
  | 'subject_terminal';

export type RetryAuthorityDecision =
  | { readonly ok: true; readonly kind: 'user' | 'wait_containing_task' | 'wait_action_successor' }
  | { readonly ok: false; readonly reason: RetryAuthorityFailureReason };

export type RetryAuthorityMessageSubject =
  | { readonly ok: true; readonly kind: 'user' }
  | { readonly ok: true; readonly kind: 'wait'; readonly carrier: WaitContinuationCarrierV1 }
  | { readonly ok: false; readonly reason: RetryAuthorityFailureReason };

export interface WaitContinuationRetryPreflightDeps {
  readonly taskStore: Pick<ITaskStore, 'get'>;
  readonly actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'preflightOutput'>;
}

export interface WaitContinuationRetryPreflightInput {
  readonly message: Pick<StoredMessage, 'catId' | 'source' | 'sourceParseFailure' | 'threadId' | 'userId'>;
  readonly requestingUserId: string;
  readonly targetCatId: string;
}

function ownerFencesMatch(left: WaitOwnerFence, right: WaitOwnerFence): boolean {
  if (left.kind !== right.kind || left.generation !== right.generation) return false;
  return left.kind === 'containing_task' || (right.kind === 'action_successor' && left.leaseId === right.leaseId);
}

export function resolveRetryAuthorityMessageSubject(
  input: WaitContinuationRetryPreflightInput,
): RetryAuthorityMessageSubject {
  if (
    input.message.catId === null &&
    !input.message.source &&
    !input.message.sourceParseFailure &&
    !isSystemUserMessage(input.message) &&
    input.message.userId === input.requestingUserId
  ) {
    return { ok: true, kind: 'user' };
  }
  if (input.message.source?.connector !== 'github-wait') {
    return { ok: false, reason: 'legacy_unattributed' };
  }
  const carrier = parseWaitContinuationCarrier(input.message.source.meta?.waitContinuationCarrier);
  if (!carrier) return { ok: false, reason: 'invalid_wait_carrier' };
  return { ok: true, kind: 'wait', carrier };
}

export function evaluateWaitRetryAuthoritySnapshot(input: {
  readonly request: WaitContinuationRetryPreflightInput;
  readonly carrier: WaitContinuationCarrierV1;
  readonly task: TaskItem | null;
  readonly lease?: ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' };
}): RetryAuthorityDecision {
  const { carrier, request, task } = input;
  if (!task) return { ok: false, reason: 'task_missing' };
  if (
    (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking') ||
    task.threadId !== request.message.threadId ||
    task.userId !== request.message.userId ||
    task.userId !== request.requestingUserId
  ) {
    return { ok: false, reason: 'task_identity_mismatch' };
  }
  if (task.ownerCatId !== request.targetCatId) return { ok: false, reason: 'owner_mismatch' };

  const outcome = task.automationState?.waitOutcome;
  if (
    !outcome ||
    outcome.outcomeId !== carrier.outcomeId ||
    !ownerFencesMatch(outcome.ownerFence, carrier.ownerFence) ||
    outcome.reason !== 'matched' ||
    (outcome.delivery !== 'pending' && outcome.delivery !== 'delivered')
  ) {
    if (outcome?.reason === 'subject_terminal' || outcome?.terminalSubjectState) {
      return { ok: false, reason: 'subject_terminal' };
    }
    return { ok: false, reason: 'outcome_mismatch' };
  }
  if (carrier.ownerFence.kind === 'containing_task') {
    if (outcome.generation !== carrier.ownerFence.generation) {
      return { ok: false, reason: 'outcome_mismatch' };
    }
    return { ok: true, kind: 'wait_containing_task' };
  }

  const lease = input.lease;
  if (!lease) return { ok: false, reason: 'lease_missing' };
  if (lease.ok) {
    return lease.reason === 'active'
      ? { ok: true, kind: 'wait_action_successor' }
      : { ok: false, reason: 'holder_terminal' };
  }
  if (lease.reason === 'predicate_mismatch') return { ok: false, reason: 'stale_generation' };
  return { ok: false, reason: lease.reason };
}

/**
 * Read-only authority check for one manual retry. The decision is transient;
 * Queue and Message custody remain unchanged until this method returns ok.
 */
export class WaitContinuationRetryPreflight {
  constructor(private readonly deps: WaitContinuationRetryPreflightDeps) {}

  async preflight(input: WaitContinuationRetryPreflightInput): Promise<RetryAuthorityDecision> {
    const subject = resolveRetryAuthorityMessageSubject(input);
    if (!subject.ok) return subject;
    if (subject.kind === 'user') return { ok: true, kind: 'user' };
    return this.preflightWait(input, subject.carrier);
  }

  private async preflightWait(
    input: WaitContinuationRetryPreflightInput,
    carrier: WaitContinuationCarrierV1,
  ): Promise<RetryAuthorityDecision> {
    const task = await this.deps.taskStore.get(carrier.waitId);
    const lease =
      carrier.ownerFence.kind === 'action_successor'
        ? await this.deps.actionSuccessorLeaseStore?.preflightOutput(
            carrier.ownerFence.leaseId,
            carrier.ownerFence.generation,
            input.targetCatId,
          )
        : undefined;
    return evaluateWaitRetryAuthoritySnapshot({ request: input, carrier, task, lease });
  }
}
