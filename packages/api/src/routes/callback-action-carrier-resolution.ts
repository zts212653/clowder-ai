import type {
  ActionSuccessorAdmissionInput,
  ActionSuccessorFence,
} from '../domains/ball-custody/ActionSuccessorAdmissionContract.js';
import {
  type ActionSuccessorCarrierRefreshRejection,
  refreshHandledActionSuccessorCarrier,
} from '../domains/ball-custody/ActionSuccessorCarrierRefresh.js';
import type { ActionSuccessorLeaseStore } from '../domains/ball-custody/ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from '../domains/ball-custody/action-successor-state-machine.js';
import {
  type DirectActionSuccessorCarrierUnavailableReason,
  readCarrierAdmissionEvidence,
  resolveDirectActionSuccessorCarrier,
} from '../domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import type {
  ActionHistoryExecutionState,
  ExecutionLineageReader,
  ExecutionRecordReader,
} from '../domains/ball-custody/DirectActionSuccessorExecutionEvidence.js';
import { readActionHistoryExecution } from '../domains/ball-custody/DirectActionSuccessorExecutionEvidence.js';
import type { ActionSuccessorCarrierAdmissionOutcome } from '../domains/ball-custody/reconcile-action-successor-enqueue.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';

/** Stable append identity of one generation's replacement carrier; a retry converges on one message. */
export function actionCarrierRecoveryKey(fence: Pick<ActionSuccessorFence, 'leaseId' | 'generation'>): string {
  return `action-carrier-recovery:${fence.leaseId}:${fence.generation}`;
}

/**
 * The replacement carrier message is durable but its delivery did not commit. Which instruction is
 * true depends on a durable fact, not on the failure: with a durable Queue admission, startup
 * reconciliation can restore delivery; without one (or when that cannot be read back) only retrying
 * the same clientMessageId can. A retry is always safe, because the message is appended under a
 * stable key and delivery is keyed by the generation's carrier key.
 */
interface CarrierRecoveryEvidenceInput {
  invocationQueue: Pick<InvocationQueue, 'getDurableEntriesForMessages'>;
  messageStore?: Pick<IMessageStore, 'getById'>;
  invocationRecordStore?: ExecutionRecordReader;
  turnExecutionStore?: ExecutionLineageReader;
  threadId: string;
  userId: string;
  messageId: string;
  holderCatIds: readonly string[];
  fence: ActionSuccessorFence;
  clientMessageId: string | undefined;
}

async function recoveryHistoryExecutions(
  input: CarrierRecoveryEvidenceInput,
): Promise<
  { kind: 'none' | 'unverified' } | { kind: 'committed'; executions: Record<string, ActionHistoryExecutionState> }
> {
  if (!input.messageStore) return { kind: 'none' };
  const source = await input.messageStore.getById(input.messageId);
  if (
    !source ||
    source.id !== input.messageId ||
    source.userId !== input.userId ||
    source.threadId !== input.threadId ||
    source.from?.kind !== 'agent'
  )
    return { kind: 'unverified' };
  const refs = source.lifecycle?.dispatchRefs ?? [];
  if (!refs.length) return { kind: 'none' };
  if (!input.holderCatIds.length) return { kind: 'unverified' };
  const executions: Record<string, ActionHistoryExecutionState> = {};
  for (const holder of input.holderCatIds) {
    const ref = refs.find((value) => value.targetId === holder);
    if (!ref) return { kind: 'unverified' };
    const state = await readActionHistoryExecution({
      lease: {
        leaseId: input.fence.leaseId,
        generation: input.fence.generation,
        holderThreadId: input.threadId,
        tenantScope: input.userId,
      },
      source,
      holder,
      responseMessageId: ref.statusMessageId,
      messages: input.messageStore,
      recordStore: input.invocationRecordStore,
      lineage: input.turnExecutionStore,
    });
    if (!state || state === 'unconfirmed') return { kind: 'unverified' };
    executions[holder] = state;
  }
  return { kind: 'committed', executions };
}

