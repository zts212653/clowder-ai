import { z } from 'zod';

const bounded = (max: number) => z.string().trim().min(1).max(max);
const timestampSchema = z.number().int().nonnegative().finite();
const sha256RevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const evidenceRefsSchema = z.array(bounded(500)).min(1).max(16);

export const STANDING_REFLEX_BEATS = ['perception', 'proposal', 'adjudication', 'consumption'] as const;
export const STANDING_REFLEX_EXPLICIT_ABSENCES = ['none', 'exempt', 'sunset'] as const;
export const STANDING_REFLEX_SHADOW_CATEGORIES = [
  'eligible',
  'delivered',
  'omitted',
  'disposition',
  'defer_reentry',
  'terminal',
  'invalidation',
  'error',
  'burden',
] as const;

function beatSchema<TBeat extends (typeof STANDING_REFLEX_BEATS)[number]>(beat: TBeat) {
  return z.discriminatedUnion('status', [
    z
      .object({
        beat: z.literal(beat),
        status: z.literal('observed'),
        outcome: bounded(120),
        evidenceRefs: evidenceRefsSchema,
      })
      .strict(),
    z
      .object({
        beat: z.literal(beat),
        status: z.enum(STANDING_REFLEX_EXPLICIT_ABSENCES),
        reasonCode: bounded(120),
        evidenceRefs: z.array(z.never()).length(0),
      })
      .strict(),
  ]);
}

/**
 * Lane-neutral four-beat episode. It carries only opaque source/evidence coordinates;
 * producer-owned payload and canonical truth remain outside this contract.
 */
export const standingReflexEpisodeV1Schema = z
  .object({
    v: z.literal(1),
    episodeId: bounded(240),
    laneId: bounded(160),
    reflexId: bounded(160),
    reflexVersion: z.number().int().positive(),
    generation: z.number().int().positive(),
    source: z
      .object({
        kind: bounded(120),
        ref: bounded(1_000),
        revision: sha256RevisionSchema,
      })
      .strict(),
    observedAt: timestampSchema,
    beats: z
      .object({
        perception: beatSchema('perception'),
        proposal: beatSchema('proposal'),
        adjudication: beatSchema('adjudication'),
        consumption: beatSchema('consumption'),
      })
      .strict(),
  })
  .strict();

/** Historical/synthetic replay can prove deterministic contract behavior, never live utility. */
export const standingReflexReplayContractV1Schema = z
  .object({
    v: z.literal(1),
    contractRevision: z.literal('StandingReflex.EpisodeReplay.v1'),
    fixtureRevision: bounded(160),
    replayKind: z.enum(['historical', 'synthetic']),
    frozenAt: timestampSchema,
    sourcePolicy: z.literal('opaque_refs_only'),
    runtimeEpisode: z.literal(false),
    ownerTruthMutation: z.literal(false),
    utilityVerdict: z.literal('not_measured'),
    episodes: z.array(standingReflexEpisodeV1Schema).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const episodeIds = new Set<string>();
    value.episodes.forEach((episode, index) => {
      if (episode.observedAt > value.frozenAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes', index, 'observedAt'],
          message: 'episode observation is later than the frozen replay clock',
        });
      }
      if (episodeIds.has(episode.episodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes', index, 'episodeId'],
          message: 'episodeId must be unique within one replay',
        });
      }
      episodeIds.add(episode.episodeId);
    });
  });

const shadowBase = {
  v: z.literal(1),
  episodeId: bounded(240),
  laneId: bounded(160),
  occurredAt: timestampSchema,
  evidenceRef: bounded(500),
};

