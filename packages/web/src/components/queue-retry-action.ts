import type { QueueReceiptTarget, QueueTargetAttempt } from '@cat-cafe/shared';

export function latestRetryableQueueAttempt(target: QueueReceiptTarget): QueueTargetAttempt | undefined {
  if (target.state !== 'failed' || target.retryable === false) return undefined;
  const latest = target.attempts?.at(-1);
  return latest?.state === 'failed' ||
    (latest?.state === 'cancelled' && latest.terminalReason === 'invocation_cancelled')
    ? latest
    : undefined;
}
