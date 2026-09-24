import type {
  FreshnessReplayReport,
  FreshnessReplaySample,
  FreshnessReplayScenario,
  FreshnessReplaySelector,
  FreshnessReplayViolation,
} from './freshness-replay-types.js';

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
  const liveSampleCount = samples.filter((sample) => sample.source === 'live_window').length;
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
      ? {
          noDataReason:
            'No live samples resolved in this window; the windowed queue-custody and attention signals below carry the live evidence.',
        }
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
