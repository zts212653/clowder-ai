import type { ContextEpochRecord } from '../../../cats/services/stores/ports/ContextEpochStore.js';
import type { LiveInboxScope } from '../inbox/live-inbox-contract.js';

export async function abortableRecoveryRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const onAbort = () => rejectAbort(signal.reason);
  let rejectAbort: (reason: unknown) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([read(), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function recoveryBinding(scope: LiveInboxScope, epoch: ContextEpochRecord | null) {
  return JSON.stringify([
    scope.userId,
    scope.threadId,
    scope.catId,
    scope.invocationId,
    scope.parentInvocationId ?? null,
    scope.callId,
    scope.generation,
    epoch?.version ?? null,
  ]);
}

export function recoveryContinuity(epoch: ContextEpochRecord | null) {
  return epoch
    ? {
        source: 'F296' as const,
        contextEpoch: epoch.contextEpoch,
        recordVersion: epoch.version,
        transitionRef: epoch.lastTransitionRef,
      }
    : { source: 'unavailable' as const };
}
