import type {
  CycleCoverageAssessment,
  CycleEvaluationSubmission,
  CycleRecord,
  CycleTracePage,
  TraceAnnotation,
  TraceEpisode,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import {
  counterexampleWakeKey,
  isEvaluationPriorityAnnotation,
  isEvaluationPriorityCounterexample,
  isReplayableStructuredAnnotation,
} from '../trace-annotation/high-confidence-annotation.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

/** Reads the immutable trace pool and validates evidence-bound cycle writeback. */
export class CycleEvaluationEvidence {
  constructor(
    private readonly runtime: ObjectiveEvaluationRuntime,
    private readonly messageStore: Pick<IMessageStore, 'getByIds'>,
  ) {}

  async read(record: CycleRecord, input: { cursor: number; limit: number }): Promise<CycleTracePage> {
    const priority = await this.priorityMap(record);
    const invocationIds = await this.runtime.traces.ownerInvocationIds(record.ownerUserId, record.windows);
    const available = new Set(invocationIds);
    const ordered = [
      ...[...priority.keys()].filter((invocationId) => available.has(invocationId)),
      ...invocationIds.filter((invocationId) => !priority.has(invocationId)),
    ];
    if (input.cursor > ordered.length) throw new Error(`cycle_trace_cursor_out_of_range:${input.cursor}`);
    const selected = ordered.slice(input.cursor, input.cursor + input.limit);
    const episodes = (
      await Promise.all(selected.map((invocationId) => this.runtime.traces.getEpisodeByInvocationId(invocationId)))
    ).filter((episode): episode is TraceEpisode => episode !== null);
    const messages = await this.loadMessages(record.ownerUserId, episodes);
    const projected = episodes.map((episode) => this.projectEpisode(episode, priority, messages, record.objectiveId));
    const next = input.cursor + selected.length;
    return {
      objectiveId: record.objectiveId,
      cycleId: record.cycleId,
      cursor: input.cursor,
      ...(next < ordered.length ? { nextCursor: next } : {}),
      total: ordered.length,
      episodes: projected,
    };
  }

  async validateSubmission(record: CycleRecord, input: CycleEvaluationSubmission): Promise<void> {
    const objective = this.runtime.catalog.registry.objectives.find((item) => item.id === record.objectiveId);
    const model = this.runtime.catalog.registry.evaluationModels.find(
      (item) => item.id === objective?.evaluationModelId,
    );
    if (!model) throw new Error(`cycle_evaluation_model_not_found:${record.objectiveId}`);
    const submitted = new Map(input.metrics.map((metric) => [metric.id, metric]));
    if (submitted.size !== input.metrics.length || submitted.size !== model.metrics.length) {
      throw new Error(`cycle_evaluation_metric_coverage:${record.cycleId}`);
    }
    const evidenceRefs = new Set<string>();
    let evidenceRefCount = 0;
    for (const definition of model.metrics) {
      const metric = submitted.get(definition.id);
      if (!metric || metric.conclusion.kind !== conclusionKind(definition.kind)) {
        throw new Error(`cycle_evaluation_metric_conclusion:${definition.id}`);
      }
      validateConclusion(metric.conclusion);
      evidenceRefCount += metric.evidenceRefs.length;
      for (const ref of metric.evidenceRefs) evidenceRefs.add(ref);
    }
    if (evidenceRefCount > 64) throw new Error(`cycle_evaluation_evidence_limit:${record.cycleId}`);
    const annotations = await this.annotations(record);
    const counterexampleEventCount = new Set(
      annotations.map((annotation) => counterexampleWakeKey(annotation)).filter((key): key is string => key !== null),
    ).size;
    validateCounterexampleGrouping(record, input.counterexampleRootCauses, counterexampleEventCount);
    const coverageRefs = this.validateCoverageAssessment(record, input.coverageAssessment, model.metrics, annotations);
    evidenceRefCount += coverageRefs.length;
    if (evidenceRefCount > 64) throw new Error(`cycle_evaluation_evidence_limit:${record.cycleId}`);
    for (const ref of coverageRefs) evidenceRefs.add(ref);
    await Promise.all([...evidenceRefs].map((ref) => this.validateEvidenceRef(record, ref)));
  }

  private async annotations(record: CycleRecord): Promise<TraceAnnotation[]> {
    const objective = this.runtime.catalog.registry.objectives.find((item) => item.id === record.objectiveId);
    const model = this.runtime.catalog.registry.evaluationModels.find(
      (item) => item.id === objective?.evaluationModelId,
    );
    if (!model) throw new Error(`cycle_evaluation_model_not_found:${record.objectiveId}`);
    const lists = await Promise.all(
      record.windows.flatMap((window) =>
        model.metrics.map((metric) =>
          this.runtime.annotations.queryMetricWindow(
            record.ownerUserId,
            record.objectiveId,
            metric.id,
            window.start,
            window.end,
          ),
        ),
      ),
    );
    return lists.flat();
  }

  private async priorityMap(record: CycleRecord): Promise<Map<string, TraceAnnotation[]>> {
    const annotations = (await this.annotations(record))
      .filter(isEvaluationPriorityAnnotation)
      .sort((left, right) => left.createdAt - right.createdAt || left.incidentKey.localeCompare(right.incidentKey));
    const byInvocation = new Map<string, TraceAnnotation[]>();
    for (const annotation of annotations) {
      const invocationId = annotation.episodeRef.invocationId;
      const signals = byInvocation.get(invocationId) ?? [];
      if (!signals.some((candidate) => candidate.annotationId === annotation.annotationId)) signals.push(annotation);
      byInvocation.set(invocationId, signals);
    }
    return byInvocation;
  }

  private validateCoverageAssessment(
    record: CycleRecord,
    assessment: CycleCoverageAssessment,
    metrics: Array<{ id: string }>,
    annotations: TraceAnnotation[],
  ): string[] {
    validateCoverageShape(record, assessment);
    const metricIds = new Set(metrics.map((metric) => metric.id));
    const refs: string[] = [];
    for (const finding of assessment.findings) {
      validateCoverageFinding(record, finding, metricIds, annotations);
      refs.push(...finding.evidenceRefs);
    }
    return refs;
  }

  private async loadMessages(ownerUserId: string, episodes: TraceEpisode[]): Promise<Map<string, StoredMessage>> {
    const ids = episodes.flatMap((episode) =>
      [episode.terminal.inputMessageId, episode.terminal.outputMessageId].filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    const messages = ids.length > 0 ? await this.messageStore.getByIds([...new Set(ids)]) : [];
    return new Map(
      messages
        .filter((message) => message.userId === ownerUserId && !message.deletedAt)
        .map((message) => [message.id, message]),
    );
  }

  private projectEpisode(
    episode: TraceEpisode,
    priority: Map<string, TraceAnnotation[]>,
    messages: Map<string, StoredMessage>,
    objectiveId: string,
  ): CycleTracePage['episodes'][number] {
    const unitIds = new Set(
      this.runtime.catalog.manifest.units
        .filter((unit) => unit.objectives.some((objective) => objective.objectiveId === objectiveId))
        .map((unit) => unit.unitId),
    );
    const message = (id: string | null) => {
      const stored = id ? messages.get(id) : undefined;
      if (!stored || stored.threadId !== episode.terminal.threadId) return null;
      return { messageId: stored.id, text: truncate(stored.content, 2_000) };
    };
    const calls = episode.terminal.toolCalls.map(({ toolName, outcome }) => ({ toolName, outcome }));
    const signals = priority.get(episode.terminal.invocationId);
    const incidentKeys = signals
      ?.filter(isEvaluationPriorityCounterexample)
      .map((annotation) => annotation.incidentKey);
    return {
      invocationId: episode.terminal.invocationId,
      terminalAt: episode.terminal.terminalAt,
      threadId: episode.terminal.threadId,
      catId: episode.terminal.catId,
      terminalKind: episode.terminal.terminalKind,
      priority: incidentKeys?.length ? 'counterexample' : signals?.length ? 'hint' : 'ordinary',
      ...(incidentKeys?.length ? { incidentKeys } : {}),
      ...(signals?.length
        ? {
            signals: signals.map((annotation) => ({
              incidentKey: annotation.incidentKey,
              source: annotation.source as 'mcp-marker' | 'structured-rule',
              polarity: annotation.polarity as 'counterexample' | 'positive' | 'candidate',
              confidence: annotation.confidence,
              metricId: annotation.metricId,
              ...(annotation.rationale ? { rationale: annotation.rationale } : {}),
            })),
          }
        : {}),
      segments: episode.summary.segments
        .filter((segment) => unitIds.has(segment.segmentId))
        .map((segment) => ({
          segmentId: segment.segmentId,
          status: segment.status,
          ...(segment.pipelineStatus ? { pipelineStatus: segment.pipelineStatus } : {}),
          ...(segment.reasonCode ? { reasonCode: segment.reasonCode } : {}),
        })),
      input: message(episode.terminal.inputMessageId),
      output: message(episode.terminal.outputMessageId),
      toolCalls: {
        total: calls.length,
        head: calls.slice(0, 5),
        tail: calls.slice(Math.max(5, calls.length - 5)),
      },
    };
  }

  private async validateEvidenceRef(record: CycleRecord, invocationId: string): Promise<void> {
    const episode = await this.runtime.traces.getEpisodeByInvocationId(invocationId);
    const inWindow =
      episode &&
      record.windows.some(
        (window) => episode.terminal.terminalAt >= window.start && episode.terminal.terminalAt < window.end,
      );
    if (!episode || episode.terminal.ownerUserId !== record.ownerUserId || !inWindow) {
      throw new Error(`cycle_evaluation_invalid_evidence_ref:${invocationId}`);
    }
  }
}

function validateCounterexampleGrouping(
  record: CycleRecord,
  grouping: CycleEvaluationSubmission['counterexampleRootCauses'],
  eventCount: number,
): void {
  const invalidRootCauseCount =
    grouping.rootCauseCount > grouping.eventCount ||
    (grouping.eventCount === 0 ? grouping.rootCauseCount !== 0 : grouping.rootCauseCount < 1);
  if (grouping.eventCount !== eventCount || invalidRootCauseCount) {
    throw new Error(`cycle_evaluation_counterexample_grouping:${record.cycleId}`);
  }
}

function validateCoverageShape(record: CycleRecord, assessment: CycleCoverageAssessment): void {
  const invalidFindingCount =
    assessment.status === 'gaps_found' ? assessment.findings.length === 0 : assessment.findings.length !== 0;
  if (!assessment.rationale.trim() || invalidFindingCount) {
    throw new Error(`cycle_evaluation_coverage_invalid:${record.cycleId}`);
  }
  if (assessment.findings.length > 16) throw new Error(`cycle_evaluation_coverage_limit:${record.cycleId}`);
}

function validateCoverageFinding(
  record: CycleRecord,
  finding: CycleCoverageAssessment['findings'][number],
  metricIds: Set<string>,
  annotations: TraceAnnotation[],
): void {
  if (!finding.rationale.trim() || finding.evidenceRefs.length === 0) {
    throw new Error(`cycle_evaluation_coverage_invalid:${record.cycleId}`);
  }
  if (finding.kind === 'detector_gap' && !metricIds.has(finding.metricId)) {
    throw new Error(`cycle_evaluation_coverage_metric:${finding.metricId}`);
  }
  if (finding.kind === 'metric_gap' && finding.basis !== 'evaluator-observation') {
    throw new Error(`cycle_evaluation_coverage_basis:${record.cycleId}`);
  }
  if (finding.basis === 'mcp-marker' && !hasMatchingMarker(finding, annotations)) {
    throw new Error(`cycle_evaluation_coverage_marker_basis:${record.cycleId}`);
  }
  if (finding.kind === 'detector_gap' && hasReplayableDetector(finding, annotations)) {
    throw new Error(`cycle_evaluation_coverage_detector_present:${finding.metricId}`);
  }
}

function hasMatchingMarker(
  finding: CycleCoverageAssessment['findings'][number],
  annotations: TraceAnnotation[],
): boolean {
  return finding.evidenceRefs.some((invocationId) =>
    annotations.some(
      (annotation) =>
        annotation.source === 'mcp-marker' &&
        annotation.episodeRef.invocationId === invocationId &&
        (finding.kind !== 'detector_gap' || annotation.metricId === finding.metricId),
    ),
  );
}

function hasReplayableDetector(
  finding: Extract<CycleCoverageAssessment['findings'][number], { kind: 'detector_gap' }>,
  annotations: TraceAnnotation[],
): boolean {
  return finding.evidenceRefs.some((invocationId) =>
    annotations.some(
      (annotation) =>
        annotation.metricId === finding.metricId &&
        annotation.episodeRef.invocationId === invocationId &&
        isReplayableStructuredAnnotation(annotation),
    ),
  );
}

function conclusionKind(kind: string): 'count' | 'rate-badness' | 'semantic-label' {
  if (kind === 'rate') return 'rate-badness';
  if (kind === 'semantic') return 'semantic-label';
  return 'count';
}

function validateConclusion(conclusion: CycleEvaluationSubmission['metrics'][number]['conclusion']): void {
  if (conclusion.kind === 'rate-badness' && (conclusion.value < 0 || conclusion.value > 1)) {
    throw new Error('cycle_evaluation_rate_out_of_range');
  }
  const value = conclusion.kind === 'semantic-label' ? conclusion.count : conclusion.value;
  if (!Number.isFinite(value) || value < 0) throw new Error('cycle_evaluation_value_invalid');
  if (conclusion.kind !== 'rate-badness' && !Number.isSafeInteger(value)) {
    throw new Error('cycle_evaluation_value_invalid');
  }
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
