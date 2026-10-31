import { z } from 'zod';

export const DREAM_EVIDENCE_KINDS = [
  'thread_message',
  'session_digest',
  'invocation_summary',
  'event_memory',
  'taste_vignette',
  'profile_primer',
  'profile_capsule',
  'recall_anchor',
  'feature_doc',
  'diary_entry',
] as const;

export const PRESENT_LOOP_OUTCOMES = ['diary', 'quiet', 'daze'] as const;
export const PRESENT_LOOP_RUN_STATES = ['awakened', 'settled', 'wake_failed', 'wake_expired'] as const;
export const DIARY_ENTRY_KINDS = ['evidence', 'souvenir'] as const;
export const DIARY_TRACE_KINDS = ['work', 'non_work', 'mixed'] as const;
export const CAT_LIFE_RHYTHMS = ['gentle', 'daily', 'weekends', 'custom'] as const;
export const CAT_LIFE_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const CAT_LIFE_COST_BANDS = ['low', 'medium', 'high'] as const;

const prefixedId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 1)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9._:-]*$`));

export const dreamIdSchema = prefixedId('dream_').brand<'DreamId'>();
export const dreamRunIdSchema = prefixedId('dreamrun_').brand<'DreamRunId'>();
export const sleepPostureIdSchema = prefixedId('posture_').brand<'SleepPostureId'>();
export const privateCueIdSchema = prefixedId('cue_').brand<'PrivateCueId'>();
export const ownedSeedIdSchema = prefixedId('seed_').brand<'OwnedSeedId'>();
export const proactiveIntentIdSchema = prefixedId('intent_').brand<'ProactiveIntentId'>();
export const proactiveVisitIdSchema = prefixedId('visit_').brand<'ProactiveVisitId'>();
export const proactiveEchoIdSchema = prefixedId('echo_').brand<'ProactiveEchoId'>();

const seedClaimSchema = z.string().trim().min(1).max(4_000);

export const seedDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('adopt'), cueId: privateCueIdSchema }).strict(),
  z
    .object({
      kind: z.literal('rewrite'),
      cueId: privateCueIdSchema,
      claim: seedClaimSchema,
    })
    .strict(),
  z.object({ kind: z.literal('reject'), cueId: privateCueIdSchema }).strict(),
  z.object({ kind: z.literal('originate'), claim: seedClaimSchema }).strict(),
]);

export const PROACTIVE_EXPRESSION_KINDS = ['want', 'discover', 'care'] as const;
export const REVERSIBLE_FIRST_ACTION_KINDS = ['research', 'sketch', 'evidence_check', 'attentive_pause'] as const;
export const PROACTIVE_ECHO_KINDS = ['seen', 'helpful', 'wrong', 'not_now', 'companion'] as const;

const proactiveSeedRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision') }).strict(),
  z.object({ kind: z.literal('owned_seed'), seedId: ownedSeedIdSchema }).strict(),
]);

const reversibleFirstActionSchema = z
  .object({
    kind: z.enum(REVERSIBLE_FIRST_ACTION_KINDS),
    summary: z.string().trim().min(1).max(1_000),
    artifactRef: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const proactiveIntentBaseShape = {
  seedRef: proactiveSeedRefSchema,
  expressionKind: z.enum(PROACTIVE_EXPRESSION_KINDS),
  firstAction: reversibleFirstActionSchema,
};

export const proactiveIntentSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('silence'), ...proactiveIntentBaseShape }).strict(),
    z.object({ kind: z.literal('body_language'), ...proactiveIntentBaseShape }).strict(),
    z
      .object({
        kind: z.literal('message'),
        ...proactiveIntentBaseShape,
        message: z.object({ body: z.string().trim().min(1).max(4_000) }).strict(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== 'message') return;
    const requiredPrefix = {
      want: '我想要',
      discover: '我发现',
      care: '我惦记',
    }[value.expressionKind];
    if (!value.message.body.startsWith(requiredPrefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message', 'body'],
        message: `${value.expressionKind} messages must start with ${requiredPrefix}`,
      });
    }
  });

export const proactiveEchoInputSchema = z
  .object({
    visitId: proactiveVisitIdSchema,
    kind: z.enum(PROACTIVE_ECHO_KINDS),
    clientEventId: z.string().trim().min(1).max(160),
  })
  .strict();

export const dreamEvidenceRefSchema = z
  .object({
    kind: z.enum(DREAM_EVIDENCE_KINDS),
    refId: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(240).optional(),
    threadId: z.string().trim().min(1).max(200).optional(),
    messageId: z.string().trim().min(1).max(240).optional(),
    sessionId: z.string().trim().min(1).max(240).optional(),
    eventId: z.string().trim().min(1).max(240).optional(),
    path: z.string().trim().min(1).max(1_000).optional(),
    line: z.number().int().positive().optional(),
    excerpt: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const dreamObservationSchema = z
  .object({
    observationId: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(['profile_candidate', 'taste_candidate', 'event_candidate', 'provoke_seed', 'diary_only']),
    text: z.string().trim().min(1).max(4_000),
    confidence: z.enum(['low', 'medium', 'high']),
    evidenceRefs: z.array(dreamEvidenceRefSchema).min(1).max(100),
    target: z
      .object({
        lane: z.enum(['F231', 'F221', 'F227']),
        catId: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const sleepPostureDraftSchema = z
  .object({
    lastRoom: z.string().trim().min(1).max(1_000).optional(),
    curiosity: z.string().trim().min(1).max(2_000).optional(),
    unfinishedThought: z.string().trim().min(1).max(4_000).optional(),
    selfPromise: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const diaryDraftSchema = z
  .object({
    entryKind: z.enum(DIARY_ENTRY_KINDS),
    traceKind: z.enum(DIARY_TRACE_KINDS),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    headline: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(280),
    bodyMarkdown: z.string().trim().min(1).max(6_000),
    provenance: z.array(dreamEvidenceRefSchema).min(1).max(100),
    observations: z.array(dreamObservationSchema).max(100).optional().default([]),
  })
  .strict();

const settlePresentLoopInputObjectSchema = z
  .object({
    runId: dreamRunIdSchema,
    outcome: z.enum(PRESENT_LOOP_OUTCOMES),
    diary: diaryDraftSchema.optional(),
    sleepPosture: sleepPostureDraftSchema.optional(),
    seedDecision: seedDecisionSchema.optional(),
    intent: proactiveIntentSchema.optional(),
  })
  .strict();

export const settlePresentLoopInputSchema = settlePresentLoopInputObjectSchema.superRefine((value, ctx) => {
  if (value.outcome === 'diary' && !value.diary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diary'],
      message: 'diary outcome requires a diary artifact',
    });
  }
  if (value.outcome !== 'diary' && value.diary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diary'],
      message: 'quiet and daze outcomes cannot carry a diary artifact',
    });
  }
  if (value.intent?.seedRef.kind === 'decision' && !value.seedDecision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intent', 'seedRef'],
      message: 'decision seedRef requires seedDecision in the same settlement',
    });
  }
  if (value.intent?.seedRef.kind === 'owned_seed' && value.seedDecision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intent', 'seedRef'],
      message: 'a settlement cannot decide one seed while building intent from another',
    });
  }
  if (value.intent?.seedRef.kind === 'decision' && value.seedDecision?.kind === 'reject') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intent', 'seedRef'],
      message: 'a rejected cue cannot become an intent seed',
    });
  }
});

const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Expected local time in HH:mm format, for example 22:30');

const catLifeRhythmSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['gentle', 'daily', 'weekends']) }).strict(),
  z
    .object({
      kind: z.literal('custom'),
      weekdays: z.array(z.enum(CAT_LIFE_WEEKDAYS)).min(1).max(7),
    })
    .strict(),
]);

export const catLifeSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    rhythm: catLifeRhythmSchema,
    wakeTime: localTimeSchema,
    timezone: z.string().trim().min(1).max(120),
    quietHours: z
      .object({
        start: localTimeSchema,
        end: localTimeSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const catLifePreviewDecisionSchema = z
  .object({
    previewId: prefixedId('lifepreview_'),
    decision: z.enum(['confirm', 'cancel']),
  })
  .strict();

export const diaryEngagementInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('open'),
      clientEventId: z.string().trim().min(1).max(160),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reaction'),
      clientEventId: z.string().trim().min(1).max(160),
      active: z.boolean(),
    })
    .strict(),
]);

export type DreamId = z.infer<typeof dreamIdSchema>;
export type DreamRunId = z.infer<typeof dreamRunIdSchema>;
export type SleepPostureId = z.infer<typeof sleepPostureIdSchema>;
export type PrivateCueId = z.infer<typeof privateCueIdSchema>;
export type OwnedSeedId = z.infer<typeof ownedSeedIdSchema>;
export type ProactiveIntentId = z.infer<typeof proactiveIntentIdSchema>;
export type ProactiveVisitId = z.infer<typeof proactiveVisitIdSchema>;
export type ProactiveEchoId = z.infer<typeof proactiveEchoIdSchema>;
export type SeedDecision = z.infer<typeof seedDecisionSchema>;
export type ProactiveIntent = z.infer<typeof proactiveIntentSchema>;
export type ProactiveEchoInput = z.infer<typeof proactiveEchoInputSchema>;
export type DreamEvidenceKind = (typeof DREAM_EVIDENCE_KINDS)[number];
export type PresentLoopOutcome = (typeof PRESENT_LOOP_OUTCOMES)[number];
export type PresentLoopRunState = (typeof PRESENT_LOOP_RUN_STATES)[number];
export type DiaryEntryKind = (typeof DIARY_ENTRY_KINDS)[number];
export type DiaryTraceKind = (typeof DIARY_TRACE_KINDS)[number];
export type DreamEvidenceRef = z.infer<typeof dreamEvidenceRefSchema>;
export type DreamObservationDraft = z.infer<typeof dreamObservationSchema>;
export type SleepPostureDraft = z.infer<typeof sleepPostureDraftSchema>;
export type DiaryDraft = z.infer<typeof diaryDraftSchema>;
export type SettlePresentLoopInput = z.infer<typeof settlePresentLoopInputSchema>;
export type CatLifeRhythm = z.infer<typeof catLifeRhythmSchema>;
export type CatLifeSettingsInput = z.infer<typeof catLifeSettingsInputSchema>;
export type CatLifePreviewDecision = z.infer<typeof catLifePreviewDecisionSchema>;
export type DiaryEngagementInput = z.infer<typeof diaryEngagementInputSchema>;
export type CatLifeCostBand = (typeof CAT_LIFE_COST_BANDS)[number];
