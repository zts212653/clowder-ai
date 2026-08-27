import { describe, expect, it } from 'vitest';
import {
  compareStandingReflexReplays,
  projectStandingReflexShadowHealth,
  standingReflexReplayContractV1Schema,
  standingReflexShadowEventV1Schema,
} from '../types/standing-reflex-episode.js';

const source = {
  kind: 'thread_message',
  ref: 'thread-message://thread-1/message-1',
  revision: `sha256:${'a'.repeat(64)}`,
};

const episode = {
  v: 1 as const,
  episodeId: 'standing_episode_fixture_1',
  laneId: 'fixture-lane',
  reflexId: 'fixture-reflex',
  reflexVersion: 3,
  generation: 1,
  source,
  observedAt: 1_000,
  beats: {
    perception: {
      beat: 'perception' as const,
      status: 'observed' as const,
      outcome: 'eligible',
      evidenceRefs: ['fixture:eligible:1'],
    },
    proposal: {
      beat: 'proposal' as const,
      status: 'observed' as const,
      outcome: 'proposed',
      evidenceRefs: ['fixture:proposal:1'],
    },
    adjudication: {
      beat: 'adjudication' as const,
      status: 'none' as const,
      reasonCode: 'outside_historical_fixture',
      evidenceRefs: [],
    },
    consumption: {
      beat: 'consumption' as const,
      status: 'none' as const,
      reasonCode: 'outside_historical_fixture',
      evidenceRefs: [],
    },
  },
};

const replay = {
  v: 1 as const,
  contractRevision: 'StandingReflex.EpisodeReplay.v1' as const,
  fixtureRevision: 'fixture-lane-v1',
  replayKind: 'historical' as const,
  frozenAt: 2_000,
  sourcePolicy: 'opaque_refs_only' as const,
  runtimeEpisode: false as const,
  ownerTruthMutation: false as const,
  utilityVerdict: 'not_measured' as const,
  episodes: [episode],
};

describe('lane-neutral Standing Reflex replay contract', () => {
  it('requires all four beats while allowing explicit none/exempt/sunset states', () => {
    expect(standingReflexReplayContractV1Schema.parse(replay)).toEqual(replay);
    expect(
      standingReflexReplayContractV1Schema.safeParse({
        ...replay,
        episodes: [{ ...episode, beats: { ...episode.beats, adjudication: undefined } }],
      }).success,
    ).toBe(false);

    for (const status of ['none', 'exempt', 'sunset'] as const) {
      expect(
        standingReflexReplayContractV1Schema.safeParse({
          ...replay,
          episodes: [
            {
              ...episode,
              beats: {
                ...episode.beats,
                consumption: {
                  beat: 'consumption',
                  status,
                  reasonCode: `fixture_${status}`,
                  evidenceRefs: [],
                },
              },
            },
          ],
        }).success,
      ).toBe(true);
    }
  });

  it('makes source-only historical replay flags structural invariants', () => {
    for (const forbidden of [
      { runtimeEpisode: true },
      { ownerTruthMutation: true },
      { utilityVerdict: 'keep' },
      { transcript: 'private source body' },
    ]) {
      expect(standingReflexReplayContractV1Schema.safeParse({ ...replay, ...forbidden }).success).toBe(false);
    }
    expect(
      standingReflexReplayContractV1Schema.safeParse({
        ...replay,
        episodes: [{ ...episode, source: { ...source, speakerMap: { speaker_1: 'person' } } }],
      }).success,
    ).toBe(false);
    expect(
      standingReflexReplayContractV1Schema.safeParse({
        ...replay,
        episodes: [{ ...episode, personName: 'private person' }],
      }).success,
    ).toBe(false);
  });

  it('is replayable and compares frozen contract output without consulting mutable truth', () => {
    const first = standingReflexReplayContractV1Schema.parse(replay);
    const second = standingReflexReplayContractV1Schema.parse(structuredClone(replay));
    expect(compareStandingReflexReplays(first, second)).toEqual({ comparable: true, identical: true, mismatches: [] });

    const drifted = standingReflexReplayContractV1Schema.parse({ ...replay, frozenAt: 2_001 });
    expect(compareStandingReflexReplays(first, drifted)).toMatchObject({
      comparable: false,
      identical: false,
      mismatches: ['frozenAt'],
    });
  });
});

describe('content-free Standing Reflex shadow health', () => {
  const base = {
    v: 1 as const,
    episodeId: episode.episodeId,
    laneId: episode.laneId,
    occurredAt: 1_000,
    evidenceRef: 'fixture:shadow:1',
  };
  const events = [
    { ...base, category: 'eligible' as const, outcome: 'eligible' as const },
    { ...base, category: 'delivered' as const, outcome: 'delivered' as const },
    { ...base, category: 'omitted' as const, outcome: 'source_ineligible' as const },
    { ...base, category: 'disposition' as const, outcome: 'defer' as const },
    { ...base, category: 'defer_reentry' as const, outcome: 'reentered' as const },
    { ...base, category: 'terminal' as const, outcome: 'proposed' as const },
    { ...base, category: 'invalidation' as const, outcome: 'source_corrected' as const },
    { ...base, category: 'error' as const, outcome: 'contract_violation' as const },
    { ...base, category: 'burden' as const, outcome: 'approval_requested' as const, units: 1 },
  ];

  it('keeps every health family separate and never emits a utility total', () => {
    const projection = projectStandingReflexShadowHealth(events);
    expect(Object.keys(projection.byCategory)).toEqual([
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
    expect(projection.byCategory.disposition).toEqual({ total: 1, outcomes: { defer: 1 } });
    expect(projection.byCategory.burden).toEqual({ total: 1, units: 1, outcomes: { approval_requested: 1 } });
    expect(projection.utilityVerdict).toBe('not_measured');
    expect(projection).not.toHaveProperty('totalScore');
  });

  it('rejects content, identity maps, and private reasoning at the schema boundary', () => {
    for (const forbidden of [
      { transcript: 'private source body' },
      { personName: 'private person' },
      { speakerMap: { speaker_1: 'person' } },
      { privateReasoning: 'hidden chain' },
    ]) {
      expect(standingReflexShadowEventV1Schema.safeParse({ ...events[0], ...forbidden }).success).toBe(false);
    }
  });
});
