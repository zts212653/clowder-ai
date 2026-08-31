import { createHash } from 'node:crypto';
import type {
  EvaluationSnapshot,
  EvaluationUnitRef,
  MetricDefinition,
  MetricResult,
  TraceAnnotation,
  TraceEpisode,
} from '@cat-cafe/shared';
import { EVALUATION_READINESS_WINDOW_MS, EVALUATION_TRACE_VOLUME_THRESHOLD } from '@cat-cafe/shared';
import { type TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import type { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type CadenceMetricDefinition = MetricDefinition & {
  trigger: { kind: 'cadence'; cadence: 'daily' | 'weekly' | `every-${number}d` };
};

export interface EvaluationModelInput {
  id: string;
  label: string;
  ruleVersion: string;
  metrics: MetricDefinition[];
}

export type EvaluationScheduleResult =
  | { status: 'not-ready'; observed: number; required: number }
  | { status: 'not-due'; nextDueAt: number }
  | { status: 'queued'; snapshot: EvaluationSnapshot };

export interface UnitTraceCorpusReader {
  queryUnitWindow(
    ownerUserId: string,
    unitRefs: EvaluationUnitRef[],
    startMs: number,
    endMs: number,
  ): Promise<TraceEpisode[]>;
  /** Count owner episodes that observed a specific segment in the window. */
  countSegmentWindow(ownerUserId: string, segmentId: string, startMs: number, endMs: number): Promise<number>;
  /** Count owner episodes not yet classified by semantic sweep in the window. */
  countUnclassified(ownerUserId: string, startMs?: number, endMs?: number): Promise<number>;
}

export class EvaluationScheduler {
  constructor(
    private readonly deps: {
      annotations: TraceAnnotationStore;
      snapshots: EvaluationSnapshotStore;
      traces: UnitTraceCorpusReader;
    },
  ) {}

  async schedule(input: {
    ownerUserId: string;
    objectiveId: string;
    evaluationModel: EvaluationModelInput;
    unitRefs: EvaluationUnitRef[];
    now: number;
    /**
     * When true, the scheduler will evaluate a Unit even if its event-driven
     * metrics have not reached their sample threshold, emitting
     * `insufficient_evidence` outcomes instead of returning `not-ready`.
     * Used by the periodic `runCadenceMetrics` sweep.
     */
    force?: boolean;
  }): Promise<EvaluationScheduleResult> {
    const { metrics } = input.evaluationModel;
    const { cadenceMetrics, eventDrivenMetrics } = classifyMetrics(metrics);

    // F257 R11: the semantic Unit window starts at the last completed run's
    // exclusive upper bound. The ingestion cursor (max consumed createdAt) is
    // kept for audit/dedup and for the pending-run claim, but it no longer
    // defines the semantic window start.
    const ingestionCursor = await this.deps.snapshots.ingestionCursor(input.ownerUserId, input.objectiveId);
    const completedWindowEnd = await this.deps.snapshots.completedWindowEnd(input.ownerUserId, input.objectiveId);
    const cadenceWatermark = await this.deps.snapshots.cadenceWatermark(input.ownerUserId, input.objectiveId);

    // F257 P1-2: if a previous attempt left a pending UnitRun for the current
    // ingestion cursor, resume the same immutable snapshot instead of building a
    // new one with a different snapshotId that the claim Lua would reject.
    const pending = await this.deps.snapshots.getPendingUnitRun(input.ownerUserId, input.objectiveId);
    if (pending) {
      if (pending.expectedWatermark === ingestionCursor) {
        return { status: 'queued', snapshot: pending.snapshot };
      }
      await this.deps.snapshots.clearPending(input.ownerUserId, input.objectiveId, pending);
    }

    const nowInteger = input.now;
    const endScore = nowInteger;
    const windowStartMs =
      completedWindowEnd > 0 ? completedWindowEnd : Math.max(0, nowInteger - EVALUATION_READINESS_WINDOW_MS);
    // Segment-filtered corpus: queryUnitWindow returns episodes whose
    // summary.segments have at least one unitRef with status=observed.
    const traceCorpus = this.deps.traces
      ? await this.deps.traces.queryUnitWindow(input.ownerUserId, input.unitRefs, windowStartMs, endScore)
      : [];

    // Per-segment readiness: compute the minimum observed count across all
    // segments in this Unit. An L2-only episode does not inflate D20's count
    // because each segment is counted independently. This prevents shared-
    // Objective inflation where one segment's activity advances another's
    // readiness threshold.
    const unitSegmentIds = new Set(input.unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId));
    const perSegmentCount = new Map<string, number>();
    for (const segmentId of unitSegmentIds) perSegmentCount.set(segmentId, 0);
    for (const episode of traceCorpus) {
      for (const seg of episode.summary.segments) {
        if (seg.status === 'observed' && unitSegmentIds.has(seg.segmentId)) {
          perSegmentCount.set(seg.segmentId, (perSegmentCount.get(seg.segmentId) ?? 0) + 1);
        }
      }
    }
    // MAX: if ANY segment reaches the volume threshold, the Unit has enough
    // data to evaluate. Segments with fewer episodes provide negative evidence
    // rather than blocking the entire Unit.
    const maxSegmentTraceCount = unitSegmentIds.size > 0 ? Math.max(...perSegmentCount.values()) : traceCorpus.length;

    // Cadence watermark is checked at the Unit level using the last completed Unit
    // run's evaluatedAt timestamp. A pure cadence Unit is not due again until the
    // previous completed Unit run's cadence has elapsed. A mixed Unit also honors
    // the cadence watermark, but an event-driven metric can force an early run
    // (Unit-level anyOf).
    const firstEligibleTraceAt = await this.deps.snapshots.firstEligibleTraceAt(
      input.ownerUserId,
      input.objectiveId,
      traceCorpus[0]?.terminal.terminalAt ?? 0,
    );
    const cadenceDue = isCadenceDue(cadenceMetrics, cadenceWatermark, nowInteger, firstEligibleTraceAt);

    const consumed = await this.deps.snapshots.consumedAnnotationIds(input.ownerUserId, input.objectiveId);
    const candidates = await this.collectCandidates(input, metrics, windowStartMs, endScore, consumed);
    // Volume threshold uses per-segment MAX: if ANY segment reaches 200
    // observed episodes, the Unit is ready to evaluate. Cadence triggers use
    // total corpus size (any data at all). Segments with fewer episodes
    // provide negative evidence for the evaluator, not a readiness blocker.
    const readiness = evaluateReadiness(
      metrics,
      eventDrivenMetrics,
      cadenceMetrics,
      cadenceDue,
      candidates,
      maxSegmentTraceCount,
      traceCorpus.length,
      input.force ?? false,
    );
    if (readiness.status !== 'ready') return readiness.result;

    const snapshot = this.buildSnapshot(
      input,
      metrics,
      candidates,
      traceCorpus,
      windowStartMs,
      ingestionCursor,
      nowInteger,
    );
    const appended = await this.deps.snapshots.append(snapshot);
    // A duplicate immutable snapshot is still runnable. Consumption/completion
    // is committed only after MetricResult + ObjectiveJudgment append, so
    // evaluator failure stays retryable and concurrent workers converge through
    // deterministic snapshotId.
    if (appended.outcome === 'duplicate') return { status: 'queued', snapshot };
    return { status: 'queued', snapshot };
  }

  private async collectCandidates(
    input: {
      ownerUserId: string;
      objectiveId: string;
      now: number;
    },
    metrics: MetricDefinition[],
    windowStartMs: number,
    endScore: number,
    consumed: Set<string>,
  ): Promise<Map<string, TraceAnnotation[]>> {
    // The Unit snapshot freezes the cohort of annotations whose createdAt is at
    // or after the last completed run's exclusive upper bound. Per-metric
    // candidate selection preserves each metric's own lookback/window contract,
    // but they share the same Unit semantic window. Already-consumed annotations
    // are excluded so the next Unit does not reuse the previous window's samples.
    //
    // Intervals are half-open [start, end) in annotation-score (createdAt) space:
    // an annotation whose score equals the upper bound belongs to the next Unit run.
    const annotationLists = await Promise.all(
      metrics.map((metric) => {
        const metricWindowStart = Math.max(windowStartMs, metricWindowStartFor(metric, input.now));
        return this.deps.annotations.queryMetricWindow(
          input.ownerUserId,
          input.objectiveId,
          metric.id,
          metricWindowStart,
          endScore,
        );
      }),
    );

    const metricCandidates = new Map<string, TraceAnnotation[]>();
    for (let index = 0; index < metrics.length; index++) {
      const unconsumed = annotationLists[index].filter((annotation) => !consumed.has(annotation.annotationId));
      metricCandidates.set(metrics[index].id, selectCandidates(metrics[index], unconsumed));
    }
    return metricCandidates;
  }

  private buildSnapshot(
    input: {
      ownerUserId: string;
      objectiveId: string;
      evaluationModel: EvaluationModelInput;
      unitRefs: EvaluationUnitRef[];
      now: number;
    },
    metrics: MetricDefinition[],
    candidates: Map<string, TraceAnnotation[]>,
    traceCorpus: TraceEpisode[],
    windowStartMs: number,
    ingestionCursor: number,
    nowInteger: number,
  ): EvaluationSnapshot {
    // The snapshot is the union of all metric candidate samples in the Unit
    // window. Readiness has already been checked; do not truncate the cohort
    // here, so every metric is evaluated against the same frozen window.
    const sampleSet = new Map<string, TraceAnnotation>();
    for (const metric of metrics) {
      for (const annotation of candidates.get(metric.id) ?? []) {
        sampleSet.set(annotation.annotationId, annotation);
      }
    }

    const selected = [...sampleSet.values()].sort(
      (left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId),
    );

    const annotationIds = selected.map((annotation) => annotation.annotationId);
    const episodeRefs = traceCorpus.map((episode) => episode.terminal);
    const traceInvocationIds = episodeRefs.map((episode) => episode.invocationId);

    const maxAnnotationScore =
      selected.length > 0 ? Math.max(...selected.map((annotation) => annotation.createdAt)) : ingestionCursor;

    const snapshotId = `snapshot-${digest([
      input.ownerUserId,
      input.objectiveId,
      input.evaluationModel.id,
      input.evaluationModel.ruleVersion,
      input.unitRefs,
      traceInvocationIds,
      annotationIds,
      ingestionCursor,
    ])}`;

    return {
      snapshotId,
      ownerUserId: input.ownerUserId,
      objectiveId: input.objectiveId,
      evaluationModelId: input.evaluationModel.id,
      evaluationModelVersion: input.evaluationModel.ruleVersion,
      unitRefs: input.unitRefs,
      metricDefinitions: metrics,
      // Human-readable window bounds (timestamp millis). The semantic start is the
      // last completed run's exclusive upper bound; windowStartScore remains the
      // ingestion cursor used to claim/resume the immutable Unit run.
      window: { start: windowStartMs, end: nowInteger },
      windowStartScore: ingestionCursor,
      maxAnnotationScore,
      traceCorpus,
      episodeRefs,
      annotationIds,
      samples: selected.map((annotation) => ({
        annotationId: annotation.annotationId,
        episodeRef: annotation.episodeRef,
        objectiveId: annotation.objectiveId,
        metricId: annotation.metricId,
        unitRefs: annotation.unitRefs,
        incidentKey: annotation.incidentKey,
        polarity: annotation.polarity,
        confidence: annotation.confidence,
        source: annotation.source,
        ...(annotation.rationale ? { rationale: annotation.rationale } : {}),
        createdAt: annotation.createdAt,
        sequence: annotation.sequence,
      })),
      createdAt: nowInteger,
    };
  }
}

export function metricWindowStartFor(metric: MetricDefinition, now: number): number {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return metric.trigger.lookbackMs ? now - metric.trigger.lookbackMs : 0;
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return now - metric.trigger.windowMs;
  }
  // Cadence/replay metrics have no rolling lookback; they use the Unit watermark.
  return 0;
}

