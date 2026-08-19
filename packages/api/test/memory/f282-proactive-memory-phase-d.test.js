import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const NOW = Date.parse('2026-07-30T22:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function toolEvent({ invocationId, toolName, timestamp = NOW, outcome, reasonCode, error = false }) {
  return {
    invocationId,
    sessionId: invocationId,
    threadId: 'thread-f282-phase-d',
    catId: 'codex-sol',
    toolName,
    timestamp,
    turnIndex: 0,
    status: 'success',
    summary: {
      ...(reasonCode ? { reasonCode } : {}),
      ...(outcome ? { proactiveMemoryOutcome: outcome, _resultMerged: true } : {}),
      ...(error ? { isError: true, _resultMerged: true } : {}),
    },
  };
}

describe('F282 Phase D opportunity evaluator', () => {
  test('derives a stable opaque ref from invocation identity and rejects unknown identity', async () => {
    const { deriveProactiveMemoryOpportunityRef } = await import(
      '../../dist/domains/memory/proactive-memory-opportunity-ref.js'
    );

    const first = deriveProactiveMemoryOpportunityRef('invocation-private-1');
    const second = deriveProactiveMemoryOpportunityRef('invocation-private-1');
    assert.equal(first, second);
    assert.match(first, /^opp_[a-f0-9]{32}$/);
    assert.equal(first.includes('invocation-private-1'), false);
    assert.throws(() => deriveProactiveMemoryOpportunityRef('unknown'));
    assert.throws(() => deriveProactiveMemoryOpportunityRef(''));
  });

  test('projects propose, calibrated abstention, failed-then-abstain, silence and contradictions without minting exposures', async () => {
    const { deriveProactiveMemoryOpportunityRef } = await import(
      '../../dist/domains/memory/proactive-memory-opportunity-ref.js'
    );
    const { evaluateProactiveMemoryColdStart } = await import(
      '../../dist/domains/memory/ProactiveMemoryOpportunityEvaluator.js'
    );

    const exposure = (invocationId, expectedDisposition, proposalAdjudication) => ({
      opportunityRef: deriveProactiveMemoryOpportunityRef(invocationId),
      workspaceWeekBucket: `workspace-${invocationId}:2026-W31`,
      expectedDisposition,
      ...(proposalAdjudication ? { proposalAdjudication } : {}),
    });
    const exposures = [
      exposure('inv-propose', 'proposal_ready', 'relevant'),
      exposure('inv-abstain', 'abstention_expected'),
      exposure('inv-defer', 'proposal_ready'),
      exposure('inv-silence', 'proposal_ready'),
      exposure('inv-failed-then-abstain', 'abstention_expected'),
      exposure('inv-contradiction', 'proposal_ready', 'irrelevant'),
      exposure('inv-duplicate', 'abstention_expected'),
      exposure('inv-too-old', 'abstention_expected'),
    ];
    const events = [
      toolEvent({
        invocationId: 'inv-propose',
        toolName: 'propose_person_memory',
        outcome: 'proposal_submitted',
      }),
      toolEvent({
        invocationId: 'inv-abstain',
        toolName: 'record_proactive_memory_abstention',
        outcome: 'abstention_recorded',
        reasonCode: 'insufficient_owner_evidence',
      }),
      toolEvent({
        invocationId: 'inv-defer',
        toolName: 'defer_person_memory_delta',
        outcome: 'deferred_receipt_recorded',
      }),
      toolEvent({
        invocationId: 'inv-failed-then-abstain',
        toolName: 'propose_person_memory',
        error: true,
      }),
      toolEvent({
        invocationId: 'inv-failed-then-abstain',
        toolName: 'record_proactive_memory_abstention',
        outcome: 'abstention_recorded',
        reasonCode: 'authorization_boundary',
      }),
      toolEvent({
        invocationId: 'inv-contradiction',
        toolName: 'propose_person_memory',
        outcome: 'proposal_submitted',
      }),
      toolEvent({
        invocationId: 'inv-contradiction',
        toolName: 'record_proactive_memory_abstention',
        outcome: 'abstention_recorded',
        reasonCode: 'bad_timing',
      }),
      toolEvent({
        invocationId: 'inv-contradiction',
        toolName: 'defer_person_memory_delta',
        outcome: 'deferred_receipt_recorded',
      }),
      toolEvent({
        invocationId: 'inv-duplicate',
        toolName: 'record_proactive_memory_abstention',
        outcome: 'abstention_recorded',
        reasonCode: 'not_continuity_valued',
      }),
      toolEvent({
        invocationId: 'inv-duplicate',
        toolName: 'record_proactive_memory_abstention',
        outcome: 'abstention_recorded',
        reasonCode: 'not_continuity_valued',
      }),
      toolEvent({
        invocationId: 'inv-too-old',
        toolName: 'record_proactive_memory_abstention',
        timestamp: NOW - 8 * DAY,
        outcome: 'abstention_recorded',
        reasonCode: 'bad_timing',
      }),
      toolEvent({
        invocationId: 'inv-unmatched',
        toolName: 'propose_person_memory',
        outcome: 'proposal_submitted',
      }),
    ];

    const result = evaluateProactiveMemoryColdStart({ exposures, toolEvents: events, now: NOW });

    assert.equal(result.status, 'incubating');
    assert.equal(Object.hasOwn(result, 'totalScore'), false);
    assert.equal(Object.hasOwn(result, 'acceptanceRate'), false);
    assert.deepEqual(result.vector.coverage, {
      eligibleEpisodes: 8,
      informedEpisodes: 5,
      proposalReadyEpisodes: 4,
      proposedReadyEpisodes: 1,
      uninformedSilenceEpisodes: 2,
    });
    assert.deepEqual(
      result.episodes.map((episode) => [episode.opportunityRef, episode.disposition, episode.reasonCode]),
      [
        [deriveProactiveMemoryOpportunityRef('inv-propose'), 'propose', 'proposal_submitted'],
        [deriveProactiveMemoryOpportunityRef('inv-abstain'), 'abstain', 'insufficient_owner_evidence'],
        [deriveProactiveMemoryOpportunityRef('inv-defer'), 'defer', 'deferred_receipt_recorded'],
        [deriveProactiveMemoryOpportunityRef('inv-failed-then-abstain'), 'abstain', 'authorization_boundary'],
        [deriveProactiveMemoryOpportunityRef('inv-duplicate'), 'abstain', 'not_continuity_valued'],
      ],
    );
    assert.deepEqual(result.failures, [
      {
        opportunityRef: deriveProactiveMemoryOpportunityRef('inv-silence'),
        code: 'uninformed_silence',
      },
      {
        opportunityRef: deriveProactiveMemoryOpportunityRef('inv-contradiction'),
        code: 'contradictory_disposition',
      },
      {
        opportunityRef: deriveProactiveMemoryOpportunityRef('inv-too-old'),
        code: 'uninformed_silence',
      },
    ]);
    assert.equal(
      result.episodes.some(
        (episode) => episode.opportunityRef === deriveProactiveMemoryOpportunityRef('inv-unmatched'),
      ),
      false,
    );
  });

  test('does not let abstain-everything or zero coverage become eligible to exit', async () => {
    const { deriveProactiveMemoryOpportunityRef } = await import(
      '../../dist/domains/memory/proactive-memory-opportunity-ref.js'
    );
    const { evaluateProactiveMemoryColdStart } = await import(
      '../../dist/domains/memory/ProactiveMemoryOpportunityEvaluator.js'
    );

    const exposures = Array.from({ length: 20 }, (_, index) => ({
      opportunityRef: deriveProactiveMemoryOpportunityRef(`inv-ready-${index}`),
      workspaceWeekBucket: `workspace-${index % 4}:2026-W31`,
      expectedDisposition: 'proposal_ready',
    }));
    const abstainEvents = exposures.map((_, index) =>
      toolEvent({
        invocationId: `inv-ready-${index}`,
        toolName: 'record_proactive_memory_abstention',
        outcome: 'abstention_recorded',
        reasonCode: 'bad_timing',
      }),
    );
    const allAbstain = evaluateProactiveMemoryColdStart({
      exposures,
      toolEvents: abstainEvents,
      now: NOW,
    });
    const allSilent = evaluateProactiveMemoryColdStart({
      exposures,
      toolEvents: [],
      now: NOW,
    });

    assert.notEqual(allAbstain.status, 'eligible_to_exit');
    assert.ok(allAbstain.violatedConstraints.includes('proposalReadyCoverageFloor'));
    assert.notEqual(allSilent.status, 'eligible_to_exit');
    assert.ok(allSilent.violatedConstraints.includes('awarenessCoverageFloor'));
    assert.ok(allSilent.violatedConstraints.includes('proposalReadyCoverageFloor'));
  });

  test('pollution is a hard violation and the default frozen fixture remains incubating', async () => {
    const { DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG } = await import(
      '../../dist/domains/memory/proactive-memory-cold-start-contract.js'
    );
    const { deriveProactiveMemoryOpportunityRef } = await import(
      '../../dist/domains/memory/proactive-memory-opportunity-ref.js'
    );
    const { evaluateProactiveMemoryColdStart } = await import(
      '../../dist/domains/memory/ProactiveMemoryOpportunityEvaluator.js'
    );

    assert.equal(Object.isFrozen(DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG), true);
    assert.equal(DEFAULT_PROACTIVE_MEMORY_COLD_START_CONFIG.status, 'incubating');

    const exposures = Array.from({ length: 20 }, (_, index) => ({
      opportunityRef: deriveProactiveMemoryOpportunityRef(`inv-pollution-${index}`),
      workspaceWeekBucket: `workspace-${index % 4}:2026-W31`,
      expectedDisposition: 'proposal_ready',
      proposalAdjudication: index === 0 ? 'pollution' : 'relevant',
    }));
    const events = exposures.map((_, index) =>
      toolEvent({
        invocationId: `inv-pollution-${index}`,
        toolName: 'propose_person_memory',
        outcome: 'proposal_submitted',
      }),
    );
    const result = evaluateProactiveMemoryColdStart({ exposures, toolEvents: events, now: NOW });

    assert.equal(result.status, 'constraint_violation');
    assert.ok(result.violatedConstraints.includes('pollutionProposalCountCeiling'));
    assert.equal(result.vector.falsePositiveBudget.pollutionProposals, 1);
  });

  test('replays propose, abstain and uninformed silence deterministically without an aggregate score', async () => {
    const { runF282ProactiveMemoryPhaseDReplay } = await import(
      '../../dist/scripts/f282-proactive-memory-phase-d-replay.js'
    );

    const first = runF282ProactiveMemoryPhaseDReplay();
    const second = runF282ProactiveMemoryPhaseDReplay();

    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.fixtureRevision, 'f282-phase-d-v1');
    assert.equal(first.status, 'incubating');
    assert.deepEqual(first.prerequisiteEvidence, {
      revision: 'f282-phase-d-prerequisites-v1',
      receiptPath: 'docs/evidence/F282/phase-d/prerequisites.json',
    });
    assert.equal(Object.hasOwn(first, 'totalScore'), false);
    assert.equal(Object.hasOwn(first, 'acceptanceRate'), false);
    assert.ok(first.episodes.some((episode) => episode.disposition === 'propose'));
    assert.ok(first.episodes.some((episode) => episode.disposition === 'abstain'));

    const silenceFixture = first.fixtures.find((fixture) => fixture.id === 'single-important-uninformed-silence');
    assert.ok(silenceFixture);
    assert.ok(
      first.failures.some(
        (failure) => failure.opportunityRef === silenceFixture.opportunityRef && failure.code === 'uninformed_silence',
      ),
    );
  });

  test('projects existing single-important cat-judgment coverage without lowering detector thresholds', async () => {
    const { summarizeF282SingleImportantCoverage } = await import(
      '../../dist/scripts/f282-proactive-memory-phase-d-replay.js'
    );

    assert.deepEqual(summarizeF282SingleImportantCoverage(), {
      opportunities: 3,
      informedOpportunities: 2,
    });
  });
});
