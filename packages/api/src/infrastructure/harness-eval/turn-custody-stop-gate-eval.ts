import {
  TURN_CUSTODY_CLOSE_CHECKPOINT_ATTR,
  TURN_CUSTODY_PROJECTION_REASON_ATTR,
  TURN_CUSTODY_PROJECTION_STATE_ATTR,
  TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL,
  TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL,
  TURN_CUSTODY_PROMETHEUS_STATE_LABEL,
  TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME,
  TURN_CUSTODY_SOURCE_CATEGORY_ATTR,
  TURN_CUSTODY_SOURCE_SEMANTIC_ATTR,
  TURN_CUSTODY_TRANSITION_OBSERVED_ATTR,
  TURN_CUSTODY_UNKNOWN_AGREE_BLOCK_EVENT_NAME,
  TURN_CUSTODY_WAKE_PROVENANCE_ATTR,
} from '../telemetry/turn-custody-shadow-telemetry.js';
import { extractPerFireSamples, type PerFireSample } from './c2-sample-evidence.js';
import type { ComponentHealth, TelemetryGap } from './f167-eval.js';
import type { EvalTraceSpan } from './telemetry-adapter.js';

export { TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME };

const PROJECTION_METRIC = 'cat_cafe_a2a_turn_custody_projection_total';
const COMPARISON_METRIC = 'cat_cafe_a2a_turn_custody_shadow_comparison_total';

function metricName(raw: string): string {
  return raw.replace(/\{[^}]*\}/, '');
}

function matchesMetric(raw: string, expected: string): boolean {
  const name = metricName(raw);
  return name === expected || name === `${expected}_total`;
}

function labelValue(raw: string, label: string): string | undefined {
  const labels = /\{([^}]*)\}/.exec(raw)?.[1];
  if (!labels) return undefined;
  return new RegExp(`(?:^|,)${label}="([^"]*)"`).exec(labels)?.[1];
}

