import type { InvocationQueue, QueueEntry } from '../../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type {
  FreshnessAttentionEvent,
  FreshnessAttentionEventLog,
  FreshnessEventWindowCoverage,
} from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { FRESHNESS_AC_E9_FIXTURE_IDS, loadFreshnessReplayFixture } from './freshness-replay-fixtures.js';
import { buildFreshnessReplayReport } from './freshness-replay-report.js';
import type {
  FreshnessReplayBundle,
  FreshnessReplaySample,
  FreshnessReplayScenario,
  FreshnessReplaySelector,
  FreshnessReplaySourceStatus,
} from './freshness-replay-types.js';
import {
  buildFreshnessWindowedSignals,
  type FreshnessQueueLifecycleRecord,
} from './freshness-windowed-signal-report.js';
import { buildProviderNativeFreshnessCoverage } from './provider-native-freshness-coverage.js';

const DEFAULT_AUTOMATIC_ATTEMPT_LIMIT = 5;

export interface FreshnessReplayProvider {
  resolve(selector: FreshnessReplaySelector, context?: { ownerUserId?: string }): Promise<FreshnessReplayBundle>;
}

export class FreshnessReplayProviderImpl implements FreshnessReplayProvider {
  constructor(
    private readonly deps: {
      fixtureRoot: string;
      queueLifecycleSource?: Pick<InvocationQueue, 'listOwnerDurableEntries'>;
      messageLifecycleSource?: Pick<IMessageStore, 'listOwnerMessagesInWindow'>;
      attentionEventLog?: Pick<FreshnessAttentionEventLog, 'queryWindowBetween'>;
    },
  ) {}

  async resolve(
    selector: FreshnessReplaySelector,
    context: { ownerUserId?: string } = {},
  ): Promise<FreshnessReplayBundle> {
    const fixtures = FRESHNESS_AC_E9_FIXTURE_IDS.map((fixtureId) =>
      loadFreshnessReplayFixture({
        fixtureRoot: this.deps.fixtureRoot,
        fixtureId,
        occurredAt: selector.windowStartMs,
      }),
    );
    const threadFilter = selector.threadIds ? new Set(selector.threadIds) : null;
    const ownerUserId = context.ownerUserId;
    const [queueResult, attentionResult] = await Promise.allSettled([
      ownerUserId && this.deps.queueLifecycleSource && this.deps.messageLifecycleSource
        ? projectQueueLifecycleRecords(
            this.deps.queueLifecycleSource,
            this.deps.messageLifecycleSource,
            ownerUserId,
            selector.windowEndMs,
          )
        : Promise.reject(new Error('owner_scoped_queue_source_unavailable')),
      ownerUserId && this.deps.attentionEventLog
        ? this.deps.attentionEventLog.queryWindowBetween(selector.windowStartMs, selector.windowEndMs, ownerUserId, {
            ...(selector.threadIds ? { threadIds: selector.threadIds } : {}),
          })
        : Promise.reject(new Error('owner_scoped_attention_source_unavailable')),
    ]);
    const queueRecords = fulfilledValue<FreshnessQueueLifecycleRecord[]>(queueResult, []).filter(
      (record) => !threadFilter || threadFilter.has(record.threadId),
    );
    const attentionWindow =
      attentionResult.status === 'fulfilled'
        ? attentionResult.value
        : {
            events: [] as FreshnessAttentionEvent[],
            coverage: {
              status: 'unavailable' as const,
              observedThroughMs: Date.now(),
              reason: 'query_failed' as const,
            },
          };
    const attentionEvents = attentionWindow.events.filter((event) => !threadFilter || threadFilter.has(event.threadId));
    const samples = [...fixtures];
    const windowedSignals = buildFreshnessWindowedSignals({
      window: { startMs: selector.windowStartMs, endMs: selector.windowEndMs },
      queueRecords,
      attentionEvents,
    });
    const sources = {
      queue_custody: resultStatus(queueResult),
      attention_events: coverageStatus(attentionWindow.coverage),
    };
    if (windowedSignals.queue.legacyUntimedCount > 0) {
      sources.queue_custody = {
        status: 'incomplete',
        reason: `legacy_untimed_lifecycles=${windowedSignals.queue.legacyUntimedCount}`,
      };
    }
    const reasons = Object.entries(sources)
      .filter(([, source]) => source.status !== 'complete')
      .map(([name, source]) => `${name}:${'reason' in source ? source.reason : source.status}`);
    return {
      selector: structuredClone(selector),
      samples,
      report: buildFreshnessReplayReport(selector, samples),
      providerNativeCoverage: buildProviderNativeFreshnessCoverage(attentionEvents),
      windowedSignals,
      measurementMaturity: {
        status: reasons.length === 0 ? 'ready' : 'blocked',
        sources,
        reasons,
      },
    };
  }
}

