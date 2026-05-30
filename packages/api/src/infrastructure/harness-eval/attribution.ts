import type { ComponentHealth, TelemetryGap } from './f167-eval.js';

export type AttributionClass =
  | 'vision_gap'
  | 'translation_gap'
  | 'harness_misfit'
  | 'tool_gap'
  | 'execution_gap'
  | 'environment_drift'
  | 'taste_gap';

export interface AttributionRecord {
  id: string;
  relatedFeature: string;
  frictionSignal: {
    type: string;
    severity: 'low' | 'medium' | 'high';
    confidence: number;
    detectedAt: string;
  };
  attribution: {
    primaryLayer: AttributionClass;
    pipelineOrHuman: 'pipeline' | 'human-required';
    evidence: Array<{ type: string; anchor: string; excerpt: string }>;
  };
  proposedAction: Array<{
    action: string;
    target: string;
    rationale: string;
  }>;
  status: 'open';
}

export interface ActionRate {
  total: number;
  actedOn: number;
  rate: number;
  sunsetCandidate: boolean;
}

export interface AttributionReport {
  featureId: string;
  evalSnapshotId: string;
  generatedAt: string;
  findings: AttributionRecord[];
  noFindingRecord?: {
    reason: string;
    evidence: string;
  };
  actionRate?: ActionRate;
}

interface AttributionInput {
  featureId: string;
  snapshot: {
    components: Array<
      Pick<
        ComponentHealth,
        | 'componentId'
        | 'activationCounts'
        | 'frictionCounts'
        | 'telemetryGaps'
        | 'confidence'
        | 'falsePositiveCandidates'
        | 'bypassCandidates'
      >
    >;
  };
}

let findingCounter = 0;

function nextFindingId(): string {
  findingCounter++;
  const date = new Date().toISOString().slice(0, 10);
  return `AR-${date}-${String(findingCounter).padStart(3, '0')}`;
}

// Friction → finding gate (F192 Phase D + 2026-05-29 denominator-robustness fix).
const MIN_COUNT = 3;
const RATIO_FLOOR = 0.05;

// Per-friction-metric activation denominators (most specific tier). C2 runs TWO
// independent guards with separate counts — verdict-without-pass vs void-hold — so they
// must NOT share one prefix-level denominator: grading void_hold against the verdict
// count (c2.checked) divides by the wrong base and suppresses real void-hold signals
// (cloud review PR #1941 P2). Each maps to its own `*_checked` denominator.
const FRICTION_DENOMINATOR_BY_METRIC: Record<string, string> = {
  'c2.verdict_without_pass_count': 'c2.checked',
  'c2.void_hold_hint_emitted': 'c2.void_hold_checked',
};

// Prefix-level fallback for components whose friction counters all share one denominator.
// C1's real denominator is `hold_ball_calls` (buildC1), not `c1.checked` (砚砚 review P2).
// Unknown prefixes fall back to the `<prefix>.checked` convention, which still yields the
// safe denominator-missing path when absent.
const FRICTION_DENOMINATOR_BY_PREFIX: Record<string, string> = {
  c1: 'hold_ball_calls',
  inline_action: 'inline_action.checked',
};

interface FrictionGrade {
  severity: AttributionRecord['frictionSignal']['severity'];
  confidence: number;
  hasBaseline: boolean;
  baseKey: string;
  baseline: number;
  ratioText: string;
}

/**
 * Grade a single friction counter against its activation denominator `<prefix>.checked`,
 * or return null to suppress it (sub-threshold noise).
 *
 * When the denominator is MISSING we must NOT fabricate a 100% ratio: the pre-fix
 * `ratio = baseline > 0 ? v/baseline : 1` did exactly that, auto-escalating every
 * denominator-less counter to high-severity / human-required — it is what made the
 * F167 eval:a2a 2026-05-29 C2 `verdict_without_pass_count=9` land on the owner as
 * "human-required" despite there being no way to tell signal from activation. New
 * contract: still SURFACE the friction (Day-9 invariant #1816 — C2 friction must not
 * be silently dropped) but, absent a denominator, cap severity at low and propose
 * adding the denominator, because severity is genuinely uncomputable.
 */
function gradeFriction(
  metric: string,
  value: number,
  activationCounts: Record<string, number | null>,
): FrictionGrade | null {
  if (value < MIN_COUNT) return null;

  const baseMetric = metric.replace(/\.(shadow_miss|failed|skip)$/, '');
  const prefix = baseMetric.split('.')[0];
  const baseKey =
    FRICTION_DENOMINATOR_BY_METRIC[metric] ?? FRICTION_DENOMINATOR_BY_PREFIX[prefix] ?? `${prefix}.checked`;
  const rawBaseline = activationCounts[baseKey] as number | null | undefined;
  const hasBaseline = typeof rawBaseline === 'number' && rawBaseline > 0;
  const baseline = hasBaseline ? rawBaseline : 0;
  const ratio = hasBaseline ? value / baseline : null;

  // Ratio-based noise suppression only applies when a real denominator exists.
  if (ratio != null && ratio <= RATIO_FLOOR) return null;

  // Denominator missing → cannot grade → surface low, never escalate.
  const severity: FrictionGrade['severity'] =
    ratio == null ? 'low' : ratio > 0.3 ? 'high' : ratio > 0.1 ? 'medium' : 'low';

  return {
    severity,
    confidence: hasBaseline ? 0.7 : 0.4,
    hasBaseline,
    baseKey,
    baseline,
    ratioText: hasBaseline ? `${((ratio as number) * 100).toFixed(1)}%` : 'n/a',
  };
}

