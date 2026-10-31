import type {
  ActionSuccessorAdmissionInput,
  ActionSuccessorFence,
} from '../domains/ball-custody/ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLease } from '../domains/ball-custody/action-successor-state-machine.js';
import { currentOrphanCarrierRecovery } from '../domains/ball-custody/action-successor-state-machine.js';
import type { DirectActionSuccessorCarrierUnavailableReason } from '../domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import type { ActionSuccessorCarrierAdmissionOutcome } from '../domains/ball-custody/reconcile-action-successor-enqueue.js';
import type { TaskActionSuccessorOrphanRecovery } from '../domains/ball-custody/TaskActionSuccessorOrphanRecovery.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/owner-auth-provenance.js';

export type SafeWaitCarrierResolution =
  | { kind: 'respond'; statusCode?: number; body: Record<string, unknown> }
  | {
      kind: 'continue';
      admissionOutcome: ActionSuccessorCarrierAdmissionOutcome;
      fence: ActionSuccessorFence;
      recoveryKey: string;
    };

export interface OrphanCarrierResolutionInput {
  orphanRecovery?: Pick<TaskActionSuccessorOrphanRecovery, 'recover'>;
  ownerAuthProvenance?: OwnerAuthProvenance;
  parentInvocationId?: string;
  lease: ActionSuccessorLease;
  admissionInput: ActionSuccessorAdmissionInput;
  clientMessageId: string | undefined;
}

function orphanRecoveryReceipt(
  lease: ActionSuccessorLease,
  messageId: string,
  clientMessageId: string | undefined,
): SafeWaitCarrierResolution {
  return {
    kind: 'respond',
    body: {
      status: 'orphan_carrier_recovered',
      threadId: lease.holderThreadId,
      messageId,
      routed: lease.holderCatIds,
      clientMessageId,
      actionLease: {
        leaseId: lease.leaseId,
        generation: lease.generation,
        outcome: 'orphan_carrier_recovery',
      },
    },
  };
}

export function replayedOrphanReceipt(input: OrphanCarrierResolutionInput): SafeWaitCarrierResolution | null {
  const recovery = currentOrphanCarrierRecovery(input.lease);
  return recovery && input.admissionInput.dispatchId === input.lease.dispatchId
    ? orphanRecoveryReceipt(input.lease, recovery.sourceMessageId, input.clientMessageId)
    : null;
}

export async function adoptReplayedTaskOrphanCarrier(
  input: OrphanCarrierResolutionInput,
): Promise<SafeWaitCarrierResolution | null> {
  const receipt = replayedOrphanReceipt(input);
  if (!receipt) return null;
  if (!input.orphanRecovery || !input.ownerAuthProvenance) {
    return recoveryRefused(input, 'recovery_unavailable');
  }
  const recovery = await input.orphanRecovery.recover({
    lease: input.lease,
    admissionInput: input.admissionInput,
    ownerAuthProvenance: input.ownerAuthProvenance,
    ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
  });
  if (recovery.outcome === 'recovered' || recovery.outcome === 'replayed') {
    return orphanRecoveryReceipt(recovery.lease, recovery.messageId, input.clientMessageId);
  }
  return recoveryRefused(
    input,
    recovery.outcome === 'superseded'
      ? 'recovery_state_changed'
      : 'reason' in recovery
        ? recovery.reason
        : 'recovery_state_changed',
  );
}

function recoveryRefused(input: OrphanCarrierResolutionInput, recoveryRefusal: string): SafeWaitCarrierResolution {
  return {
    kind: 'respond',
    statusCode: 409,
    body: {
      status: 'action_carrier_unavailable',
      reason: 'carrier_missing',
      actionLease: input.lease,
      clientMessageId: input.clientMessageId,
      recoveryRefusal,
    },
  };
}

export async function tryTaskOrphanRecovery(
  input: OrphanCarrierResolutionInput,
  reason: DirectActionSuccessorCarrierUnavailableReason,
  race: { attempt: number; observedGeneration: number },
  resolveSuperseded: (
    lease: ActionSuccessorLease,
    race: { attempt: number; observedGeneration: number },
  ) => Promise<SafeWaitCarrierResolution>,
): Promise<SafeWaitCarrierResolution | null> {
  if (reason !== 'carrier_missing' || !input.orphanRecovery || !input.ownerAuthProvenance) return null;
  const recovery = await input.orphanRecovery.recover({
    lease: input.lease,
    admissionInput: input.admissionInput,
    ownerAuthProvenance: input.ownerAuthProvenance,
    ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
  });
  if (recovery.outcome === 'recovered' || recovery.outcome === 'replayed') {
    return orphanRecoveryReceipt(recovery.lease, recovery.messageId, input.clientMessageId);
  }
  if (recovery.outcome === 'superseded') {
    return resolveSuperseded(recovery.lease, {
      attempt: race.attempt + 1,
      observedGeneration: race.observedGeneration,
    });
  }
  return recoveryRefused(input, 'reason' in recovery ? recovery.reason : 'recovery_state_changed');
}
