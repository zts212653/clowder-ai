import type { FreshnessClosureAggregate } from '@cat-cafe/shared';
import type { FreshnessAttentionEventLog } from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import type { FreshnessClosureStore } from '../../../domains/cats/services/freshness/FreshnessClosureStore.js';
import { buildFreshnessReplayReport, deriveFreshnessClosureEvalSnapshot } from './freshness-closure-eval-adapter.js';
import { FRESHNESS_AC_E9_FIXTURE_IDS, loadFreshnessReplayFixture } from './freshness-replay-fixtures.js';
import type {
  FreshnessReplayBundle,
  FreshnessReplaySample,
  FreshnessReplayScenario,
  FreshnessReplaySelector,
} from './freshness-replay-types.js';
import { buildProviderNativeFreshnessCoverage } from './provider-native-freshness-coverage.js';

const DEFAULT_AUTOMATIC_ATTEMPT_LIMIT = 5;

export interface FreshnessReplayProvider {
  resolve(selector: FreshnessReplaySelector): Promise<FreshnessReplayBundle>;
}

export class FreshnessReplayProviderImpl implements FreshnessReplayProvider {
  constructor(
    private readonly deps: {
      store: FreshnessClosureStore;
      fixtureRoot: string;
      providerNativeEventLog?: Pick<FreshnessAttentionEventLog, 'queryProviderNativeBetween'>;
    },
  ) {}

  async resolve(selector: FreshnessReplaySelector): Promise<FreshnessReplayBundle> {
    const fixtures = FRESHNESS_AC_E9_FIXTURE_IDS.map((fixtureId) =>
      loadFreshnessReplayFixture({
        fixtureRoot: this.deps.fixtureRoot,
        fixtureId,
        occurredAt: selector.windowStartMs,
      }),
    );
    const threadFilter = selector.threadIds ? new Set(selector.threadIds) : null;
    const liveClosures = await this.deps.store.listUpdatedBetween(selector.windowStartMs, selector.windowEndMs);
    const eligibleLiveClosures = liveClosures.filter((closure) => !threadFilter || threadFilter.has(closure.threadId));
    const liveSamples = eligibleLiveClosures
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(normalizeLiveClosure);
    const samples = [...fixtures, ...liveSamples];
    const providerNativeEvents = this.deps.providerNativeEventLog
      ? await this.deps.providerNativeEventLog.queryProviderNativeBetween(selector.windowStartMs, selector.windowEndMs)
      : [];
    return {
      selector: structuredClone(selector),
      samples,
      aggregateSnapshot: deriveFreshnessClosureEvalSnapshot(eligibleLiveClosures, {
        fromInclusive: selector.windowStartMs,
        toExclusive: selector.windowEndMs,
      }),
      report: buildFreshnessReplayReport(selector, samples),
      providerNativeCoverage: buildProviderNativeFreshnessCoverage(
        providerNativeEvents.filter((event) => !threadFilter || threadFilter.has(event.threadId)),
      ),
    };
  }
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