function terminalProjection(
  response: StoredMessage | undefined,
): Pick<
  FreshnessQueueLifecycleRecord,
  'lastUpdatedAt' | 'handledAt' | 'withdrawnAt' | 'failedAt' | 'terminalState' | 'legacyUntimed'
> | null {
  const lifecycle = response?.lifecycle;
  if (!response || lifecycle?.kind !== 'response' || lifecycle.status === 'processing') return null;
  const terminalAt = lifecycle.completedAt ?? response.timestamp;
  if (lifecycle.status === 'completed') {
    return { lastUpdatedAt: terminalAt, handledAt: terminalAt, terminalState: true, legacyUntimed: false };
  }
  if (lifecycle.status === 'canceled' || (lifecycle.status === 'interrupted' && lifecycle.reason === 'preempted')) {
    return { lastUpdatedAt: terminalAt, withdrawnAt: terminalAt, terminalState: true, legacyUntimed: false };
  }
  return { lastUpdatedAt: terminalAt, failedAt: terminalAt, terminalState: true, legacyUntimed: false };
}

function activeQueueRecord(entry: QueueEntry, targetCatId: string): FreshnessQueueLifecycleRecord {
  return {
    entryId: entry.id,
    targetCatId,
    threadId: entry.threadId,
    ...(entry.payload.messageId ? { messageId: entry.payload.messageId } : {}),
    createdAt: entry.enqueuedAt,
    lastUpdatedAt: entry.processingStartedAt ?? entry.claimedAt ?? entry.enqueuedAt,
    ...(entry.claimedAt === undefined ? {} : { firstSeenAt: entry.claimedAt }),
    terminalState: false,
    legacyUntimed: false,
  };
}

async function projectQueueLifecycleRecords(
  queue: Pick<InvocationQueue, 'listOwnerDurableEntries'>,
  messages: Pick<IMessageStore, 'listOwnerMessagesInWindow'>,
  ownerUserId: string,
  windowEndMs: number,
): Promise<FreshnessQueueLifecycleRecord[]> {
  const [activeEntries, history] = await Promise.all([
    queue.listOwnerDurableEntries(ownerUserId),
    messages.listOwnerMessagesInWindow(ownerUserId, 0, windowEndMs),
  ]);
  const byId = new Map(history.map((message) => [message.id, message]));
  const records = new Map<string, FreshnessQueueLifecycleRecord>();
  for (const message of history) {
    if (message.lifecycle?.kind !== 'input') continue;
    for (const dispatch of message.lifecycle.dispatchRefs ?? []) {
      const key = `${message.lifecycle.orderKey}\u0000${dispatch.targetId}`;
      const terminal = terminalProjection(byId.get(dispatch.statusMessageId));
      records.set(key, {
        entryId: message.lifecycle.orderKey,
        targetCatId: dispatch.targetId,
        threadId: message.threadId,
        messageId: message.id,
        createdAt: message.timestamp,
        ...(dispatch.dispatchedAt === undefined ? {} : { firstSeenAt: dispatch.dispatchedAt }),
        ...(terminal ?? {
          lastUpdatedAt: dispatch.dispatchedAt ?? message.timestamp,
          terminalState: false,
          legacyUntimed: dispatch.dispatchedAt === undefined,
        }),
      });
    }
  }
  for (const entry of activeEntries) {
    for (const targetCatId of entry.targets) {
      const key = `${entry.id}\u0000${targetCatId}`;
      if (!records.has(key)) records.set(key, activeQueueRecord(entry, targetCatId));
    }
  }
  return [...records.values()];
}

function fulfilledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function resultStatus(result: PromiseSettledResult<unknown>): FreshnessReplaySourceStatus {
  return result.status === 'fulfilled' ? { status: 'complete' } : { status: 'unavailable', reason: 'query_failed' };
}

function coverageStatus(
  coverage: FreshnessEventWindowCoverage | { status: 'unavailable'; reason: 'query_failed'; observedThroughMs: number },
): FreshnessReplaySourceStatus {
  if (coverage.status === 'complete') return { status: 'complete' };
  return {
    status: coverage.status,
    reason: coverage.reason,
    ...('completeFromMs' in coverage ? { completeFromMs: coverage.completeFromMs } : {}),
    ...('observedThroughMs' in coverage ? { observedThroughMs: coverage.observedThroughMs } : {}),
  };
}
