import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStandingReflexFirstCaseContract,
  STANDING_REFLEX_FIRST_CASE_FROZEN_AT,
} from '../../dist/scripts/standing-reflex-first-case-contract.js';

// Historical trace projection remains in Host; the retired Meeting intake replay is not a runtime producer.
test('historical reflex projection preserves source exclusion, defer lineage and unmeasured utility', () => {
  const traces = [
    {
      id: 'excluded',
      source: { kind: 'owner_explicit_event', threadId: 'fixture', sourceMessageId: 'message-1' },
      status: 'excluded_non_asr_source',
      steps: [],
      generations: [],
      observedAt: STANDING_REFLEX_FIRST_CASE_FROZEN_AT - 10,
    },
    {
      id: 'deferred',
      source: { kind: 'asr', threadId: 'fixture', sourceMessageId: 'message-2' },
      status: 'contract_replay_passed',
      steps: ['generation_1_deferred', 'generation_2_proposed'],
      generations: [1, 2],
      observedAt: STANDING_REFLEX_FIRST_CASE_FROZEN_AT - 10,
    },
    {
      id: 'proposed',
      source: { kind: 'asr', threadId: 'fixture', sourceMessageId: 'message-3' },
      status: 'contract_replay_passed',
      steps: ['generation_1_proposed'],
      generations: [1],
      observedAt: STANDING_REFLEX_FIRST_CASE_FROZEN_AT - 10,
    },
  ];
  const result = buildStandingReflexFirstCaseContract(traces);
  assert.deepEqual(buildStandingReflexFirstCaseContract(traces), result);
  assert.equal(result.replay.contractRevision, 'StandingReflex.EpisodeReplay.v1');
  assert.equal(result.replay.runtimeEpisode, false);
  assert.equal(result.replay.ownerTruthMutation, false);
  assert.equal(result.replay.utilityVerdict, 'not_measured');
  assert.equal(result.replay.sourcePolicy, 'opaque_refs_only');
  assert.equal(result.replay.episodes.length, 4);
  for (const episode of result.replay.episodes) {
    assert.equal(episode.beats.adjudication.status, 'none');
    assert.equal(episode.beats.consumption.status, 'none');
  }
  const deferred = result.replay.episodes.filter((e) => e.episodeId.startsWith('deferred:'));
  assert.deepEqual(
    deferred.map((e) => e.generation),
    [1, 2],
  );
  assert.deepEqual(deferred[0].source, deferred[1].source);
  const counts = result.shadowHealth.byCategory;
  assert.equal(counts.eligible.total, 4);
  assert.equal(counts.delivered.total, 3);
  assert.equal(counts.omitted.total, 1);
  assert.equal(counts.disposition.total, 3);
  assert.equal(counts.defer_reentry.total, 1);
  assert.equal(counts.terminal.total, 3);
  assert.equal(result.shadowHealth.utilityVerdict, 'not_measured');
  assert.equal('totalScore' in result.shadowHealth, false);
  assert.deepEqual(result.replayComparison, { comparable: true, identical: true, mismatches: [] });
});
