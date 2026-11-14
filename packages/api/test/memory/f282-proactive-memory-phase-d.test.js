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

// 2026-11-13: cats submit person proposals, defers and abstentions only through cat_cafe_remember.
describe('F282 evaluator reads remember items', () => {
  test('a remember result yields per-item outcomes; rejected rows are not counted', async () => {
    const { deriveResultSummary } = await import(
      '../../dist/domains/cats/services/tool-usage/derive-result-summary.js'
    );
    const text = JSON.stringify({
      groupId: 'remember_x',
      messageId: 'card-1',
      results: [
        {
          itemId: 'p',
          target: 'person',
          statusCode: 200,
          result: { candidateId: 'cand-1', messageId: 'msg-1', status: 'pending_approval', deduped: false },
        },
        {
          itemId: 'd',
          target: 'person_defer',
          statusCode: 200,
          result: { receiptId: 'r-1', status: 'active', deduped: false },
        },
        { itemId: 'a', target: 'person_abstain', statusCode: 200, result: { status: 'recorded' } },
        { itemId: 'x', target: 'person', statusCode: 422, result: { error: 'source_not_eligible' } },
        { itemId: 't', target: 'taste', statusCode: 200, result: { proposalId: 'taste-1', status: 'pending' } },
      ],
    });
    assert.deepEqual(deriveResultSummary('remember', text), {
      proactiveMemoryOutcomes: [
        { itemId: 'p', outcome: 'proposal_submitted' },
        { itemId: 'd', outcome: 'deferred_receipt_recorded' },
        { itemId: 'a', outcome: 'abstention_recorded' },
      ],
    });
    assert.deepEqual(deriveResultSummary('remember', JSON.stringify({ status: 'stale_ignored' })), {});
  });

  test('remember proposals and abstentions count as informed, with the abstention reason from the item payload', async () => {
    const { deriveProactiveMemoryOpportunityRef } = await import(
      '../../dist/domains/memory/proactive-memory-opportunity-ref.js'
    );
    const { evaluateProactiveMemoryColdStart } = await import(
      '../../dist/domains/memory/ProactiveMemoryOpportunityEvaluator.js'
    );
    const rememberEvent = (invocationId, items, proactiveMemoryOutcomes) => ({
      invocationId,
      sessionId: invocationId,
      threadId: 'thread-f282-phase-d',
      catId: 'codex-sol',
      toolName: 'remember',
      timestamp: NOW,
      turnIndex: 0,
      status: 'success',
      summary: { clientRequestId: invocationId, items, proactiveMemoryOutcomes, _resultMerged: true },
    });
    const exposure = (invocationId, expectedDisposition) => ({
      opportunityRef: deriveProactiveMemoryOpportunityRef(invocationId),
      workspaceWeekBucket: `workspace-${invocationId}:2026-W31`,
      expectedDisposition,
      ...(expectedDisposition === 'proposal_ready' ? { proposalAdjudication: 'relevant' } : {}),
    });
    const result = evaluateProactiveMemoryColdStart({
      exposures: [
        exposure('remember-propose', 'proposal_ready'),
        exposure('remember-abstain', 'abstention_expected'),
        exposure('remember-rejected', 'proposal_ready'),
      ],
      toolEvents: [
        rememberEvent(
          'remember-propose',
          [{ itemId: 'p', target: 'person', payload: {} }],
          [{ itemId: 'p', outcome: 'proposal_submitted' }],
        ),
        rememberEvent(
          'remember-abstain',
          [{ itemId: 'a', target: 'person_abstain', payload: { reasonCode: 'bad_timing' } }],
          [{ itemId: 'a', outcome: 'abstention_recorded' }],
        ),
        rememberEvent('remember-rejected', [{ itemId: 'x', target: 'person', payload: {} }], []),
      ],
      now: NOW,
    });
    const byRef = new Map(result.episodes.map((episode) => [episode.opportunityRef, episode]));
    assert.equal(byRef.get(deriveProactiveMemoryOpportunityRef('remember-propose'))?.disposition, 'propose');
    const abstained = byRef.get(deriveProactiveMemoryOpportunityRef('remember-abstain'));
    assert.equal(abstained?.disposition, 'abstain');
    assert.equal(abstained?.reasonCode, 'bad_timing');
    assert.ok(
      result.failures.some(
        (failure) =>
          failure.opportunityRef === deriveProactiveMemoryOpportunityRef('remember-rejected') &&
          failure.code === 'uninformed_silence',
      ),
    );
  });
});

test('a failed remember callback stays a tool error', async () => {
  const { deriveResultSummary } = await import('../../dist/domains/cats/services/tool-usage/derive-result-summary.js');
  assert.equal(deriveResultSummary('remember', 'Callback failed (401): unauthorized').isError, true);
});
