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

export const collectiveLocationSchema = z
  .object({
    channelId: z.string().trim().min(1).max(160),
    rootEventId: collectiveEventIdSchema.optional(),
  })
  .strict();

export const collectiveRecipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel') }).strict(),
  z.object({ kind: z.literal('human'), humanId: collectiveHumanIdSchema }).strict(),
  z
    .object({
      kind: z.literal('agent'),
      humanId: collectiveHumanIdSchema,
      agentId: z.string().trim().min(1).max(120),
      connectionId: collectiveConnectionIdSchema,
      participationRevision: z.number().int().positive(),
    })
    .strict(),
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
    // Optional only for durable legacy history; new events always receive both.
    location: collectiveLocationSchema.optional(),
    recipient: collectiveRecipientSchema.optional(),
    replyToEventId: collectiveEventIdSchema.optional(),
    workRequest: z.literal('entrust').optional(),
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

// F290's experience candidate uses a deliberately reference-only Host seam. It is
// not a pairing extension or a transport path: origin/source checks stay at each
// iframe boundary, while this schema makes it impossible to smuggle a private
// Thread id, message body, credential, or owner-admission payload through it.
export const collectiveF290ExperienceWorkRefSchema = z
  .string()
  .regex(/^work_demo_[A-Za-z0-9_-]+$/)
  .min('work_demo_'.length + 1)
  .max(160);

export type CollectiveF290ExperienceWorkRef = z.infer<typeof collectiveF290ExperienceWorkRefSchema>;

export const collectiveF290ExperienceWorks = [
  { ref: 'work_demo_product-brief', title: '共同空间首页', cat: '砚砚', channelId: 'product-direction' },
  { ref: 'work_demo_architecture-check', title: '接收端装配查漏', cat: '宪宪', channelId: 'product-direction' },
] as const satisfies readonly {
  readonly ref: CollectiveF290ExperienceWorkRef;
  readonly title: string;
  readonly cat: string;
  readonly channelId: 'product-direction' | 'community';
}[];

export function findCollectiveF290ExperienceWork(workRef: CollectiveF290ExperienceWorkRef) {
  return collectiveF290ExperienceWorks.find((work) => work.ref === workRef);
}

export const collectiveF290ExperienceHostRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('collective:f290-experience-open-cafe') }).strict(),
  z
    .object({
      type: z.literal('collective:f290-experience-open-work'),
      workRef: collectiveF290ExperienceWorkRefSchema,
    })
    .strict(),
  z.object({ type: z.literal('collective:f290-experience-close-cafe') }).strict(),
]);

export const collectiveF290ExperienceHostResultSchema = z
  .object({
    type: z.literal('collective:f290-experience-result-ready'),
    workRef: collectiveF290ExperienceWorkRefSchema,
  })
  .strict();

export const collectiveF290ExperienceResultRejectionReasonSchema = z.enum([
  'connection_offline',
  'participation_revoked',
  'unknown_work',
]);

// The Client receipt lets the Host keep its private panel honest: a Host
// result is only complete once the exact embedded Client accepted it. These
// messages deliberately contain only the public Work reference and a bounded
// rejection reason, never private Host data.
export const collectiveF290ExperienceHostResultReceiptSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('collective:f290-experience-result-accepted'),
      workRef: collectiveF290ExperienceWorkRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('collective:f290-experience-result-rejected'),
      workRef: collectiveF290ExperienceWorkRefSchema,
      reason: collectiveF290ExperienceResultRejectionReasonSchema,
    })
    .strict(),
]);

export const collectiveF290ExperienceHostInboundMessageSchema = z.discriminatedUnion('type', [
  ...collectiveF290ExperienceHostRequestSchema.options,
  ...collectiveF290ExperienceHostResultReceiptSchema.options,
]);

export const collectiveF290ExperienceHostMessageSchema = z.discriminatedUnion('type', [
  ...collectiveF290ExperienceHostInboundMessageSchema.options,
  collectiveF290ExperienceHostResultSchema,
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
    target: collectiveTargetSchema.optional(),
    location: collectiveLocationSchema.optional(),
    recipient: collectiveRecipientSchema.optional(),
    replyToEventId: collectiveEventIdSchema.optional(),
    workRequest: z.literal('entrust').optional(),
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
    target: collectiveTargetSchema.optional(),
    location: collectiveLocationSchema.optional(),
    recipient: collectiveRecipientSchema.optional(),
    participationRevision: z.number().int().positive().optional(),
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
export type CollectiveLocation = z.infer<typeof collectiveLocationSchema>;
export type CollectiveRecipient = z.infer<typeof collectiveRecipientSchema>;
export type CollectiveEventEnvelope = z.infer<typeof collectiveEventEnvelopeSchema>;
export type CollectivePairingIntent = z.infer<typeof collectivePairingIntentSchema>;
export type CollectivePairingIntentMessage = z.infer<typeof collectivePairingIntentMessageSchema>;
export type CollectivePairingBridgeErrorCode = z.infer<typeof collectivePairingBridgeErrorCodeSchema>;
export type CollectivePairingBridgeMessage = z.infer<typeof collectivePairingBridgeMessageSchema>;
export type CollectivePairingMessage = z.infer<typeof collectivePairingMessageSchema>;
export type CollectivePairingHostRequest = z.infer<typeof collectivePairingHostRequestSchema>;
export type CollectiveF290ExperienceHostRequest = z.infer<typeof collectiveF290ExperienceHostRequestSchema>;
export type CollectiveF290ExperienceHostResult = z.infer<typeof collectiveF290ExperienceHostResultSchema>;
export type CollectiveF290ExperienceResultRejectionReason = z.infer<
  typeof collectiveF290ExperienceResultRejectionReasonSchema
>;
export type CollectiveF290ExperienceHostResultReceipt = z.infer<typeof collectiveF290ExperienceHostResultReceiptSchema>;
export type CollectiveF290ExperienceHostInboundMessage = z.infer<
  typeof collectiveF290ExperienceHostInboundMessageSchema
>;
export type CollectiveF290ExperienceHostMessage = z.infer<typeof collectiveF290ExperienceHostMessageSchema>;
export type CollectivePairingExchangeRequest = z.infer<typeof collectivePairingExchangeRequestSchema>;
export type CollectiveAckRequest = z.infer<typeof collectiveAckRequestSchema>;
export type CollectivePollRequest = z.infer<typeof collectivePollRequestSchema>;
export type CollectiveHumanMessageRequest = z.infer<typeof collectiveHumanMessageRequestSchema>;
export type CollectiveAgentMessageRequest = z.infer<typeof collectiveAgentMessageRequestSchema>;
