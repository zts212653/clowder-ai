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

function detectFrictionFromCounts(component: AttributionInput['snapshot']['components'][0]): AttributionRecord[] {
  const findings: AttributionRecord[] = [];
  const { frictionCounts, activationCounts, componentId } = component;

  for (const [metric, value] of Object.entries(frictionCounts)) {
    if (value == null || value === 0) continue;

    const baseMetric = metric.replace(/\.(shadow_miss|failed|skip)$/, '');
    const baseKey = `${baseMetric.split('.')[0]}.checked`;
    const baseline = (activationCounts[baseKey] as number | null | undefined) ?? 0;
    const ratio = baseline > 0 ? (value as number) / baseline : 1;

    if (ratio <= 0.05 || (value as number) < 3) continue;

    const severity: AttributionRecord['frictionSignal']['severity'] =
      ratio > 0.3 ? 'high' : ratio > 0.1 ? 'medium' : 'low';

    const isFailure = metric.includes('failed');
    const primaryLayer: AttributionClass = isFailure ? 'execution_gap' : 'harness_misfit';

    findings.push({
      id: nextFindingId(),
      relatedFeature: 'F167',
      frictionSignal: {
        type: metric,
        severity,
        confidence: baseline > 0 ? 0.7 : 0.4,
        detectedAt: new Date().toISOString(),
      },
      attribution: {
        primaryLayer,
        pipelineOrHuman: severity === 'high' ? 'human-required' : 'pipeline',
        evidence: [
          {
            type: 'counter',
            anchor: `${componentId}/${metric}`,
            excerpt: `${metric}=${value} (baseline ${baseKey}=${baseline}, ratio=${(ratio * 100).toFixed(1)}%)`,
          },
        ],
      },
      proposedAction: [
        {
          action: isFailure ? 'tool-fix' : 'harness-tune',
          target: `${componentId}/${metric}`,
          rationale: `${metric} ratio ${(ratio * 100).toFixed(1)}% exceeds threshold`,
        },
      ],
      status: 'open',
    });
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