/** Strict content-free health events. Payload, identity maps, and judgments have no fields here. */
export const standingReflexShadowEventV1Schema = z.discriminatedUnion('category', [
  z.object({ ...shadowBase, category: z.literal('eligible'), outcome: z.enum(['eligible', 'ineligible']) }).strict(),
  z.object({ ...shadowBase, category: z.literal('delivered'), outcome: z.literal('delivered') }).strict(),
  z
    .object({
      ...shadowBase,
      category: z.literal('omitted'),
      outcome: z.enum(['source_ineligible', 'policy_ineligible', 'consumer_unavailable']),
    })
    .strict(),
  z
    .object({ ...shadowBase, category: z.literal('disposition'), outcome: z.enum(['propose', 'defer', 'abstain']) })
    .strict(),
  z
    .object({ ...shadowBase, category: z.literal('defer_reentry'), outcome: z.enum(['reentered', 'not_reentered']) })
    .strict(),
  z
    .object({
      ...shadowBase,
      category: z.literal('terminal'),
      outcome: z.enum(['proposed', 'deferred', 'abstained', 'expired']),
    })
    .strict(),
  z
    .object({
      ...shadowBase,
      category: z.literal('invalidation'),
      outcome: z.enum(['source_corrected', 'source_forgotten', 'scope_revoked', 'superseded']),
    })
    .strict(),
  z
    .object({ ...shadowBase, category: z.literal('error'), outcome: z.enum(['contract_violation', 'adapter_error']) })
    .strict(),
  z
    .object({
      ...shadowBase,
      category: z.literal('burden'),
      outcome: z.enum(['approval_requested', 'approval_decided', 'manual_correction']),
      units: z.number().int().positive(),
    })
    .strict(),
]);

export type StandingReflexReplayContractV1 = z.infer<typeof standingReflexReplayContractV1Schema>;
export type StandingReflexEpisodeV1 = z.infer<typeof standingReflexEpisodeV1Schema>;
export type StandingReflexShadowEventV1 = z.infer<typeof standingReflexShadowEventV1Schema>;
export type StandingReflexShadowCategory = (typeof STANDING_REFLEX_SHADOW_CATEGORIES)[number];

export interface StandingReflexReplayComparison {
  readonly comparable: boolean;
  readonly identical: boolean;
  readonly mismatches: readonly string[];
}

export function compareStandingReflexReplays(
  expected: StandingReflexReplayContractV1,
  actual: StandingReflexReplayContractV1,
): StandingReflexReplayComparison {
  const comparableFields = ['contractRevision', 'fixtureRevision', 'replayKind', 'frozenAt', 'sourcePolicy'] as const;
  const mismatches: string[] = comparableFields.filter((field) => expected[field] !== actual[field]);
  if (mismatches.length > 0) return { comparable: false, identical: false, mismatches };
  if (JSON.stringify(expected.episodes) !== JSON.stringify(actual.episodes)) mismatches.push('episodes');
  return { comparable: true, identical: mismatches.length === 0, mismatches };
}

interface ShadowCategoryProjection {
  readonly total: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly units?: number;
}

export interface StandingReflexShadowHealthProjection {
  readonly v: 1;
  readonly contractRevision: 'StandingReflex.ShadowHealth.v1';
  readonly utilityVerdict: 'not_measured';
  readonly byCategory: Readonly<Record<StandingReflexShadowCategory, ShadowCategoryProjection>>;
}

/** Health projection only: it deliberately has no score, ranking, or keep/tune/sunset verdict. */
export function projectStandingReflexShadowHealth(
  input: readonly StandingReflexShadowEventV1[],
): StandingReflexShadowHealthProjection {
  const events = input.map((event) => standingReflexShadowEventV1Schema.parse(event));
  const byCategory = Object.fromEntries(
    STANDING_REFLEX_SHADOW_CATEGORIES.map((category) => {
      const categoryEvents = events.filter((event) => event.category === category);
      const outcomes = Object.fromEntries(
        [...new Set(categoryEvents.map((event) => event.outcome))]
          .sort()
          .map((outcome) => [outcome, categoryEvents.filter((event) => event.outcome === outcome).length]),
      );
      const total = categoryEvents.length;
      if (category === 'burden') {
        const units = categoryEvents.reduce((sum, event) => sum + ('units' in event ? event.units : 0), 0);
        return [category, { total, units, outcomes }];
      }
      return [category, { total, outcomes }];
    }),
  ) as unknown as Record<StandingReflexShadowCategory, ShadowCategoryProjection>;
  return {
    v: 1,
    contractRevision: 'StandingReflex.ShadowHealth.v1',
    utilityVerdict: 'not_measured',
    byCategory,
  };
}
