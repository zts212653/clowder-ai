import { isDeepStrictEqual } from 'node:util';
import type { CacheRetentionProbeReceipt } from './CacheRetentionProbeService.js';
import type { CacheRetentionStateStore } from './CacheRetentionStateStore.js';
import { RETENTION_LEAD_MS, type RetentionWindow } from './cache-retention-state.js';

const CAS_ATTEMPTS = 8;

/** An orphaned claim loses send eligibility before any raw result is consulted. */
export async function stopInterruptedRetentionAttempt(
  store: Pick<CacheRetentionStateStore, 'get' | 'save'>,
  id: string,
  attemptId: string,
): Promise<RetentionWindow> {
  for (let conflict = 0; conflict < CAS_ATTEMPTS; conflict++) {
    const latest = await store.get(id);
    if (!latest || latest.attempt?.id !== attemptId) break;
    if (latest.state === 'stopped') return latest;
    const stopped: RetentionWindow = {
      ...latest,
      revision: latest.revision + 1,
      state: 'stopped',
      reason: 'interrupted_attempt_cost_unknown',
    };
    if (await store.save(stopped, latest.revision)) return stopped;
  }
  throw new Error('cache_retention_interrupted_stop_unconfirmed');
}

/** CAS conflicts retry only this metadata merge; the durable receipt remains recoverable next poll. */
export async function settleRetentionReceipt(
  store: Pick<CacheRetentionStateStore, 'get' | 'save'>,
  id: string,
  attemptId: string,
  receipt: CacheRetentionProbeReceipt,
): Promise<boolean> {
  for (let conflict = 0; conflict < CAS_ATTEMPTS; conflict++) {
    const latest = await store.get(id);
    if (
      !latest ||
      latest.attempt?.id !== attemptId ||
      receipt.sessionId !== latest.sessionId ||
      receipt.parentNativeSessionId !== latest.nativeSessionId ||
      receipt.sourceInvocationId !== latest.source.invocationId
    )
      return false;
    const existing = latest.receipts.find((item) => item.invocationId === receipt.invocationId);
    if (existing) return latest.attempt.completed && isDeepStrictEqual(existing, receipt);
    if (
      await store.save(
        {
          ...latest,
          revision: latest.revision + 1,
          receipts: [...latest.receipts, receipt],
          attempt: { ...latest.attempt, completed: true },
          state: latest.state === 'stopped' || receipt.outcome !== 'sample_pass' ? 'stopped' : 'waiting',
          ...(latest.state !== 'stopped' && receipt.outcome !== 'sample_pass'
            ? { reason: receipt.reason ?? 'maintenance_failed' }
            : {}),
          dueAt: receipt.startedAt + 3_600_000 - RETENTION_LEAD_MS,
        },
        latest.revision,
      )
    )
      return true;
  }
  return false;
}