export async function carrierRecoveryPendingResponse(
  input: CarrierRecoveryEvidenceInput,
): Promise<{ statusCode: 200 | 503; body: Record<string, unknown> }> {
  const admission = await readCarrierAdmissionEvidence(
    input.invocationQueue,
    input.messageId,
    input.holderCatIds,
    input.fence,
    { threadId: input.threadId, userId: input.userId },
  );
  const identity = {
    messageId: input.messageId,
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  };
  try {
    const history = await recoveryHistoryExecutions(input);
    if (history.kind === 'committed')
      return {
        statusCode: 200,
        body: {
          kind: 'action_carrier_delivery_committed',
          ...identity,
          executions: history.executions,
          message:
            'Canonical History confirms this carrier was delivered. No replacement is scheduled by this read; execution outcomes are reported separately.',
        },
      };
    // A dispatched source with missing or mismatched lineage is not proof of non-admission.
    if (history.kind === 'unverified')
      return {
        statusCode: 503,
        body: {
          kind: 'action_carrier_retry_required',
          admission: 'unverified',
          ...identity,
          message:
            'Carrier delivery could not be confirmed. Retry this exact clientMessageId to re-check canonical evidence; this result does not authorize a new delivery.',
        },
      };
  } catch {
    return {
      statusCode: 503,
      body: {
        kind: 'action_carrier_retry_required',
        admission: 'unverified',
        ...identity,
        message:
          'Canonical History could not be read. Retry this exact clientMessageId; no delivery is inferred from unavailable storage.',
      },
    };
  }
  if (admission === 'durable') {
    return {
      statusCode: 503,
      body: {
        kind: 'action_carrier_recovery_pending',
        message:
          'The replacement carrier has durable Queue admission, but delivery is not committed. Runtime startup reconciliation is required to restore Queue delivery; retrying this clientMessageId only confirms the admission.',
        ...identity,
      },
    };
  }
  return {
    statusCode: 503,
    body: {
      kind: 'action_carrier_retry_required',
      message:
        admission === 'not_persisted'
          ? 'The replacement carrier message is durable, but no matching pending Queue admission is present. Retry this exact clientMessageId to re-check and reconcile delivery; absence alone does not prove it was never admitted.'
          : 'The replacement carrier message is durable, but its Queue admission could not be confirmed. Retry this exact clientMessageId to restore delivery.',
      admission,
      ...identity,
    },
  };
}

export type SafeWaitCarrierResolution =
  /** Answer the caller now; nothing is dispatched. */
  | { kind: 'respond'; statusCode?: number; body: Record<string, unknown> }
  /** Persist and enqueue a carrier bound to `fence`, appended under `recoveryKey`. */
  | {
      kind: 'continue';
      admissionOutcome: ActionSuccessorCarrierAdmissionOutcome;
      fence: ActionSuccessorFence;
      recoveryKey: string;
    };

/** Refusals about the lease or the request are authority problems; the rest mean custody already ended. */
const REFRESH_REFUSAL_REASON: Record<
  ActionSuccessorCarrierRefreshRejection,
  DirectActionSuccessorCarrierUnavailableReason
> = {
  not_direct_carrier: 'authority_mismatch',
  authority_mismatch: 'authority_mismatch',
  terminal_predicate_mismatch: 'authority_mismatch',
  dispatch_unchanged: 'authority_mismatch',
  lease_not_active: 'carrier_terminal',
  holder_outcome_present: 'carrier_terminal',
  completion_candidate_present: 'carrier_terminal',
  return_present: 'carrier_terminal',
};

/**
 * How many times one request may recognise a refreshable carrier and try to commit the refresh while
 * the lease keeps moving under it. A lost race is normal (a concurrent refresh, a holder outcome);
 * a lease that never settles is not worth an unbounded loop, so the caller is told to retry.
 */
export const MAX_REFRESH_ATTEMPTS = 3;

/**
 * An active lease already exists for this action and the caller wants to dispatch it again
 * (`safe_wait`). Decide from durable custody what that means: a live carrier waits, an interrupted
 * one is restarted on its own generation, a handled one whose execution provably ended is
 * refreshed onto a new generation, and everything else is refused with a precise reason.
 *
 * `lease` is the lease this request observed. When the store reports that it has since moved, the
 * observation is stale and nothing about it may be answered: the same decision is re-derived from the
 * lease that is current, so `safe_wait` is only ever said about a carrier that is really there.
 *
 * A move that advanced the GENERATION means another request's refresh already took over what this
 * one asked for. Refreshing that generation again, even if its run has finished by now, would run the
 * work twice for one overlapping ask, so the caller is told the lease changed and may ask again.
 */
