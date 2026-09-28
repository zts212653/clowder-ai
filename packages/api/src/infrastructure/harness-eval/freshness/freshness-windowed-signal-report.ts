import type { FreshnessSupplementAggregate } from '@cat-cafe/shared';
import type { FreshnessAttentionEvent } from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import type { QueueCustodyLifecycleRecord } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type {
  FreshnessAttentionSignalReport,
  FreshnessQueueLifecycle,
  FreshnessQueueLifecycleReport,
  FreshnessSupplementLifecycleReport,
  FreshnessWindowedSignals,
} from './freshness-replay-types.js';

interface Window {
  startMs: number;
  endMs: number;
}

interface QueueAccumulator {
  entryId: string;
  targetCatId: string;
  threadIds: Set<string>;
  messageIds: Set<string>;
  latestRevision: number;
  createdAt: number;
  updatedAt: number;
  firstSeenAt?: number;
  handledAt?: number;
  withdrawnAt?: number;
  failedAt?: number;
  seenWithoutTime: boolean;
  handledWithoutTime: boolean;
  withdrawnWithoutTime: boolean;
  failedWithoutTime: boolean;
}

function inWindow(timestamp: number | undefined, window: Window): boolean {
  return timestamp !== undefined && timestamp >= window.startMs && timestamp < window.endMs;
}

function earliest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function latest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function currentFailureAt(record: QueueCustodyLifecycleRecord, targetCatId: string): number | undefined {
  if (!record.custody.failedByCatIds.some((catId) => catId === targetCatId)) return undefined;
  return (record.custody.targetAttempts ?? [])
    .filter(
      (attempt) =>
        attempt.targetCatId === targetCatId &&
        (attempt.state === 'failed' || attempt.state === 'interrupted' || attempt.state === 'cancelled'),
    )
    .sort((left, right) => right.sequence - left.sequence || right.updatedAt - left.updatedAt)[0]?.updatedAt;
}

function terminalAt(lifecycle: FreshnessQueueLifecycle): number | undefined {
  return earliest(earliest(lifecycle.handledAt, lifecycle.withdrawnAt), lifecycle.failedAt);
}

function lifecycleEndAt(lifecycle: FreshnessQueueLifecycle): number | undefined {
  return terminalAt(lifecycle) ?? (lifecycle.terminalState ? lifecycle.lastUpdatedAt : undefined);
}

function intersectsWindow(createdAt: number, terminal: number | undefined, window: Window): boolean {
  return createdAt < window.endMs && (terminal === undefined || terminal >= window.startMs);
}

function queueTargets(record: QueueCustodyLifecycleRecord): string[] {
  const custody = record.custody;
  return [
    ...new Set([
      ...custody.allTargetCats,
      ...custody.seenByCatIds,
      ...custody.handledByCatIds,
      ...custody.failedByCatIds,
      ...(custody.withdrawnByCatIds ?? []),
      ...Object.keys(custody.targetOutcomeByCatId ?? {}),
      ...Object.keys(custody.withdrawnAtByCatId ?? {}),
      ...(custody.bodyExposures ?? []).map((exposure) => exposure.targetCatId),
      ...(custody.targetAttempts ?? []).map((attempt) => attempt.targetCatId),
    ]),
  ];
}

function newQueueAccumulator(record: QueueCustodyLifecycleRecord, targetCatId: string): QueueAccumulator {
  return {
    entryId: record.custody.entryId,
    targetCatId,
    threadIds: new Set<string>(),
    messageIds: new Set<string>(),
    latestRevision: -1,
    createdAt: record.custody.createdAt,
    updatedAt: record.custody.updatedAt,
    seenWithoutTime: false,
    handledWithoutTime: false,
    withdrawnWithoutTime: false,
    failedWithoutTime: false,
  };
}

function resetTerminalProjection(current: QueueAccumulator, revision: number): void {
  current.latestRevision = revision;
  current.handledAt = undefined;
  current.withdrawnAt = undefined;
  current.failedAt = undefined;
  current.handledWithoutTime = false;
  current.withdrawnWithoutTime = false;
  current.failedWithoutTime = false;
}

