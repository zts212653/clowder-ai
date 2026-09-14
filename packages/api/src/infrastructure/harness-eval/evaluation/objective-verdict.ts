import type {
  EvaluationSnapshot,
  MetricDefinition,
  MetricResult,
  MetricResultValue,
  MetricVerdictDecision,
  MetricVerdictRule,
  ObjectiveVerdictDecision,
  SegmentVerdict,
} from '@cat-cafe/shared';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const METRIC_DECISION_STATUSES = new Set<MetricVerdictDecision['status']>([
  'breach',
  'clean',
  'inconclusive',
  'insufficient_evidence',
  'unavailable',
]);

/**
 * Evaluate one metric against its EXPLICIT verdict rule. Trigger thresholds are
 * deliberately absent from this function: they decide readiness, never truth.
 */
function decideMetric(
  metric: MetricDefinition,
  result: MetricResult | undefined,
  outcome: { status: 'evaluated' | 'insufficient_evidence' | 'unavailable'; reason?: string },
  attributedSegmentIds: string[],
): MetricVerdictDecision {
  const rule: MetricVerdictRule = metric.verdictRule ?? { kind: 'evidence-only' };
  if (outcome.status !== 'evaluated') {
    return {
      metricId: metric.id,
      rule,
      status: outcome.status,
      reason: outcome.reason ?? outcome.status,
      measurement: null,
      attributedSegmentIds,
    };
  }
  if (!result) {
    return {
      metricId: metric.id,
      rule,
      status: 'inconclusive',
      reason: 'evaluated_without_result',
      measurement: null,
      attributedSegmentIds,
    };
  }

  return { ...decideMeasuredMetric(metric.id, rule, result.value), attributedSegmentIds };
}

type MetricDecisionCore = Omit<MetricVerdictDecision, 'attributedSegmentIds'>;

function decideMeasuredMetric(metricId: string, rule: MetricVerdictRule, value: MetricResultValue): MetricDecisionCore {
  switch (rule.kind) {
    case 'counter-zero':
      return decideCounter(metricId, rule, value);
    case 'rate-maximum':
    case 'rate-minimum':
      return value.kind === 'rate' ? decideRate(metricId, rule, value) : kindMismatch(metricId, rule);
    case 'semantic-label-maximum':
      return decideSemantic(metricId, rule, value);
    case 'replay-zero-failure':
      return decideReplay(metricId, rule, value);
    case 'evidence-only':
      return { metricId, rule, status: 'inconclusive', reason: 'metric_is_evidence_only', measurement: null };
  }
}

function decideCounter(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'counter-zero' }>,
  value: MetricResultValue,
): MetricDecisionCore {
  if (value.kind !== 'counter') return kindMismatch(metricId, rule);
  return {
    metricId,
    rule,
    status: value.count > 0 ? 'breach' : 'clean',
    reason: `counter=${value.count}; zero required`,
    measurement: {
      kind: 'count',
      value: value.count,
      howCounted: `${metricId}:distinct-counterexamples(${value.count})`,
    },
  };
}

function decideRate(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'rate-maximum' | 'rate-minimum' }>,
  value: Extract<MetricResultValue, { kind: 'rate' }>,
): MetricDecisionCore {
  const maximum = rule.kind === 'rate-maximum';
  const breach = maximum ? value.rate > rule.maximum : value.rate < rule.minimum;
  return {
    metricId,
    rule,
    status: breach ? 'breach' : 'clean',
    reason: maximum ? `rate=${value.rate}; maximum=${rule.maximum}` : `rate=${value.rate}; minimum=${rule.minimum}`,
    measurement: {
      kind: 'rate-badness',
      value: maximum ? value.rate : 1 - value.rate,
      howCounted: maximum
        ? `${metricId}:${value.numerator}/${value.denominator}`
        : `${metricId}:1-(${value.numerator}/${value.denominator})`,
    },
  };
}

function decideSemantic(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'semantic-label-maximum' }>,
  value: MetricResultValue,
): MetricDecisionCore {
  if (value.kind !== 'semantic') return kindMismatch(metricId, rule);
  const count = value.labels[rule.label] ?? 0;
  return {
    metricId,
    rule,
    status: count > rule.maximum ? 'breach' : 'clean',
    reason: `label(${rule.label})=${count}; maximum=${rule.maximum}`,
    measurement: {
      kind: 'count',
      value: count,
      howCounted: `${metricId}:label(${rule.label})=${count}`,
    },
  };
}

function decideReplay(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'replay-zero-failure' }>,
  value: MetricResultValue,
): MetricDecisionCore {
  if (value.kind !== 'replay') return kindMismatch(metricId, rule);
  return {
    metricId,
    rule,
    status: value.failed > 0 ? 'breach' : 'clean',
    reason: `failed=${value.failed}; zero required`,
    measurement: {
      kind: 'count',
      value: value.failed,
      howCounted: `${metricId}:failed=${value.failed}; replayed=${value.passed + value.failed}`,
    },
  };
}

function kindMismatch(metricId: string, rule: MetricVerdictRule): MetricDecisionCore {
  return { metricId, rule, status: 'inconclusive', reason: 'result_rule_kind_mismatch', measurement: null };
}

