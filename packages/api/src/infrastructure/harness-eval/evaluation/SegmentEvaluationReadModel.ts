import type {
  CycleRecord,
  MetricDefinition,
  SegmentCycleSummary,
  SegmentEvaluationResponse,
  SegmentObjectiveEvaluationView,
  TraceAnnotation,
} from '@cat-cafe/shared';
import { isFiredTraceSegment } from '../../../domains/prompt-hooks/injection-trace-semantics.js';
import type { HarnessGovernanceProposalStore } from '../governance/HarnessGovernanceProposalStore.js';
import type { EvaluationModelDefinition, ObjectiveDefinition } from '../objective-registry.js';
import {
  counterexampleWakeKey,
  isEvaluationPriorityCounterexample,
} from '../trace-annotation/high-confidence-annotation.js';
import { cycleTriggerPolicyFor, initialCycleTriggerPolicy } from './cycle-trigger-policy.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';
import { projectSegmentGovernanceImpact } from './SegmentGovernanceImpact.js';
import { unitRefsForObjective } from './segment-evaluation-helpers.js';

type ObjectiveProjection = {
  objective: SegmentObjectiveEvaluationView;
  trigger: SegmentEvaluationResponse['tracing']['trigger'];
  counterexamples: TraceAnnotation[];
  injections: SegmentEvaluationResponse['tracing']['injections'];
  injectionsCapped: boolean;
  window: { start: number; end: number };
};

const MAX_INJECTION_ROWS = 100;
/**
 * Version-chain depth sent to the console.
 *
 * The chain drives the per-version cycle selector, so a short bound silently
 * hides every cycle of the older versions once an Objective outlives it: the
 * tree filters `cycle.segmentVersion === epoch.version`, and versions whose
 * cycles all fell outside the window simply render as empty. Keep the bound
 * generous and report truncation instead of dropping history in silence.
 */
const MAX_VERSION_CHAIN_CYCLES = 100;

/** F257 S4: Console projection whose only cycle truth is CycleRecord. */
export class SegmentEvaluationReadModel {
  constructor(
    private readonly runtime: ObjectiveEvaluationRuntime,
    private readonly now: () => number = Date.now,
    private readonly proposals?: Pick<HarnessGovernanceProposalStore, 'get'>,
  ) {}

  async read(input: {
    ownerUserId: string;
    segmentId: string;
    startMs: number;
    endMs: number;
    cycleId?: string;
  }): Promise<SegmentEvaluationResponse> {
    const unit = this.runtime.catalog.manifest.units.find((candidate) => candidate.unitId === input.segmentId);
    if (!unit) throw new Error(`segment_evaluation_unit_not_found:${input.segmentId}`);

    const attachment = unit.objectives[0];
    if (!attachment) throw new Error(`segment_evaluation_objective_missing:${input.segmentId}`);
    const objective = this.requireObjective(attachment.objectiveId);
    const model = this.requireModel(objective.evaluationModelId);
    const projection = await this.projectObjective(input, objective, model);
    const projections = [projection];
    // Same set the trigger counts. Narrowing this list to the requested segment
    // used to render "no counterexample in this cycle" on a segment whose
    // Objective had already collected several against a sibling segment — an
    // absence claim contradicted by the counter directly above it. The rows
    // carry their attribution instead, so a shared Objective stays legible.
    const counterexamples = projections.flatMap((projection) => projection.counterexamples);

    return {
      segmentId: input.segmentId,
      window: projection.window,
      tracing: {
        trigger: projection.trigger,
        injections: projection.injections,
        injectionsCapped: projection.injectionsCapped,
        structuredCounterexamples: counterexamples.map((annotation) => ({
          annotationId: annotation.annotationId,
          incidentKey: annotation.incidentKey,
          objectiveId: annotation.objectiveId,
          metricId: annotation.metricId,
          source: annotation.source,
          createdAt: annotation.createdAt,
          ...(annotation.rationale ? { rationale: annotation.rationale } : {}),
          threadId: annotation.episodeRef.threadId,
          turnId: annotation.episodeRef.traceTurnId,
          catId: annotation.episodeRef.catId,
          segmentIds: annotation.unitRefs
            .filter((unitRef) => unitRef.unitType === 'segment')
            .map((unitRef) => unitRef.unitId),
        })),
      },
      objectives: projections.map((projection) => projection.objective),
    };
  }

