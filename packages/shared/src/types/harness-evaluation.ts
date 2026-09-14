import type { CycleCoverageAssessment, CycleMetricEvaluation } from './cycle-evaluation.js';
import type { TraceEpisodeRef } from './injection-trace.js';
import type { SegmentVerdict } from './segment-lifecycle.js';

export type MetricKind = 'counter' | 'rate' | 'semantic' | 'replay';
export type TraceAnnotationSource = 'mcp-marker' | 'structured-rule' | 'semantic-sweep';
export type TraceAnnotationPolarity = 'counterexample' | 'positive' | 'candidate' | 'irrelevant' | 'unscorable';

export interface EvaluationUnitRef {
  unitType: 'segment';
  unitId: string;
  clauseId?: string;
}

export interface PendingTraceMarker {
  markerId: string;
  invocationId: string;
  ownerUserId: string;
  subjectCatId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: EvaluationUnitRef[];
  polarity: Exclude<TraceAnnotationPolarity, 'irrelevant' | 'unscorable'> | 'candidate';
  note?: string;
  createdAt: number;
}

export interface TraceAnnotation {
  annotationId: string;
  episodeRef: TraceEpisodeRef;
  source: TraceAnnotationSource;
  ruleId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: EvaluationUnitRef[];
  polarity: TraceAnnotationPolarity;
  confidence: number;
  incidentKey: string;
  evidenceRefs: string[];
  rationale?: string;
  createdAt: number;
  /**
   * F257 P1-3: per-objective monotonic ingest sequence assigned by the annotation
   * store. Combined with createdAt it forms a stable composite cursor that can
   * distinguish annotations sharing the same millisecond timestamp.
   */
  sequence?: number;
}

export type MetricTrigger =
  | { kind: 'distinct-counterexamples'; threshold: number; lookbackMs?: number }
  | { kind: 'minimum-sample'; minimum: number; windowMs: number }
  | { kind: 'cadence'; cadence: 'daily' | 'weekly' | `every-${number}d` };

/**
 * Versioned eval-decision rule. `trigger` decides WHEN to evaluate; this rule
 * independently decides WHAT a measured result means. Keeping the two
 * contracts separate prevents a collection threshold from becoming a verdict
 * threshold by accident.
 */
export type MetricVerdictRule =
  | { kind: 'counter-zero' }
  | { kind: 'rate-maximum'; maximum: number }
  | { kind: 'rate-minimum'; minimum: number }
  | { kind: 'semantic-label-maximum'; label: string; maximum: number }
  | { kind: 'replay-zero-failure' }
  | { kind: 'evidence-only' };

export interface MetricDefinition {
  id: string;
  label: string;
  kind: MetricKind;
  evaluator: { kind: 'code' | 'llm' | 'replay'; ruleRef: string };
  trigger: MetricTrigger;
  verdictRule: MetricVerdictRule;
}

export type MetricVerdictDecisionStatus = 'breach' | 'clean' | 'inconclusive' | 'insufficient_evidence' | 'unavailable';

export interface MetricComparisonMeasurement {
  /** Count metrics stay counts; only naturally normalized metrics use rate-badness. */
  kind: 'count' | 'rate-badness';
  /** Lower is better within the SAME metric, rule and evaluator version. */
  value: number;
  howCounted: string;
}

export interface MetricVerdictDecision {
  metricId: string;
  rule: MetricVerdictRule;
  status: MetricVerdictDecisionStatus;
  reason: string;
  /** Stable before/after coordinate; never invents a denominator for counters. */
  measurement: MetricComparisonMeasurement | null;
  /** Exact segment refs carried by this metric's counterexample samples. */
  attributedSegmentIds: string[];
}

export interface ObjectiveVerdictDecision {
  /** Schema of this roll-up record; separate from the evaluation model version. */
  schemaVersion: 2;
  evaluationModelVersion: string;
  metricDecisions: MetricVerdictDecision[];
  /** Deterministic primary metric surfaced to the governance decision drafter. */
  primaryMetricId: string | null;
  /** Lower-is-better coordinate for primaryMetricId. */
  measurement: MetricComparisonMeasurement | null;
  /** Only these evidence-attributed segments may enter governance. */
  targetSegmentIds: string[];
}

