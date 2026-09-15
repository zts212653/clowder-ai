import { z } from 'zod';
import { evolutionAssetReviewBlockerV1Schema, evolutionOwnerHrefSchema } from './capability-evolution-asset-review.js';
import {
  bounded,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  refIdentity,
  timestampSchema,
} from './capability-evolution-refs.js';

const owner = ownerTruthRefV1Schema;
const blockers = z.array(evolutionAssetReviewBlockerV1Schema).max(32);
export const evolutionPreparationReviewRequestV1Schema = z.object({ programRef: owner, objectRef: owner }).strict();
export const evolutionPreparationMediaRequestV1Schema = z
  .object({ programRef: owner, objectRef: owner, mediaRef: owner })
  .strict();
export const evolutionPreparationActivityV1Schema = z
  .object({
    state: z.enum(['running', 'completed', 'awaiting_publication', 'failed']),
    updatedAt: timestampSchema,
    detail: bounded(2_000).optional(),
  })
  .strict();
export const evolutionPreparationMediaV1Schema = z
  .object({
    mediaRef: owner.refine((value) => /^[a-f0-9]{64}$/u.test(value.version ?? ''), {
      message: 'preparation media requires a lowercase SHA-256 version',
    }),
    contentType: z.enum(['video/mp4', 'video/webm']),
    durationSeconds: z.number().finite().positive().max(86_400).optional(),
  })
  .strict();
export const evolutionPreparationResourceV1Schema = z
  .object({
    label: bounded(240),
    sourceRef: owner,
    ownerHref: evolutionOwnerHrefSchema.optional(),
    media: evolutionPreparationMediaV1Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.media && refIdentity(value.media.mediaRef) !== refIdentity(value.sourceRef))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'preparation media and resource source refs must match',
      });
  });
export const evolutionPreparationMaterialV1Schema = z
  .object({
    materialRef: owner,
    title: bounded(240),
    summary: bounded(4_000),
    status: z.enum(['available', 'planned', 'unavailable']),
    candidateVersionRef: exactAssetVersionRefV1Schema.optional(),
    /** Owner-named facts: setup, gaps, responsible roles, comparison or method notes. No fixed checklist. */
    facts: z
      .array(z.object({ label: bounded(120), value: bounded(2_000) }).strict())
      .max(12)
      .optional(),
    activity: evolutionPreparationActivityV1Schema.optional(),
    resources: z.array(evolutionPreparationResourceV1Schema).max(32),
  })
  .strict();
export const evolutionPreparationGroupV1Schema = z
  .object({
    groupRef: owner,
    title: bounded(240),
    items: z.array(evolutionPreparationMaterialV1Schema).max(128),
  })
  .strict();
const envelope = { schemaVersion: z.literal(1), programRef: owner, objectRef: owner };
const publication = { sourceRef: owner, readAt: timestampSchema, updatedAt: timestampSchema };

/** Read-time publication, independent of Program stage, connected EYES, or adoption eligibility. */
export const evolutionPreparationReviewV1Schema = z
  .discriminatedUnion('status', [
    z.object({ ...envelope, status: z.literal('unknown'), blockers: blockers.min(1) }).strict(),
    z.object({ ...envelope, status: z.literal('unavailable'), blockers: blockers.min(1) }).strict(),
    z.object({ ...envelope, ...publication, status: z.literal('unpublished'), blockers }).strict(),
    z
      .object({
        ...envelope,
        ...publication,
        status: z.literal('resolved'),
        groups: z.array(evolutionPreparationGroupV1Schema).max(32),
        blockers,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.status !== 'resolved') return;
    const groups = value.groups.map((item) => refIdentity(item.groupRef));
    const materials = value.groups.flatMap((item) => item.items.map((entry) => refIdentity(entry.materialRef)));
    if (new Set(groups).size !== groups.length || new Set(materials).size !== materials.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'publication group and material refs must each be unique',
      });
    const publicationTime = Date.parse(value.updatedAt);
    if (
      value.groups.some((item) =>
        item.items.some((entry) => entry.activity && Date.parse(entry.activity.updatedAt) > publicationTime),
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'material activity cannot be newer than its publication',
      });
  });

export type EvolutionPreparationReviewRequestV1 = z.infer<typeof evolutionPreparationReviewRequestV1Schema>;
export type EvolutionPreparationMediaRequestV1 = z.infer<typeof evolutionPreparationMediaRequestV1Schema>;
export type EvolutionPreparationReviewV1 = z.infer<typeof evolutionPreparationReviewV1Schema>;
export type EvolutionResolvedPreparationReviewV1 = Extract<EvolutionPreparationReviewV1, { status: 'resolved' }>;
export type EvolutionPreparationMediaV1 = z.infer<typeof evolutionPreparationMediaV1Schema>;
