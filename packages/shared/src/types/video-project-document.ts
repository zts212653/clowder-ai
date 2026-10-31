import { z } from 'zod';
import {
  videoProjectActorSchema,
  videoProjectAssetSchema,
  videoProjectOriginSchema,
  videoProjectTextSchema,
  videoProjectTimestampSchema,
} from './video-project-primitives.js';
import { videoProjectScreeningsSchema } from './video-project-screening.js';
import { videoProjectSelfReviewsSchema } from './video-project-self-review.js';
import {
  videoProjectCheckPageSchema,
  videoProjectCheckResultSchema,
  videoProjectDecisionSchema,
} from './video-project-settings.js';
import { videoProjectTimelineSchema } from './video-project-timeline.js';

export const videoProjectDocumentBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: videoProjectTextSchema(1000),
    kind: videoProjectTextSchema(256),
    tags: z.array(videoProjectTextSchema(256)).max(1000),
    roles: z.array(z.object({ role: videoProjectTextSchema(256), actor: videoProjectActorSchema }).strict()).max(1000),
    origin: videoProjectOriginSchema,
    timeline: videoProjectTimelineSchema,
    assets: z.array(videoProjectAssetSchema).max(10000),
    checkPages: z.array(videoProjectCheckPageSchema).max(10000),
    checkResults: z.array(videoProjectCheckResultSchema).max(10000),
    decisions: z.array(videoProjectDecisionSchema).max(10000),
    screenings: videoProjectScreeningsSchema.optional(),
    selfReviews: videoProjectSelfReviewsSchema.optional(),
    archivedAt: videoProjectTimestampSchema.optional(),
  })
  .strict();

export type VideoProjectDocumentV1 = z.infer<typeof videoProjectDocumentBaseSchema>;
