import { collectiveArtifactSelectionSchema, collectiveModificationReworkSchema } from '@cat-cafe/shared';
import { z } from 'zod';

export const sharedArtifactDraftSelectionSchema = z
  .object({
    artifactId: z.string(),
    ownerRevision: z.number().int().positive(),
    blobDigest: z.string(),
    span: collectiveArtifactSelectionSchema,
  })
  .strict();
export type SharedArtifactDraftSelection = z.infer<typeof sharedArtifactDraftSelectionSchema>;
export const sharedArtifactDraftReworkSchema = sharedArtifactDraftSelectionSchema
  .omit({ span: true })
  .extend({
    sourceOwnerRevision: z.number().int().positive(),
    rework: collectiveModificationReworkSchema,
  })
  .strict();
export type SharedArtifactDraftRework = z.infer<typeof sharedArtifactDraftReworkSchema>;
export const sharedArtifactDraftReplySchema = sharedArtifactDraftSelectionSchema
  .omit({ span: true })
  .extend({
    annotationId: z.string(),
    messageEventId: z.string(),
    authorHumanId: z.string(),
  })
  .strict();
export type SharedArtifactDraftReply = z.infer<typeof sharedArtifactDraftReplySchema>;

export function readSharedArtifactDraftSelections(value: unknown) {
  const parsed = sharedArtifactDraftSelectionSchema.array().max(12).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
