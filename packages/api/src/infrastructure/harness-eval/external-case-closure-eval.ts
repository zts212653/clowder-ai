import type { ComponentHealth } from './f167-eval.js';
import type { EvalTraceStoreStats } from './telemetry-adapter.js';

function metricName(raw: string): string {
  return raw.replace(/\{[^}]*\}/, '').replace(/_total$/, '');
}

function sumMetric(metrics: Record<string, number>, expected: string): number | null {
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (metricName(key) !== expected) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function histogramAverage(metrics: Record<string, number>, expected: string): number | null {
  const sum = sumMetric(metrics, `${expected}_sum`);
  const count = sumMetric(metrics, `${expected}_count`);
  if (sum == null || count == null || count === 0) return null;
  return sum / count;
}

/** F168 → F192 live adapter. Warm activation=0 remains no-data, never a false clean verdict. */
export function buildExternalCaseClosureHealth(metrics: Record<string, number>): ComponentHealth {
  const headObserved = sumMetric(metrics, 'cat_cafe_external_case_head_observed');
  const verdictRecorded = sumMetric(metrics, 'cat_cafe_external_case_verdict_recorded');
  const wakeDelivered = sumMetric(metrics, 'cat_cafe_external_case_reviewer_wake_delivered');
  const violationMetrics = {
    'external_case.verdict_ready_without_delivery_total': sumMetric(
      metrics,
      'cat_cafe_external_case_verdict_ready_without_delivery',
    ),
    'external_case.noisy_wake_during_cloud_review_total': sumMetric(
      metrics,
      'cat_cafe_external_case_noisy_wake_during_cloud_review',
    ),
    'external_case.duplicate_reviewer_wake_per_head_total': sumMetric(
      metrics,
      'cat_cafe_external_case_duplicate_reviewer_wake_per_head',
    ),
    'external_case.user_nudge_required_total': sumMetric(metrics, 'cat_cafe_external_case_user_nudge_required'),
  };
  const hasActivationTraffic = (headObserved ?? 0) + (verdictRecorded ?? 0) + (wakeDelivered ?? 0) > 0;
  const hasViolation = Object.values(violationMetrics).some((value) => (value ?? 0) > 0);
  const hasTraffic = hasActivationTraffic || hasViolation;
  const telemetryGaps = hasTraffic
    ? Object.entries(violationMetrics)
        .filter(([, value]) => value == null)
        .map(([metric]) => ({
          metric,
          reason: 'no_counter' as const,
          impact: `Cannot prove ${metric} stayed at zero for observed external-case traffic`,
        }))
    : [];
  return {
    componentId: 'external-case-closure',
    componentName: 'F168 external issue/PR closure',
    activationCounts: hasTraffic
      ? {
          'external_case.head_observed_total': headObserved ?? 0,
          'external_case.verdict_recorded_total': verdictRecorded ?? 0,
          'external_case.reviewer_wake_delivered_total': wakeDelivered ?? 0,
          'external_case.pending_delivery_age_seconds': histogramAverage(
            metrics,
            'cat_cafe_external_case_pending_delivery_age',
          ),
          'external_case.author_update_to_ready_wake_seconds': histogramAverage(
            metrics,
            'cat_cafe_external_case_author_update_to_ready_wake',
          ),
        }
      : {},
    frictionCounts: hasTraffic ? violationMetrics : {},
    frictionSamples: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: hasTraffic ? (telemetryGaps.length > 0 ? 'low' : 'medium') : 'no-data',
    telemetryGaps,
  };
}

export interface ExternalCaseClosureSnapshotInput {
  readonly metrics: Record<string, number>;
  readonly traceStats: EvalTraceStoreStats;
  readonly now?: number;
  readonly processStartMs?: number;
  readonly processUptimeSec?: number;
}

export interface ExternalCaseClosureSnapshot {
  readonly featureId: 'F168';
  readonly window: { startMs: number; endMs: number; durationHours: number };
  readonly counterWindow?: { startMs: number; endMs: number; durationHours: number };
  readonly dataSource: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly traceStoreStats: EvalTraceStoreStats;
  readonly components: readonly ComponentHealth[];
  readonly overallConfidence: ComponentHealth['confidence'];
  readonly summary: string;
}

/** F168 owns a separate eval snapshot; adding this component to F167 would corrupt both domains' confidence. */
export function generateExternalCaseClosureSnapshot(
  input: ExternalCaseClosureSnapshotInput,
): ExternalCaseClosureSnapshot {
  const now = input.now ?? Date.now();
  const processWindowStart =
    input.processUptimeSec != null ? now - Math.max(0, input.processUptimeSec) * 1000 : input.processStartMs;
  const windowStart = processWindowStart ?? input.traceStats.oldestStoredAt ?? now;
  const windowEnd = now;
  const durationHours = Math.max(0, windowEnd - windowStart) / 3_600_000;
  const component = buildExternalCaseClosureHealth(input.metrics);
  const gapCount = component.telemetryGaps.length;

  return {
    featureId: 'F168',
    window: { startMs: windowStart, endMs: windowEnd, durationHours },
    ...(processWindowStart == null
      ? {}
      : {
          counterWindow: {
            startMs: processWindowStart,
            endMs: windowEnd,
            durationHours,
          },
        }),
    dataSource: 'F153 /api/telemetry/metrics',
    generatedAt: new Date(now).toISOString(),
    generatedBy: 'F168 external-case eval',
    traceStoreStats: input.traceStats,
    components: [component],
    overallConfidence: component.confidence,
    summary:
      `F168 external-case closure eval: ${component.confidence === 'no-data' ? 'no observed traffic' : 'traffic observed'}. ` +
      `${gapCount} telemetry gaps identified. Overall confidence: ${component.confidence}.`,
  };
}

interface ReplayEvent {
  readonly kind: string;
  readonly at: number;
  readonly payload: Record<string, unknown>;
}

export interface ExternalCaseReplayScenario {
  readonly id: string;
  readonly events: readonly ReplayEvent[];
  readonly diagnostics?: {
    readonly identitySplitAttempts?: number;
    readonly issueClaimsWithoutEvidence?: number;
    readonly userNudges?: number;
  };
}

export interface ExternalCaseReplayResult {
  readonly verdict: 'pass' | 'fix' | 'keep_observe' | 'no-data';
  readonly metrics: {
    readonly verdictReadyWithoutDelivery: number;
    readonly noisyWakeDuringCloudReview: number;
    readonly duplicateReviewerWakePerHead: number;
    readonly userNudgeRequired: number;
    readonly staleHeadFacts: number;
    readonly identitySplitAttempts: number;
    readonly issueClaimsWithoutEvidence: number;
    readonly pendingDeliveryAgeSeconds: number | null;
    readonly authorUpdateToReadyWakeSeconds: readonly number[];
  };
}

function readHead(payload: Record<string, unknown>): string | null {
  return typeof payload.headSha === 'string' && payload.headSha.length > 0 ? payload.headSha : null;
}

interface ReplayAccumulator {
  currentHead: string | null;
  verdictReadyWithoutDelivery: number;
  noisyWakeDuringCloudReview: number;
  staleHeadFacts: number;
  pendingDeliveryCreatedAt: number | null;
  readonly cloudByHead: Map<string, string>;
  readonly headObservedAt: Map<string, number>;
  readonly wakeCountByHead: Map<string, number>;
  readonly wakeLatencies: number[];
}

function createReplayAccumulator(): ReplayAccumulator {
  return {
    currentHead: null,
    verdictReadyWithoutDelivery: 0,
    noisyWakeDuringCloudReview: 0,
    staleHeadFacts: 0,
    pendingDeliveryCreatedAt: null,
    cloudByHead: new Map(),
    headObservedAt: new Map(),
    wakeCountByHead: new Map(),
    wakeLatencies: [],
  };
}

function isStaleFact(state: ReplayAccumulator, headSha: string | null): boolean {
  if (headSha === state.currentHead) return false;
  state.staleHeadFacts++;
  return true;
}

function applyWakeEvent(state: ReplayAccumulator, event: ReplayEvent, headSha: string | null): void {
  if (!headSha) return;
  const cloud = state.cloudByHead.get(headSha);
  if (cloud === 'running' || cloud === 'blocking' || cloud === 'failed_or_timeout') {
    state.noisyWakeDuringCloudReview++;
  }
  state.wakeCountByHead.set(headSha, (state.wakeCountByHead.get(headSha) ?? 0) + 1);
  const observedAt = state.headObservedAt.get(headSha);
  if (observedAt != null) state.wakeLatencies.push(Math.max(0, event.at - observedAt) / 1000);
}

function applyVerdictEvent(state: ReplayAccumulator, event: ReplayEvent): void {
  const delivery = event.payload.delivery;
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    state.verdictReadyWithoutDelivery++;
    return;
  }
  const record = delivery as Record<string, unknown>;
  if (record.kind === 'pending_delivery' && typeof record.createdAt === 'number') {
    state.pendingDeliveryCreatedAt = record.createdAt;
    return;
  }
  if (record.kind === 'delivered') {
    state.pendingDeliveryCreatedAt = null;
    return;
  }
  state.verdictReadyWithoutDelivery++;
}

