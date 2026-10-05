import { z } from 'zod';
import {
  collectiveConnectionIdSchema,
  collectiveCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
  collectiveIdSchema,
  collectiveLocationSchema,
  collectiveServiceInstanceIdSchema,
} from './collective.js';
import { collectiveAcceptedWorkResultSchema, collectiveWorkIdSchema } from './collective-collaboration.js';

const sessionId = z.string().min(8).max(120);
export const collectiveClientContextSchema = collectiveCoordinatesSchema
  .extend({
    type: z.literal('collective:client-context'),
    bridgeId: sessionId,
    contextId: sessionId,
    revision: z.number().int().positive(),
    humanId: collectiveHumanIdSchema,
    channelId: collectiveLocationSchema.shape.channelId,
    channelIds: z.array(collectiveLocationSchema.shape.channelId).min(1).max(100),
    openCafe: z.boolean(),
  })
  .strict();
export const collectiveContextReadySchema = z.object({ type: z.literal('collective:context-ready') }).strict();
export const collectiveHostContextInitSchema = collectiveCoordinatesSchema
  .extend({
    type: z.literal('collective:host-context-init'),
    bridgeId: sessionId,
    connectionId: collectiveConnectionIdSchema,
    humanId: collectiveHumanIdSchema,
    authorityStatus: z.enum(['connected', 'revoking', 'revoked']).optional(),
  })
  .strict();
export const collectiveHostParticipationReadySchema = collectiveCoordinatesSchema
  .extend({
    type: z.literal('collective:host-participation-ready'),
    bridgeId: sessionId,
    connectionId: collectiveConnectionIdSchema,
    humanId: collectiveHumanIdSchema,
    participationRevision: z.number().int().positive(),
    catCount: z.number().int().nonnegative().max(100),
  })
  .strict();
export const collectiveHostContextActionSchema = z
  .object({
    type: z.enum(['collective:host-context-close', 'collective:host-context-open']),
    bridgeId: sessionId,
    contextId: sessionId,
    revision: z.number().int().positive(),
  })
  .strict();
export const collectiveClientWorkResultAcceptedSchema = collectiveAcceptedWorkResultSchema
  .extend({
    type: z.literal('collective:client-work-result-accepted'),
    bridgeId: sessionId,
    contextId: sessionId,
    contextRevision: z.number().int().positive(),
    humanId: collectiveHumanIdSchema,
  })
  .strict();
export const collectiveHostWorkResultReconciledSchema = z
  .object({
    type: z.literal('collective:host-work-result-reconciled'),
    bridgeId: sessionId,
    contextId: sessionId,
    contextRevision: z.number().int().positive(),
    workId: collectiveWorkIdSchema,
    workRevision: z.number().int().positive(),
  })
  .strict();
export const collectiveHostWorkFocusSchema = z
  .object({
    type: z.literal('collective:host-focus-work'),
    bridgeId: sessionId,
    contextId: sessionId,
    contextRevision: z.number().int().positive(),
    workId: collectiveWorkIdSchema,
    workRevision: z.number().int().positive(),
    channelId: collectiveLocationSchema.shape.channelId,
    resultEventId: collectiveEventIdSchema,
    resultRevision: z.number().int().positive(),
  })
  .strict();

export const collectiveWorldDirectoryReadySchema = z
  .object({ type: z.literal('collective:world-directory-ready') })
  .strict();
export const collectiveHostWorldDirectoryInitSchema = z
  .object({
    type: z.literal('collective:host-world-directory-init'),
    bridgeId: sessionId,
    expectedServiceInstanceId: collectiveServiceInstanceIdSchema.optional(),
  })
  .strict();
export const collectiveWorldDirectoryMembershipSchema = z
  .object({
    collectiveId: collectiveIdSchema,
    name: z.string().trim().min(1).max(160),
    role: z.enum(['steward', 'member']),
  })
  .strict();
const collectiveClientWorldDirectoryBaseSchema = z.object({
  type: z.literal('collective:client-world-directory'),
  bridgeId: sessionId,
  revision: z.number().int().positive(),
});
export const collectiveClientWorldDirectorySchema = z.discriminatedUnion('state', [
  collectiveClientWorldDirectoryBaseSchema
    .extend({
      state: z.literal('ready'),
      serviceInstanceId: collectiveServiceInstanceIdSchema,
      humanId: collectiveHumanIdSchema,
      currentCollectiveId: collectiveIdSchema.optional(),
      memberships: z.array(collectiveWorldDirectoryMembershipSchema).max(100),
    })
    .strict(),
  collectiveClientWorldDirectoryBaseSchema
    .extend({
      state: z.literal('session_required'),
      serviceInstanceId: collectiveServiceInstanceIdSchema,
    })
    .strict(),
  collectiveClientWorldDirectoryBaseSchema
    .extend({
      state: z.literal('unavailable'),
      code: z.enum(['service_unavailable', 'client_unavailable']),
      serviceInstanceId: collectiveServiceInstanceIdSchema.optional(),
    })
    .strict(),
]);
export const collectiveHostWorldSelectionSchema = z
  .object({
    type: z.literal('collective:host-select-world'),
    bridgeId: sessionId,
    directoryRevision: z.number().int().positive(),
    serviceInstanceId: collectiveServiceInstanceIdSchema,
    humanId: collectiveHumanIdSchema,
    collectiveId: collectiveIdSchema,
  })
  .strict();
export type CollectiveClientContext = z.infer<typeof collectiveClientContextSchema>;
export type CollectiveHostContextInit = z.infer<typeof collectiveHostContextInitSchema>;
export type CollectiveHostParticipationReady = z.infer<typeof collectiveHostParticipationReadySchema>;
export type CollectiveClientWorkResultAccepted = z.infer<typeof collectiveClientWorkResultAcceptedSchema>;
export type CollectiveHostWorkFocus = z.infer<typeof collectiveHostWorkFocusSchema>;
export type CollectiveClientWorldDirectory = z.infer<typeof collectiveClientWorldDirectorySchema>;
export type CollectiveHostWorldDirectoryInit = z.infer<typeof collectiveHostWorldDirectoryInitSchema>;
export type CollectiveHostWorldSelection = z.infer<typeof collectiveHostWorldSelectionSchema>;
export type CollectiveWorldDirectoryMembership = z.infer<typeof collectiveWorldDirectoryMembershipSchema>;

// Human session commands share this bridge's exact frame and current public coordinates.
export * from './collective-work-policy-bridge.js';
