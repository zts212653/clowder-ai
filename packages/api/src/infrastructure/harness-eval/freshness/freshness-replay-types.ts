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

export interface FreshnessReplayAggregateSnapshot {
  window: { fromInclusive: number; toExclusive: number };
  closureCount: number;
  committedCount: number;
  blockedCount: number;
  disposedCount: number;
  unresolvedCount: number;
  supersededAttemptCount: number;
  redundantCommittedAttemptCount: number;
  attemptBudgetExhaustedCount: number;
  commitRecheckExhaustedCount: number;
  startupRecoveryBlockedCount: number;
  preflightIncompleteCount: number;
  lineageIdentityGapCount: number;
  custodyGapCount: number;
  verdict: 'no_data' | 'healthy' | 'needs_attention';
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
  source: 'fixture' | 'live_closure';
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

export interface FreshnessReplayBundle {
  selector: FreshnessReplaySelector;
  samples: FreshnessReplaySample[];
  aggregateSnapshot: FreshnessReplayAggregateSnapshot;
  report: FreshnessReplayReport;
  providerNativeCoverage: import('./provider-native-freshness-coverage.js').ProviderNativeFreshnessCoverageReport;
}
