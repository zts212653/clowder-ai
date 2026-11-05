import type { RuntimeSessionMetadata } from './RuntimeSessionMetadata.js';

export function needsRuntimeSealRecovery(record: RuntimeSessionMetadata): boolean {
  return record.lifecycle.state === 'runtime_seal_pending' && !record.lifecycle.recoveryDisposition;
}
export function sameRuntimeSealExecution(a: RuntimeSessionMetadata, b: RuntimeSessionMetadata): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.runtimeSessionId === b.runtimeSessionId &&
    a.runtime === b.runtime &&
    a.catId === b.catId &&
    a.userId === b.userId &&
    a.threadId === b.threadId
  );
}

/** Only the selected original execution/lifecycle revision may charge this completed observation. */
export function planRuntimeSealRecoveryFailure(
  current: RuntimeSessionMetadata,
  selected: RuntimeSessionMetadata,
  now: number,
  maxRetries: number,
  reason: string,
): RuntimeSessionMetadata | null {
  if (
    !needsRuntimeSealRecovery(current) ||
    !sameRuntimeSealExecution(current, selected) ||
    JSON.stringify(current.lifecycle) !== JSON.stringify(selected.lifecycle)
  )
    return null;
  const retryCount = (current.lifecycle.retryCount ?? 0) + 1;
  return {
    ...current,
    lifecycle: {
      ...current.lifecycle,
      retryCount,
      lastRetryAt: now,
      lastFailureReason: reason,
      ...(retryCount >= maxRetries
        ? {
            recoveryDisposition: 'needs_attention' as const,
            recoveryReasonCode: 'seal_retry_exhausted',
            recoveryDisposedAt: now,
          }
        : {}),
    },
  };
}

export function runtimeSealRecoveryScore(record: RuntimeSessionMetadata): number {
  return Math.max(record.lifecycle.lastObservedAt, record.lifecycle.lastRetryAt ?? 0);
}

/** Same-execution snapshots preserve the original owner's budget; reliable scope/state changes remain original owner input. */
export function preserveRuntimeSealRecovery(
  previous: RuntimeSessionMetadata | null,
  incoming: RuntimeSessionMetadata,
): RuntimeSessionMetadata {
  if (
    !previous ||
    !sameRuntimeSealExecution(previous, incoming) ||
    previous.lifecycle.state !== 'runtime_seal_pending' ||
    incoming.lifecycle.state !== 'runtime_seal_pending'
  )
    return incoming;
  const counter =
    previous.lifecycle.retryCount === undefined && incoming.lifecycle.retryCount === undefined
      ? {}
      : {
          retryCount: Math.max(previous.lifecycle.retryCount ?? 0, incoming.lifecycle.retryCount ?? 0),
        };
  const disposition = previous.lifecycle.recoveryDisposition
    ? {
        recoveryDisposition: previous.lifecycle.recoveryDisposition,
        recoveryReasonCode: previous.lifecycle.recoveryReasonCode,
        recoveryDisposedAt: previous.lifecycle.recoveryDisposedAt,
      }
    : {};
  const retryAt =
    previous.lifecycle.lastRetryAt === undefined && incoming.lifecycle.lastRetryAt === undefined
      ? {}
      : {
          lastRetryAt: Math.max(previous.lifecycle.lastRetryAt ?? 0, incoming.lifecycle.lastRetryAt ?? 0),
        };
  return { ...incoming, lifecycle: { ...incoming.lifecycle, ...counter, ...retryAt, ...disposition } };
}