  private async projectObjective(
    input: { ownerUserId: string; segmentId: string; startMs: number; endMs: number; cycleId?: string },
    objective: ObjectiveDefinition,
    model: EvaluationModelDefinition,
  ): Promise<ObjectiveProjection> {
    const [current, history, requestedHistoryCycle, historyCount] = await Promise.all([
      this.runtime.cycles.current(input.ownerUserId, objective.id),
      this.runtime.cycles.history(input.ownerUserId, objective.id, MAX_VERSION_CHAIN_CYCLES),
      input.cycleId ? this.runtime.cycles.historyCycle(input.ownerUserId, objective.id, input.cycleId) : null,
      this.runtime.cycles.historyCount(input.ownerUserId, objective.id),
    ]);
    const selected = input.cycleId
      ? current?.cycleId === input.cycleId
        ? current
        : requestedHistoryCycle
      : (current ?? history[0] ?? null);
    if (input.cycleId && !selected) throw new Error(`segment_evaluation_cycle_not_found:${input.cycleId}`);

    const cycleStart = selected?.cycleStart ?? input.startMs;
    const cycleEnd = selected?.cycleEnd ?? this.now();
    const policy = selected ? cycleTriggerPolicyFor(this.runtime.catalog, selected) : initialCycleTriggerPolicy(model);
    const [cumulativeCount, segmentEpisodes, annotationLists] = await Promise.all([
      this.runtime.traces.countOwnerWindow(input.ownerUserId, cycleStart, cycleEnd),
      this.runtime.traces.queryUnitWindow(
        input.ownerUserId,
        [{ unitType: 'segment', unitId: input.segmentId }],
        cycleStart,
        cycleEnd,
      ),
      Promise.all(
        model.metrics.map((metric) =>
          this.runtime.annotations.queryMetricWindow(input.ownerUserId, objective.id, metric.id, cycleStart, cycleEnd),
        ),
      ),
    ]);
    const counterexamples = distinctWakeSignals(annotationLists.flat());
    const segmentRows = segmentEpisodes
      .map((episode) => episode.summary.segments.find((segment) => segment.segmentId === input.segmentId))
      .filter((segment): segment is NonNullable<typeof segment> => segment !== undefined);
    const injections = segmentEpisodes
      .flatMap((episode) => {
        const segment = episode.summary.segments.find((candidate) => candidate.segmentId === input.segmentId);
        if (!segment || !isFiredTraceSegment(segment)) return [];
        return [
          {
            threadId: episode.summary.threadId,
            turnId: episode.summary.turnId,
            timestamp: episode.summary.timestamp,
            catId: episode.summary.catId,
            pipelineStatus: 'fired' as const,
            version: segment.version ?? null,
            charCount: segment.charCount,
          },
        ];
      })
      .sort((left, right) => right.timestamp - left.timestamp || right.turnId.localeCompare(left.turnId));
    const selectedEvaluated = selected?.evaluation ? selected : undefined;
    const selectedGoverned = selected?.governance ? selected : undefined;
    const latestMetrics = new Map(
      (selectedEvaluated?.evaluation?.metrics ?? []).map((metric) => [metric.id, metric] as const),
    );
    const cycleTotal = historyCount + (current ? 1 : 0);
    const chronologicalHistory = [...history].reverse();
    const versionChain = await Promise.all(
      chronologicalHistory.map((record, index) => {
        const nextRecord = chronologicalHistory[index + 1] ?? current ?? undefined;
        return this.toSummary(record, input.segmentId, historyCount - history.length + index + 1, nextRecord);
      }),
    );
    if (current) versionChain.push(await this.toSummary(current, input.segmentId, cycleTotal));
    const selectedSummary = selected
      ? (versionChain.find((cycle) => cycle.cycleId === selected.cycleId) ??
        (await this.toSummary(selected, input.segmentId)))
      : null;
    const currentSummary = current
      ? (versionChain.find((cycle) => cycle.cycleId === current.cycleId) ??
        (await this.toSummary(current, input.segmentId, cycleTotal)))
      : null;
    const lastClosedAt = history.find(
      (record) =>
        record.cycleId !== selected?.cycleId && record.cycleStart < cycleStart && record.closedAt !== undefined,
    )?.closedAt;

    return {
      window: { start: cycleStart, end: cycleEnd },
      injections: injections.slice(0, MAX_INJECTION_ROWS),
      injectionsCapped: injections.length > MAX_INJECTION_ROWS,
      trigger: {
        objective: {
          objectiveId: objective.id,
          evalStatus: selected?.evalStatus ?? 'idle',
          lifecycle: objective.lifecycle === 'retired' ? 'retired' : (selected?.objectiveLifecycle ?? 'active'),
          // An empty fresh cycle is a normal tracing state, not evidence of a
          // collector failure. Only an independently observed fault may make
          // this field unhealthy in a future contract.
          health: 'healthy',
          policyChangeCount: history.filter(
            (record) => record.cycleStart <= cycleStart && record.triggerPolicyChange !== undefined,
          ).length,
          cycleStartMs: cycleStart,
          cycleEndMs: selected?.cycleEnd ?? null,
          lastClosedAtMs: lastClosedAt ?? null,
          minimumIntervalMs: policy.minimumIntervalMs,
          triggeredBy: selected?.triggeredBy ?? [],
          cumulative: { count: cumulativeCount, threshold: policy.cumulativeThreshold },
          counterexamples: { count: counterexamples.length, threshold: policy.counterexampleThreshold },
          cadence: {
            elapsedMs: Math.max(0, cycleEnd - cycleStart),
            thresholdMs: policy.cadenceDays * 24 * 60 * 60 * 1000,
            eligible: cumulativeCount > 0,
          },
        },
        segment: {
          segmentId: input.segmentId,
          observationCount: segmentRows.length,
          injectionCount: segmentRows.filter(isFiredTraceSegment).length,
          disabledCount: segmentRows.filter((segment) => segment.pipelineStatus === 'disabled').length,
        },
      },
      counterexamples,
      objective: {
        objectiveId: objective.id,
        objectiveLabel: objective.label,
        objectiveStatement: objective.statement,
        evaluationModelId: model.id,
        evaluationModelLabel: model.label,
        ruleVersion: model.ruleVersion,
        unitRefs: unitRefsForObjective(this.runtime, objective.id),
        metrics: model.metrics.map((metric) => metricView(metric, latestMetrics.get(metric.id))),
        selectedCycle: selectedSummary,
        currentCycle: currentSummary,
        latestEvaluation: latestEvaluationView(selectedEvaluated),
        latestGovernance: latestGovernanceView(selectedGoverned, selectedSummary?.governanceImpact ?? null),
        versionChain,
        versionChainCapped: historyCount > history.length,
      },
    };
  }

