import type { FreshnessSupplementAggregate } from '@cat-cafe/shared';
import type { FreshnessAttentionEvent } from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import type {
  FreshnessAttentionSignalReport,
  FreshnessQueueLifecycleReport,
  FreshnessSupplementLifecycleReport,
  FreshnessWindowedSignals,
} from './freshness-replay-types.js';

interface Window {
  startMs: number;
  endMs: number;
}

/** Queue/History join projected by the replay provider; no second durable lifecycle is introduced. */
export interface FreshnessQueueLifecycleRecord {
  entryId: string;
  targetCatId: string;
  threadId: string;
  messageId?: string;
  createdAt: number;
  lastUpdatedAt: number;
  firstSeenAt?: number;
  handledAt?: number;
  withdrawnAt?: number;
  failedAt?: number;
  terminalState: boolean;
  legacyUntimed: boolean;
}

function inWindow(timestamp: number | undefined, window: Window): boolean {
  return timestamp !== undefined && timestamp >= window.startMs && timestamp < window.endMs;
}

function lifecycleEndAt(record: Omit<FreshnessQueueLifecycleRecord, 'threadId'>): number | undefined {
  return (
    record.handledAt ??
    record.withdrawnAt ??
    record.failedAt ??
    (record.terminalState ? record.lastUpdatedAt : undefined)
  );
}

function queueLifecycleReport(
  records: readonly FreshnessQueueLifecycleRecord[],
  window: Window,
): FreshnessQueueLifecycleReport {
  const lifecycles = records
    .filter((record) => record.createdAt < window.endMs && (lifecycleEndAt(record) ?? Infinity) >= window.startMs)
    .map((record) => ({
      entryId: record.entryId,
      targetCatId: record.targetCatId,
      threadIds: [record.threadId],
      messageIds: record.messageId ? [record.messageId] : [],
      createdAt: record.createdAt,
      lastUpdatedAt: record.lastUpdatedAt,
      ...(record.firstSeenAt === undefined ? {} : { firstSeenAt: record.firstSeenAt }),
      ...(record.handledAt === undefined ? {} : { handledAt: record.handledAt }),
      ...(record.withdrawnAt === undefined ? {} : { withdrawnAt: record.withdrawnAt }),
      ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
      terminalState: record.terminalState,
      legacyUntimed: record.legacyUntimed,
    }))
    .sort((left, right) => left.createdAt - right.createdAt || left.entryId.localeCompare(right.entryId));
  return {
    entryTargetCount: lifecycles.length,
    admittedCount: lifecycles.filter((item) => inWindow(item.createdAt, window)).length,
    seenCount: lifecycles.filter((item) => inWindow(item.firstSeenAt, window)).length,
    handledCount: lifecycles.filter((item) => inWindow(item.handledAt, window)).length,
    withdrawnCount: lifecycles.filter((item) => inWindow(item.withdrawnAt, window)).length,
    failedCount: lifecycles.filter((item) => inWindow(item.failedAt, window)).length,
    seenUnhandledAtWindowEndCount: lifecycles.filter(
      (item) =>
        item.firstSeenAt !== undefined &&
        item.firstSeenAt < window.endMs &&
        (lifecycleEndAt(item) ?? Infinity) >= window.endMs,
    ).length,
    pendingAtWindowEndCount: lifecycles.filter(
      (item) => item.createdAt < window.endMs && (lifecycleEndAt(item) ?? Infinity) >= window.endMs,
    ).length,
    legacyUntimedCount: lifecycles.filter((item) => item.legacyUntimed).length,
    lifecycles,
  };
}

function supplementLifecycleReport(
  supplements: readonly FreshnessSupplementAggregate[],
  window: Window,
): FreshnessSupplementLifecycleReport {
  const lifecycles = supplements
    .filter((item) => {
      const terminal = item.status === 'committed' || item.status === 'declined' || item.status === 'failed';
      const endedAt = item.terminalAt ?? (terminal ? item.updatedAt : undefined);
      return item.createdAt < window.endMs && (endedAt ?? Infinity) >= window.startMs;
    })
    .map((item) => ({
      supplementId: item.id,
      threadId: item.threadId,
      catId: item.catId,
      createdAt: item.createdAt,
      lastUpdatedAt: item.updatedAt,
      ...(item.claimedAt === undefined ? {} : { claimedAt: item.claimedAt }),
      ...(item.terminalAt === undefined ? {} : { terminalAt: item.terminalAt }),
      status: item.status,
      legacyUntimed:
        item.updatedAt >= window.startMs &&
        (((item.status === 'running' || item.status === 'committed' || item.status === 'declined') &&
          item.claimedAt === undefined) ||
          (item.status === 'failed' && item.createdAt < window.startMs && item.claimedAt === undefined) ||
          ((item.status === 'committed' || item.status === 'declined' || item.status === 'failed') &&
            item.terminalAt === undefined)),
    }))
    .sort((left, right) => left.createdAt - right.createdAt || left.supplementId.localeCompare(right.supplementId));
  return {
    offeredCount: lifecycles.filter((item) => inWindow(item.createdAt, window)).length,
    claimedCount: lifecycles.filter((item) => inWindow(item.claimedAt, window)).length,
    terminalCount: lifecycles.filter((item) => inWindow(item.terminalAt, window)).length,
    committedCount: lifecycles.filter((item) => item.status === 'committed' && inWindow(item.terminalAt, window))
      .length,
    declinedCount: lifecycles.filter((item) => item.status === 'declined' && inWindow(item.terminalAt, window)).length,
    failedCount: lifecycles.filter((item) => item.status === 'failed' && inWindow(item.terminalAt, window)).length,
    unresolvedAtWindowEndCount: lifecycles.filter((item) => {
      const terminal = item.status === 'committed' || item.status === 'declined' || item.status === 'failed';
      const endedAt = item.terminalAt ?? (terminal ? item.lastUpdatedAt : undefined);
      return item.createdAt < window.endMs && (endedAt ?? Infinity) >= window.endMs;
    }).length,
    budgetExhaustedCount: supplements.filter((item) => inWindow(item.budgetExhausted?.observedAt, window)).length,
    legacyUntimedCount: lifecycles.filter((item) => item.legacyUntimed).length,
    lifecycles,
  };
}

function attentionSignalReport(events: readonly FreshnessAttentionEvent[]): FreshnessAttentionSignalReport {
  const counts: FreshnessAttentionSignalReport['counts'] = {};
  for (const event of events) {
    const units =
      event.kind === 'notice_implicit_acked' || event.kind === 'notice_deferred' ? event.noticeIds.length : 1;
    counts[event.kind] = (counts[event.kind] ?? 0) + units;
  }
  return { eventCount: events.length, counts };
}

export function buildFreshnessWindowedSignals(input: {
  window: Window;
  queueRecords: readonly FreshnessQueueLifecycleRecord[];
  supplements: readonly FreshnessSupplementAggregate[];
  attentionEvents: readonly FreshnessAttentionEvent[];
}): FreshnessWindowedSignals {
  const queue = queueLifecycleReport(input.queueRecords, input.window);
  const supplements = supplementLifecycleReport(input.supplements, input.window);
  const attention = attentionSignalReport(input.attentionEvents);
  return {
    window: { ...input.window },
    queue,
    supplements,
    attention,
    observedActivityCount:
      queue.admittedCount +
      queue.seenCount +
      queue.handledCount +
      queue.withdrawnCount +
      queue.failedCount +
      supplements.offeredCount +
      supplements.claimedCount +
      supplements.terminalCount +
      supplements.budgetExhaustedCount +
      attention.eventCount,
  };
}
