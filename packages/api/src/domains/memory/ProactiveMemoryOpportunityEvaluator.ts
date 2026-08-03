import {
  type ProactiveMemoryAbstentionReasonCode,
  type ProactiveMemoryOpportunityEpisode,
  type ProactiveMemoryOpportunityRef,
  proactiveMemoryAbstentionReasonCodeSchema,
} from '@cat-cafe/shared';
import type { ToolEvent } from '../cats/services/tool-usage/event-log-types.js';
import {
  DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG,
  PROACTIVE_MEMORY_MAX_EVENT_AGE_MS,
  type ProactiveMemoryColdStartConfig,
  type ProactiveMemoryColdStartEvaluationInput,
  type ProactiveMemoryColdStartMeasurements,
  type ProactiveMemoryColdStartResult,
  type ProactiveMemoryColdStartVector,
  type ProactiveMemoryOpportunityExposure,
  type ProactiveMemoryOpportunityFailure,
} from './proactive-memory-cold-start-contract.js';
import { deriveProactiveMemoryOpportunityRef } from './proactive-memory-opportunity-ref.js';

const PROPOSAL_TOOL_NAME = 'propose_person_memory';
const ABSTENTION_TOOL_NAME = 'record_proactive_memory_abstention';

interface ProjectedToolEvidence {
  readonly proposalSucceeded: boolean;
  readonly abstentionReasons: ReadonlySet<ProactiveMemoryAbstentionReasonCode>;
}

function toolSummary(event: ToolEvent): Readonly<Record<string, unknown>> {
  return event.summary as unknown as Readonly<Record<string, unknown>>;
}

function isRecognizedSuccess(event: ToolEvent, outcome: string): boolean {
  const summary = toolSummary(event);
  return summary._resultMerged === true && summary.isError !== true && summary.proactiveMemoryOutcome === outcome;
}

function groupEligibleEvents(
  events: readonly ToolEvent[],
  exposureRefs: ReadonlySet<ProactiveMemoryOpportunityRef>,
  now: number,
): Map<ProactiveMemoryOpportunityRef, ToolEvent[]> {
  const grouped = new Map<ProactiveMemoryOpportunityRef, ToolEvent[]>();
  for (const event of events) {
    if (event.timestamp > now || now - event.timestamp > PROACTIVE_MEMORY_MAX_EVENT_AGE_MS) continue;
    let opportunityRef: ProactiveMemoryOpportunityRef;
    try {
      opportunityRef = deriveProactiveMemoryOpportunityRef(event.invocationId);
    } catch {
      continue;
    }
    if (!exposureRefs.has(opportunityRef)) continue;
    const existing = grouped.get(opportunityRef) ?? [];
    existing.push(event);
    grouped.set(opportunityRef, existing);
  }
  return grouped;
}

function projectToolEvidence(events: readonly ToolEvent[]): ProjectedToolEvidence {
  let proposalSucceeded = false;
  const abstentionReasons = new Set<ProactiveMemoryAbstentionReasonCode>();
  for (const event of events) {
    if (event.toolName === PROPOSAL_TOOL_NAME && isRecognizedSuccess(event, 'proposal_submitted')) {
      proposalSucceeded = true;
      continue;
    }
    if (event.toolName !== ABSTENTION_TOOL_NAME || !isRecognizedSuccess(event, 'abstention_recorded')) continue;
    const reason = proactiveMemoryAbstentionReasonCodeSchema.safeParse(toolSummary(event).reasonCode);
    if (reason.success) abstentionReasons.add(reason.data);
  }
  return { proposalSucceeded, abstentionReasons };
}

