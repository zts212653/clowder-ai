import type { CycleEvaluationAssignment, CycleRecord, TraceAnnotation } from '@cat-cafe/shared';
import {
  counterexampleWakeKey,
  isEvaluationPriorityCounterexample,
} from '../trace-annotation/high-confidence-annotation.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { isSkippedCycle } from './CycleRecordStore.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';

export const MAX_CYCLE_ASSIGNMENT_BYTES = 32 * 1024;
export const MAX_ASSIGNMENT_COUNTEREXAMPLES = 64;

export async function buildCycleAssignment(
  deps: {
    catalog: EvaluationCatalog;
    annotations: Pick<TraceAnnotationStore, 'queryMetricWindow'>;
    history: CycleRecord[];
  },
  record: CycleRecord,
): Promise<CycleEvaluationAssignment> {
  const objective = deps.catalog.registry.objectives.find((item) => item.id === record.objectiveId);
  if (!objective) throw new Error(`cycle_objective_not_found:${record.objectiveId}`);
  const model = deps.catalog.registry.evaluationModels.find((item) => item.id === objective.evaluationModelId);
  if (!model) throw new Error(`cycle_evaluation_model_not_found:${objective.evaluationModelId}`);
  const priorSkipWindowCount = Math.max(0, record.windows.filter((window) => !window.provenance).length - 1);
  const priorSkipReasons = deps.history
    .slice(0, priorSkipWindowCount)
    .filter(isSkippedCycle)
    .reverse()
    .map((cycle) => ({ cycleId: cycle.cycleId, reason: skipReason(cycle) }));
  const counterexamples = await collectCounterexamples(
    deps.annotations,
    record,
    model.metrics.map((metric) => metric.id),
  );
  return fitAssignment(record, {
    objective: { id: objective.id, statement: objective.statement },
    version: record.version,
    versionContentRef: record.versionContentRef,
    windows: record.windows,
    ...(priorSkipReasons.length > 0 ? { priorSkipReasons } : {}),
    ...(record.rejectReasons?.length
      ? { rejectReasons: [...record.rejectReasons] }
      : record.approval?.state === 'rejected' && record.approval.reason
        ? { rejectReasons: [record.approval.reason] }
        : {}),
    metrics: model.metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      evaluator: metric.evaluator.kind,
      ruleRef: metric.evaluator.ruleRef,
    })),
    counterexamples,
    readPoolTool: 'cat_cafe_read_cycle_traces(objectiveId, cycleId, cursor?)',
  });
}

export function formatCycleAssignment(record: CycleRecord, assignment: CycleEvaluationAssignment): string {
  const supplementaryGuidance = assignment.windows.some((window) => window.provenance)
    ? 'Windows carrying manual-version-switch provenance are supplementary unconsumed evidence from their declared source version. Keep that provenance intact, assess the current assignment version, and do not treat those windows as native current-version observations or as a cross-version comparison.'
    : null;
  const rejectionGuidance = assignment.rejectReasons?.length
    ? 'This assignment is authoritative: the current CycleRecord is awaiting a fresh evaluation writeback. Earlier governance cards in this thread are settled history. Do not treat their conversation text as a pending proposal or skip this writeback.'
    : null;
  return [
    '## F257 Cycle Evaluation Assignment',
    '',
    `Cycle: \`${record.cycleId}\``,
    'Read the immutable owner trace pool only through the named readPoolTool, starting with counterexample references.',
    'Submit every metric conclusion and the overall result with cat_cafe_submit_cycle_evaluation.',
    'Also group every high-confidence counterexample wake event in the frozen windows into semantic root causes and submit eventCount, rootCauseCount, and howGrouped. eventCount follows the trigger coordinate: replayable structured annotations count by incidentKey, while MCP markers from multiple metrics in one invocation count once. This is audit evidence only; M remains fixed.',
    'Assess detector coverage from the same full window. Report evidence-bound detector gaps, metric gaps, data insufficiency, or adequate coverage; this inferred assessment is diagnostic and never metric truth.',
    supplementaryGuidance,
    rejectionGuidance,
    'Conversation text is not a writeback. Do not compare this cycle with another version.',
    '',
    '```json',
    JSON.stringify(assignment),
    '```',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

async function collectCounterexamples(
  annotations: Pick<TraceAnnotationStore, 'queryMetricWindow'>,
  record: CycleRecord,
  metricIds: string[],
): Promise<CycleEvaluationAssignment['counterexamples']> {
  const lists = await Promise.all(
    record.windows.flatMap((window) =>
      metricIds.map((metricId) =>
        annotations.queryMetricWindow(record.ownerUserId, record.objectiveId, metricId, window.start, window.end),
      ),
    ),
  );
  const unique = new Map<string, TraceAnnotation>();
  for (const annotation of lists.flat()) {
    if (!isEvaluationPriorityCounterexample(annotation)) continue;
    const wakeKey = counterexampleWakeKey(annotation);
    if (!wakeKey || unique.has(wakeKey)) continue;
    unique.set(wakeKey, annotation);
  }
  return [...unique.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.incidentKey.localeCompare(right.incidentKey))
    .slice(0, MAX_ASSIGNMENT_COUNTEREXAMPLES)
    .map((annotation) => ({
      invocationId: annotation.episodeRef.invocationId,
      incidentKey: annotation.incidentKey,
      ...(annotation.rationale ? { rationale: truncate(annotation.rationale, 280) } : {}),
    }));
}

function fitAssignment(record: CycleRecord, assignment: CycleEvaluationAssignment): CycleEvaluationAssignment {
  const fitted = { ...assignment, counterexamples: [...assignment.counterexamples] };
  while (Buffer.byteLength(formatCycleAssignment(record, fitted)) > MAX_CYCLE_ASSIGNMENT_BYTES) {
    if (fitted.counterexamples.length === 0) throw new Error('cycle_assignment_base_exceeds_limit');
    fitted.counterexamples.pop();
  }
  return fitted;
}

function skipReason(record: CycleRecord): string {
  if (record.approval?.reason) return record.approval.reason;
  return record.evaluation?.overall === 'insufficient_evidence' ? 'insufficient_evidence' : 'operator_skip';
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