export function classifyMetrics(metrics: MetricDefinition[]): {
  cadenceMetrics: CadenceMetricDefinition[];
  eventDrivenMetrics: MetricDefinition[];
} {
  const cadenceMetrics = metrics.filter(
    (metric): metric is CadenceMetricDefinition => metric.trigger.kind === 'cadence',
  );
  const eventDrivenMetrics = metrics.filter((metric) => metric.trigger.kind !== 'cadence');
  return { cadenceMetrics, eventDrivenMetrics };
}

export function isCadenceDue(
  cadenceMetrics: CadenceMetricDefinition[],
  cadenceWatermarkAt: number,
  now: number,
  firstEligibleTraceAt = 0,
): { status: 'due'; ready: boolean } | { status: 'not-due'; nextDueAt: number; ready: boolean } {
  if (cadenceMetrics.length === 0) return { status: 'due', ready: false };
  const cadence = cadenceMetrics[0].trigger.cadence;
  const baseline = cadenceWatermarkAt > 0 ? cadenceWatermarkAt : firstEligibleTraceAt;
  if (baseline === 0) return { status: 'due', ready: false };
  const nextDueAt = baseline + cadenceMs(cadence);
  if (now < nextDueAt) return { status: 'not-due', nextDueAt, ready: false };
  return { status: 'due', ready: true };
}

