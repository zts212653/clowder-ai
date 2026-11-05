import { randomUUID } from 'node:crypto';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { schedulerError } from '../../infrastructure/scheduler/logging/adapter.js';

const log = createModuleLogger('ball-custody/action-due-recovery');

import {
  type ActionRecoveryLane,
  type ActionRecoveryNotification,
  type ActionRecoveryOutcome,
  type ActionRecoveryPort,
  type ActionRecoverySnapshot,
  planActionRecovery,
} from './action-successor-recovery-state.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

async function notify(
  port: ActionRecoveryPort,
  snapshot: ActionRecoverySnapshot,
  lane: ActionRecoveryLane,
  now: number,
  send?: ActionRecoveryNotification,
): Promise<void> {
  const notice = snapshot.fact.notification;
  if (!notice || notice.deliveredAt !== undefined || notice.attempts >= 5) return;
  let delivered = false;
  let unavailable = !send;
  try {
    const result = await send?.({ lease: snapshot.lease, lane, key: notice.key, reasonCode: notice.reasonCode });
    delivered = result === 'delivered';
    unavailable ||= result === 'owner_unavailable';
  } catch {
    /* The committed intent survives a failed append or a crash after append. */
  }
  const current = await port.read(snapshot.lease.leaseId, lane);
  if (
    !current ||
    current.lease.generation !== snapshot.lease.generation ||
    current.fact.notification?.key !== notice.key
  )
    return;
  const attempts = notice.attempts + (delivered || unavailable ? 0 : 1);
  await port.update(current, lane, {
    ...current.fact,
    nextAttemptAt: delivered || unavailable || attempts >= 5 ? null : now + 30_000,
    notification: { ...notice, attempts, ...(delivered ? { deliveredAt: now } : {}) },
  });
}

/** Owner policy: only this lease's original lane handler may run; metadata never asserts business success. */
interface ActionDueInput {
  port?: ActionRecoveryPort;
  lease: ActionSuccessorLease;
  lane: ActionRecoveryLane;
  now: number;
  notify?: ActionRecoveryNotification;
  recover: (lease: ActionSuccessorLease) => Promise<ActionRecoveryOutcome>;
}
export async function runActionDueRecovery(input: ActionDueInput): Promise<ActionRecoveryOutcome> {
  try {
    return await recoverOriginalLane(input);
  } catch {
    return { kind: 'retryable_error', reason: 'recovery_owner_unavailable' };
  }
}
async function recoverOriginalLane(input: ActionDueInput): Promise<ActionRecoveryOutcome> {
  const { port, lease, lane, now } = input;
  // In-memory owners have no crash-recovery queue. Their business-only tests still exercise the same handler.
  if (!port)
    return input.recover(lease).catch(() => ({ kind: 'retryable_error', reason: `${lane}_recovery_read_failed` }));
  let snapshot = await port.read(lease.leaseId, lane);
  if (!snapshot || snapshot.lease.generation !== lease.generation) return { kind: 'stale' };
  if (snapshot.needsRepair) {
    if (!(await port.update(snapshot, lane, snapshot.fact))) return { kind: 'stale' };
    snapshot = await port.read(lease.leaseId, lane);
    if (!snapshot) return { kind: 'stale' };
  }
  if (snapshot.fact.nextAttemptAt === null || snapshot.fact.nextAttemptAt > now) return { kind: 'stale' };
  if (snapshot.fact.disposition) {
    await notify(port, snapshot, lane, now, input.notify);
    return { kind: 'settled' };
  }
  if (snapshot.fact.claim) {
    if (snapshot.fact.claim.expiresAt > now) return { kind: 'stale' };
    const fact = planActionRecovery(
      snapshot.fact,
      { kind: 'retryable_error', reason: 'interrupted_recovery' },
      snapshot.lease,
      lane,
      now,
    );
    if (await port.update(snapshot, lane, fact)) {
      const current = await port.read(lease.leaseId, lane);
      if (current?.fact.disposition) await notify(port, current, lane, now, input.notify);
    }
    return { kind: 'retryable_error', reason: 'interrupted_recovery' };
  }
  if (snapshot.lease.revision !== lease.revision) return { kind: 'stale' };
  const token = randomUUID();
  if (
    !(await port.update(
      snapshot,
      lane,
      { ...snapshot.fact, nextAttemptAt: now + 10_000, claim: { token, expiresAt: now + 10_000 } },
      true,
    ))
  )
    return { kind: 'stale' };
  let outcome: ActionRecoveryOutcome;
  try {
    outcome = await input.recover(snapshot.lease);
  } catch {
    outcome = { kind: 'retryable_error', reason: `${lane}_recovery_read_failed` };
  }
  const current = await port.read(lease.leaseId, lane);
  if (!current || current.lease.generation !== lease.generation || current.fact.claim?.token !== token)
    return { kind: 'stale' };
  const fact = planActionRecovery(current.fact, outcome, current.lease, lane, now);
  if (await port.update(current, lane, fact, false, token)) {
    if (fact.disposition && !current.fact.disposition)
      log.warn(
        {
          leaseId: lease.leaseId,
          generation: lease.generation,
          lane,
          disposition: fact.disposition,
          reasonCode: fact.reasonCode,
        },
        'Action recovery paused; original custody retained',
      );
    const settled = await port.read(lease.leaseId, lane);
    if (settled?.fact.disposition) await notify(port, settled, lane, now, input.notify);
  }
  return outcome;
}

/** Unexpected batch faults still use this original owner's finite budget; no business handler is replayed. */
export async function recordActionRecoveryBatchFailure(
  port: ActionRecoveryPort | undefined,
  lease: ActionSuccessorLease,
  lane: ActionRecoveryLane,
  now: number,
  error: unknown,
): Promise<void> {
  log.warn({ leaseId: lease.leaseId, lane, err: schedulerError(error) }, 'Action recovery batch item failed');
  await runActionDueRecovery({
    port,
    lease,
    lane,
    now,
    recover: async () => ({ kind: 'retryable_error', reason: `${lane}_batch_item_failed` }),
  });
}