function applyReplayEvent(state: ReplayAccumulator, event: ReplayEvent): void {
  const headSha = readHead(event.payload);
  switch (event.kind) {
    case 'case.head_observed':
      if (!headSha) return;
      state.currentHead = headSha;
      state.headObservedAt.set(headSha, event.at);
      return;
    case 'case.ci_observed':
      isStaleFact(state, headSha);
      return;
    case 'case.cloud_review_observed':
      if (isStaleFact(state, headSha) || !headSha || typeof event.payload.status !== 'string') return;
      state.cloudByHead.set(headSha, event.payload.status);
      return;
    case 'case.reviewer_wake_delivered':
      applyWakeEvent(state, event, headSha);
      return;
    case 'case.review_verdict_recorded':
      applyVerdictEvent(state, event);
      return;
    default:
      return;
  }
}

function replayVerdict(hasEvidence: boolean, violations: number, pending: boolean, hasVerdict: boolean) {
  if (!hasEvidence) return 'no-data' as const;
  if (violations > 0) return 'fix' as const;
  if (pending || !hasVerdict) return 'keep_observe' as const;
  return 'pass' as const;
}

export function evaluateExternalCaseReplay(
  scenario: ExternalCaseReplayScenario,
  now: number,
): ExternalCaseReplayResult {
  const state = createReplayAccumulator();
  for (const event of scenario.events) applyReplayEvent(state, event);

  const duplicateReviewerWakePerHead = [...state.wakeCountByHead.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const identitySplitAttempts = scenario.diagnostics?.identitySplitAttempts ?? 0;
  const issueClaimsWithoutEvidence = scenario.diagnostics?.issueClaimsWithoutEvidence ?? 0;
  const userNudgeRequired = scenario.diagnostics?.userNudges ?? 0;
  const pendingDeliveryAgeSeconds =
    state.pendingDeliveryCreatedAt == null ? null : Math.max(0, now - state.pendingDeliveryCreatedAt) / 1000;
  const violations =
    state.verdictReadyWithoutDelivery +
    state.noisyWakeDuringCloudReview +
    duplicateReviewerWakePerHead +
    userNudgeRequired +
    identitySplitAttempts +
    issueClaimsWithoutEvidence;
  const hasEvidence = scenario.events.length > 0 || violations > 0;
  const hasVerdict = scenario.events.some((event) => event.kind === 'case.review_verdict_recorded');
  const verdict = replayVerdict(hasEvidence, violations, pendingDeliveryAgeSeconds != null, hasVerdict);

  return {
    verdict,
    metrics: {
      verdictReadyWithoutDelivery: state.verdictReadyWithoutDelivery,
      noisyWakeDuringCloudReview: state.noisyWakeDuringCloudReview,
      duplicateReviewerWakePerHead,
      userNudgeRequired,
      staleHeadFacts: state.staleHeadFacts,
      identitySplitAttempts,
      issueClaimsWithoutEvidence,
      pendingDeliveryAgeSeconds,
      authorUpdateToReadyWakeSeconds: state.wakeLatencies,
    },
  };
}
