/** F257 TC-5/6: compact assignment and writeback contracts for one Objective cycle. */
import type { CycleWindow } from './harness-evaluation.js';

export type CycleMetricConclusion =
  | { kind: 'count'; value: number; howCounted: string }
  | { kind: 'rate-badness'; value: number; howCounted: string }
  | { kind: 'semantic-label'; label: string; count: number; howCounted: string };

export interface CycleMetricEvaluation {
  id: string;
  conclusion: CycleMetricConclusion;
  evidenceRefs: string[];
}

export type CycleCoverageFinding =
  | {
      kind: 'detector_gap';
      basis: 'mcp-marker' | 'evaluator-observation';
      metricId: string;
      rationale: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'metric_gap';
      basis: 'evaluator-observation';
      rationale: string;
      evidenceRefs: string[];
    };

/** Inferred diagnostic from the existing Objective evaluator; never metric truth. */
export interface CycleCoverageAssessment {
  status: 'adequate' | 'data_insufficient' | 'gaps_found';
  rationale: string;
  findings: CycleCoverageFinding[];
}

export interface CycleEvaluationSubmission {
  objectiveId: string;
  cycleId: string;
  metrics: CycleMetricEvaluation[];
  overall: 'complete' | 'partial' | 'insufficient_evidence';
  counterexampleRootCauses: { eventCount: number; rootCauseCount: number; howGrouped: string };
  coverageAssessment: CycleCoverageAssessment;
}

export interface CycleEvaluationAssignment {
  objective: { id: string; statement: string };
  version: string;
  versionContentRef: string;
  /** Native window plus any provenance-tagged supplementary evidence windows. */
  windows: CycleWindow[];
  priorSkipReasons?: Array<{ cycleId: string; reason: string }>;
  rejectReasons?: string[];
  metrics: Array<{
    id: string;
    label: string;
    evaluator: 'code' | 'llm' | 'replay';
    ruleRef: string;
  }>;
  counterexamples: Array<{ invocationId: string; incidentKey: string; rationale?: string }>;
  readPoolTool: 'cat_cafe_read_cycle_traces(objectiveId, cycleId, cursor?)';
}

export interface CycleTracePage {
  objectiveId: string;
  cycleId: string;
  cursor: number;
  nextCursor?: number;
  total: number;
  episodes: Array<{
    invocationId: string;
    terminalAt: number;
    threadId: string;
    catId: string;
    terminalKind: 'completed' | 'failed' | 'cancelled';
    priority: 'counterexample' | 'hint' | 'ordinary';
    incidentKeys?: string[];
    signals?: Array<{
      incidentKey: string;
      source: 'mcp-marker' | 'structured-rule';
      polarity: 'counterexample' | 'positive' | 'candidate';
      confidence: number;
      metricId: string;
      rationale?: string;
    }>;
    segments: Array<{
      segmentId: string;
      status: 'observed' | 'absent';
      pipelineStatus?: string;
      reasonCode?: string;
    }>;
    input: { messageId: string; text: string } | null;
    output: { messageId: string; text: string } | null;
    toolCalls: {
      total: number;
      head: Array<{ toolName: string; outcome: 'ok' | 'error' | 'unknown' }>;
      tail: Array<{ toolName: string; outcome: 'ok' | 'error' | 'unknown' }>;
    };
  }>;
}

export interface HarnessUnitDescription {
  unitId: string;
  hookId: string;
  objectives: Array<{ objectiveId: string; clauseId?: string }>;
  allowedActions: {
    enable: boolean;
    disable: boolean;
    modify: boolean;
    add: boolean;
  };
  current: { enabled: boolean; version: number; contentRef: string };
  versionChain: Array<{ version: number; contentRef: string; current: boolean }>;
}
