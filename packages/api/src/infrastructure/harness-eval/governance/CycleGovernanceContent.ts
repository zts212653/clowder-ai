import type {
  CycleGovernanceAssignment,
  CycleGovernanceHistorySummary,
  CycleMetricEvaluation,
  CycleRecord,
} from '@cat-cafe/shared';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';

export const MAX_GOVERNANCE_ASSIGNMENT_BYTES = 32 * 1024;
const MAX_HISTORY_CYCLES = 8;
const MAX_ASSIGNMENT_REFS_PER_METRIC = 8;

export function buildGovernanceAssignment(
  catalog: EvaluationCatalog,
  record: CycleRecord,
  history: CycleRecord[],
): CycleGovernanceAssignment {
  if (record.evalStatus !== 'written' || !record.evaluation || record.evaluation.overall === 'insufficient_evidence') {
    throw new Error(`cycle_governance_not_ready:${record.cycleId}`);
  }
  const objective = catalog.registry.objectives.find((item) => item.id === record.objectiveId);
  if (!objective) throw new Error(`cycle_objective_not_found:${record.objectiveId}`);
  const assignment: CycleGovernanceAssignment = {
    objective: { id: objective.id, label: objective.label, statement: objective.statement },
    cycleId: record.cycleId,
    version: record.version,
    versionContentRef: record.versionContentRef,
    windows: record.windows.map((window) => ({ ...window })),
    triggeredBy: [...(record.triggeredBy ?? [])],
    evaluation: {
      overall: record.evaluation.overall,
      metrics: summarizeMetrics(record.evaluation.metrics),
      writtenAt: record.evaluation.writtenAt,
      ...(record.evaluation.coverageAssessment
        ? { coverageAssessment: structuredClone(record.evaluation.coverageAssessment) }
        : {}),
    },
    history: history.flatMap(summarizeHistory).slice(0, MAX_HISTORY_CYCLES),
    rejectedProposalReasons: [...(record.rejectReasons ?? [])],
    unitTool: 'cat_cafe_describe_harness_unit(unitId)',
    writebackTool: 'cat_cafe_submit_cycle_governance(objectiveId, cycleId, decision, reason, rollback?, v2Draft?)',
  };
  return fitAssignment(record, assignment);
}

export function formatGovernanceAssignment(record: CycleRecord, assignment: CycleGovernanceAssignment): string {
  const rejectionGuidance = assignment.rejectedProposalReasons.length
    ? 'This assignment is authoritative: the current CycleRecord is awaiting a fresh governance writeback. Earlier proposal cards in this thread are settled history. Do not reuse an earlier proposalId or infer pending state from conversation text.'
    : null;
  return [
    '## F257 Cycle Governance Assignment',
    '',
    `Cycle: \`${record.cycleId}\``,
    'Choose keep, rollback, or evolve from the written evaluation and historical cycle summaries below.',
    'For rollback/evolve, inspect every affected unit with cat_cafe_describe_harness_unit, then include the full structured draft.',
    'Merge means disable the source unit and modify the destination unit. Do not mutate any hook directly.',
    rejectionGuidance,
    'Submit the decision with cat_cafe_submit_cycle_governance. Conversation text is not a writeback.',
    '',
    '```json',
    JSON.stringify(assignment),
    '```',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function summarizeHistory(record: CycleRecord): CycleGovernanceHistorySummary[] {
  if (!record.evaluation) return [];
  return [
    {
      cycleId: record.cycleId,
      version: record.version,
      windows: record.windows.map((window) => ({ ...window })),
      evaluation: {
        overall: record.evaluation.overall,
        metrics: summarizeMetrics(record.evaluation.metrics),
        writtenAt: record.evaluation.writtenAt,
        ...(record.evaluation.coverageAssessment
          ? { coverageAssessment: structuredClone(record.evaluation.coverageAssessment) }
          : {}),
      },
      ...(record.governance ? { governance: { ...record.governance } } : {}),
      ...(record.approval && record.approval.state !== 'pending'
        ? {
            approval: {
              state: record.approval.state,
              ...(record.approval.reason ? { reason: record.approval.reason } : {}),
              at: record.approval.at,
            },
          }
        : {}),
    },
  ];
}

function summarizeMetrics(metrics: CycleMetricEvaluation[]): CycleMetricEvaluation[] {
  return metrics.map((metric) => ({
    ...structuredClone(metric),
    evidenceRefs: metric.evidenceRefs.slice(0, MAX_ASSIGNMENT_REFS_PER_METRIC),
  }));
}

function fitAssignment(record: CycleRecord, assignment: CycleGovernanceAssignment): CycleGovernanceAssignment {
  const fitted = structuredClone(assignment);
  while (Buffer.byteLength(formatGovernanceAssignment(record, fitted)) > MAX_GOVERNANCE_ASSIGNMENT_BYTES) {
    if (fitted.history.length > 0) {
      fitted.history.pop();
      continue;
    }
    const metric = [...fitted.evaluation.metrics].reverse().find((item) => item.evidenceRefs.length > 0);
    if (metric) {
      metric.evidenceRefs.pop();
      continue;
    }
    throw new Error('cycle_governance_assignment_base_exceeds_limit');
  }
  return fitted;
}
