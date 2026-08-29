import { createHash } from 'node:crypto';
import {
  compareStandingReflexReplays,
  projectStandingReflexShadowHealth,
  type StandingReflexEpisodeV1,
  type StandingReflexReplayComparison,
  type StandingReflexReplayContractV1,
  type StandingReflexShadowEventV1,
  type StandingReflexShadowHealthProjection,
  standingReflexReplayContractV1Schema,
} from '@cat-cafe/shared';

export const STANDING_REFLEX_FIRST_CASE_FROZEN_AT = Date.parse('2026-08-07T00:00:00Z');

export interface StandingReflexHistoricalTrace {
  readonly id: string;
  readonly source: {
    readonly kind: string;
    readonly threadId: string;
    readonly sourceMessageId: string;
  };
  readonly status: 'excluded_non_asr_source' | 'contract_replay_passed';
  readonly steps: readonly string[];
  readonly generations: readonly number[];
  readonly observedAt: number;
}

export interface StandingReflexFirstCaseContractProjection {
  readonly replay: StandingReflexReplayContractV1;
  readonly shadowHealth: StandingReflexShadowHealthProjection;
  readonly replayComparison: StandingReflexReplayComparison;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sourceFor(trace: StandingReflexHistoricalTrace) {
  const ref = `thread-message://${trace.source.threadId}/${trace.source.sourceMessageId}`;
  return { kind: trace.source.kind, ref, revision: sha256(ref) };
}

function noBeat<TBeat extends 'proposal' | 'adjudication' | 'consumption'>(beat: TBeat, reasonCode: string) {
  return { beat, status: 'none' as const, reasonCode, evidenceRefs: [] };
}

function episodeFor(
  trace: StandingReflexHistoricalTrace,
  generation: number,
  proposalOutcome: 'deferred' | 'proposed' | 'source_ineligible',
): StandingReflexEpisodeV1 {
  const id = `${trace.id}:generation:${generation}`;
  const proposal =
    proposalOutcome === 'source_ineligible'
      ? noBeat('proposal', 'source_ineligible')
      : {
          beat: 'proposal' as const,
          status: 'observed' as const,
          outcome: proposalOutcome,
          evidenceRefs: [`fixture:${id}:disposition`],
        };
  return {
    v: 1,
    episodeId: id,
    laneId: 'person_memory',
    reflexId: 'asr-person-memory',
    reflexVersion: 1,
    generation,
    source: sourceFor(trace),
    observedAt: trace.observedAt + (generation - 1) * 3,
    beats: {
      perception: {
        beat: 'perception',
        status: 'observed',
        outcome: proposalOutcome === 'source_ineligible' ? 'ineligible_non_asr_source' : 'eligible',
        evidenceRefs: [`fixture:${id}:eligibility`],
      },
      proposal,
      adjudication: noBeat('adjudication', 'outside_historical_fixture'),
      consumption: noBeat('consumption', 'outside_historical_fixture'),
    },
  };
}

function episodesFor(trace: StandingReflexHistoricalTrace): StandingReflexEpisodeV1[] {
  if (trace.status === 'excluded_non_asr_source') return [episodeFor(trace, 1, 'source_ineligible')];
  return trace.generations.map((generation) => {
    const deferred = trace.steps.includes(`generation_${generation}_deferred`);
    return episodeFor(trace, generation, deferred ? 'deferred' : 'proposed');
  });
}

function baseEvent(episode: StandingReflexEpisodeV1, suffix: string) {
  return {
    v: 1 as const,
    episodeId: episode.episodeId,
    laneId: episode.laneId,
    occurredAt: episode.observedAt,
    evidenceRef: `fixture:${episode.episodeId}:${suffix}`,
  };
}

function shadowEventsFor(episode: StandingReflexEpisodeV1): StandingReflexShadowEventV1[] {
  const base = baseEvent(episode, 'shadow');
  const proposal = episode.beats.proposal;
  if (proposal.status !== 'observed') {
    return [
      { ...base, category: 'eligible', outcome: 'ineligible' },
      { ...base, category: 'omitted', outcome: 'source_ineligible' },
    ];
  }
  const disposition = proposal.outcome === 'deferred' ? 'defer' : 'propose';
  const terminal = proposal.outcome === 'deferred' ? 'deferred' : 'proposed';
  return [
    { ...base, category: 'eligible', outcome: 'eligible' },
    ...(episode.generation > 1 ? ([{ ...base, category: 'defer_reentry', outcome: 'reentered' }] as const) : []),
    { ...base, category: 'delivered', outcome: 'delivered' },
    { ...base, category: 'disposition', outcome: disposition },
    { ...base, category: 'terminal', outcome: terminal },
  ];
}

export function buildStandingReflexFirstCaseContract(
  traces: readonly StandingReflexHistoricalTrace[],
): StandingReflexFirstCaseContractProjection {
  const episodes = traces.flatMap(episodesFor);
  const replay = standingReflexReplayContractV1Schema.parse({
    v: 1,
    contractRevision: 'StandingReflex.EpisodeReplay.v1',
    fixtureRevision: 'standing-reflex-first-case-v1',
    replayKind: 'historical',
    frozenAt: STANDING_REFLEX_FIRST_CASE_FROZEN_AT,
    sourcePolicy: 'opaque_refs_only',
    runtimeEpisode: false,
    ownerTruthMutation: false,
    utilityVerdict: 'not_measured',
    episodes,
  });
  const replayed = standingReflexReplayContractV1Schema.parse(JSON.parse(JSON.stringify(replay)));
  return {
    replay,
    shadowHealth: projectStandingReflexShadowHealth(episodes.flatMap(shadowEventsFor)),
    replayComparison: compareStandingReflexReplays(replay, replayed),
  };
}
