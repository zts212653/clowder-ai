import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, MetricDefinition, MetricResult, TraceEpisode } from '@cat-cafe/shared';
import { evaluateCounterSnapshot, evaluateRateSnapshot } from './EvaluationScheduler.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ReplayEvaluator {
  evaluate(snapshot: EvaluationSnapshot, metric: MetricDefinition): Promise<{ passed: number; failed: number }>;
}

export interface ProgressiveTraceRetrieval {
  take(limit: number): { episodes: TraceEpisode[]; remaining: number };
}

export interface SemanticEvaluator {
  evaluate(input: {
    snapshot: {
      snapshotId: string;
      ownerUserId: string;
      objectiveId: string;
      evaluationModelId: string;
      evaluationModelVersion: string;
      unitRefs: EvaluationSnapshot['unitRefs'];
      window: EvaluationSnapshot['window'];
      frozenCorpusSize: number;
    };
    metric: MetricDefinition;
    priorityHints: EvaluationSnapshot['samples'];
    retrieval: ProgressiveTraceRetrieval;
  }): Promise<{ labels: Record<string, number>; explanation: string }>;
}

export interface SemanticRetrievalProvenance {
  frozenCorpusSize: number;
  inspectedInvocationIds: string[];
  priorityAnchorIds: string[];
  exhausted: boolean;
}

/**
 * Dispatches immutable Unit snapshots by evaluator kind. Structured annotations
 * are only retrieval hints: the semantic adapter must inspect canonical raw trace
 * episodes through the progressive retrieval interface. Replay also stays behind
 * an explicit adapter and is never guessed when the adapter is absent.
 */
export class EvaluatorRunner {
  constructor(private readonly deps: { replay?: ReplayEvaluator; semantic?: SemanticEvaluator } = {}) {}

  canRun(metric: MetricDefinition): boolean {
    if (metric.evaluator.kind === 'replay') return this.deps.replay !== undefined;
    if (metric.evaluator.kind === 'llm') return this.deps.semantic !== undefined;
    return true;
  }

  async run(snapshot: EvaluationSnapshot, metric: MetricDefinition, evaluatedAt: number): Promise<MetricResult | null> {
    if (!snapshot.metricDefinitions.some((definition) => definition.id === metric.id)) {
      throw new Error(`evaluator_metric_not_in_snapshot:${metric.id}:${snapshot.snapshotId}`);
    }
    switch (metric.evaluator.kind) {
      case 'code':
        return this.runCodeEvaluator(snapshot, metric, evaluatedAt);
      case 'llm':
        return this.runLlmEvaluator(snapshot, metric, evaluatedAt);
      case 'replay':
        return this.runReplayEvaluator(snapshot, metric, evaluatedAt);
      default:
        throw new Error(`evaluator_kind_not_supported:${metric.id}`);
    }
  }

  private runCodeEvaluator(
    snapshot: EvaluationSnapshot,
    metric: MetricDefinition,
    evaluatedAt: number,
  ): MetricResult | null {
    if (metric.kind === 'counter') return evaluateCounterSnapshot(snapshot, metric, evaluatedAt);
    if (metric.kind === 'rate') return evaluateRateSnapshot(snapshot, metric, evaluatedAt);
    throw new Error(`code_evaluator_metric_not_supported:${metric.id}`);
  }

