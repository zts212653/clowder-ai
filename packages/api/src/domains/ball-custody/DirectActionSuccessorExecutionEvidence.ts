import { actionSuccessorInvocationIdempotencyKey } from '../cats/services/agents/invocation/InvocationQueue.js';
import { actionSuccessorCarrierKey } from '../cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { IInvocationRecordStore, InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../cats/services/stores/ports/invocation-state-machine.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import type { ActionSuccessorFence } from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import type { DirectActionSuccessorCarrierDecision } from './DirectActionSuccessorCarrierRecovery.js';

type ExecutionVerdict = 'ended' | 'canceled' | 'unconfirmed';

/** What the InvocationRecord created from this very carrier key proves about the holder's run. */
function executionVerdict(record: InvocationRecord | null, holder: string): ExecutionVerdict {
  if (!record) return 'unconfirmed';
  const recovery = classifyInvocationRecoveryStatus(record.status);
  if (recovery === 'terminal') return 'canceled';
  const succeededFor = (record.successfulCatIds as readonly string[] | undefined)?.includes(holder) === true;
  return recovery === 'completed' && succeededFor ? 'ended' : 'unconfirmed';
}

/** What the recognition needs from the record store: the exact-key index, and the persistent record by id. */
export type ExecutionRecordReader = Pick<IInvocationRecordStore, 'getByIdempotencyKey' | 'get'>;

/** The durable child ledger: which parent InvocationRecord a handling child invocation belongs to. */
export type ExecutionLineageReader = Pick<ITurnExecutionStore, 'get'>;

/**
 * The idempotency index expires 5 minutes after the run was created, while the InvocationRecord stays. So when
 * the exact key no longer finds the run, follow the carrier's own durable custody to it.
 *
 * The ids custody names are CHILD invocation ids (the turn that consumed the carrier), never the parent
 * InvocationRecord the Queue created from the carrier key, so reading a record by that id finds nothing. The
 * durable TurnExecution ledger links child to parent. Every link is checked, and a missing or inconsistent one
 * is "unconfirmed", never a guess: the child must be that exact id, run by that holder in that thread and tenant,
 * and its parent must be a record created from this exact carrier key in the same thread and tenant, so a run of
 * any other carrier (another generation, another cat, an ordinary client key) is never evidence.
 */
async function readBoundRecord(
  recordStore: ExecutionRecordReader,
  lineage: ExecutionLineageReader | undefined,
  lease: ActionSuccessorLease,
  holder: string,
  key: string,
  childInvocationIds: ReadonlySet<string> | undefined,
): Promise<InvocationRecord | null> {
  if (!lineage) return null;
  for (const childId of childInvocationIds ?? []) {
    const child = await lineage.get(childId);
    if (
      !child ||
      child.invocationId !== childId ||
      child.catId !== holder ||
      child.threadId !== lease.holderThreadId ||
      child.userId !== lease.tenantScope
    ) {
      continue;
    }
    const parent = await recordStore.get(child.parentInvocationId);
    if (
      parent &&
      parent.idempotencyKey === key &&
      parent.threadId === lease.holderThreadId &&
      parent.userId === lease.tenantScope
    ) {
      return parent;
    }
  }
  return null;
}

/**
 * `handled` is a custody fact, not an execution fact, and it cannot tell a normal finish from an
 * explicit cancel. Refreshing is safe only when every holder's own InvocationRecord (same carrier key
 * the Queue created it from) shows a successful terminal run for exactly that target. A missing or
 * unsettled record is its own state, never folded into either answer.
 */
export async function confirmHandledExecutionsEnded(
  lease: ActionSuccessorLease,
  fence: ActionSuccessorFence,
  readers: { recordStore: ExecutionRecordReader | undefined; lineage: ExecutionLineageReader | undefined },
  handledChildInvocationIds: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<DirectActionSuccessorCarrierDecision> {
  const { recordStore, lineage } = readers;
  // No way to read the execution record is "unconfirmed", the same third state as a missing record.
  if (!recordStore) return { disposition: 'unavailable', reason: 'execution_unconfirmed' };
  const verdicts: ExecutionVerdict[] = [];
  try {
    for (const holder of lease.holderCatIds) {
      const key = actionSuccessorInvocationIdempotencyKey(actionSuccessorCarrierKey(fence, holder));
      const indexed = await recordStore.getByIdempotencyKey(lease.holderThreadId, lease.tenantScope, key);
      const record =
        indexed ??
        (await readBoundRecord(recordStore, lineage, lease, holder, key, handledChildInvocationIds.get(holder)));
      verdicts.push(executionVerdict(record, holder));
    }
  } catch {
    return { disposition: 'unavailable', reason: 'lookup_failed' };
  }
  if (verdicts.includes('canceled')) return { disposition: 'unavailable', reason: 'carrier_terminal' };
  if (verdicts.includes('unconfirmed')) return { disposition: 'unavailable', reason: 'execution_unconfirmed' };
  return { disposition: 'refresh_handled', fence };
}
