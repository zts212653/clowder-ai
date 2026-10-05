import { z } from 'zod';
import { reviewedMediaAssetSchema } from './artifact-review.js';

export const messagePublicationChoiceSchema = z.object({
  asset: reviewedMediaAssetSchema,
  title: z.string(),
  threadTitle: z.string(),
  taskTitle: z.string().optional(),
  targetName: z.string().optional(),
  match: z.enum(['exact', 'legacy-ambiguous']),
});
export type MessagePublicationChoice = z.infer<typeof messagePublicationChoiceSchema>;
export const messagePublicationLandingSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), ownerUserId: z.string().min(1), asset: reviewedMediaAssetSchema }),
  z.object({
    status: z.literal('choice-required'),
    ownerUserId: z.string().min(1),
    choices: z.array(messagePublicationChoiceSchema).min(1),
    unavailableContexts: z.boolean().optional(),
  }),
]);
export type MessagePublicationLanding = z.infer<typeof messagePublicationLandingSchema>;