export async function resolveSafeWaitCarrier(
  input: {
    invocationQueue: Pick<InvocationQueue, 'listAllDurable'>;
    messageStore: Pick<IMessageStore, 'getByThreadAfter' | 'getById'>;
    invocationRecordStore: ExecutionRecordReader | undefined;
    turnExecutionStore: ExecutionLineageReader | undefined;
    leaseStore: Pick<ActionSuccessorLeaseStore, 'refreshHandledCarrier' | 'getSubjectTerminal'> | undefined;
    lease: ActionSuccessorLease;
    admissionInput: ActionSuccessorAdmissionInput;
    clientMessageId: string | undefined;
  },
  race: { attempt: number; observedGeneration: number } = { attempt: 1, observedGeneration: input.lease.generation },
): Promise<SafeWaitCarrierResolution> {
  const { lease, clientMessageId } = input;
  const { attempt, observedGeneration } = race;
  const unavailable = (
    reason: DirectActionSuccessorCarrierUnavailableReason,
    extra = {},
  ): SafeWaitCarrierResolution => ({
    kind: 'respond',
    statusCode: 409,
    body: { status: 'action_carrier_unavailable', reason, actionLease: lease, clientMessageId, ...extra },
  });

  if (attempt > MAX_REFRESH_ATTEMPTS) return unavailable('lease_changed');

  const carrier = await resolveDirectActionSuccessorCarrier({
    invocationQueue: input.invocationQueue,
    messageStore: input.messageStore,
    invocationRecordStore: input.invocationRecordStore,
    turnExecutionStore: input.turnExecutionStore,
    lease,
    admissionInput: input.admissionInput,
  });
  if (carrier.disposition === 'live') {
    return { kind: 'respond', body: { status: 'safe_wait', actionLease: lease, clientMessageId } };
  }
  if (carrier.disposition === 'restart_interrupted') {
    return {
      kind: 'continue',
      admissionOutcome: 'replayed',
      fence: carrier.fence,
      recoveryKey: actionCarrierRecoveryKey(carrier.fence),
    };
  }
  if (carrier.disposition === 'unavailable') {
    // On a re-read the request already passed the authority check against the lease it observed, so
    // failing it now means the lease itself changed (cancelled, completed, replaced), not the caller.
    return unavailable(attempt > 1 && carrier.reason === 'authority_mismatch' ? 'lease_changed' : carrier.reason);
  }

  // refresh_handled. Without the lease store the old, safe answer stands: no new execution.
  if (!input.leaseStore) return unavailable('carrier_terminal');
  if (lease.generation !== observedGeneration) return unavailable('lease_changed');
  const refreshed = await refreshHandledActionSuccessorCarrier({
    leaseStore: input.leaseStore,
    lease,
    admissionInput: input.admissionInput,
  });
  switch (refreshed.outcome) {
    case 'refreshed':
      return {
        kind: 'continue',
        admissionOutcome: 'refreshed',
        fence: refreshed.fence,
        recoveryKey: actionCarrierRecoveryKey(refreshed.fence),
      };
    case 'superseded':
      // Someone else moved the lease first. Whether that left a live carrier, none, or a lease that is
      // no longer ours to refresh is a fact about the lease that is current now, so ask it again.
      return resolveSafeWaitCarrier({ ...input, lease: refreshed.lease }, { attempt: attempt + 1, observedGeneration });
    case 'subject_terminal': {
      const terminal = await input.leaseStore.getSubjectTerminal(lease.subjectRef);
      return terminal
        ? { kind: 'respond', body: { status: 'subject_terminal', terminal, clientMessageId } }
        : unavailable('carrier_terminal');
    }
    default:
      return unavailable(REFRESH_REFUSAL_REASON[refreshed.reason], { refusal: refreshed.reason });
  }
}
