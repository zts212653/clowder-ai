import { z } from 'zod';
import { collectiveArtifactProjectionSchema, collectiveArtifactVersionSchema } from './collective-artifact.js';
import { collectiveCollaborationActorSchema } from './collective-collaboration-actor.js';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().safe();
const coordinates = { serviceInstanceId: id, collectiveId: id };
export const collectiveProjectArtifactVersionRefSchema = collectiveArtifactVersionSchema.pick({
  ownerRevision: true,
  blobDigest: true,
  receiptRef: true,
});
export type CollectiveProjectArtifactVersionRef = z.infer<typeof collectiveProjectArtifactVersionRefSchema>;
const action = z.enum(['attach', 'switch', 'keep', 'remove']);
export const collectiveProjectArtifactReferenceSchema = z
  .object({
    ...coordinates,
    referenceId: id,
    roadmapId: id,
    artifactId: id,
    versionRef: collectiveProjectArtifactVersionRefSchema,
    keptVersionRef: collectiveProjectArtifactVersionRefSchema.optional(),
    status: z.enum(['active', 'removed']),
    revision: positive,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    history: z
      .array(
        z
          .object({
            revision: positive,
            action,
            actor: collectiveCollaborationActorSchema,
            at: z.string().datetime(),
            sourceEventId: id,
            versionRef: collectiveProjectArtifactVersionRefSchema,
            previousVersionRef: collectiveProjectArtifactVersionRefSchema.optional(),
            observedVersionRef: collectiveProjectArtifactVersionRefSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();
export type CollectiveProjectArtifactReference = z.infer<typeof collectiveProjectArtifactReferenceSchema>;

const base = z.object({
  ...coordinates,
  roadmapId: id,
  artifactId: id,
  requestId: id,
  expectedRevision: z.number().int().nonnegative().safe(),
});
export const changeCollectiveProjectArtifactRequestSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('attach'), versionRef: collectiveProjectArtifactVersionRefSchema }).strict(),
  base.extend({ action: z.literal('switch'), versionRef: collectiveProjectArtifactVersionRefSchema }).strict(),
  base.extend({ action: z.literal('keep'), versionRef: collectiveProjectArtifactVersionRefSchema }).strict(),
  base.extend({ action: z.literal('remove') }).strict(),
]);
export type ChangeCollectiveProjectArtifactRequest = z.infer<typeof changeCollectiveProjectArtifactRequestSchema>;
export const listCollectiveProjectArtifactsRequestSchema = z
  .object({
    ...coordinates,
    roadmapId: id,
    expectedSnapshot: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    offset: z.number().int().nonnegative().max(1000).default(0),
    limit: z.number().int().min(1).max(30).default(30),
  })
  .strict();
export const collectiveProjectArtifactItemSchema = z
  .object({
    reference: collectiveProjectArtifactReferenceSchema,
    availability: z.enum(['available', 'access_denied', 'owner_unavailable', 'version_unavailable']),
    artifact: collectiveArtifactProjectionSchema.optional(),
    latestVersionRef: collectiveProjectArtifactVersionRefSchema.optional(),
    hasUpdate: z.boolean(),
    usedBy: z
      .array(
        z
          .object({
            roadmapId: id,
            title: z.string(),
            accountableHumanId: id,
            versionRef: collectiveProjectArtifactVersionRefSchema,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.availability !== 'available' &&
      (item.artifact || item.latestVersionRef || item.usedBy.length || item.hasUpdate)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unavailable references must not disclose source metadata',
      });
    if (item.availability === 'available' && !item.artifact)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Available references require authorized original metadata',
      });
  });
export type CollectiveProjectArtifactItem = z.infer<typeof collectiveProjectArtifactItemSchema>;
export const collectiveProjectArtifactListSchema = z
  .object({
    ...coordinates,
    roadmapId: id,
    snapshot: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().optional(),
    items: z.array(collectiveProjectArtifactItemSchema).max(30),
    removedReferences: z.array(z.object({ artifactId: id, revision: positive }).strict()).max(1000),
  })
  .strict();
export const collectiveProjectArtifactChangeSchema = z
  .object({
    outcome: z.enum(['changed', 'replayed', 'conflict']),
    item: collectiveProjectArtifactItemSchema.nullable(),
  })
  .strict();