function evaluateReadiness(
  metrics: MetricDefinition[],
  eventDrivenMetrics: MetricDefinition[],
  cadenceMetrics: CadenceMetricDefinition[],
  cadenceDue: { status: 'due'; ready: boolean } | { status: 'not-due'; nextDueAt: number; ready: boolean },
  candidates: Map<string, TraceAnnotation[]>,
  maxSegmentTraceCount: number,
  corpusSize: number,
  force: boolean,
):
  | { status: 'ready'; metric: MetricDefinition }
  | { status: 'not-ready'; result: { status: 'not-ready'; observed: number; required: number } }
  | { status: 'not-due'; result: { status: 'not-due'; nextDueAt: number } } {
  // Unit-level anyOf: an event-driven metric can always force a run, even when
  // the Unit cadence watermark has not elapsed.
  const counterReadiness = evaluateCounterReadiness(eventDrivenMetrics, candidates);
  if (counterReadiness.readyMetric) {
    return { status: 'ready', metric: counterReadiness.readyMetric };
  }

  const nonCounterEventMetrics = eventDrivenMetrics.filter(
    (metric) => metric.trigger.kind !== 'distinct-counterexamples',
  );
  const readyEventMetric = nonCounterEventMetrics.find((metric) => {
    const list = candidates.get(metric.id) ?? [];
    return list.length >= requiredSampleCount(metric);
  });
  if (readyEventMetric) return { status: 'ready', metric: readyEventMetric };

  // Raw volume is a Unit-level trigger using per-segment MAX: if ANY segment
  // reaches the volume threshold, the Unit has enough data to evaluate.
  // Segments with fewer episodes provide negative evidence for the evaluator.
  if (maxSegmentTraceCount >= EVALUATION_TRACE_VOLUME_THRESHOLD) {
    return { status: 'ready', metric: metrics[0] };
  }

  if (cadenceDue.status === 'not-due') {
    return { status: 'not-due', result: { status: 'not-due', nextDueAt: cadenceDue.nextDueAt } };
  }

  // Cadence is measured from the first eligible raw trace (or the previous
  // completed Unit run), not from annotation arrival. A due Unit with at least
  // one raw episode is evaluable even when it has no structured hints.
  // Uses total corpus size (not per-segment MIN) because cadence should fire
  // when ANY segment has data — segments with no data provide negative evidence
  // for the evaluator.
  if (cadenceMetrics.length > 0 && cadenceDue.ready && corpusSize > 0) {
    return { status: 'ready', metric: cadenceMetrics[0] };
  }

  // Periodic sweep (force=true) may evaluate pending candidates for a Unit whose
  // cadence watermark has elapsed, even when no metric has reached its
  // event-driven threshold. It must not force pure event-driven Units: the
  // sweep itself is not a cadence trigger. Uses corpus size (not per-segment
  // MIN) for the same reason as cadence above.
  if (force && cadenceMetrics.length > 0 && cadenceDue.status === 'due') {
    if (corpusSize > 0) return { status: 'ready', metric: metrics[0] };
  }

  // Return the most constrained event-driven metric for observability.
  if (counterReadiness.required !== null) {
    return {
      status: 'not-ready',
      result: {
        status: 'not-ready',
        observed: counterReadiness.observed,
        required: counterReadiness.required,
      },
    };
  }
  const first = nonCounterEventMetrics[0] ?? metrics[0];
  const list = candidates.get(first.id) ?? [];
  return {
    status: 'not-ready',
    result: {
      status: 'not-ready',
      observed: Math.max(list.length, maxSegmentTraceCount),
      required: first.trigger.kind === 'cadence' ? EVALUATION_TRACE_VOLUME_THRESHOLD : requiredSampleCount(first),
    },
  };
}

