import type {
  ProactiveMemoryAbstentionReasonCode,
  ProactiveMemoryOpportunityEpisode,
  ProactiveMemoryOpportunityRef,
} from '@cat-cafe/shared';
import type { ToolEvent } from '../cats/services/tool-usage/event-log-types.js';

export const PROACTIVE_MEMORY_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProactiveMemoryColdStartConfig {
  readonly revision: 'f282-phase-d-v1';
  readonly status: 'incubating';
  readonly sampleContract: {
    readonly minEligibleEpisodes: number;
    readonly minAdjudicatedProposals: number;
    readonly minDistinctWorkspaceWeekBuckets: number;
  };
  readonly constraints: {
    readonly awarenessCoverageFloor: number;
    readonly proposalReadyCoverageFloor: number;
    readonly irrelevantProposalRateCeiling: number;
    readonly pollutionProposalCountCeiling: number;
    readonly approvalCardsP95PerWorkspaceWeekCeiling: number;
  };
}

export const DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG: ProactiveMemoryColdStartConfig = Object.freeze({
  revision: 'f282-phase-d-v1',
  status: 'incubating',
  sampleContract: Object.freeze({
    minEligibleEpisodes: 20,
    minAdjudicatedProposals: 20,
    minDistinctWorkspaceWeekBuckets: 4,
  }),
  constraints: Object.freeze({
    awarenessCoverageFloor: 0.8,
    proposalReadyCoverageFloor: 0.5,
    irrelevantProposalRateCeiling: 0.25,
    pollutionProposalCountCeiling: 0,
    approvalCardsP95PerWorkspaceWeekCeiling: 3,
  }),
});

export type ProactiveMemoryExpectedDisposition = 'proposal_ready' | 'abstention_expected';
export type ProactiveMemoryProposalAdjudication = 'relevant' | 'irrelevant' | 'pollution';

export interface ProactiveMemoryOpportunityExposure {
  readonly opportunityRef: ProactiveMemoryOpportunityRef;
  readonly workspaceWeekBucket: string;
  readonly expectedDisposition: ProactiveMemoryExpectedDisposition;
  readonly proposalAdjudication?: ProactiveMemoryProposalAdjudication;
}

export type ProactiveMemoryOpportunityFailureCode =
  | 'uninformed_silence'
  | 'contradictory_disposition'
  | 'missing_proposal_adjudication';

export interface ProactiveMemoryOpportunityFailure {
  readonly opportunityRef: ProactiveMemoryOpportunityRef;
  readonly code: ProactiveMemoryOpportunityFailureCode;
}

export interface ProactiveMemoryColdStartVector {
  readonly coverage: {
    readonly eligibleEpisodes: number;
    readonly informedEpisodes: number;
    readonly proposalReadyEpisodes: number;
    readonly proposedReadyEpisodes: number;
    readonly uninformedSilenceEpisodes: number;
  };
  readonly falsePositiveBudget: {
    readonly adjudicatedProposals: number;
    readonly irrelevantProposals: number;
    readonly pollutionProposals: number;
  };
  readonly approvalBurden: {
    readonly distinctWorkspaceWeekBuckets: number;
    readonly cardsPerWorkspaceWeek: readonly number[];
    readonly p95CardsPerWorkspaceWeek: number;
  };
}

export interface ProactiveMemoryColdStartMeasurements {
  readonly awarenessCoverage: number;
  readonly proposalReadyCoverage: number;
  readonly irrelevantProposalRate: number;
}

export interface ProactiveMemoryColdStartResult {
  readonly revision: ProactiveMemoryColdStartConfig['revision'];
  readonly status: 'incubating' | 'eligible_to_exit' | 'constraint_violation';
  readonly vector: ProactiveMemoryColdStartVector;
  readonly measurements: ProactiveMemoryColdStartMeasurements;
  readonly violatedConstraints: readonly string[];
  readonly episodes: readonly ProactiveMemoryOpportunityEpisode[];
  readonly failures: readonly ProactiveMemoryOpportunityFailure[];
}

export interface ProactiveMemoryColdStartEvaluationInput {
  readonly exposures: readonly ProactiveMemoryOpportunityExposure[];
  readonly toolEvents: readonly ToolEvent[];
  readonly now: number;
  readonly config?: ProactiveMemoryColdStartConfig;
}

export interface ProactiveMemoryAbstentionEvidence {
  readonly reasonCode: ProactiveMemoryAbstentionReasonCode;
}
