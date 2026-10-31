import { z } from 'zod';
import { collectiveConnectionCoordinatesSchema, collectiveEventIdSchema } from './collective.js';
import { collectiveArtifactRequestSourceSchema, collectiveArtifactVersionSchema } from './collective-artifact.js';

const id = z.string().trim().min(1).max(256);
export const collectiveArtifactAgentContextRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    eventId: collectiveEventIdSchema,
    catId: id,
    participationRevision: z.number().int().positive().safe(),
  })
  .strict();
export const collectiveArtifactAgentContextSchema = z
  .object({
    status: z.enum(['available', 'access_denied', 'unavailable']),
    requests: z
      .array(
        collectiveArtifactRequestSourceSchema
          .omit({
            requestingHumanId: true,
            requesterMembershipRevision: true,
            requesterAccessRevision: true,
            targetMembershipRevision: true,
            targetAccessRevision: true,
          })
          .extend({
            artifactId: id,
            contentRef: id,
            sourceEventId: id,
            title: z.string().min(1).max(200),
            adoption: collectiveArtifactVersionSchema.optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export type CollectiveArtifactAgentContext = z.infer<typeof collectiveArtifactAgentContextSchema>;