  private requireObjective(objectiveId: string): ObjectiveDefinition {
    const objective = this.runtime.catalog.registry.objectives.find((candidate) => candidate.id === objectiveId);
    if (!objective) throw new Error(`segment_evaluation_objective_not_found:${objectiveId}`);
    return objective;
  }

  private requireModel(modelId: string): EvaluationModelDefinition {
    const model = this.runtime.catalog.registry.evaluationModels.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`segment_evaluation_model_not_found:${modelId}`);
    return model;
  }

  private async toSummary(
    record: CycleRecord,
    segmentId: string,
    ordinal?: number,
    nextRecord?: CycleRecord,
  ): Promise<SegmentCycleSummary> {
    const [segmentVersion, governanceImpact] = await Promise.all([
      this.runtime.resolveSegmentVersion(record.versionContentRef, segmentId),
      projectSegmentGovernanceImpact(this.runtime, this.proposals, record, nextRecord, segmentId),
    ]);
    return toSummary(record, segmentVersion, governanceImpact, ordinal);
  }
}

function latestEvaluationView(record: CycleRecord | undefined): SegmentObjectiveEvaluationView['latestEvaluation'] {
  if (!record?.evaluation) return null;
  return {
    cycleId: record.cycleId,
    overall: record.evaluation.overall,
    writtenAt: record.evaluation.writtenAt,
    by: record.evaluation.by,
    windows: record.windows,
    ...(record.evaluation.coverageAssessment
      ? { coverageAssessment: structuredClone(record.evaluation.coverageAssessment) }
      : {}),
  };
}

