import { z } from 'zod';

const stableId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));

export const collectiveServiceInstanceIdSchema = stableId('svc_');
export const collectiveIdSchema = stableId('col_');
export const collectiveConnectionIdSchema = stableId('con_');
export const collectiveEndpointIdSchema = stableId('ep_');
export const collectiveEventIdSchema = stableId('evt_');
export const collectivePairingIntentIdSchema = stableId('pair_');
export const collectiveHumanIdSchema = stableId('human_');
export const collectiveServiceUrlSchema = z
  .string()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));

export const collectiveCoordinatesSchema = z
  .object({
    serviceInstanceId: collectiveServiceInstanceIdSchema,
    collectiveId: collectiveIdSchema,
  })
  .strict();

export const collectiveConnectionCoordinatesSchema = collectiveCoordinatesSchema
  .extend({ connectionId: collectiveConnectionIdSchema })
  .strict();

export const collectiveClientAnchorSchema = collectiveConnectionCoordinatesSchema
  .extend({
    kind: z.literal('collective-client'),
    serviceUrl: collectiveServiceUrlSchema,
    clientBuildId: z.string().trim().min(1).max(120),
  })
  .strict();

export const collectiveHumanActorSchema = z
  .object({
    kind: z.literal('human'),
    humanId: collectiveHumanIdSchema,
    displayName: z.string().trim().min(1).max(120),
    avatarUrl: z.string().url().optional(),
  })
  .strict();

export const collectiveAgentActorSchema = z
  .object({
    kind: z.literal('agent'),
    human: collectiveHumanActorSchema.omit({ kind: true }).strict(),
    agent: z
      .object({
        agentId: z.string().trim().min(1).max(120),
        displayName: z.string().trim().min(1).max(120),
      })
      .strict(),
    provenance: z
      .object({
        connectionId: collectiveConnectionIdSchema,
        endpointId: collectiveEndpointIdSchema,
        endpointLabel: z.string().trim().min(1).max(160).optional(),
        catId: z.string().trim().min(1).max(120),
        sessionRef: z.string().trim().min(1).max(240),
      })
      .strict(),
  })
  .strict();

export const collectiveActorSchema = z.discriminatedUnion('kind', [
  collectiveHumanActorSchema,
  collectiveAgentActorSchema,
]);

export const collectiveTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel'), channelId: z.string().trim().min(1).max(160) }).strict(),
  z.object({ kind: z.literal('message'), eventId: collectiveEventIdSchema }).strict(),
  z.object({ kind: z.literal('human'), humanId: collectiveHumanIdSchema }).strict(),
  z
    .object({
      kind: z.literal('agent'),
      humanId: collectiveHumanIdSchema,
      agentId: z.string().trim().min(1).max(120),
    })
    .strict(),
]);

export const collectiveEventEnvelopeSchema = collectiveCoordinatesSchema
  .extend({
    eventId: collectiveEventIdSchema,
    clientEventId: z.string().trim().min(1).max(200),
    sequence: z.number().int().positive(),
    actor: collectiveActorSchema,
    target: collectiveTargetSchema,
    replyToEventId: collectiveEventIdSchema.optional(),
    body: z.string().trim().min(1).max(32_000),
    acceptedAt: z.string().datetime(),
  })
  .strict();