export type CycleEvaluationStatus = 'idle' | 'requested' | 'retriggered' | 'written' | 'stalled';
export type CycleTriggerRoute = 'cumulative' | 'counterexamples' | 'cadence';
export type ObjectiveLifecycle = 'active' | 'dormant' | 'retired';
export interface CycleTriggerPolicy {
  cumulativeThreshold: number;
  counterexampleThreshold: number;
  cadenceDays: number;
  minimumIntervalMs: number;
  consecutiveKeepCycles: number;
  consecutiveCadenceKeepCycles: number;
}
export interface CycleTriggerPolicyChange {
  decision: 'keep' | 'rollback' | 'evolve';
  before: CycleTriggerPolicy;
  after: CycleTriggerPolicy;
  appliedAt: number;
}
export interface CycleWindow {
  start: number;
  end: number;
  /**
   * Present only when this window is supplementary evidence inherited from a
   * different content coordinate. The native window for the selected cycle is
   * always the unannotated [cycleStart, cycleEnd) window.
   */
  provenance?: {
    kind: 'manual-version-switch';
    sourceCycleId: string;
    sourceVersion: string;
    sourceVersionContentRef: string;
    sourceSegmentId: string;
    sourceSegmentVersion: number;
  };
}

/** F257 TC-3/4/10/14: one compact, owner/objective-scoped evaluation cycle. */
export interface CycleRecord {
  schemaVersion: 1;
  cycleId: string;
  ownerUserId: string;
  objectiveId: string;
  version: string;
  versionContentRef: string;
  cycleStart: number;
  cycleEnd?: number;
  evalStatus: CycleEvaluationStatus;
  /** Policy used to decide this cycle. Missing only on pre-TC-3 historical rows. */
  triggerPolicy?: CycleTriggerPolicy;
  triggerPolicyChange?: CycleTriggerPolicyChange;
  objectiveLifecycle?: Exclude<ObjectiveLifecycle, 'retired'>;
  /** Unconsumed supplementary evidence retained across an operator version switch. */
  carryoverWindows?: CycleWindow[];
  windows: CycleWindow[];
  triggeredBy?: CycleTriggerRoute[];
  assignmentThreadId?: string;
  assignmentMessageId?: string;
  assignedAt?: number;
  retriggerMessageId?: string;
  retriggeredAt?: number;
  stalledAlertMessageId?: string;
  stalledAt?: number;
  governanceAssignmentMessageId?: string;
  governanceAssignedAt?: number;
  governanceReminderMessageId?: string;
  governanceRemindedAt?: number;
  evaluation?: {
    metrics: CycleMetricEvaluation[];
    overall: 'complete' | 'partial' | 'insufficient_evidence';
    writtenAt: number;
    by: string;
    counterexampleRootCauses?: { eventCount: number; rootCauseCount: number; howGrouped: string };
    coverageAssessment?: CycleCoverageAssessment;
  };
  governance?: { decision: 'keep' | 'rollback' | 'evolve'; reason: string; writtenAt: number; by: string };
  approval?: {
    cardId?: string;
    state: 'pending' | 'approved' | 'skipped' | 'rejected';
    reason?: string;
    by?: string;
    rejectCount: number;
    at: number;
  };
  rejectReasons?: string[];
  /** Explicit terminal reason for a tracing cycle closed by an operator version switch. */
  termination?: {
    kind: 'manual-version-switch';
    segmentId: string;
    fromVersion: number;
    toVersion: number;
    /** Historical content version used as the new version's parent, when distinct from the active source. */
    baseVersion?: number;
    at: number;
    by: string;
    reason: string;
  };
  closedAt?: number;
}

/**
 * F257: EvaluationSnapshot is a Unit-scoped frozen view.
 *
 * The Evaluation Unit is an Objective + its EvaluationModel + the segment unitRefs
 * attached to it. All metrics defined by the model are evaluated against the same
 * snapshot/window; the watermark belongs to the Unit run, not to any single metric.
 */