function absorbCurrentTerminal(
  current: QueueAccumulator,
  record: QueueCustodyLifecycleRecord,
  targetCatId: string,
): void {
  const custody = record.custody;
  if (custody.handledByCatIds.some((catId) => catId === targetCatId)) {
    current.handledAt = earliest(current.handledAt, custody.targetOutcomeByCatId?.[targetCatId]?.handledAt);
    current.handledWithoutTime ||= current.handledAt === undefined;
  }
  if (custody.withdrawnByCatIds?.some((catId) => catId === targetCatId)) {
    current.withdrawnAt = earliest(current.withdrawnAt, custody.withdrawnAtByCatId?.[targetCatId]);
    current.withdrawnWithoutTime ||= current.withdrawnAt === undefined;
  }
  if (custody.failedByCatIds.some((catId) => catId === targetCatId)) {
    current.failedAt = latest(current.failedAt, currentFailureAt(record, targetCatId));
    current.failedWithoutTime ||= current.failedAt === undefined;
  }
}

function absorbQueueTarget(current: QueueAccumulator, record: QueueCustodyLifecycleRecord, targetCatId: string): void {
  const custody = record.custody;
  current.threadIds.add(record.threadId);
  current.messageIds.add(record.messageId);
  current.createdAt = Math.min(current.createdAt, custody.createdAt);
  current.updatedAt = Math.max(current.updatedAt, custody.updatedAt);
  for (const exposure of custody.bodyExposures ?? []) {
    if (exposure.targetCatId === targetCatId) current.firstSeenAt = earliest(current.firstSeenAt, exposure.seenAt);
  }
  if (custody.revision > current.latestRevision) resetTerminalProjection(current, custody.revision);
  if (custody.revision === current.latestRevision) absorbCurrentTerminal(current, record, targetCatId);
  current.seenWithoutTime ||=
    custody.seenByCatIds.some((catId) => catId === targetCatId) && current.firstSeenAt === undefined;
}

function queueLifecycle(item: QueueAccumulator, window: Window): FreshnessQueueLifecycle {
  const terminalState =
    item.handledAt !== undefined ||
    item.withdrawnAt !== undefined ||
    item.failedAt !== undefined ||
    item.handledWithoutTime ||
    item.withdrawnWithoutTime ||
    item.failedWithoutTime;
  const legacyUntimed =
    item.updatedAt >= window.startMs &&
    ((item.seenWithoutTime && item.firstSeenAt === undefined) ||
      (item.handledWithoutTime && item.handledAt === undefined) ||
      (item.withdrawnWithoutTime && item.withdrawnAt === undefined) ||
      (item.failedWithoutTime && item.failedAt === undefined));
  return {
    entryId: item.entryId,
    targetCatId: item.targetCatId,
    threadIds: [...item.threadIds].sort(),
    messageIds: [...item.messageIds].sort(),
    createdAt: item.createdAt,
    lastUpdatedAt: item.updatedAt,
    ...(item.firstSeenAt === undefined ? {} : { firstSeenAt: item.firstSeenAt }),
    ...(item.handledAt === undefined ? {} : { handledAt: item.handledAt }),
    ...(item.withdrawnAt === undefined ? {} : { withdrawnAt: item.withdrawnAt }),
    ...(item.failedAt === undefined ? {} : { failedAt: item.failedAt }),
    terminalState,
    legacyUntimed,
  };
}

function mergeQueueLifecycles(records: readonly QueueCustodyLifecycleRecord[], window: Window) {
  const merged = new Map<string, QueueAccumulator>();
  for (const record of records) {
    for (const targetCatId of queueTargets(record)) {
      const key = `${record.custody.entryId}\u0000${targetCatId}`;
      const current = merged.get(key) ?? newQueueAccumulator(record, targetCatId);
      absorbQueueTarget(current, record, targetCatId);
      merged.set(key, current);
    }
  }
  return [...merged.values()]
    .map((item) => queueLifecycle(item, window))
    .filter((item) => intersectsWindow(item.createdAt, lifecycleEndAt(item), window))
    .sort((left, right) => left.createdAt - right.createdAt || left.entryId.localeCompare(right.entryId));
}

function queueLifecycleReport(records: readonly QueueCustodyLifecycleRecord[], window: Window) {
  const lifecycles = mergeQueueLifecycles(records, window);

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
  } satisfies FreshnessQueueLifecycleReport;
}

function supplementLifecycleReport(
  supplements: readonly FreshnessSupplementAggregate[],
  window: Window,
): FreshnessSupplementLifecycleReport {
  const lifecycles = supplements
    .filter((item) => {
      const isTerminal = item.status === 'committed' || item.status === 'declined' || item.status === 'failed';
      return intersectsWindow(item.createdAt, item.terminalAt ?? (isTerminal ? item.updatedAt : undefined), window);
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
      const isTerminal = item.status === 'committed' || item.status === 'declined' || item.status === 'failed';
      const endedAt = item.terminalAt ?? (isTerminal ? item.lastUpdatedAt : undefined);
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
  queueRecords: readonly QueueCustodyLifecycleRecord[];
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
