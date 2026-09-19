import type { FreshnessClosureAggregate, FreshnessSupplementAggregate } from '@cat-cafe/shared';
import type { InvocationQueue, QueueEntry } from '../../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { FreshnessClosureStore } from '../../../domains/cats/services/freshness/closure/FreshnessClosureStore.js';
import type {
  FreshnessAttentionEvent,
  FreshnessAttentionEventLog,
  FreshnessEventWindowCoverage,
} from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { buildFreshnessReplayReport, deriveFreshnessClosureEvalSnapshot } from './freshness-closure-eval-adapter.js';
import { FRESHNESS_AC_E9_FIXTURE_IDS, loadFreshnessReplayFixture } from './freshness-replay-fixtures.js';
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
      store: FreshnessClosureStore;
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
    const [closureResult, supplementResult, queueResult, attentionResult] = await Promise.allSettled([
      this.deps.store.listUpdatedBetween(selector.windowStartMs, selector.windowEndMs),
      typeof this.deps.store.listAllSupplements === 'function'
        ? this.deps.store.listAllSupplements()
        : Promise.reject(new Error('supplement_source_unavailable')),
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
    const liveClosures = fulfilledValue<FreshnessClosureAggregate[]>(closureResult, []);
    const eligibleLiveClosures = liveClosures.filter(
      (closure) =>
        (!ownerUserId || closure.userId === ownerUserId) && (!threadFilter || threadFilter.has(closure.threadId)),
    );
    const supplements = fulfilledValue<FreshnessSupplementAggregate[]>(supplementResult, []).filter(
      (supplement) =>
        (!ownerUserId || supplement.userId === ownerUserId) && (!threadFilter || threadFilter.has(supplement.threadId)),
    );
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
    const liveSamples = eligibleLiveClosures
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(normalizeLiveClosure);
    const samples = [...fixtures, ...liveSamples];
    const windowedSignals = buildFreshnessWindowedSignals({
      window: { startMs: selector.windowStartMs, endMs: selector.windowEndMs },
      queueRecords,
      supplements,
      attentionEvents,
    });
    const sources = {
      legacy_closures: resultStatus(closureResult),
      queue_custody: resultStatus(queueResult),
      freshness_supplements: resultStatus(supplementResult),
      attention_events: coverageStatus(attentionWindow.coverage),
    };
    if (windowedSignals.queue.legacyUntimedCount > 0) {
      sources.queue_custody = {
        status: 'incomplete',
        reason: `legacy_untimed_lifecycles=${windowedSignals.queue.legacyUntimedCount}`,
      };
    }
    if (windowedSignals.supplements.legacyUntimedCount > 0) {
      sources.freshness_supplements = {
        status: 'incomplete',
        reason: `legacy_untimed_lifecycles=${windowedSignals.supplements.legacyUntimedCount}`,
      };
    }
    const reasons = Object.entries(sources)
      .filter(([, source]) => source.status !== 'complete')
      .map(([name, source]) => `${name}:${'reason' in source ? source.reason : source.status}`);
    return {
      selector: structuredClone(selector),
      samples,
      aggregateSnapshot: deriveFreshnessClosureEvalSnapshot(eligibleLiveClosures, {
        fromInclusive: selector.windowStartMs,
        toExclusive: selector.windowEndMs,
      }),
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

function normalizeLiveClosure(closure: FreshnessClosureAggregate): FreshnessReplaySample {
  const committedAttempts = closure.attempts.filter((attempt) => attempt.outcome === 'committed');
  const committedAttempt =
    committedAttempts.find((attempt) => attempt.invocationId === closure.committedInvocationId) ?? committedAttempts[0];
  const lineageComplete = Boolean(closure.originTriggerMessageId && closure.turnInvocationId);
  const staleCommittedAttempts = committedAttempts.filter(
    (attempt) => attempt.inputFrontierMessageId !== closure.requiredFrontierMessageId,
  );
  const sameBatchCounts = new Map<string, number>();
  for (const attempt of closure.attempts) {
    const key = `${attempt.inputFrontierMessageId ?? '<missing>'}:${attempt.createdAt}`;
    sameBatchCounts.set(key, (sameBatchCounts.get(key) ?? 0) + 1);
  }
  const sameBatchSiblingWakeCount = Math.max(
    0,
    ...[...sameBatchCounts.values()].map((count) => Math.max(0, count - 1)),
  );
  const terminalEvidenceComplete =
    closure.status === 'committed'
      ? Boolean(
          lineageComplete &&
            closure.committedMessageId &&
            closure.committedInvocationId &&
            committedAttempt?.evidenceRefs.length,
        )
      : closure.status === 'disposed'
        ? Boolean(closure.disposition?.evidenceRef)
        : closure.status === 'blocked'
          ? Boolean(
              closure.blockedEvidenceRefs?.length ||
                closure.attempts.at(-1)?.evidenceRefs.length ||
                (closure.blockedReason === 'side_effect_requires_explicit_retry' &&
                  closure.replayUnsafeToolNames?.length),
            )
          : true;
  const attentionReasons: FreshnessReplaySample['attentionReasons'] = [];
  if (closure.status === 'blocked') attentionReasons.push('blocked_responsibility');
  if (closure.status === 'pending' || closure.status === 'running') attentionReasons.push('unresolved_responsibility');
  return {
    id: `closure:${closure.id}@r${closure.revision}`,
    scenario: scenarioForClosure(closure),
    source: 'live_closure',
    occurredAt: closure.updatedAt,
    threadId: closure.threadId,
    catIds: [closure.catId],
    closureId: closure.id,
    traceRef: `trace:freshness-closure/${closure.id}@r${closure.revision}`,
    evidenceRefs: evidenceRefsForClosure(closure),
    facts: {
      responsibilityCount: 1,
      custodyCount: lineageComplete ? 1 : 0,
      formalFinalCount: committedAttempts.length,
      formalFinalLimit: 1,
      knownStaleFinalCount: staleCommittedAttempts.length,
      targetCount: 1,
      accountedTargetCount: lineageComplete ? 1 : 0,
      sameBatchSiblingWakeCount,
      automaticAttemptCount: closure.automaticSuccessorAttemptCount,
      automaticAttemptLimit:
        closure.blockedReason === 'attempt_budget_exhausted'
          ? Math.max(0, closure.automaticSuccessorAttemptCount - 1)
          : DEFAULT_AUTOMATIC_ATTEMPT_LIMIT,
      commitRecheckCount: closure.activeAttempt?.commitRecheckCount ?? 0,
      commitRecheckLimit:
        closure.blockedReason === 'commit_recheck_exhausted'
          ? Math.max(0, (closure.activeAttempt?.commitRecheckCount ?? 0) - 1)
          : null,
      terminalEvidenceComplete,
    },
    attentionReasons,
  };
}

function scenarioForClosure(closure: FreshnessClosureAggregate): FreshnessReplayScenario {
  if (closure.blockedReason === 'side_effect_requires_explicit_retry') return 'connector_blocked';
  if (closure.blockedReason === 'attempt_budget_exhausted' || closure.blockedReason === 'commit_recheck_exhausted') {
    return 'attempt_recheck_budget';
  }
  if (
    closure.blockedReason === 'user_cancel' ||
    closure.blockedReason === 'provider_failure' ||
    closure.blockedReason === 'infrastructure' ||
    closure.blockedReason === 'startup_recovery_requires_explicit_retry'
  ) {
    return 'crash_cancel';
  }
  if (closure.requiredMessageIds.length > 1) return 'continuous_new_messages';
  return 'original_double_message_dogfood';
}

function evidenceRefsForClosure(closure: FreshnessClosureAggregate): string[] {
  const refs = new Set<string>([
    `closure:${closure.id}@r${closure.revision}`,
    ...(closure.blockedEvidenceRefs ?? []),
    ...closure.attempts.flatMap((attempt) => attempt.evidenceRefs),
  ]);
  if (closure.committedMessageId) refs.add(`message:${closure.committedMessageId}`);
  if (closure.disposition?.evidenceRef) refs.add(closure.disposition.evidenceRef);
  return [...refs].sort();
}
