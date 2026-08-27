import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Standing Reflex first-case historical replay', () => {
  it('replays only confirmed ASR sources and preserves one lineage across defer re-entry', async () => {
    const { runStandingReflexFirstCaseReplay } = await import(
      '../../dist/scripts/standing-reflex-first-case-replay.js'
    );

    const result = runStandingReflexFirstCaseReplay();

    assert.equal(result.fixtureRevision, 'standing-reflex-first-case-v1');
    assert.equal(result.contractRevision, 'StandingReflex.EpisodeReplay.v1');
    assert.equal(result.replayKind, 'historical');
    assert.equal(result.frozenAt, Date.parse('2026-08-07T00:00:00Z'));
    assert.equal(result.status, 'contract_passed');
    assert.equal(result.runtimeEpisode, false);
    assert.equal(result.ownerTruthMutation, false);
    assert.equal(result.utilityVerdict, 'not_measured');
    assert.equal(result.sourcePolicy, 'opaque_refs_only');
    assert.deepEqual(result.hardFailures, []);
    assert.equal(result.episodes.length, 4);
    for (const episode of result.episodes) {
      assert.deepEqual(Object.keys(episode.beats), ['perception', 'proposal', 'adjudication', 'consumption']);
      assert.equal(episode.beats.adjudication.status, 'none');
      assert.equal(episode.beats.consumption.status, 'none');
    }
    assert.deepEqual(Object.keys(result.shadowHealth.byCategory), [
      'eligible',
      'delivered',
      'omitted',
      'disposition',
      'defer_reentry',
      'terminal',
      'invalidation',
      'error',
      'burden',
    ]);
    assert.equal(result.shadowHealth.byCategory.eligible.total, 4);
    assert.equal(result.shadowHealth.byCategory.delivered.total, 3);
    assert.equal(result.shadowHealth.byCategory.omitted.total, 1);
    assert.equal(result.shadowHealth.byCategory.disposition.total, 3);
    assert.equal(result.shadowHealth.byCategory.defer_reentry.total, 1);
    assert.equal(result.shadowHealth.byCategory.terminal.total, 3);
    assert.equal(result.shadowHealth.utilityVerdict, 'not_measured');
    assert.equal('totalScore' in result.shadowHealth, false);
    assert.deepEqual(result.replayComparison, { comparable: true, identical: true, mismatches: [] });
    assert.deepEqual(runStandingReflexFirstCaseReplay(), result);

    const explicitEvent = result.cases.find((item) => item.id === 'owner-explicit-phone-event');
    assert.equal(explicitEvent.status, 'excluded_non_asr_source');
    assert.equal(explicitEvent.source.kind, 'owner_explicit_event');
    assert.equal(explicitEvent.steps.includes('asr_scene_built'), false);

    const deferred = result.cases.find((item) => item.id === 'asr-product-grounding');
    assert.equal(deferred.status, 'contract_replay_passed');
    assert.deepEqual(deferred.generations, [1, 2]);
    assert.equal(deferred.lineagePreserved, true);
    assert.deepEqual(deferred.steps, [
      'asr_scene_built',
      'generation_1_delivered',
      'generation_1_deferred',
      'eligible_context_reentry',
      'generation_2_delivered',
      'generation_2_proposed',
    ]);

    const proposed = result.cases.find((item) => item.id === 'asr-hiring-method');
    assert.equal(proposed.status, 'contract_replay_passed');
    assert.deepEqual(proposed.generations, [1]);
    assert.equal(proposed.steps.at(-1), 'generation_1_proposed');

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /落地认知|华为背景候选人|一个多小时/);
    assert.doesNotMatch(serialized, /speaker_1|known_person/);
    assert.doesNotMatch(serialized, /source_speaker|source_subject|speakerMap|privateReasoning/);
    assert.match(serialized, /0001785861514468-000004-319d33c1/);
    assert.match(serialized, /0001786030137105-000032-3d07b980/);
  });
});
