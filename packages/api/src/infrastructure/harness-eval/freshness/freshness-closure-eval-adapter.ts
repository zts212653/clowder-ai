import type { FreshnessClosureStore } from '../../../domains/cats/services/freshness/FreshnessClosureStore.js';
import type {
  FreshnessReplayAggregateSnapshot,
  FreshnessReplayReport,
  FreshnessReplaySample,
  FreshnessReplayScenario,
  FreshnessReplaySelector,
  FreshnessReplayViolation,
} from './freshness-replay-types.js';

export type FreshnessClosureEvalSnapshot = FreshnessReplayAggregateSnapshot;

/** Replayable F192 source adapter over the TTL=0 closure aggregate. */
export async function readFreshnessClosureEvalSnapshot(input: {
  store: FreshnessClosureStore;
  fromInclusive: number;
  toExclusive: number;
}): Promise<FreshnessClosureEvalSnapshot> {
  const closures = await input.store.listUpdatedBetween(input.fromInclusive, input.toExclusive);
  return deriveFreshnessClosureEvalSnapshot(closures, {
    fromInclusive: input.fromInclusive,
    toExclusive: input.toExclusive,
  });
}

export function deriveFreshnessClosureEvalSnapshot(
  closures: Awaited<ReturnType<FreshnessClosureStore['listUpdatedBetween']>>,
  window: { fromInclusive: number; toExclusive: number },
): FreshnessClosureEvalSnapshot {
  const committedCount = closures.filter((closure) => closure.status === 'committed').length;
  const blockedCount = closures.filter((closure) => closure.status === 'blocked').length;
  const disposedCount = closures.filter((closure) => closure.status === 'disposed').length;
  const unresolvedCount = closures.filter(
    (closure) => closure.status === 'pending' || closure.status === 'running',
  ).length;
  const supersededAttemptCount = closures.reduce(
    (total, closure) => total + closure.attempts.filter((attempt) => attempt.outcome === 'superseded').length,
    0,
  );
  const redundantCommittedAttemptCount = closures.reduce(
    (total, closure) =>
      total + Math.max(0, closure.attempts.filter((attempt) => attempt.outcome === 'committed').length - 1),
    0,
  );
  const attemptBudgetExhaustedCount = closures.filter(
    (closure) => closure.blockedReason === 'attempt_budget_exhausted',
  ).length;
  const commitRecheckExhaustedCount = closures.filter(
    (closure) => closure.blockedReason === 'commit_recheck_exhausted',
  ).length;
  const startupRecoveryBlockedCount = closures.filter(
    (closure) => closure.blockedReason === 'startup_recovery_requires_explicit_retry',
  ).length;
  const preflightIncompleteCount = closures.filter(
    (closure) => closure.blockedReason === 'freshness_preflight_incomplete',
  ).length;
  const lineageIdentityGapCount = closures.filter(
    (closure) => !closure.originTriggerMessageId || !closure.turnInvocationId,
  ).length;
  const custodyGapCount = closures.filter((closure) => {
    if (closure.status !== 'committed') return false;
    const committedAttempts = closure.attempts.filter((attempt) => attempt.outcome === 'committed');
    return committedAttempts.some((attempt) => attempt.inputFrontierMessageId !== closure.requiredFrontierMessageId);
  }).length;
  const needsAttention =
    redundantCommittedAttemptCount > 0 ||
    blockedCount > 0 ||
    unresolvedCount > 0 ||
    custodyGapCount > 0 ||
    lineageIdentityGapCount > 0;
  return {
    window,
    closureCount: closures.length,
    committedCount,
    blockedCount,
    disposedCount,
    unresolvedCount,
    supersededAttemptCount,
    redundantCommittedAttemptCount,
    attemptBudgetExhaustedCount,
    commitRecheckExhaustedCount,
    startupRecoveryBlockedCount,
    preflightIncompleteCount,
    lineageIdentityGapCount,
    custodyGapCount,
    verdict: closures.length === 0 ? 'no_data' : needsAttention ? 'needs_attention' : 'healthy',
  };
}

const REPLAY_SCENARIOS: FreshnessReplayScenario[] = [
  'original_double_message_dogfood',
  'existing_coverage_without_closure',
  'crash_cancel',
  'continuous_new_messages',
  'multi_target',
  'parallel_same_batch',
  'attempt_recheck_budget',
  'connector_blocked',
];

/** Derive every verdict metric from server-resolved replay samples. */
export function buildFreshnessReplayReport(
  selector: FreshnessReplaySelector,
  samples: FreshnessReplaySample[],
): FreshnessReplayReport {
  const evaluations = samples.map((sample) => {
    const violations = evaluateSample(sample);
    return {
      sampleId: sample.id,
      scenario: sample.scenario,
      traceRef: sample.traceRef,
      passed: violations.length === 0,
      violations,
      attentionReasons: [...sample.attentionReasons],
    };
  });
  const scenarioCounts = Object.fromEntries(REPLAY_SCENARIOS.map((scenario) => [scenario, 0])) as Record<
    FreshnessReplayScenario,
    number
  >;
  for (const sample of samples) scenarioCounts[sample.scenario] += 1;
  const failedSampleCount = evaluations.filter((evaluation) => !evaluation.passed).length;
  const attentionSampleCount = evaluations.filter((evaluation) => evaluation.attentionReasons.length > 0).length;
  const liveSampleCount = samples.filter((sample) => sample.source === 'live_closure').length;
  const verdict =
    liveSampleCount === 0
      ? 'no_data'
      : failedSampleCount > 0 || attentionSampleCount > 0
        ? 'needs_attention'
        : 'healthy';
  return {
    window: { startMs: selector.windowStartMs, endMs: selector.windowEndMs },
    eligibleSampleCount: samples.length,
    passedSampleCount: samples.length - failedSampleCount,
    failedSampleCount,
    attentionSampleCount,
    fixtureSampleCount: samples.filter((sample) => sample.source === 'fixture').length,
    liveSampleCount,
    scenarioCounts,
    evaluations,
    verdict,
    healthy: verdict === 'healthy',
    ...(liveSampleCount === 0
      ? { noDataReason: 'No eligible live freshness closure samples resolved for this window.' }
      : {}),
  };
}

function evaluateSample(sample: FreshnessReplaySample): FreshnessReplayViolation[] {
  const facts = sample.facts;
  const violations: FreshnessReplayViolation[] = [];
  if (facts.custodyCount < facts.responsibilityCount) violations.push('responsibility_without_custody');
  if (facts.formalFinalCount > facts.formalFinalLimit) violations.push('formal_final_limit_exceeded');
  if (facts.knownStaleFinalCount > 0) violations.push('known_stale_final_visible');
  if (facts.accountedTargetCount < facts.targetCount) violations.push('target_outcome_missing');
  if (facts.sameBatchSiblingWakeCount > 0) violations.push('same_batch_sibling_triggered');
  if (facts.automaticAttemptLimit !== null && facts.automaticAttemptCount > facts.automaticAttemptLimit) {
    violations.push('automatic_attempt_budget_exceeded');
  }
  if (facts.commitRecheckLimit !== null && facts.commitRecheckCount > facts.commitRecheckLimit) {
    violations.push('commit_recheck_budget_exceeded');
  }
  if (!facts.terminalEvidenceComplete) violations.push('terminal_evidence_missing');
  return violations;
}
