export type FreshnessReplayScenario =
  | 'original_double_message_dogfood'
  | 'existing_coverage_without_closure'
  | 'crash_cancel'
  | 'continuous_new_messages'
  | 'multi_target'
  | 'parallel_same_batch'
  | 'attempt_recheck_budget'
  | 'connector_blocked';

export interface FreshnessReplaySelector {
  kind: 'freshness-closure-replay';
  windowStartMs: number;
  windowEndMs: number;
  threadIds?: string[];
}

export interface FreshnessReplayFacts {
  responsibilityCount: number;
  custodyCount: number;
  formalFinalCount: number;
  formalFinalLimit: number;
  knownStaleFinalCount: number;
  targetCount: number;
  accountedTargetCount: number;
  sameBatchSiblingWakeCount: number;
  automaticAttemptCount: number;
  automaticAttemptLimit: number | null;
  commitRecheckCount: number;
  commitRecheckLimit: number | null;
  terminalEvidenceComplete: boolean;
}

export type FreshnessReplayAttentionReason = 'blocked_responsibility' | 'unresolved_responsibility';

export interface FreshnessReplaySample {
  id: string;
  scenario: FreshnessReplayScenario;
  source: 'fixture' | 'live_window';
  occurredAt: number;
  threadId: string;
  catIds: string[];
  closureId?: string;
  traceRef: string;
  evidenceRefs: string[];
  facts: FreshnessReplayFacts;
  attentionReasons: FreshnessReplayAttentionReason[];
}

export type FreshnessReplayViolation =
  | 'responsibility_without_custody'
  | 'formal_final_limit_exceeded'
  | 'known_stale_final_visible'
  | 'target_outcome_missing'
  | 'same_batch_sibling_triggered'
  | 'automatic_attempt_budget_exceeded'
  | 'commit_recheck_budget_exceeded'
  | 'terminal_evidence_missing';

export interface FreshnessReplaySampleEvaluation {
  sampleId: string;
  scenario: FreshnessReplayScenario;
  traceRef: string;
  passed: boolean;
  violations: FreshnessReplayViolation[];
  attentionReasons: FreshnessReplayAttentionReason[];
}

export interface FreshnessReplayReport {
  window: { startMs: number; endMs: number };
  eligibleSampleCount: number;
  passedSampleCount: number;
  failedSampleCount: number;
  attentionSampleCount: number;
  fixtureSampleCount: number;
  liveSampleCount: number;
  scenarioCounts: Record<FreshnessReplayScenario, number>;
  evaluations: FreshnessReplaySampleEvaluation[];
  verdict: 'no_data' | 'healthy' | 'needs_attention';
  healthy: boolean;
  noDataReason?: string;
}

export type FreshnessReplaySourceStatus =
  | { status: 'complete' }
  | {
      status: 'incomplete';
      reason: string;
      completeFromMs?: number;
      observedThroughMs?: number;
    }
  | { status: 'unavailable'; reason: string; observedThroughMs?: number };

export interface FreshnessQueueLifecycle {
  entryId: string;
  targetCatId: string;
  threadIds: string[];
  messageIds: string[];
  createdAt: number;
  lastUpdatedAt: number;
  firstSeenAt?: number;
  handledAt?: number;
  withdrawnAt?: number;
  failedAt?: number;
  terminalState: boolean;
  legacyUntimed: boolean;
}

export interface FreshnessQueueLifecycleReport {
  entryTargetCount: number;
  admittedCount: number;
  seenCount: number;
  handledCount: number;
  withdrawnCount: number;
  failedCount: number;
  seenUnhandledAtWindowEndCount: number;
  pendingAtWindowEndCount: number;
  legacyUntimedCount: number;
  lifecycles: FreshnessQueueLifecycle[];
}

export interface FreshnessAttentionSignalReport {
  eventCount: number;
  counts: Partial<
    Record<
      import('../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js').FreshnessAttentionEvent['kind'],
      number
    >
  >;
}

export interface FreshnessWindowedSignals {
  window: { startMs: number; endMs: number };
  queue: FreshnessQueueLifecycleReport;
  attention: FreshnessAttentionSignalReport;
  observedActivityCount: number;
}

export interface FreshnessReplayMeasurementMaturity {
  status: 'ready' | 'blocked';
  sources: {
    queue_custody: FreshnessReplaySourceStatus;
    attention_events: FreshnessReplaySourceStatus;
  };
  reasons: string[];
}

export interface FreshnessReplayBundle {
  selector: FreshnessReplaySelector;
  samples: FreshnessReplaySample[];
  report: FreshnessReplayReport;
  providerNativeCoverage: import('./provider-native-freshness-coverage.js').ProviderNativeFreshnessCoverageReport;
  windowedSignals: FreshnessWindowedSignals;
  measurementMaturity: FreshnessReplayMeasurementMaturity;
}
