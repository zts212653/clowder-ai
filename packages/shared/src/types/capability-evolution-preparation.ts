import { z } from 'zod';
import {
  preparationDecisionSchema,
  preparationRecommendationSchema,
} from './capability-evolution-preparation-choice.js';
import { bounded, ownerTruthRefV1Schema } from './capability-evolution-refs.js';

export const EVOLUTION_PREPARATION_SECTIONS = [
  'object_map',
  'success_contract',
  'measurement_plan',
  'baseline_diagnosis',
] as const;
export const evolutionPreparationSectionSchema = z.enum(EVOLUTION_PREPARATION_SECTIONS);
export type EvolutionPreparationSection = (typeof EVOLUTION_PREPARATION_SECTIONS)[number];

const programIdSchema = z.string().regex(/^evolution-program:[0-9a-f]{32}$/);
const revisionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const text = (max = 2_000) => bounded(max);
const textList = (max = 32) => z.array(text()).max(max);

const PREPARATION_REF_PATTERN = new RegExp(
  `^preparation-submission:(evolution-program:[0-9a-f]{32}):(${EVOLUTION_PREPARATION_SECTIONS.join('|')})$`,
);

export function evolutionPreparationSubmissionRefCoordinates(value: {
  ownerFeatureId: string;
  ownerStateRef: string;
  version?: string;
}): { programId: string; section: EvolutionPreparationSection; revision: string } | undefined {
  const match = PREPARATION_REF_PATTERN.exec(value.ownerStateRef);
  if (value.ownerFeatureId !== 'F311' || !match || !value.version || !revisionSchema.safeParse(value.version).success) {
    return undefined;
  }
  return {
    programId: match[1] as string,
    section: match[2] as EvolutionPreparationSection,
    revision: value.version,
  };
}

export const evolutionPreparationSubmissionRefV1Schema = ownerTruthRefV1Schema.superRefine((value, ctx) => {
  if (!evolutionPreparationSubmissionRefCoordinates(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'preparation submission refs require the F311 Program/section identity and exact sha256 version',
    });
  }
});

export const evolutionPreparationActivityRefV1Schema = ownerTruthRefV1Schema.superRefine((value, ctx) => {
  if (value.ownerFeatureId !== 'F167' || !/^invocation:[^\s:{}[\]"']+$/.test(value.ownerStateRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'preparation activity must use an F167 invocation:<id> ref' });
  }
});

export const evolutionPreparationModifiabilityV1Schema = z
  .object({
    state: z.enum(['unknown', 'modifiable', 'partially_modifiable', 'not_modifiable_this_round', 'not_applicable']),
    reason: text(1_000),
    basisRefs: z.array(ownerTruthRefV1Schema).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state !== 'unknown' && value.basisRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['basisRefs'],
        message: 'a known boundary requires owner evidence',
      });
    }
  });

export const evolutionPreparationItemV1Schema = z
  .object({
    itemId: identifierSchema,
    label: text(240),
    category: text(120).optional(),
    recommendation: preparationRecommendationSchema.optional(),
    existingWork: z
      .object({ summary: text(), sourceRefs: z.array(ownerTruthRefV1Schema).min(1).max(16) })
      .strict()
      .optional(),
    decision: preparationDecisionSchema.optional(),
    scope: text(),
    why: text(),
    modifiability: evolutionPreparationModifiabilityV1Schema,
    sourceRefs: z.array(ownerTruthRefV1Schema).max(32),
    nextAction: text(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.decision?.state === 'explore' &&
      !['modifiable', 'partially_modifiable'].includes(value.modifiability.state)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'exploration requires a known modifiable boundary; a choice cannot grant permission',
      });
    }
  });

const objectMapBodySchema = z
  .object({
    kind: z.literal('object_map'),
    goalStatement: text(4_000),
    summary: text(4_000),
    items: z.array(evolutionPreparationItemV1Schema).min(1).max(32),
    unknowns: textList(),
    nextAction: text(),
  })
  .strict();

const payerSchema = z
  .object({
    kind: z.enum(['engineering_maintenance', 'judge_runway', 'human_attention', 'mixed']),
    detail: text(),
  })
  .strict();

export const evolutionPreparationCriterionV1Schema = z
  .object({
    criterionId: identifierSchema,
    label: text(240),
    utilityClaim: text(4_000),
    observationUnit: text(),
    estimator: text(4_000),
    counterexample: text(),
    gtDomain: z.enum(['verifiable', 'semi_verifiable', 'open_value']),
    judge: z.enum(['verifier', 'calibrated_judge', 'value_owner', 'mixed']),
    payer: payerSchema,
    gtSourceKeys: z.array(identifierSchema).min(1).max(16),
    validityBounds: textList(16).min(1),
    unknowns: textList(16),
    nextAction: text(),
  })
  .strict();

