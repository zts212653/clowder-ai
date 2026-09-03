import { parseWaitOwnerFence } from '@cat-cafe/shared';
import type { InvocationActionLeaseCarrier } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { type ActionSuccessorFence, buildActionSuccessorFence } from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';

export class ManagedCommandWakeActionLeaseAdmissionError extends Error {
  readonly code = 'MANAGED_COMMAND_WAKE_ACTION_LEASE_MISMATCH';
}

export interface ManagedCommandWakeActionLeaseAdmission {
  readonly actionLeaseCarrier: InvocationActionLeaseCarrier;
  readonly actionSuccessorFence?: ActionSuccessorFence;
}

export function hasManagedCommandWakeActionLeaseRef(
  message: Pick<StoredMessage, 'source'> | null | undefined,
): boolean {
  return (
    message?.source?.connector === 'hold-ball' &&
    message.source.meta?.wakeWhen === true &&
    Object.hasOwn(message.source.meta, 'actionLeaseRef')
  );
}

function parseActionLeaseRef(value: unknown): { leaseId: string; generation: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ownerFence = parseWaitOwnerFence({ kind: 'action_successor', ...(value as Record<string, unknown>) });
  return ownerFence?.kind === 'action_successor'
    ? { leaseId: ownerFence.leaseId, generation: ownerFence.generation }
    : null;
}

export async function resolveManagedCommandWakeActionLeaseAdmission(
  message: Pick<StoredMessage, 'threadId' | 'source'> | null | undefined,
  expected: { threadId: string; catId: string; tenantScope: string },
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get'> | undefined,
): Promise<ManagedCommandWakeActionLeaseAdmission> {
  const source = message?.source;
  const meta = source?.meta;
  if (source?.connector !== 'hold-ball' || meta?.wakeWhen !== true) {
    return { actionLeaseCarrier: { kind: 'none' } };
  }
  if (!Object.hasOwn(meta, 'actionLeaseRef')) {
    return { actionLeaseCarrier: { kind: 'none' } };
  }
  if (
    typeof meta.taskId !== 'string' ||
    meta.taskId.length === 0 ||
    message?.threadId !== expected.threadId ||
    meta.threadId !== expected.threadId ||
    meta.catId !== expected.catId
  ) {
    throw new ManagedCommandWakeActionLeaseAdmissionError(
      'Managed-command action lease carrier does not match the wake target identity',
    );
  }

  const ref = parseActionLeaseRef(meta.actionLeaseRef);
  if (!ref) {
    throw new ManagedCommandWakeActionLeaseAdmissionError(
      'Managed-command wake contains an invalid action lease generation',
    );
  }
  if (!leaseStore) {
    throw new ManagedCommandWakeActionLeaseAdmissionError(
      'Managed-command action lease carrier cannot be verified without the canonical lease store',
    );
  }

  const lease = await leaseStore.get(ref.leaseId);
  if (!lease || lease.leaseId !== ref.leaseId || lease.generation !== ref.generation) {
    throw new ManagedCommandWakeActionLeaseAdmissionError(
      'Managed-command action lease generation no longer matches canonical truth',
    );
  }
  if (
    lease.status !== 'active' ||
    lease.tenantScope !== expected.tenantScope ||
    lease.holderThreadId !== expected.threadId ||
    !lease.holderCatIds.includes(expected.catId)
  ) {
    throw new ManagedCommandWakeActionLeaseAdmissionError(
      'Managed-command action lease holder no longer matches canonical truth',
    );
  }

  return {
    actionLeaseCarrier: {
      kind: 'action_successor',
      leaseId: lease.leaseId,
      generation: lease.generation,
    },
    actionSuccessorFence: buildActionSuccessorFence(lease, lease.dispatchId),
  };
}