export interface EvaluationSnapshot {
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  evaluationModelId: string;
  evaluationModelVersion: string;
  unitRefs: EvaluationUnitRef[];
  metricDefinitions: MetricDefinition[];
  window: { start: number; end: number };
  /**
   * F257 P1-2/P1-3: composite lower-bound cursor (timestamp + sequence) used to
   * resume the same immutable Unit run and to order same-ms annotations.
   */
  windowStartScore: number;
  /**
   * F257 P1-3: composite cursor of the newest consumed annotation in this run.
   * The Unit-run watermark is advanced to this score so late arrivals with the
   * same timestamp but a later sequence remain visible to the next run.
   */
  maxAnnotationScore: number;
  /** Stable references only; trace bodies stay in the append-only owner pool. */
  episodeRefs: TraceEpisodeRef[];
  annotationIds: string[];
  samples: Array<{
    annotationId: string;
    episodeRef: TraceEpisodeRef;
    objectiveId: string;
    metricId: string;
    unitRefs: EvaluationUnitRef[];
    incidentKey: string;
    polarity: TraceAnnotationPolarity;
    confidence: number;
    source: TraceAnnotationSource;
    rationale?: string;
    createdAt: number;
    sequence?: number;
  }>;
  createdAt: number;
}

export type MetricResultValue =
  | { kind: 'counter'; count: number; threshold: number }
  | { kind: 'rate'; numerator: number; denominator: number; rate: number }
  | {
      kind: 'semantic';
      labels: Record<string, number>;
      explanation: string;
      /** System-recorded evidence actually returned through progressive retrieval. */
      retrieval: {
        frozenCorpusSize: number;
        inspectedInvocationIds: string[];
        priorityAnchorIds: string[];
        exhausted: boolean;
      };
    }
  | { kind: 'replay'; passed: number; failed: number };

export interface MetricResult {
  resultId: string;
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  metricId: string;
  kind: MetricKind;
  value: MetricResultValue;
  evaluatedAt: number;
}

export interface ObjectiveJudgment {
  /** Current durable judgment schema. Legacy rows are normalized on read. */
  schemaVersion: 2;
  judgmentId: string;
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  evaluationModelId: string;
  evaluationModelVersion: string;
  unitRefs: EvaluationUnitRef[];
  window: { start: number; end: number };
  metricResults: MetricResult[];
  metricOutcomes: Array<{
    metricId: string;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }>;
  annotationIds: string[];
  completion: 'complete' | 'partial' | 'insufficient_evidence';
  /**
   * F257 conclusion ring: the objective-level verdict rolled up from the metric
   * outcomes at commit time. `alive`/`dormant` are conclusive and advance the
   * lifeline state machine to governance; the inconclusive verdicts
   * (`needs-denominator`/`observability-debt`/`unmeasurable`/`retire-candidate`)
   * return the cycle to tracing to accumulate more evidence. Prior to this the
   * Objective judgment carried only per-metric outcomes and never rolled up a
   * conclusion, so `deriveActiveStage` never saw a verdict and the loop stalled
   * at tracing forever (governance unreachable).
   */
  verdict: SegmentVerdict;
  verdictDecision: ObjectiveVerdictDecision;
  evaluatedAt: number;
}

export interface SegmentMetricEvaluationView {
  metricId: string;
  label: string;
  kind: MetricKind;
  evaluatorKind: 'code' | 'llm' | 'replay';
  evaluatorRuleRef: string;
  verdictRule: MetricVerdictRule;
  latestConclusion: CycleMetricEvaluation['conclusion'] | null;
  evidenceRefs: string[];
}