function evaluateCounterReadiness(
  eventDrivenMetrics: MetricDefinition[],
  candidates: Map<string, TraceAnnotation[]>,
): { readyMetric: MetricDefinition | null; observed: number; required: number | null } {
  const metrics = eventDrivenMetrics.filter((metric) => metric.trigger.kind === 'distinct-counterexamples');
  if (metrics.length === 0) return { readyMetric: null, observed: 0, required: null };
  const incidentKeys = new Set(
    metrics.flatMap((metric) =>
      (candidates.get(metric.id) ?? [])
        .filter((annotation) => annotation.polarity === 'counterexample')
        .map((annotation) => annotation.incidentKey),
    ),
  );
  const required = Math.min(...metrics.map((metric) => requiredSampleCount(metric)));
  return {
    readyMetric: incidentKeys.size >= required ? metrics[0] : null,
    observed: incidentKeys.size,
    required,
  };
}

function requiredSampleCount(metric: MetricDefinition): number {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return metric.trigger.threshold;
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return metric.trigger.minimum;
  }
  if (metric.trigger.kind === 'cadence') return metric.kind === 'replay' ? 0 : 1;
  throw new Error(`evaluation_scheduler_trigger_not_supported:${metric.id}`);
}

export function selectCandidates(metric: MetricDefinition, annotations: TraceAnnotation[]): TraceAnnotation[] {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return distinctCounterexamples(annotations);
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return distinctRateSamples(annotations);
  }
  if (metric.trigger.kind === 'cadence') return distinctCadenceSamples(annotations);
  throw new Error(`evaluation_scheduler_trigger_not_supported:${metric.id}`);
}

