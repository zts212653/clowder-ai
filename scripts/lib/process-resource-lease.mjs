import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createProcessResourceLeaseHandle } from './process-resource-lease-handle.mjs';
import {
  readProcessResourceLeaseHolder,
  recoverStaleLease,
  removeOwnedLease,
  tryAcquireLeaseFile,
} from './process-resource-lease-lock.mjs';
import {
  createProcessResourceWaiter,
  elapsedMilliseconds,
  listLiveProcessResourceWaiters,
  removeProcessResourceWaiter,
  touchProcessResourceWaiter,
  writeProcessResourceReceipt,
} from './process-resource-lease-queue.mjs';

export { adoptProcessResourceLease } from './process-resource-lease-handle.mjs';

export const DEFAULT_QUEUE_HEAD_STALL_MS = 5_000;

export function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(delayMs) {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

async function createAcquisitionState({ lockPath, holderPid, cwd, label, leaseMetadata, logMs, stallMs, waitMs }) {
  const resolvedLockPath = resolve(lockPath);
  const waitStartedAt = Date.now();
  const waiter = await createProcessResourceWaiter({ lockPath: resolvedLockPath, holderPid, cwd, label });
  return {
    resolvedLockPath,
    holderPid,
    cwd,
    label,
    leaseMetadata,
    logMs,
    stallMs,
    waiter,
    leaseId: randomUUID(),
    waitStartedAtMonotonic: process.hrtime.bigint(),
    waitDeadlineAt: waitStartedAt + waitMs,
    nextWaitLogAt: waitStartedAt,
    waitState: {
      holderPid: 'unknown',
      holderCwd: 'unknown',
      holderStartedAt: 'unknown',
      holderQueueId: 'unknown',
    },
    nextHeartbeatAt: waitStartedAt,
    heartbeatMs: Math.min(1_000, Math.max(25, Math.floor(stallMs / 3))),
    legacyCompetitionObserved: false,
    legacyCompetitionLogged: false,
    admissionMode: 'strict_fifo',
    stalledAhead: 0,
    queuePosition: 0,
    queueDepth: 0,
    queuePositionAtJoin: undefined,
    ownsLease: false,
    waiterRemoved: false,
    terminalStatus: 'failed',
    receipt: {
      status: 'queued',
      queuePositionAtJoin: null,
      queueDepthAtJoin: null,
      lastQueuePosition: null,
      lastQueueDepth: null,
      waitDurationMs: 0,
    },
  };
}

function assertAcquisitionActive(state, signal) {
  if (!signal?.aborted) return;
  state.terminalStatus = 'aborted';
  throw new Error(`${state.label} acquisition aborted`);
}

export function assessProcessResourceAdmission(liveWaiters, currentQueueId) {
  const queueIndex = liveWaiters.findIndex(({ metadata }) => metadata.queueId === currentQueueId);
  const progressingWaiters = liveWaiters.filter(
    ({ metadata, stalled }) => !stalled || metadata.queueId === currentQueueId,
  );
  const admissionIndex = progressingWaiters.findIndex(({ metadata }) => metadata.queueId === currentQueueId);
  const stalledAhead = queueIndex < 0 ? 0 : liveWaiters.slice(0, queueIndex).filter(({ stalled }) => stalled).length;
  return { admissionIndex, queueIndex, stalledAhead };
}

async function refreshQueuePosition(state, now) {
  if (now >= state.nextHeartbeatAt) {
    if (!(await touchProcessResourceWaiter(state.waiter, now))) {
      throw new Error(`${state.label} waiter identity disappeared before acquisition`);
    }
    state.nextHeartbeatAt = now + state.heartbeatMs;
  }
  const liveWaiters = await listLiveProcessResourceWaiters(state.resolvedLockPath, {
    stalledAfterMs: state.stallMs,
  });
  const { admissionIndex, queueIndex, stalledAhead } = assessProcessResourceAdmission(
    liveWaiters,
    state.waiter.metadata.queueId,
  );
  if (queueIndex < 0) throw new Error(`${state.label} waiter identity disappeared before acquisition`);
  state.queuePosition = queueIndex + 1;
  state.queueDepth = liveWaiters.length;
  if (admissionIndex < 0) throw new Error(`${state.label} waiter heartbeat was not observed`);
  state.stalledAhead = stalledAhead;
  if (!state.legacyCompetitionObserved) {
    state.admissionMode = stalledAhead > 0 ? 'stalled_head_fail_open' : 'strict_fifo';
  }
  if (state.queuePositionAtJoin !== undefined) return { admissionIndex, stalledAhead };

  state.queuePositionAtJoin = state.queuePosition;
  state.receipt = {
    ...state.receipt,
    queuePositionAtJoin: state.queuePosition,
    queueDepthAtJoin: state.queueDepth,
    lastQueuePosition: state.queuePosition,
    lastQueueDepth: state.queueDepth,
  };
  await writeProcessResourceReceipt(state.waiter, state.receipt);
  console.error(
    `[${state.label}] queued pid=${state.holderPid} queuePosition=${state.queuePosition} queueDepth=${state.queueDepth} receipt=${JSON.stringify(state.waiter.receiptPath)}`,
  );
  return { admissionIndex, stalledAhead };
}

function observeLegacyCompetition(state) {
  if (state.waitState.holderQueueId !== null) return;
  state.legacyCompetitionObserved = true;
  state.admissionMode = 'legacy_fail_open';
  if (state.legacyCompetitionLogged) return;
  state.legacyCompetitionLogged = true;
  console.error(
    `[${state.label}] legacy holder observed; FIFO admission is fail-open for this waiter holderPid=${state.waitState.holderPid}`,
  );
}

async function attemptLeaseAcquisition(state, admission) {
  if (admission.admissionIndex !== 0 && !state.legacyCompetitionObserved) {
    state.waitState = await readProcessResourceLeaseHolder(state.resolvedLockPath);
    observeLegacyCompetition(state);
    return 'waiting';
  }

  const acquiredAt = new Date().toISOString();
  const acquired = await tryAcquireLeaseFile(state.resolvedLockPath, {
    ...state.leaseMetadata,
    leaseId: state.leaseId,
    holderPid: state.holderPid,
    cwd: state.cwd,
    startedAt: acquiredAt,
    queueId: state.waiter.metadata.queueId,
    receiptPath: state.waiter.receiptPath,
  });
  if (!acquired) {
    const recovery = await recoverStaleLease(state.resolvedLockPath);
    state.waitState = recovery;
    observeLegacyCompetition(state);
    return recovery.recovered ? 'retry' : 'waiting';
  }

  state.ownsLease = true;
  state.receipt = {
    ...state.receipt,
    status: 'acquired',
    admissionMode: state.admissionMode,
    bypassedStalledWaiters: state.stalledAhead,
    lastQueuePosition: state.queuePosition,
    lastQueueDepth: state.queueDepth,
    waitDurationMs: elapsedMilliseconds(state.waitStartedAtMonotonic),
    acquiredAt,
  };
  await writeProcessResourceReceipt(state.waiter, state.receipt);
  await removeProcessResourceWaiter(state.waiter);
  state.waiterRemoved = true;
  console.error(
    `[${state.label}] acquired pid=${state.holderPid} cwd=${state.cwd} waitDurationMs=${state.receipt.waitDurationMs} queuePositionAtJoin=${state.queuePositionAtJoin} receipt=${JSON.stringify(state.waiter.receiptPath)}`,
  );
  return 'acquired';
}

async function persistWaitingReceipt(state, now) {
  if (now < state.nextWaitLogAt) return;
  state.receipt = {
    ...state.receipt,
    status: 'waiting',
    admissionMode: state.admissionMode,
    bypassedStalledWaiters: state.stalledAhead,
    lastQueuePosition: state.queuePosition,
    lastQueueDepth: state.queueDepth,
    waitDurationMs: elapsedMilliseconds(state.waitStartedAtMonotonic),
    lastObservedAt: new Date(now).toISOString(),
    observedHolderPid: state.waitState.holderPid,
    observedHolderCwd: state.waitState.holderCwd,
    observedHolderStartedAt: state.waitState.holderStartedAt,
  };
  await writeProcessResourceReceipt(state.waiter, state.receipt);
  console.error(
    `[${state.label}] waiting elapsedMs=${state.receipt.waitDurationMs} queuePosition=${state.queuePosition} queueDepth=${state.queueDepth} holderPid=${state.waitState.holderPid} holderCwd=${JSON.stringify(state.waitState.holderCwd)} holderStartedAt=${state.waitState.holderStartedAt} lock=${state.resolvedLockPath} receipt=${JSON.stringify(state.waiter.receiptPath)}`,
  );
  state.nextWaitLogAt = now + state.logMs;
}

function assertWithinWaitDeadline(state, now, waitMs) {
  if (now < state.waitDeadlineAt) return;
  state.terminalStatus = 'timed_out';
  const resourceLabel = state.label.endsWith('-lease') ? `${state.label.slice(0, -6)} lease` : state.label;
  throw new Error(
    `Timed out waiting ${waitMs}ms for ${resourceLabel} at ${state.resolvedLockPath}; queuePosition=${state.queuePosition} queueDepth=${state.queueDepth} holderPid=${state.waitState.holderPid} holderCwd=${JSON.stringify(state.waitState.holderCwd)} holderStartedAt=${state.waitState.holderStartedAt}`,
  );
}

async function cleanupFailedAcquisition(state, error) {
  if (state.ownsLease) {
    await removeOwnedLease(state.resolvedLockPath, state.leaseId, state.holderPid);
  }
  if (state.waiterRemoved) return;
  try {
    await writeProcessResourceReceipt(state.waiter, {
      ...state.receipt,
      status: state.terminalStatus,
      lastQueuePosition: state.queuePosition || null,
      lastQueueDepth: state.queueDepth || null,
      waitDurationMs: elapsedMilliseconds(state.waitStartedAtMonotonic),
      terminalAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } catch (receiptError) {
    console.error(`[${state.label}] failed to persist terminal receipt: ${receiptError}`);
  } finally {
    await removeProcessResourceWaiter(state.waiter);
  }
}

export async function acquireProcessResourceLease({
  lockPath,
  holderPid = process.pid,
  cwd = process.cwd(),
  label,
  leaseMetadata = {},
  logMs,
  pollMs,
  waitMs,
  signal,
  stallMs = DEFAULT_QUEUE_HEAD_STALL_MS,
}) {
  const state = await createAcquisitionState({
    lockPath,
    holderPid,
    cwd,
    label,
    leaseMetadata,
    logMs,
    stallMs,
    waitMs,
  });

  try {
    while (true) {
      assertAcquisitionActive(state, signal);
      const now = Date.now();
      const admission = await refreshQueuePosition(state, now);
      const outcome = await attemptLeaseAcquisition(state, admission);
      if (outcome === 'acquired') break;
      if (outcome === 'retry') continue;
      await persistWaitingReceipt(state, now);
      assertWithinWaitDeadline(state, now, waitMs);
      await sleep(pollMs);
    }
  } catch (error) {
    await cleanupFailedAcquisition(state, error);
    throw error;
  }
  return createProcessResourceLeaseHandle(state);
}