export function produceObjectiveVerdictDecision(
  snapshot: Pick<EvaluationSnapshot, 'evaluationModelVersion' | 'metricDefinitions' | 'samples'>,
  results: MetricResult[],
  metricOutcomes: Array<{
    metricId: string;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }>,
): { verdict: SegmentVerdict; decision: ObjectiveVerdictDecision } {
  const resultByMetric = new Map(results.map((result) => [result.metricId, result]));
  const outcomeByMetric = new Map(metricOutcomes.map((outcome) => [outcome.metricId, outcome]));
  const attributedSegmentsByMetric = collectMetricSegmentAttribution(snapshot.samples);
  const metricDecisions = snapshot.metricDefinitions.map((metric) =>
    decideMetric(
      metric,
      resultByMetric.get(metric.id),
      outcomeByMetric.get(metric.id) ?? { status: 'unavailable', reason: 'metric_outcome_missing' },
      attributedSegmentsByMetric.get(metric.id) ?? [],
    ),
  );
  const decisiveMeasurements = metricDecisions.filter(
    (metric): metric is MetricVerdictDecision & { measurement: NonNullable<MetricVerdictDecision['measurement']> } =>
      metric.measurement !== null,
  );
  const breachedMeasurements = decisiveMeasurements.filter((metric) => metric.status === 'breach');
  const attributedBreaches = breachedMeasurements.filter((metric) => metric.attributedSegmentIds.length > 0);
  // Measurements from different metrics can use different scales. Never rank a
  // count against a rate. Prefer an evidence-attributed breach, then choose one
  // deterministic metric and surface it to the governance decision drafter.
  const primaryPool =
    attributedBreaches.length > 0
      ? attributedBreaches
      : breachedMeasurements.length > 0
        ? breachedMeasurements
        : decisiveMeasurements;
  const primary = [...primaryPool].sort((a, b) => a.metricId.localeCompare(b.metricId))[0];
  const verdict = verdictForMetricDecisions(metricDecisions);

  return {
    verdict,
    decision: {
      schemaVersion: 2,
      evaluationModelVersion: snapshot.evaluationModelVersion,
      metricDecisions,
      primaryMetricId: primary?.metricId ?? null,
      measurement: primary?.measurement ?? null,
      targetSegmentIds: primary?.attributedSegmentIds ?? [],
    },
  };
}

export function verdictForMetricDecisions(metricDecisions: MetricVerdictDecision[]): SegmentVerdict {
  if (metricDecisions.some((metric) => metric.status === 'breach')) return 'retire-candidate';
  if (metricDecisions.some((metric) => metric.status === 'unavailable')) return 'observability-debt';
  if (metricDecisions.some((metric) => metric.status === 'insufficient_evidence')) return 'needs-denominator';
  if (metricDecisions.length > 0 && metricDecisions.every((metric) => metric.status === 'clean')) return 'alive';
  return 'unmeasurable';
}

export function isCurrentVerdictDecision(value: unknown): value is ObjectiveVerdictDecision {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.evaluationModelVersion !== 'string' ||
    value.evaluationModelVersion.length === 0 ||
    !Array.isArray(value.metricDecisions) ||
    !value.metricDecisions.every(isMetricVerdictDecision) ||
    (typeof value.primaryMetricId !== 'string' && value.primaryMetricId !== null) ||
    !isMeasurementOrNull(value.measurement) ||
    !isStringArray(value.targetSegmentIds)
  ) {
    return false;
  }
  if (value.primaryMetricId === null) {
    return value.measurement === null && value.targetSegmentIds.length === 0;
  }
  const primary = value.metricDecisions.find((decision) => decision.metricId === value.primaryMetricId);
  return (
    primary !== undefined &&
    JSON.stringify(primary.measurement) === JSON.stringify(value.measurement) &&
    JSON.stringify(primary.attributedSegmentIds) === JSON.stringify(value.targetSegmentIds)
  );
}

function isMetricVerdictDecision(value: unknown): value is MetricVerdictDecision {
  return (
    isRecord(value) &&
    typeof value.metricId === 'string' &&
    value.metricId.length > 0 &&
    isMetricVerdictRule(value.rule) &&
    typeof value.status === 'string' &&
    METRIC_DECISION_STATUSES.has(value.status as MetricVerdictDecision['status']) &&
    typeof value.reason === 'string' &&
    isMeasurementOrNull(value.measurement) &&
    isStringArray(value.attributedSegmentIds)
  );
}

function isMetricVerdictRule(value: unknown): value is MetricVerdictRule {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'counter-zero' || value.kind === 'replay-zero-failure' || value.kind === 'evidence-only') {
    return Object.keys(value).length === 1;
  }
  if (value.kind === 'rate-maximum') return validUnitInterval(value.maximum);
  if (value.kind === 'rate-minimum') return validUnitInterval(value.minimum);
  return (
    value.kind === 'semantic-label-maximum' &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    typeof value.maximum === 'number' &&
    Number.isSafeInteger(value.maximum) &&
    value.maximum >= 0
  );
}

function isMeasurementOrNull(value: unknown): value is MetricVerdictDecision['measurement'] {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'count' || value.kind === 'rate-badness') &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    (value.kind !== 'rate-badness' || value.value <= 1) &&
    typeof value.howCounted === 'string' &&
    value.howCounted.length > 0
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function validUnitInterval(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function collectMetricSegmentAttribution(samples: EvaluationSnapshot['samples']): Map<string, string[]> {
  const collected = new Map<string, Set<string>>();
  for (const sample of samples) {
    if (sample.polarity !== 'counterexample') continue;
    const segmentIds = sample.unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId);
    if (segmentIds.length === 0) continue;
    const current = collected.get(sample.metricId) ?? new Set<string>();
    for (const segmentId of segmentIds) current.add(segmentId);
    collected.set(sample.metricId, current);
  }
  return new Map([...collected].map(([metricId, segmentIds]) => [metricId, [...segmentIds].sort()]));
}