export interface SegmentTracingEvaluationView {
  trigger: {
    objective: {
      objectiveId: string;
      lifecycle: ObjectiveLifecycle;
      health: 'healthy' | 'zero-trace-fault';
      policyChangeCount: number;
      evalStatus: CycleEvaluationStatus;
      cycleStartMs: number;
      cycleEndMs: number | null;
      /** Historical settlement coordinate retained for response compatibility; not used by the collection gate. */
      lastClosedAtMs: number | null;
      minimumIntervalMs: number;
      triggeredBy: CycleTriggerRoute[];
      cumulative: { count: number; threshold: number };
      counterexamples: { count: number; threshold: number };
      cadence: { elapsedMs: number; thresholdMs: number; eligible: boolean };
    };
    /** Segment activity measured over the exact same Objective cycle window. */
    segment: {
      segmentId: string;
      observationCount: number;
      injectionCount: number;
      disabledCount: number;
    };
  };
  /** Fired segment rows from this exact Objective cycle, newest first. */
  injections: Array<{
    threadId: string;
    turnId: string;
    timestamp: number;
    catId: string;
    pipelineStatus: 'fired';
    version: number | null;
    charCount: number;
  }>;
  injectionsCapped: boolean;
  structuredCounterexamples: Array<{
    annotationId: string;
    incidentKey: string;
    objectiveId: string;
    metricId: string;
    source: TraceAnnotationSource;
    createdAt: number;
    rationale?: string;
    threadId: string;
    turnId: string;
    catId: string;
    /** Segments this counterexample is attributed to; may exclude the segment being viewed. */
    segmentIds: string[];
  }>;
}

export interface SegmentCycleSummary {
  cycleId: string;
  /** Chronological Objective-cycle number (1-based), when known. */
  ordinal?: number;
  /** Segment content version frozen into this Objective cycle; null when legacy provenance cannot resolve it. */
  segmentVersion: number | null;
  version: string;
  versionContentRef: string;
  cycleStart: number;
  cycleEnd: number | null;
  evalStatus: CycleEvaluationStatus;
  windows: CycleWindow[];
  triggeredBy: CycleTriggerRoute[];
  evaluation: {
    overall: 'complete' | 'partial' | 'insufficient_evidence';
    writtenAt: number;
    by: string;
  } | null;
  governance: CycleRecord['governance'] | null;
  governanceImpact: {
    changedUnitIds: string[];
    selectedSegmentChanged: boolean;
    changes: Array<{
      action: 'enable' | 'disable' | 'modify' | 'rollback' | 'add';
      unitId: string;
      sourceVersion: number | null;
      targetVersion: number | null;
    }>;
  } | null;
  approval: CycleRecord['approval'] | null;
  rejectReasons: string[];
  termination: CycleRecord['termination'] | null;
  closedAt: number | null;
}

export interface SegmentObjectiveEvaluationView {
  objectiveId: string;
  objectiveLabel: string;
  objectiveStatement: string;
  evaluationModelId: string;
  evaluationModelLabel: string;
  ruleVersion: string;
  unitRefs: EvaluationUnitRef[];
  metrics: SegmentMetricEvaluationView[];
  /** Cycle whose tracing/eval/governance detail is projected in this response. */
  selectedCycle: SegmentCycleSummary | null;
  /** Live cycle coordinate, kept separate from the operator's selected history. */
  currentCycle: SegmentCycleSummary | null;
  latestEvaluation: {
    cycleId: string;
    overall: 'complete' | 'partial' | 'insufficient_evidence';
    writtenAt: number;
    by: string;
    windows: CycleWindow[];
    coverageAssessment?: CycleCoverageAssessment;
  } | null;
  latestGovernance: {
    cycleId: string;
    decision: NonNullable<CycleRecord['governance']>['decision'];
    reason: string;
    writtenAt: number;
    by: string;
    approval: CycleRecord['approval'] | null;
    impact: SegmentCycleSummary['governanceImpact'];
  } | null;
  versionChain: SegmentCycleSummary[];
  /** True when older cycles exist beyond the projected chain and are not shown. */
  versionChainCapped: boolean;
}

export interface SegmentEvaluationResponse {
  segmentId: string;
  window: { start: number; end: number };
  tracing: SegmentTracingEvaluationView;
  objectives: SegmentObjectiveEvaluationView[];
}
