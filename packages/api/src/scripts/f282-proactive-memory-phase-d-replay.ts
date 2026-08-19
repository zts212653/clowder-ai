import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProactiveMemoryOpportunityEpisode, ProactiveMemoryOpportunityRef } from '@cat-cafe/shared';
import type { ToolEvent } from '../domains/cats/services/tool-usage/event-log-types.js';
import { evaluateProactiveMemoryColdStart } from '../domains/memory/ProactiveMemoryOpportunityEvaluator.js';
import {
  DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG,
  PROACTIVE_MEMORY_MAX_EVENT_AGE_MS,
  type ProactiveMemoryColdStartMeasurements,
  type ProactiveMemoryColdStartVector,
  type ProactiveMemoryOpportunityExposure,
  type ProactiveMemoryOpportunityFailure,
} from '../domains/memory/proactive-memory-cold-start-contract.js';
import { deriveProactiveMemoryOpportunityRef } from '../domains/memory/proactive-memory-opportunity-ref.js';

const FIXTURE_NOW = Date.parse('2026-07-30T22:30:00.000Z');

interface PhaseDFixture {
  readonly id: string;
  readonly invocationId: string;
  readonly workspaceWeekBucket: string;
  readonly expectedDisposition: ProactiveMemoryOpportunityExposure['expectedDisposition'];
  readonly proposalAdjudication?: ProactiveMemoryOpportunityExposure['proposalAdjudication'];
  readonly events: readonly ToolEvent[];
}

export interface F282ProactiveMemoryPhaseDReplayResult {
  readonly fixtureRevision: 'f282-phase-d-v1';
  readonly status: 'incubating' | 'eligible_to_exit' | 'constraint_violation';
  readonly evaluatedAt: '2026-07-30T22:30:00.000Z';
  readonly prerequisiteEvidence: {
    readonly revision: 'f282-phase-d-prerequisites-v1';
    readonly receiptPath: 'docs/evidence/F282/phase-d/prerequisites.json';
  };
  readonly retentionContract: {
    readonly source: 'ToolEventLog';
    readonly maxEventAgeMs: number;
    readonly durableOpportunityStore: false;
  };
  readonly sampleContract: typeof DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG.sampleContract;
  readonly constraints: typeof DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG.constraints;
  readonly fixtures: readonly {
    readonly id: string;
    readonly opportunityRef: ProactiveMemoryOpportunityRef;
    readonly expectedDisposition: ProactiveMemoryOpportunityExposure['expectedDisposition'];
  }[];
  readonly vector: ProactiveMemoryColdStartVector;
  readonly measurements: ProactiveMemoryColdStartMeasurements;
  readonly violatedConstraints: readonly string[];
  readonly episodes: readonly ProactiveMemoryOpportunityEpisode[];
  readonly failures: readonly ProactiveMemoryOpportunityFailure[];
}

function toolEvent(invocationId: string, toolName: string, summary: Readonly<Record<string, unknown>>): ToolEvent {
  return {
    invocationId,
    sessionId: invocationId,
    threadId: 'thread-f282-phase-d-synthetic',
    catId: 'codex-sol',
    toolName,
    timestamp: FIXTURE_NOW,
    turnIndex: 0,
    status: summary.isError === true ? 'error' : 'success',
    summary: { ...summary },
  };
}