function latestGovernanceView(
  record: CycleRecord | undefined,
  impact: SegmentCycleSummary['governanceImpact'],
): SegmentObjectiveEvaluationView['latestGovernance'] {
  if (!record?.governance) return null;
  return {
    cycleId: record.cycleId,
    ...record.governance,
    approval: record.approval ?? null,
    impact,
  };
}

function metricView(
  metric: MetricDefinition,
  latest: NonNullable<CycleRecord['evaluation']>['metrics'][number] | undefined,
): SegmentObjectiveEvaluationView['metrics'][number] {
  return {
    metricId: metric.id,
    label: metric.label,
    kind: metric.kind,
    evaluatorKind: metric.evaluator.kind,
    evaluatorRuleRef: metric.evaluator.ruleRef,
    verdictRule: metric.verdictRule,
    latestConclusion: latest?.conclusion ?? null,
    evidenceRefs: latest?.evidenceRefs ?? [],
  };
}

function toSummary(
  record: CycleRecord,
  segmentVersion: number | null,
  governanceImpact: SegmentCycleSummary['governanceImpact'],
  ordinal?: number,
): SegmentCycleSummary {
  return {
    cycleId: record.cycleId,
    ...(ordinal !== undefined ? { ordinal } : {}),
    segmentVersion,
    version: record.version,
    versionContentRef: record.versionContentRef,
    cycleStart: record.cycleStart,
    cycleEnd: record.cycleEnd ?? null,
    evalStatus: record.evalStatus,
    windows: record.windows,
    triggeredBy: record.triggeredBy ?? [],
    evaluation: record.evaluation
      ? {
          overall: record.evaluation.overall,
          writtenAt: record.evaluation.writtenAt,
          by: record.evaluation.by,
        }
      : null,
    governance: record.governance ?? null,
    governanceImpact,
    approval: record.approval ?? null,
    rejectReasons: record.rejectReasons ?? [],
    termination: record.termination ?? null,
    closedAt: record.closedAt ?? null,
  };
}

/**
 * One row per wake key, carrying every segment that key was attributed to.
 *
 * The key collapses recurrences of one incident into a single trigger signal;
 * attribution is not part of that collapse. Two annotations under the same key
 * may name different segments, and keeping only the first drops a segment the
 * operator needs in order to open it — so the surviving representative takes
 * the union, deduped and sorted for a stable projection.
 */
function distinctWakeSignals(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const representatives = new Map<string, TraceAnnotation>();
  const segmentsByKey = new Map<string, Set<string>>();
  const ordered = [...annotations]
    .filter(isEvaluationPriorityCounterexample)
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId));

  for (const annotation of ordered) {
    const key = counterexampleWakeKey(annotation);
    if (!key) continue;
    if (!representatives.has(key)) representatives.set(key, annotation);
    const segments = segmentsByKey.get(key) ?? new Set<string>();
    for (const unitRef of annotation.unitRefs) {
      if (unitRef.unitType === 'segment') segments.add(unitRef.unitId);
    }
    segmentsByKey.set(key, segments);
  }

  return [...representatives].map(([key, annotation]) => ({
    ...annotation,
    unitRefs: [...(segmentsByKey.get(key) ?? new Set<string>())]
      .sort()
      .map((unitId) => ({ unitType: 'segment' as const, unitId })),
  }));
}