function buildFrictionFinding(
  componentId: string,
  metric: string,
  value: number,
  grade: FrictionGrade,
): AttributionRecord {
  const isFailure = metric.includes('failed');
  const measureNote = grade.hasBaseline
    ? `baseline ${grade.baseKey}=${grade.baseline}, ratio=${grade.ratioText}`
    : `denominator ${grade.baseKey} missing — ratio not computable; surfaced low-severity for visibility`;
  const action = isFailure ? 'tool-fix' : grade.hasBaseline ? 'harness-tune' : 'add-counter';
  const target = grade.hasBaseline ? `${componentId}/${metric}` : `${componentId}/${grade.baseKey}`;
  const rationale = grade.hasBaseline
    ? `${metric} ratio ${grade.ratioText} exceeds threshold`
    : `${metric}=${value} but denominator ${grade.baseKey} missing — add activation counter to compute a real friction ratio`;

  return {
    id: nextFindingId(),
    relatedFeature: 'F167',
    frictionSignal: {
      type: metric,
      severity: grade.severity,
      confidence: grade.confidence,
      detectedAt: new Date().toISOString(),
    },
    attribution: {
      primaryLayer: isFailure ? 'execution_gap' : 'harness_misfit',
      pipelineOrHuman: grade.severity === 'high' ? 'human-required' : 'pipeline',
      evidence: [
        {
          type: 'counter',
          anchor: `${componentId}/${metric}`,
          excerpt: `${metric}=${value} (${measureNote})`,
        },
      ],
    },
    proposedAction: [{ action, target, rationale }],
    status: 'open',
  };
}

function detectFrictionFromCounts(component: AttributionInput['snapshot']['components'][0]): AttributionRecord[] {
  const findings: AttributionRecord[] = [];
  const { frictionCounts, activationCounts, componentId } = component;

  for (const [metric, value] of Object.entries(frictionCounts)) {
    if (value == null || value === 0) continue;
    const grade = gradeFriction(metric, value, activationCounts);
    if (!grade) continue;
    findings.push(buildFrictionFinding(componentId, metric, value, grade));
  }
  return findings;
}

function detectObservabilityGaps(component: AttributionInput['snapshot']['components'][0]): AttributionRecord[] {
  if (component.telemetryGaps.length === 0) return [];

  return component.telemetryGaps.map((gap: TelemetryGap) => ({
    id: nextFindingId(),
    relatedFeature: 'F167',
    frictionSignal: {
      type: 'observability-gap',
      severity: 'medium' as const,
      confidence: 0.9,
      detectedAt: new Date().toISOString(),
    },
    attribution: {
      primaryLayer: 'tool_gap' as AttributionClass,
      pipelineOrHuman: 'pipeline' as const,
      evidence: [
        {
          type: 'telemetry-gap',
          anchor: `${component.componentId}/${gap.metric}`,
          excerpt: `${gap.metric}: ${gap.reason} — ${gap.impact}`,
        },
      ],
    },
    proposedAction: [
      {
        action: 'add-counter',
        target: `${component.componentId}/${gap.metric}`,
        rationale: gap.impact,
      },
    ],
    status: 'open' as const,
  }));
}

export function computeActionRate(
  currentFindings: Array<{ fingerprint: string }>,
  priorFindings: Array<{ status: string; fingerprint: string }>,
): ActionRate {
  const total = priorFindings.length;
  if (total === 0) return { total: 0, actedOn: 0, rate: 0, sunsetCandidate: false };

  const currentKeys = new Set(currentFindings.map((f) => f.fingerprint));

  let actedOn = 0;
  for (const prior of priorFindings) {
    const resolved = prior.status === 'resolved';
    const gone = !currentKeys.has(prior.fingerprint);
    if (resolved || gone) actedOn++;
  }

  const rate = actedOn / total;
  return { total, actedOn, rate, sunsetCandidate: rate < 0.5 };
}

export function findingFingerprint(f: {
  frictionSignal: { type: string };
  attribution?: { evidence?: Array<{ anchor: string }> };
}): string {
  const anchor = f.attribution?.evidence?.[0]?.anchor;
  return anchor ? `${f.frictionSignal.type}::${anchor}` : f.frictionSignal.type;
}

export function generateAttributionReport(input: AttributionInput): AttributionReport {
  findingCounter = 0;
  const findings: AttributionRecord[] = [];

  for (const component of input.snapshot.components) {
    findings.push(...detectFrictionFromCounts(component));
    findings.push(...detectObservabilityGaps(component));
  }

  const report: AttributionReport = {
    featureId: input.featureId,
    evalSnapshotId: `eval-${input.featureId}-${new Date().toISOString().slice(0, 10)}`,
    generatedAt: new Date().toISOString(),
    findings,
  };

  if (findings.length === 0) {
    const checkedMetrics = input.snapshot.components.flatMap((c) => Object.keys(c.frictionCounts));
    const componentIds = input.snapshot.components.map((c) => c.componentId);
    report.noFindingRecord = {
      reason: `No friction signals detected across ${componentIds.length} components`,
      evidence:
        `Checked components: ${componentIds.join(', ')}. ` +
        `Friction metrics examined: ${checkedMetrics.length > 0 ? checkedMetrics.join(', ') : 'none (no friction counters available)'}. ` +
        `All values within threshold.`,
    };
  }

  return report;
}