function phaseDFixtures(): readonly PhaseDFixture[] {
  return [
    {
      id: 'single-important-propose',
      invocationId: 'f282-phase-d-propose',
      workspaceWeekBucket: 'synthetic-workspace-a:2026-W31',
      expectedDisposition: 'proposal_ready',
      proposalAdjudication: 'relevant',
      events: [
        toolEvent('f282-phase-d-propose', 'propose_person_memory', {
          _resultMerged: true,
          proactiveMemoryOutcome: 'proposal_submitted',
        }),
      ],
    },
    {
      id: 'single-important-calibrated-abstention',
      invocationId: 'f282-phase-d-abstain',
      workspaceWeekBucket: 'synthetic-workspace-b:2026-W31',
      expectedDisposition: 'abstention_expected',
      events: [
        toolEvent('f282-phase-d-abstain', 'record_proactive_memory_abstention', {
          _resultMerged: true,
          proactiveMemoryOutcome: 'abstention_recorded',
          reasonCode: 'insufficient_owner_evidence',
        }),
      ],
    },
    {
      id: 'single-important-uninformed-silence',
      invocationId: 'f282-phase-d-silence',
      workspaceWeekBucket: 'synthetic-workspace-c:2026-W31',
      expectedDisposition: 'proposal_ready',
      events: [],
    },
    {
      id: 'failed-proposal-then-calibrated-abstention',
      invocationId: 'f282-phase-d-failed-then-abstain',
      workspaceWeekBucket: 'synthetic-workspace-a:2026-W31',
      expectedDisposition: 'abstention_expected',
      events: [
        toolEvent('f282-phase-d-failed-then-abstain', 'propose_person_memory', {
          _resultMerged: true,
          isError: true,
        }),
        toolEvent('f282-phase-d-failed-then-abstain', 'record_proactive_memory_abstention', {
          _resultMerged: true,
          proactiveMemoryOutcome: 'abstention_recorded',
          reasonCode: 'authorization_boundary',
        }),
      ],
    },
  ];
}

export function summarizeF282SingleImportantCoverage(): {
  readonly opportunities: number;
  readonly informedOpportunities: number;
} {
  const fixtures = phaseDFixtures().filter((fixture) => fixture.id.startsWith('single-important-'));
  const informedOpportunities = fixtures.filter((fixture) =>
    fixture.events.some((event) => {
      const outcome = 'proactiveMemoryOutcome' in event.summary ? event.summary.proactiveMemoryOutcome : undefined;
      return outcome === 'proposal_submitted' || outcome === 'abstention_recorded';
    }),
  ).length;
  return { opportunities: fixtures.length, informedOpportunities };
}

export function runF282ProactiveMemoryPhaseDReplay(): F282ProactiveMemoryPhaseDReplayResult {
  const fixtures = phaseDFixtures();
  const exposures = fixtures.map(
    (fixture): ProactiveMemoryOpportunityExposure => ({
      opportunityRef: deriveProactiveMemoryOpportunityRef(fixture.invocationId),
      workspaceWeekBucket: fixture.workspaceWeekBucket,
      expectedDisposition: fixture.expectedDisposition,
      ...(fixture.proposalAdjudication ? { proposalAdjudication: fixture.proposalAdjudication } : {}),
    }),
  );
  const result = evaluateProactiveMemoryColdStart({
    exposures,
    toolEvents: fixtures.flatMap((fixture) => fixture.events),
    now: FIXTURE_NOW,
  });

  return {
    fixtureRevision: 'f282-phase-d-v1',
    status: result.status,
    evaluatedAt: '2026-07-30T22:30:00.000Z',
    prerequisiteEvidence: {
      revision: 'f282-phase-d-prerequisites-v1',
      receiptPath: 'docs/evidence/F282/phase-d/prerequisites.json',
    },
    retentionContract: {
      source: 'ToolEventLog',
      maxEventAgeMs: PROACTIVE_MEMORY_MAX_EVENT_AGE_MS,
      durableOpportunityStore: false,
    },
    sampleContract: DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG.sampleContract,
    constraints: DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG.constraints,
    fixtures: fixtures.map((fixture) => ({
      id: fixture.id,
      opportunityRef: deriveProactiveMemoryOpportunityRef(fixture.invocationId),
      expectedDisposition: fixture.expectedDisposition,
    })),
    vector: result.vector,
    measurements: result.measurements,
    violatedConstraints: result.violatedConstraints,
    episodes: result.episodes,
    failures: result.failures,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  console.log(JSON.stringify(runF282ProactiveMemoryPhaseDReplay(), null, 2));
}