  private async runLlmEvaluator(
    snapshot: EvaluationSnapshot,
    metric: MetricDefinition,
    evaluatedAt: number,
  ): Promise<MetricResult> {
    if (!this.deps.semantic) throw new Error(`semantic_evaluator_unavailable:${metric.id}`);
    if (metric.kind !== 'semantic') throw new Error(`llm_evaluator_metric_not_supported:${metric.id}`);
    const semanticSamples = snapshot.samples.filter((sample) => sample.metricId === metric.id);
    const { ordered, priorityAnchorIds } = orderSemanticTraceCorpus(snapshot, metric.id);
    let cursor = 0;
    const inspectedInvocationIds: string[] = [];
    const retrieval: ProgressiveTraceRetrieval = {
      take(limit) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          throw new Error(`semantic_retrieval_invalid_batch_size:${limit}`);
        }
        const selected = ordered.slice(cursor, cursor + limit);
        cursor += selected.length;
        inspectedInvocationIds.push(...selected.map((episode) => episode.terminal.invocationId));
        return { episodes: structuredClone(selected), remaining: ordered.length - cursor };
      },
    };
    const semantic = await this.deps.semantic.evaluate({
      snapshot: {
        snapshotId: snapshot.snapshotId,
        ownerUserId: snapshot.ownerUserId,
        objectiveId: snapshot.objectiveId,
        evaluationModelId: snapshot.evaluationModelId,
        evaluationModelVersion: snapshot.evaluationModelVersion,
        unitRefs: snapshot.unitRefs,
        window: snapshot.window,
        frozenCorpusSize: snapshot.traceCorpus.length,
      },
      metric,
      priorityHints: structuredClone(semanticSamples),
      retrieval,
    });
    if (inspectedInvocationIds.length === 0) {
      throw new Error(`semantic_evaluator_no_traces_inspected:${metric.id}`);
    }
    validateSemanticOutput(semantic, metric.id);
    return buildSemanticMetricResult(snapshot, metric, evaluatedAt, semantic, {
      frozenCorpusSize: snapshot.traceCorpus.length,
      inspectedInvocationIds,
      priorityAnchorIds,
      exhausted: cursor >= ordered.length,
    });
  }

  private async runReplayEvaluator(
    snapshot: EvaluationSnapshot,
    metric: MetricDefinition,
    evaluatedAt: number,
  ): Promise<MetricResult> {
    if (!this.deps.replay) throw new Error(`replay_evaluator_unavailable:${metric.id}`);
    if (metric.kind !== 'replay') throw new Error(`replay_evaluator_metric_not_supported:${metric.id}`);
    const value = await this.deps.replay.evaluate(snapshot, metric);
    return {
      resultId: `result-${digest(['replay', snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id, value])}`,
      snapshotId: snapshot.snapshotId,
      ownerUserId: snapshot.ownerUserId,
      objectiveId: snapshot.objectiveId,
      metricId: metric.id,
      kind: 'replay',
      value: { kind: 'replay', ...value },
      evaluatedAt,
    };
  }
}

function distinctInvocationIds(values: string[]): string[] {
  return [...new Set(values)];
}

export function orderSemanticTraceCorpus(
  snapshot: EvaluationSnapshot,
  metricId: string,
): { ordered: TraceEpisode[]; priorityAnchorIds: string[] } {
  const priorityAnchorIds = distinctInvocationIds(
    snapshot.samples
      .filter((sample) => sample.metricId === metricId && sample.polarity === 'counterexample')
      .map((sample) => sample.episodeRef.invocationId),
  ).filter((invocationId) => snapshot.traceCorpus.some((episode) => episode.terminal.invocationId === invocationId));
  const prioritySet = new Set(priorityAnchorIds);
  return {
    priorityAnchorIds,
    ordered: [
      ...priorityAnchorIds
        .map((invocationId) => snapshot.traceCorpus.find((episode) => episode.terminal.invocationId === invocationId))
        .filter((episode): episode is TraceEpisode => episode !== undefined),
      ...snapshot.traceCorpus.filter((episode) => !prioritySet.has(episode.terminal.invocationId)),
    ],
  };
}

export function buildSemanticMetricResult(
  snapshot: EvaluationSnapshot,
  metric: MetricDefinition,
  evaluatedAt: number,
  semantic: { labels: Record<string, number>; explanation: string },
  retrieval: SemanticRetrievalProvenance,
): MetricResult {
  if (metric.kind !== 'semantic' || metric.evaluator.kind !== 'llm') {
    throw new Error(`llm_evaluator_metric_not_supported:${metric.id}`);
  }
  validateSemanticOutput(semantic, metric.id);
  if (retrieval.inspectedInvocationIds.length === 0) {
    throw new Error(`semantic_evaluator_no_traces_inspected:${metric.id}`);
  }
  const frozenIds = new Set(snapshot.traceCorpus.map((episode) => episode.terminal.invocationId));
  if (retrieval.inspectedInvocationIds.some((invocationId) => !frozenIds.has(invocationId))) {
    throw new Error(`semantic_evaluator_unknown_trace:${metric.id}`);
  }
  return {
    resultId: `result-${digest([
      'semantic',
      snapshot.snapshotId,
      snapshot.evaluationModelVersion,
      metric.id,
      semantic,
      retrieval,
    ])}`,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    metricId: metric.id,
    kind: 'semantic',
    value: { kind: 'semantic', ...semantic, retrieval },
    evaluatedAt,
  };
}

export function validateSemanticOutput(
  value: { labels: Record<string, number>; explanation: string },
  metricId: string,
): void {
  if (!value.explanation.trim()) throw new Error(`semantic_evaluator_invalid_explanation:${metricId}`);
  for (const [label, count] of Object.entries(value.labels)) {
    if (!label || !Number.isInteger(count) || count < 0) {
      throw new Error(`semantic_evaluator_invalid_label_count:${metricId}:${label}`);
    }
  }
}
