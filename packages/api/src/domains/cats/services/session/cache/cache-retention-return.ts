import type { TurnExecutionCacheFacts } from '../../stores/ports/TurnExecutionCacheFacts.js';
import type { CacheRetentionProbeService } from './CacheRetentionProbeService.js';
import type { CacheRetentionStateStore } from './CacheRetentionStateStore.js';
import { stopInterruptedRetentionAttempt } from './cache-retention-settlement.js';
import type { RetentionWindow } from './cache-retention-state.js';

/** Read-only recovery never replays a claimed provider input, even when its result is missing. */
export async function recoverRetentionReceipt(
  window: RetentionWindow,
  store: CacheRetentionStateStore,
  probe: Pick<CacheRetentionProbeService, 'readReceipt'>,
): Promise<RetentionWindow> {
  if (!window.attempt || window.attempt.completed) return window;
  // Durable usage is billing evidence, not proof of provider teardown or local ownership.
  await stopInterruptedRetentionAttempt(store, window.id, window.attempt.id);
  const receipt = await probe.readReceipt({
    ...window,
    sourceInvocationId: window.source.invocationId,
    attemptId: window.attempt.id,
  });
  if (receipt && !(await store.settleReceipt(window.id, window.attempt.id, receipt)))
    throw new Error('cache_retention_receipt_settlement_refused');
  return (await store.get(window.id)) ?? window;
}

/** First input after the receipt frontier; lastUsage and best-effort transcript absence prove no order. */
export async function reconcileRetentionReturn(
  window: RetentionWindow,
  store: CacheRetentionStateStore,
  facts?: TurnExecutionCacheFacts,
): Promise<void> {
  if (
    window.returned ||
    window.returnUnknown ||
    !window.receipts.length ||
    (window.attempt && !window.attempt.completed)
  )
    return;
  const receipt = window.receipts.at(-1)!;
  const frontier = receipt.returnAfterSequence;
  const first =
    facts && frontier !== undefined && frontier === window.sourceInputSequence
      ? await facts.firstAfter(window, frontier)
      : { status: 'unknown' as const };
  if (first.status === 'none') return;
  if (first.status === 'pending') {
    if (window.state !== 'stopped')
      await store.save(
        { ...window, revision: window.revision + 1, state: 'stopped', reason: 'real_input_started' },
        window.revision,
      );
    return;
  }
  if (first.status === 'unknown') {
    await store.save(
      {
        ...window,
        revision: window.revision + 1,
        state: 'stopped',
        reason: 'first_return_unproven',
        returnUnknown: 'first_return_unproven',
      },
      window.revision,
    );
    return;
  }
  const { observation, sessionId } = first.value;
  const same =
    sessionId === window.sessionId &&
    observation.runtime === window.source.runtime &&
    observation.model === window.source.model &&
    observation.executionBoundaryRef === window.source.executionBoundaryRef &&
    observation.compressionCount === window.source.compressionCount &&
    observation.nativeSessionId === window.nativeSessionId &&
    observation.requestStartedAt >= receipt.endedAt;
  const read = observation.cacheReadTokens;
  const known = same && typeof read === 'number' && Number.isFinite(read) && read >= 0 && observation.contextTokens > 0;
  const returned = {
    invocationId: first.invocationId,
    inputSequence: frontier! + 1,
    observedAt: observation.observedAt,
    maintenanceInvocationId: receipt.invocationId,
    maintenanceInvocationIds: window.receipts.map((item) => item.invocationId),
    ...(known ? { readRatio: read / observation.contextTokens } : {}),
  };
  if (!(await store.recordReturn(window, returned))) throw new Error('cache_retention_return_fact_refused');
  const health = await store.health(window.userId, window.catId, window.sessionId);
  await store.save(
    {
      ...window,
      revision: window.revision + 1,
      state: 'stopped',
      returned,
      reason: health?.stopped ? 'repeated_cold_return' : 'real_return',
    },
    window.revision,
  );
}