export const collectivePairingIntentSchema = collectiveCoordinatesSchema
  .extend({
    pairingIntentId: collectivePairingIntentIdSchema,
    hostOrigin: z.string().url(),
    nonce: z.string().min(16).max(200),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const collectivePairingIntentMessageSchema = z
  .object({
    type: z.literal('collective:pairing-intent'),
    serviceUrl: collectiveServiceUrlSchema,
    intent: collectivePairingIntentSchema,
  })
  .strict();

export const collectivePairingBridgeReadyMessageSchema = z
  .object({
    type: z.literal('collective:pairing-ready'),
    serviceUrl: collectiveServiceUrlSchema,
  })
  .strict();

export const collectivePairingBridgeErrorCodeSchema = z.enum([
  'session_required',
  'collective_required',
  'client_unavailable',
  'pairing_failed',
]);

export const collectivePairingBridgeErrorMessageSchema = z
  .object({
    type: z.literal('collective:pairing-error'),
    serviceUrl: collectiveServiceUrlSchema,
    code: collectivePairingBridgeErrorCodeSchema,
  })
  .strict();

export const collectivePairingBridgeMessageSchema = z.discriminatedUnion('type', [
  collectivePairingBridgeReadyMessageSchema,
  collectivePairingBridgeErrorMessageSchema,
]);

export const collectivePairingMessageSchema = z.discriminatedUnion('type', [
  collectivePairingIntentMessageSchema,
  collectivePairingBridgeReadyMessageSchema,
  collectivePairingBridgeErrorMessageSchema,
]);

export const collectivePairingHostRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('collective:request-pairing') }).strict(),
  z.object({ type: z.literal('collective:request-pairing-status') }).strict(),
]);

export const collectivePairingExchangeRequestSchema = collectivePairingIntentSchema
  .pick({
    serviceInstanceId: true,
    collectiveId: true,
    pairingIntentId: true,
    hostOrigin: true,
    nonce: true,
  })
  .extend({
    endpointLabel: z.string().trim().min(1).max(160),
  })
  .strict();

export const collectiveAckRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({ sequence: z.number().int().nonnegative() })
  .strict();

export const collectivePollRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();

export const collectiveHumanMessageRequestSchema = collectiveCoordinatesSchema
  .extend({
    clientEventId: z.string().trim().min(1).max(200),
    target: collectiveTargetSchema,
    replyToEventId: collectiveEventIdSchema.optional(),
    body: z.string().trim().min(1).max(32_000),
  })
  .strict();

export const collectiveAgentMessageRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    clientEventId: z.string().trim().min(1).max(200),
    agent: z
      .object({
        agentId: z.string().trim().min(1).max(120),
        displayName: z.string().trim().min(1).max(120),
        catId: z.string().trim().min(1).max(120),
        sessionRef: z.string().trim().min(1).max(240),
      })
      .strict(),
    target: collectiveTargetSchema,
    replyToEventId: collectiveEventIdSchema.optional(),
    body: z.string().trim().min(1).max(32_000),
  })
  .strict();

export type CollectiveCoordinates = z.infer<typeof collectiveCoordinatesSchema>;
export type CollectiveConnectionCoordinates = z.infer<typeof collectiveConnectionCoordinatesSchema>;
export type CollectiveClientAnchor = z.infer<typeof collectiveClientAnchorSchema>;
export type CollectiveHumanActor = z.infer<typeof collectiveHumanActorSchema>;
export type CollectiveAgentActor = z.infer<typeof collectiveAgentActorSchema>;
export type CollectiveActor = z.infer<typeof collectiveActorSchema>;
export type CollectiveTarget = z.infer<typeof collectiveTargetSchema>;
export type CollectiveEventEnvelope = z.infer<typeof collectiveEventEnvelopeSchema>;
export type CollectivePairingIntent = z.infer<typeof collectivePairingIntentSchema>;
export type CollectivePairingIntentMessage = z.infer<typeof collectivePairingIntentMessageSchema>;
export type CollectivePairingBridgeErrorCode = z.infer<typeof collectivePairingBridgeErrorCodeSchema>;
export type CollectivePairingBridgeMessage = z.infer<typeof collectivePairingBridgeMessageSchema>;
export type CollectivePairingMessage = z.infer<typeof collectivePairingMessageSchema>;
export type CollectivePairingHostRequest = z.infer<typeof collectivePairingHostRequestSchema>;
export type CollectivePairingExchangeRequest = z.infer<typeof collectivePairingExchangeRequestSchema>;
export type CollectiveAckRequest = z.infer<typeof collectiveAckRequestSchema>;
export type CollectivePollRequest = z.infer<typeof collectivePollRequestSchema>;
export type CollectiveHumanMessageRequest = z.infer<typeof collectiveHumanMessageRequestSchema>;
export type CollectiveAgentMessageRequest = z.infer<typeof collectiveAgentMessageRequestSchema>;