function cadenceMs(cadence: 'daily' | 'weekly' | `every-${number}d`): number {
  if (cadence === 'daily') return 24 * 60 * 60 * 1000;
  if (cadence === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  const match = /^every-(\d+)d$/.exec(cadence);
  if (!match || Number(match[1]) < 1) throw new Error(`evaluation_scheduler_invalid_cadence:${cadence}`);
  return Number(match[1]) * 24 * 60 * 60 * 1000;
}

function distinctCounterexamples(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const incidents = new Set<string>();
  return annotations
    .filter((annotation) => annotation.polarity === 'counterexample')
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (incidents.has(annotation.incidentKey)) return false;
      incidents.add(annotation.incidentKey);
      return true;
    });
}

function distinctRateSamples(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const incidents = new Set<string>();
  return annotations
    .filter((annotation) => annotation.polarity === 'positive' || annotation.polarity === 'counterexample')
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (incidents.has(annotation.incidentKey)) return false;
      incidents.add(annotation.incidentKey);
      return true;
    });
}

function distinctCadenceSamples(annotations: TraceAnnotation[]): TraceAnnotation[] {
  return distinctRateSamples(annotations);
}

export function evaluateCounterSnapshot(
  snapshot: EvaluationSnapshot,
  metric: MetricDefinition,
  evaluatedAt: number,
): MetricResult {
  if (metric.kind !== 'counter' || metric.trigger.kind !== 'distinct-counterexamples') {
    throw new Error(`counter_evaluator_metric_not_supported:${metric.id}`);
  }
  const samples = snapshot.samples.filter((sample) => sample.metricId === metric.id);
  const resultId = `result-${digest(['counter', snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id])}`;
  return {
    resultId,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    metricId: metric.id,
    kind: 'counter',
    value: {
      kind: 'counter',
      count: samples.length,
      threshold: metric.trigger.threshold,
    },
    evaluatedAt,
  };
}

export function evaluateRateSnapshot(
  snapshot: EvaluationSnapshot,
  metric: MetricDefinition,
  evaluatedAt: number,
): MetricResult | null {
  if (metric.kind !== 'rate' || metric.trigger.kind !== 'minimum-sample') {
    throw new Error(`rate_evaluator_metric_not_supported:${metric.id}`);
  }
  const samples = snapshot.samples.filter((sample) => sample.metricId === metric.id);
  const denominator = samples.filter(
    (sample) => sample.polarity === 'positive' || sample.polarity === 'counterexample',
  ).length;
  if (denominator < metric.trigger.minimum) {
    return null;
  }
  const numerator = samples.filter((sample) => sample.polarity === 'positive').length;
  const resultId = `result-${digest(['rate', snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id])}`;
  return {
    resultId,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    metricId: metric.id,
    kind: 'rate',
    value: { kind: 'rate', numerator, denominator, rate: numerator / denominator },
    evaluatedAt,
  };
}
