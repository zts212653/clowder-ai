import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F282 Phase A/B replay', () => {
  test('emits a deterministic raw constraint vector without a synthetic total score', async () => {
    const { runF282ProactiveMemoryReplay } = await import('../../dist/scripts/f282-proactive-memory-replay.js');

    const first = await runF282ProactiveMemoryReplay();
    const second = await runF282ProactiveMemoryReplay();

    assert.deepEqual(second, first, 'frozen fixture replay must be deterministic');
    assert.equal(JSON.stringify(second), JSON.stringify(first), 'frozen output must be byte-identical');
    assert.equal(first.fixtureRevision, 'f282-phase-a-b-v2');
    assert.equal(first.status, 'incubating');
    assert.equal(Object.hasOwn(first, 'totalScore'), false);
    assert.deepEqual(first.vector.relevantCoverage, {
      detector: {
        eligibleOpportunities: 5,
        surfacedEligibleOpportunities: 4,
      },
      singleImportantCatJudgment: {
        opportunities: 3,
        informedOpportunities: 2,
      },
    });
    assert.deepEqual(first.vector.irrelevantSlots, {
      surfacedSlots: 4,
      irrelevantSlots: 0,
    });
    assert.deepEqual(first.vector.attentionBurden, {
      activeWorkspaceWeeks: 7,
      surfacedSlotsByWeek: [1, 0, 0, 0, 0, 0, 3],
    });
    assert.deepEqual(first.hardConstraintFailures, []);
    assert.deepEqual(first.evidenceContract, {
      attachmentResolved: true,
      confirmedTranscriptResolved: true,
      inferenceRejectedBeforeStage: true,
      quotedEventFactRejected: true,
      hardFailures: [],
    });
    assert.deepEqual(
      first.episodes.map((episode) => episode.id),
      [
        'alden-positive',
        'single-thread-detector-silent',
        'observed-lexical-noise',
        'chronic-background-noise',
        'private-source-excluded',
        'registry-and-dormant-suppressed',
        'cap-overflow-preserved',
      ],
    );
    assert.deepEqual(first.episodes[2].surfacedSubjects, []);
    assert.deepEqual(first.episodes[3].surfacedSubjects, []);
    assert.deepEqual(first.episodes[5].surfacedSubjects, []);
    assert.deepEqual(first.episodes[6].surfacedSubjects, ['alden', 'boreal', 'cora']);
  });
});
