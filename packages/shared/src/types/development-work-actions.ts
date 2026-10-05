import { z } from 'zod';
import { custodyAdmissionRequestV1Schema, entrustedWorkClosureSpecV1Schema } from './entrusted-work-actions.js';
import { entrustedWorkV1Schema, growingSourceMessageRevisionV1Schema } from './growing.js';
import { developmentScopeQueryV1Schema, developmentTaskRefSchema } from './growing-development.js';

export const developmentWorkActionV1Schema = z
  .object({
    action: z.enum(['resolve', 'admit', 'resume', 'adopt', 'bind']),
    scope: developmentScopeQueryV1Schema,
    admission: custodyAdmissionRequestV1Schema,
    sourceMessageRevision: growingSourceMessageRevisionV1Schema,
    taskId: z.string().min(1).max(160).optional(),
    expectedRevision: z.number().int().positive().optional(),
    expectedSnapshot: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    title: z.string().trim().min(1).max(200).optional(),
    why: z.string().max(1000).optional(),
    closure: entrustedWorkClosureSpecV1Schema.optional(),
    time: entrustedWorkV1Schema.shape.time.optional(),
    artifactRefs: z.array(z.string().min(1).max(1000)).max(64).optional(),
    parentTaskRef: developmentTaskRefSchema.optional(),
    predecessorTaskRef: developmentTaskRefSchema.optional(),
  })
  .strict();
export type DevelopmentWorkActionV1 = z.infer<typeof developmentWorkActionV1Schema>;