const successContractBodySchema = z
  .object({
    kind: z.literal('success_contract'),
    summary: text(4_000),
    criteria: z.array(evolutionPreparationCriterionV1Schema).min(1).max(12),
    unknowns: textList(),
    nextAction: text(),
  })
  .strict();

const gtCollectionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_connected'), method: text() }).strict(),
  z.object({ state: z.literal('collecting'), method: text(), sourceRef: ownerTruthRefV1Schema.optional() }).strict(),
  z.object({ state: z.literal('collected'), method: text(), sourceRef: ownerTruthRefV1Schema }).strict(),
]);
const gtValiditySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown'), detail: text() }).strict(),
  z
    .object({
      state: z.literal('needs_review'),
      detail: text(),
      proofRefs: z.array(ownerTruthRefV1Schema).max(16).optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('bounded'),
      detail: text(),
      validFor: text(),
      proofRefs: z.array(ownerTruthRefV1Schema).min(1).max(16),
    })
    .strict(),
]);

export const evolutionPreparationGtSourceV1Schema = z
  .object({
    sourceKey: identifierSchema,
    category: z.enum(['business_fact', 'domain_precedent', 'real_world_outcome']),
    label: text(240),
    collection: gtCollectionSchema,
    validity: gtValiditySchema,
    missingOrDisputed: textList(32),
    cost: z.object({ payer: text(240), detail: text() }).strict(),
  })
  .strict();

const comparisonSchema = z
  .object({
    unit: text(),
    primaryVariable: text(),
    controls: textList(32),
    developmentEvidence: text(),
    independentHoldout: text(),
    repeatability: text(),
  })
  .strict();

const measurementPlanBodySchema = z
  .object({
    kind: z.literal('measurement_plan'),
    summary: text(4_000),
    gtSources: z.array(evolutionPreparationGtSourceV1Schema).min(1).max(32),
    conditions: z.array(evolutionPreparationItemV1Schema).max(32),
    comparison: comparisonSchema,
    unknowns: textList(),
    nextAction: text(),
  })
  .strict();

const baselineFactSchema = z
  .object({
    factId: identifierSchema,
    label: text(240),
    state: z.enum(['unknown', 'reported', 'owner_verified']),
    sourceRefs: z.array(ownerTruthRefV1Schema).max(32),
    limitation: text(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'owner_verified' && value.sourceRefs.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceRefs'], message: 'verified facts require owner refs' });
    }
  });
const competingExplanationSchema = z
  .object({
    explanationId: identifierSchema,
    hypothesis: text(),
    evidenceFor: z.array(ownerTruthRefV1Schema).max(32),
    evidenceAgainst: z.array(ownerTruthRefV1Schema).max(32),
    discriminatingNextStep: text(),
  })
  .strict();
const baselineDiagnosisBodySchema = z
  .object({
    kind: z.literal('baseline_diagnosis'),
    summary: text(4_000),
    baselineState: z.enum(['unknown', 'draft', 'owner_verified']),
    observationUnit: text(),
    facts: z.array(baselineFactSchema).max(64),
    competingExplanations: z.array(competingExplanationSchema).min(2).max(16),
    unknowns: textList(),
    nextAction: text(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.baselineState === 'owner_verified' && !value.facts.some((fact) => fact.state === 'owner_verified')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['facts'],
        message: 'a verified baseline needs an owner-verified fact',
      });
    }
  });

export const evolutionPreparationBodyV1Schema = z.union([
  objectMapBodySchema,
  successContractBodySchema,
  measurementPlanBodySchema,
  baselineDiagnosisBodySchema,
]);

export const evolutionPreparationSubmissionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    programId: programIdSchema,
    section: evolutionPreparationSectionSchema,
    title: text(240),
    authorCatId: identifierSchema,
    revision: revisionSchema,
    dependsOn: z.array(evolutionPreparationSubmissionRefV1Schema).max(3),
    body: evolutionPreparationBodyV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.section !== value.body.kind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'section and body kind must match' });
    }
    const identities = new Set<string>();
    for (const dependency of value.dependsOn) {
      const coordinates = evolutionPreparationSubmissionRefCoordinates(dependency);
      if (!coordinates || coordinates.programId !== value.programId || coordinates.section === value.section) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dependsOn'],
          message: 'dependencies must name another section in this Program',
        });
        continue;
      }
      const identity = `${coordinates.section}:${coordinates.revision}`;
      if (identities.has(identity)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dependsOn'], message: 'dependencies must be unique' });
      }
      identities.add(identity);
    }
  });

export type EvolutionPreparationSubmissionV1 = z.infer<typeof evolutionPreparationSubmissionV1Schema>;
export type EvolutionPreparationBodyV1 = z.infer<typeof evolutionPreparationBodyV1Schema>;
export type EvolutionPreparationSubmissionRefV1 = z.infer<typeof evolutionPreparationSubmissionRefV1Schema>;
