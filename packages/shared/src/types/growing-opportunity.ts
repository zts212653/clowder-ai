import { z } from 'zod';
import { growingSourceMessageRevisionV1Schema } from './growing.js';

const boundedRef = z.string().trim().min(1).max(1_000);
const timestamp = z.number().int().nonnegative().finite();
const reasonCode = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u);
const evidenceRefs = z.array(boundedRef).min(1).max(64);

export const CUSTODY_OPPORTUNITY_CONTRACT_VIOLATION_CODES = [
  'task_owner_write_boundary',
  'duplicate_admission',
  'unauthorized_auto_admit',
  'pre_admission_needs_me',
  'unaccepted_projection',
  'conflicting_episode_replay',
] as const;

export const custodyOpportunityContractViolationV1Schema = z
  .object({
    code: z.enum(CUSTODY_OPPORTUNITY_CONTRACT_VIOLATION_CODES),
    evidenceRef: boundedRef,
  })
  .strict();

const sourceSchema = z
  .object({
    subjectRef: boundedRef,
    sourceRevision: growingSourceMessageRevisionV1Schema,
    evidenceRefs,
  })
  .strict();

const actionWindowSchema = z
  .object({
    kind: z.literal('action'),
    openedAt: timestamp,
    closedAt: timestamp,
  })
  .strict();

const sampledSilentWindowSchema = z
  .object({
    kind: z.literal('sampled_silent'),
    openedAt: timestamp,
    closedAt: timestamp,
    sampling: z
      .object({
        bucket: z.enum(['random', 'risk_targeted']),
        sampleRef: boundedRef,
        policyVersion: boundedRef,
      })
      .strict(),
  })
  .strict();

const candidateSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('exposed'),
      exposedAt: timestamp,
      reasonCode,
    })
    .strict(),
  z.object({ state: z.literal('not_exposed') }).strict(),
]);

const userDispositionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_applicable') }).strict(),
  z.object({ state: z.literal('not_observed') }).strict(),
  z
    .object({
      state: z.literal('observed'),
      result: z.enum(['accept', 'decline', 'dismiss', 'correct']),
      dispositionRef: boundedRef,
    })
    .strict(),
]);

const taskRefSchema = z
  .object({
    subjectRef: boundedRef,
    observedRevision: z.number().int().positive(),
  })
  .strict();

const custodySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_task') }).strict(),
  z
    .object({
      state: z.literal('admitted'),
      taskRef: taskRefSchema,
      receiptRef: boundedRef,
    })
    .strict(),
  z
    .object({
      state: z.literal('resumed'),
      taskRef: taskRefSchema,
      receiptRef: boundedRef,
    })
    .strict(),
]);

const opportunityAssessmentSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.literal('present'), evidenceRefs }).strict(),
  z.object({ state: z.literal('absent'), evidenceRefs }).strict(),
]);

const delayedOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }).strict(),
  z.object({ state: z.literal('missing') }).strict(),
  z.object({ state: z.literal('available'), outcomeRefs: evidenceRefs }).strict(),
]);

const interruptionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none_observed') }).strict(),
  z.object({ state: z.literal('evidenced'), evidenceRefs }).strict(),
]);

const episodeBase = {
  version: z.literal(1),
  ownerRef: boundedRef,
  policyVersion: boundedRef,
  source: sourceSchema,
  window: z.discriminatedUnion('kind', [actionWindowSchema, sampledSilentWindowSchema]),
  candidate: candidateSchema,
  policyDisposition: z.enum(['auto_admit', 'offer', 'abstain', 'uninformed_silence']),
  userDisposition: userDispositionSchema,
  custody: custodySchema,
  opportunityAssessment: opportunityAssessmentSchema,
  delayedOutcome: delayedOutcomeSchema,
  interruption: interruptionSchema,
  duplicatePromptRefs: z.array(boundedRef).max(64),
};

function validateEpisodeSemantics(
  episode: {
    window: z.infer<typeof episodeBase.window>;
    candidate: z.infer<typeof candidateSchema>;
    policyDisposition: 'auto_admit' | 'offer' | 'abstain' | 'uninformed_silence';
  },
  context: z.RefinementCtx,
): void {
  if (episode.window.closedAt < episode.window.openedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['window', 'closedAt'],
      message: 'window closes before open',
    });
  }
  if (
    episode.candidate.state === 'exposed' &&
    (episode.candidate.exposedAt < episode.window.openedAt || episode.candidate.exposedAt > episode.window.closedAt)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate', 'exposedAt'],
      message: 'candidate exposure must be replayable inside the opportunity window',
    });
  }
  if (episode.policyDisposition === 'abstain' && episode.candidate.state !== 'exposed') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policyDisposition'],
      message: 'deliberate abstention requires an exposed candidate',
    });
  }
  if (
    (episode.policyDisposition === 'auto_admit' || episode.policyDisposition === 'offer') &&
    (episode.window.kind !== 'action' || episode.candidate.state !== 'exposed')
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policyDisposition'],
      message: 'custody actions require an exposed candidate in an action window',
    });
  }
  if (episode.policyDisposition === 'uninformed_silence' && episode.window.kind !== 'sampled_silent') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policyDisposition'],
      message: 'uninformed silence can enter only through a sampled silent window',
    });
  }
}

export const custodyOpportunityEpisodeInputV1Schema = z
  .object({
    ...episodeBase,
    contractViolations: z.array(custodyOpportunityContractViolationV1Schema).max(64).optional(),
  })
  .strict()
  .superRefine(validateEpisodeSemantics);

export const custodyOpportunityEpisodeV1Schema = z
  .object({
    episodeRef: z.string().regex(/^f310_opp_[a-f0-9]{32}$/u),
    ...episodeBase,
  })
  .strict()
  .superRefine(validateEpisodeSemantics);

export type CustodyOpportunityContractViolationV1 = z.infer<typeof custodyOpportunityContractViolationV1Schema>;
export type CustodyOpportunityEpisodeInputV1 = z.infer<typeof custodyOpportunityEpisodeInputV1Schema>;
export type CustodyOpportunityEpisodeV1 = z.infer<typeof custodyOpportunityEpisodeV1Schema>;

export interface CustodyOpportunityVectorV1 {
  readonly denominator: {
    readonly totalEpisodes: number;
    readonly actionWindows: number;
    readonly sampledSilentWindows: number;
    readonly randomSilentWindows: number;
    readonly riskTargetedSilentWindows: number;
  };
  readonly opportunity: {
    readonly assessedPresent: number;
    readonly assessedAbsent: number;
    readonly unknown: number;
    readonly sampledMissed: number;
    readonly nuisanceAction: number;
  };
  readonly silence: {
    readonly deliberateAbstentions: number;
    readonly trueNegativeEligible: number;
    readonly uninformed: number;
    readonly unknownEarnedCredit: 0;
  };
  readonly interruption: {
    readonly evidencedEpisodes: number;
    readonly duplicatePromptEpisodes: number;
  };
}

export type CustodyOpportunityCohortSnapshotV1 =
  | {
      readonly state: 'valid';
      readonly episodes: readonly CustodyOpportunityEpisodeV1[];
      readonly vector: CustodyOpportunityVectorV1;
    }
  | {
      readonly state: 'invalid';
      readonly episodes: readonly CustodyOpportunityEpisodeV1[];
      readonly contractViolations: readonly CustodyOpportunityContractViolationV1[];
    };
