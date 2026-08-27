import type { QueueReceiptTarget, QueueTargetAttempt } from '@cat-cafe/shared';
import type { QueueEntry } from '@/stores/chat-types';

export function latestRetryableQueueAttempt(target: QueueReceiptTarget): QueueTargetAttempt | undefined {
  if (target.state !== 'failed' || target.retryable === false) return undefined;
  const latest = target.attempts?.at(-1);
  return latest?.state === 'failed' ||
    (latest?.state === 'cancelled' && latest.terminalReason === 'invocation_cancelled')
    ? latest
    : undefined;
}

export function queueEntryHasSteerableTarget(entry: QueueEntry): boolean {
  const states = Object.values(entry.targetStates ?? {});
  return states.length === 0 || states.some((state) => state !== 'failed');
}