function sumMetric(metrics: Record<string, number>, expected: string): number | null {
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (!matchesMetric(key, expected)) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function sumLabelledMetric(
  metrics: Record<string, number>,
  expected: string,
  label: string,
  expectedValue: string,
): number | null {
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (!matchesMetric(key, expected) || labelValue(key, label) !== expectedValue) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function sumKnown(values: ReadonlyArray<number | null>): number | null {
  return values.some((value) => value == null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null) return null;
  return denominator === 0 ? 0 : numerator / denominator;
}

function gap(metric: string, impact: string): TelemetryGap {
  return { metric, reason: 'no_counter', impact };
}

/** F167 Phase T utility projection consumed by the real weekly eval:a2a verdict. */
export function buildTurnCustodyStopGateEval(
  metrics: Record<string, number>,
  spans: ReadonlyArray<EvalTraceSpan> = [],
): ComponentHealth {
  const coveredActive = sumLabelledMetric(
    metrics,
    PROJECTION_METRIC,
    TURN_CUSTODY_PROMETHEUS_STATE_LABEL,
    'covered_active',
  );
  const coveredEmpty = sumLabelledMetric(
    metrics,
    PROJECTION_METRIC,
    TURN_CUSTODY_PROMETHEUS_STATE_LABEL,
    'covered_empty',
  );
  const unknownLegacy = sumLabelledMetric(
    metrics,
    PROJECTION_METRIC,
    TURN_CUSTODY_PROMETHEUS_STATE_LABEL,
    'unknown_legacy',
  );
  const projections = sumKnown([coveredActive, coveredEmpty, unknownLegacy]);

  const agreeAllow = sumLabelledMetric(
    metrics,
    COMPARISON_METRIC,
    TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL,
    'agree_allow',
  );
  const agreeBlock = sumLabelledMetric(
    metrics,
    COMPARISON_METRIC,
    TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL,
    'agree_block',
  );
  const oldOnlyBlock = sumLabelledMetric(
    metrics,
    COMPARISON_METRIC,
    TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL,
    'old_only_block',
  );
  const newOnlyBlock = sumLabelledMetric(
    metrics,
    COMPARISON_METRIC,
    TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL,
    'new_only_block',
  );
  const newOnlyJustified = sumLabelledMetric(
    metrics,
    COMPARISON_METRIC,
    TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL,
    'justified',
  );
  const newOnlyUnjustified = sumLabelledMetric(
    metrics,
    COMPARISON_METRIC,
    TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL,
    'unjustified',
  );
  const newOnlyUnexplained = sumLabelledMetric(
    metrics,
    COMPARISON_METRIC,
    TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL,
    'unexplained',
  );
  const newOnlyClassified = sumKnown([newOnlyJustified, newOnlyUnjustified, newOnlyUnexplained]);
  const newOnlyClassificationGap =
    newOnlyBlock == null || newOnlyClassified == null ? null : Math.abs(newOnlyBlock - newOnlyClassified);
  const agreements = sumKnown([agreeAllow, agreeBlock]);
  const disagreements = sumKnown([oldOnlyBlock, newOnlyBlock]);

  const oldBlock = sumMetric(metrics, 'cat_cafe_a2a_turn_custody_shadow_old_block_total');
  const newBlock = sumMetric(metrics, 'cat_cafe_a2a_turn_custody_shadow_new_block_total');
  const projectedBlockIncrease = oldBlock == null || newBlock == null ? null : Math.max(0, newBlock - oldBlock);

  const protocolActionWithoutCustody = sumMetric(metrics, 'cat_cafe_a2a_protocol_action_without_custody_total');
  const userNudgeRequired = sumMetric(metrics, 'cat_cafe_a2a_user_nudge_required_total');
  const legacyGuardWithoutActiveCustody = sumMetric(metrics, 'cat_cafe_a2a_legacy_guard_without_active_custody_total');
  const sameSubjectPostTerminalEnqueue = sumMetric(metrics, 'cat_cafe_a2a_same_subject_post_terminal_enqueue_total');
  const leaseSucceededSubjectNonterminal = sumMetric(metrics, 'cat_cafe_a2a_lease_succeeded_subject_nonterminal_total');

  const required: Array<[string, number | null, string]> = [
    [
      'turn_custody.projection.covered_active',
      coveredActive,
      'Cannot measure structured wakes that carry an active protocol ball',
    ],
    [
      'turn_custody.projection.covered_empty',
      coveredEmpty,
      'Cannot measure turns that should stop naturally without a protocol obligation',
    ],
    [
      'turn_custody.projection.unknown_legacy',
      unknownLegacy,
      'Cannot measure remaining legacy wake provenance before cutover',
    ],
    ['turn_custody.comparison.agree_allow', agreeAllow, 'Cannot compare legacy and structured allow decisions'],
    ['turn_custody.comparison.agree_block', agreeBlock, 'Cannot compare legacy and structured block decisions'],
    [
      'turn_custody.comparison.old_only_block',
      oldOnlyBlock,
      'Cannot inspect legacy false-positive candidates before deleting the old guard',
    ],
    [
      'turn_custody.comparison.new_only_block',
      newOnlyBlock,
      'Cannot inspect structured-gate bypass candidates before enabling the new guard',
    ],
    [
      'turn_custody.comparison.new_only_justified',
      newOnlyJustified,
      'Cannot count justified structured-gate blocks over the full authoritative denominator',
    ],
    [
      'turn_custody.comparison.new_only_unjustified',
      newOnlyUnjustified,
      'Cannot count unjustified structured-gate blocks over the full authoritative denominator',
    ],
    [
      'turn_custody.comparison.new_only_unexplained',
      newOnlyUnexplained,
      'Cannot count unexplained structured-gate blocks over the full authoritative denominator',
    ],
    ['turn_custody.shadow_old_block_total', oldBlock, 'Cannot establish the legacy guard block baseline'],
    ['turn_custody.shadow_new_block_total', newBlock, 'Cannot project the structured guard block total'],
    [
      'turn_custody.protocol_action_without_custody_total',
      protocolActionWithoutCustody,
      'Cannot prove structured protocol actions always acquire custody',
    ],
    [
      'turn_custody.user_nudge_required_total',
      userNudgeRequired,
      'Cannot detect turns that forced the operator to act as the wake router',
    ],
    [
      'turn_custody.legacy_guard_without_active_custody_total',
      legacyGuardWithoutActiveCustody,
      'Cannot retain raw behavior-delta visibility for the deleted legacy guard',
    ],
    [
      'turn_custody.same_subject_post_terminal_enqueue_total',
      sameSubjectPostTerminalEnqueue,
      'Cannot prove terminal subjects do not create courtesy successor work',
    ],
    [
      'turn_custody.lease_succeeded_subject_nonterminal_total',
      leaseSucceededSubjectNonterminal,
      'Cannot detect custody success that outruns independent subject truth',
    ],
  ];
  const telemetryGaps = required.filter(([, value]) => value == null).map(([metric, , impact]) => gap(metric, impact));
  if (newOnlyClassificationGap != null && newOnlyClassificationGap !== 0) {
    telemetryGaps.push({
      metric: 'turn_custody.new_only_classification',
      reason: 'denominator_mismatch',
      impact: `Authoritative new-only count (${newOnlyBlock}) does not equal classified rows (${newOnlyClassified})`,
    });
  }
  const coreShadowAvailable = [
    coveredActive,
    coveredEmpty,
    unknownLegacy,
    agreeAllow,
    agreeBlock,
    oldOnlyBlock,
    newOnlyBlock,
    oldBlock,
    newBlock,
  ].every((value) => value != null);
  const sampleExtraAttributes = [
    TURN_CUSTODY_PROJECTION_STATE_ATTR,
    TURN_CUSTODY_CLOSE_CHECKPOINT_ATTR,
    TURN_CUSTODY_WAKE_PROVENANCE_ATTR,
    TURN_CUSTODY_TRANSITION_OBSERVED_ATTR,
    TURN_CUSTODY_PROJECTION_REASON_ATTR,
    TURN_CUSTODY_SOURCE_CATEGORY_ATTR,
    TURN_CUSTODY_SOURCE_SEMANTIC_ATTR,
  ];
  const disagreementSamples = extractPerFireSamples(
    spans,
    TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME,
    { total: 20, perTrigger: 10 },
    sampleExtraAttributes,
  );
  const unknownAgreeBlockSamples = extractPerFireSamples(
    spans,
    TURN_CUSTODY_UNKNOWN_AGREE_BLOCK_EVENT_NAME,
    { total: 20, perTrigger: 20 },
    sampleExtraAttributes,
  );
  const samplesByMetric: Record<string, PerFireSample[]> = {};
  const oldOnlySamples = disagreementSamples.filter((sample) => sample.trigger === 'old_only_block');
  const newOnlySamples = disagreementSamples.filter((sample) => sample.trigger === 'new_only_block');
  if (oldOnlySamples.length > 0) samplesByMetric['turn_custody.old_only_block_total'] = oldOnlySamples;
  if (newOnlySamples.length > 0) samplesByMetric['turn_custody.new_only_block_total'] = newOnlySamples;
  if (unknownAgreeBlockSamples.length > 0) {
    samplesByMetric['turn_custody.unknown_legacy_total'] = unknownAgreeBlockSamples;
  }

  return {
    componentId: 'turn-custody-stop-gate',
    componentName: 'turn-scoped custody stop gate',
    activationCounts: {
      'turn_custody.projections_total': projections,
      'turn_custody.covered_active_total': coveredActive,
      'turn_custody.covered_empty_total': coveredEmpty,
      'turn_custody.unknown_legacy_total': unknownLegacy,
      'turn_custody.unknown_legacy_rate': ratio(unknownLegacy, projections),
      'turn_custody.agree_allow_total': agreeAllow,
      'turn_custody.agree_block_total': agreeBlock,
      'turn_custody.agreements_total': agreements,
      'turn_custody.disagreements_total': disagreements,
      'turn_custody.shadow_old_block_total': oldBlock,
      'turn_custody.shadow_new_block_total': newBlock,
      'turn_custody.old_only_block_total': oldOnlyBlock,
      'turn_custody.new_only_block_total': newOnlyBlock,
      'turn_custody.projected_block_increase_total': projectedBlockIncrease,
      'turn_custody.new_only_classified_total': newOnlyClassified,
      'turn_custody.new_only_justified_total': newOnlyJustified,
      'turn_custody.legacy_guard_without_active_custody_total': legacyGuardWithoutActiveCustody,
    },
    frictionCounts: {
      'turn_custody.new_only_unjustified_total': newOnlyUnjustified,
      'turn_custody.new_only_unexplained_total': newOnlyUnexplained,
      'turn_custody.new_only_classification_gap_total': newOnlyClassificationGap,
      'turn_custody.protocol_action_without_custody_total': protocolActionWithoutCustody,
      'turn_custody.user_nudge_required_total': userNudgeRequired,
      'turn_custody.same_subject_post_terminal_enqueue_total': sameSubjectPostTerminalEnqueue,
      'turn_custody.lease_succeeded_subject_nonterminal_total': leaseSucceededSubjectNonterminal,
    },
    frictionSamples: samplesByMetric,
    falsePositiveCandidates:
      oldOnlyBlock && oldOnlyBlock > 0 ? [`turn_custody.old_only_block_total=${oldOnlyBlock}`] : [],
    bypassCandidates: newOnlyBlock && newOnlyBlock > 0 ? [`turn_custody.new_only_block_total=${newOnlyBlock}`] : [],
    confidence: telemetryGaps.length === 0 ? 'medium' : coreShadowAvailable ? 'low' : 'no-data',
    telemetryGaps,
  };
}