function projectEpisode(
  exposure: ProactiveMemoryOpportunityExposure,
  evidence: ProjectedToolEvidence,
): { episode?: ProactiveMemoryOpportunityEpisode; failure?: ProactiveMemoryOpportunityFailure } {
  if (evidence.proposalSucceeded && evidence.abstentionReasons.size > 0) {
    return {
      failure: { opportunityRef: exposure.opportunityRef, code: 'contradictory_disposition' },
    };
  }
  if (evidence.abstentionReasons.size > 1) {
    return {
      failure: { opportunityRef: exposure.opportunityRef, code: 'contradictory_disposition' },
    };
  }
  if (evidence.proposalSucceeded) {
    return {
      episode: {
        opportunityRef: exposure.opportunityRef,
        disposition: 'propose',
        reasonCode: 'proposal_submitted',
      },
    };
  }
  const reasonCode = [...evidence.abstentionReasons][0];
  if (reasonCode) {
    return {
      episode: {
        opportunityRef: exposure.opportunityRef,
        disposition: 'abstain',
        reasonCode,
      },
    };
  }
  return {
    failure: { opportunityRef: exposure.opportunityRef, code: 'uninformed_silence' },
  };
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function assertUniqueExposureRefs(
  exposures: readonly ProactiveMemoryOpportunityExposure[],
): Set<ProactiveMemoryOpportunityRef> {
  const exposureRefs = new Set<ProactiveMemoryOpportunityRef>();
  for (const exposure of exposures) {
    if (exposureRefs.has(exposure.opportunityRef)) {
      throw new Error(`Duplicate proactive-memory exposure: ${exposure.opportunityRef}`);
    }
    exposureRefs.add(exposure.opportunityRef);
  }
  return exposureRefs;
}

function projectCohort(
  exposures: readonly ProactiveMemoryOpportunityExposure[],
  groupedEvents: ReadonlyMap<ProactiveMemoryOpportunityRef, readonly ToolEvent[]>,
): {
  episodes: ProactiveMemoryOpportunityEpisode[];
  failures: ProactiveMemoryOpportunityFailure[];
  successfulProposalRefs: Set<ProactiveMemoryOpportunityRef>;
} {
  const episodes: ProactiveMemoryOpportunityEpisode[] = [];
  const failures: ProactiveMemoryOpportunityFailure[] = [];
  const successfulProposalRefs = new Set<ProactiveMemoryOpportunityRef>();

  for (const exposure of exposures) {
    const evidence = projectToolEvidence(groupedEvents.get(exposure.opportunityRef) ?? []);
    if (evidence.proposalSucceeded) successfulProposalRefs.add(exposure.opportunityRef);
    const projected = projectEpisode(exposure, evidence);
    if (projected.episode) episodes.push(projected.episode);
    if (projected.failure) failures.push(projected.failure);
  }
  for (const exposure of exposures) {
    if (successfulProposalRefs.has(exposure.opportunityRef) && exposure.proposalAdjudication === undefined) {
      failures.push({ opportunityRef: exposure.opportunityRef, code: 'missing_proposal_adjudication' });
    }
  }
  return { episodes, failures, successfulProposalRefs };
}

function buildVector(
  exposures: readonly ProactiveMemoryOpportunityExposure[],
  episodes: readonly ProactiveMemoryOpportunityEpisode[],
  failures: readonly ProactiveMemoryOpportunityFailure[],
  successfulProposalRefs: ReadonlySet<ProactiveMemoryOpportunityRef>,
): ProactiveMemoryColdStartVector {
  const proposalReadyEpisodes = exposures.filter(
    (exposure) => exposure.expectedDisposition === 'proposal_ready',
  ).length;
  const proposedReadyEpisodes = episodes.filter((episode) => {
    if (episode.disposition !== 'propose') return false;
    return exposures.some(
      (exposure) =>
        exposure.opportunityRef === episode.opportunityRef && exposure.expectedDisposition === 'proposal_ready',
    );
  }).length;
  const proposalExposures = exposures.filter((exposure) => successfulProposalRefs.has(exposure.opportunityRef));
  const adjudicatedProposalExposures = proposalExposures.filter(
    (exposure) => exposure.proposalAdjudication !== undefined,
  );
  const workspaceBuckets = [...new Set(exposures.map((exposure) => exposure.workspaceWeekBucket))].sort();
  const cardsPerWorkspaceWeek = workspaceBuckets.map(
    (bucket) => proposalExposures.filter((exposure) => exposure.workspaceWeekBucket === bucket).length,
  );
  return {
    coverage: {
      eligibleEpisodes: exposures.length,
      informedEpisodes: episodes.length,
      proposalReadyEpisodes,
      proposedReadyEpisodes,
      uninformedSilenceEpisodes: failures.filter((failure) => failure.code === 'uninformed_silence').length,
    },
    falsePositiveBudget: {
      adjudicatedProposals: adjudicatedProposalExposures.length,
      irrelevantProposals: adjudicatedProposalExposures.filter(
        (exposure) => exposure.proposalAdjudication === 'irrelevant',
      ).length,
      pollutionProposals: adjudicatedProposalExposures.filter(
        (exposure) => exposure.proposalAdjudication === 'pollution',
      ).length,
    },
    approvalBurden: {
      distinctWorkspaceWeekBuckets: workspaceBuckets.length,
      cardsPerWorkspaceWeek,
      p95CardsPerWorkspaceWeek: percentile95(cardsPerWorkspaceWeek),
    },
  };
}

function measureVector(vector: ProactiveMemoryColdStartVector): ProactiveMemoryColdStartMeasurements {
  return {
    awarenessCoverage: safeRate(vector.coverage.informedEpisodes, vector.coverage.eligibleEpisodes),
    proposalReadyCoverage: safeRate(vector.coverage.proposedReadyEpisodes, vector.coverage.proposalReadyEpisodes),
    irrelevantProposalRate: safeRate(
      vector.falsePositiveBudget.irrelevantProposals,
      vector.falsePositiveBudget.adjudicatedProposals,
    ),
  };
}

function findViolatedConstraints(
  vector: ProactiveMemoryColdStartVector,
  measurements: ProactiveMemoryColdStartMeasurements,
  config: ProactiveMemoryColdStartConfig,
): string[] {
  const violatedConstraints: string[] = [];
  if (measurements.awarenessCoverage < config.constraints.awarenessCoverageFloor) {
    violatedConstraints.push('awarenessCoverageFloor');
  }
  if (measurements.proposalReadyCoverage < config.constraints.proposalReadyCoverageFloor) {
    violatedConstraints.push('proposalReadyCoverageFloor');
  }
  if (measurements.irrelevantProposalRate > config.constraints.irrelevantProposalRateCeiling) {
    violatedConstraints.push('irrelevantProposalRateCeiling');
  }
  if (vector.falsePositiveBudget.pollutionProposals > config.constraints.pollutionProposalCountCeiling) {
    violatedConstraints.push('pollutionProposalCountCeiling');
  }
  if (vector.approvalBurden.p95CardsPerWorkspaceWeek > config.constraints.approvalCardsP95PerWorkspaceWeekCeiling) {
    violatedConstraints.push('approvalCardsP95PerWorkspaceWeekCeiling');
  }
  return violatedConstraints;
}

function sampleContractIsMet(vector: ProactiveMemoryColdStartVector, config: ProactiveMemoryColdStartConfig): boolean {
  return (
    vector.coverage.eligibleEpisodes >= config.sampleContract.minEligibleEpisodes &&
    vector.falsePositiveBudget.adjudicatedProposals >= config.sampleContract.minAdjudicatedProposals &&
    vector.approvalBurden.distinctWorkspaceWeekBuckets >= config.sampleContract.minDistinctWorkspaceWeekBuckets
  );
}

export function evaluateProactiveMemoryColdStart(
  input: ProactiveMemoryColdStartEvaluationInput,
): ProactiveMemoryColdStartResult {
  const config = input.config ?? DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG;
  const exposureRefs = assertUniqueExposureRefs(input.exposures);
  const groupedEvents = groupEligibleEvents(input.toolEvents, exposureRefs, input.now);
  const { episodes, failures, successfulProposalRefs } = projectCohort(input.exposures, groupedEvents);
  const vector = buildVector(input.exposures, episodes, failures, successfulProposalRefs);
  const measurements = measureVector(vector);
  const violatedConstraints = findViolatedConstraints(vector, measurements, config);
  const sampleMet = sampleContractIsMet(vector, config);
  const status = !sampleMet
    ? 'incubating'
    : violatedConstraints.length > 0
      ? 'constraint_violation'
      : 'eligible_to_exit';

  return {
    revision: config.revision,
    status,
    vector,
    measurements,
    violatedConstraints,
    episodes,
    failures,
  };
}
