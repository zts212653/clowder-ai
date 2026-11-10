import { z } from 'zod';

const ref = z.string().min(1).max(512);

const legacyDotSubscriptionSchema = z
  .object({
    id: ref,
    url: z.string().url().max(2048),
    secret: z.string().max(256),
    expiresAt: z.number().nullable(),
    verifiedAt: z.number(),
    previousSecret: z.string().max(256).nullable().default(null),
    rotationUntil: z.number().nullable().default(null),
  })
  .strict();

export const legacyDotConnectionStateSchema = z
  .object({
    v: z.literal(1),
    revision: z.number().int().positive(),
    ownerUserId: ref,
    pluginInstanceId: ref,
    agentKeyId: ref,
    credentialSecret: z.string().length(64),
    attemptId: ref,
    pairingCode: z.string().min(16).max(128),
    pairingExpiresAt: z.number(),
    pairedAt: z.number().nullable(),
    pairedCallbackUrl: z.string().url().max(2048).nullable().optional(),
    subscription: legacyDotSubscriptionSchema.nullable(),
    lastSourceReadAt: z.number().nullable(),
    lastReplyAt: z.number().nullable(),
    lastImageAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
    allowedCatIds: z.array(ref).max(50).optional(),
    testEventIds: z.array(ref).max(2).default([]),
  })
  .strict()
  .transform(({ allowedCatIds: _retired, ...state }) => state);

export type LegacyDotConnectionState = z.infer<typeof legacyDotConnectionStateSchema>;

export const legacyDotDispatchRecordSchema = z
  .object({
    eventId: z.string().regex(/^dot_evt_[a-f0-9]{64}$/),
    ownerUserId: ref,
    threadId: ref,
    sourceMessageId: ref,
    dispatchInvocationId: ref,
    attemptId: ref,
    agentKeyId: ref,
    occurredAt: z.number(),
    webhookAcknowledgedAt: z.number().nullable(),
    sourceReadAt: z.number().nullable(),
    replyMessageId: ref.nullable(),
    imagePublicationIds: z.array(ref),
    imageReservationIds: z.array(ref).optional(),
    connectionTest: z.boolean().default(false),
    expectedNonce: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
  })
  .strict();

export type LegacyDotDispatchRecord = z.infer<typeof legacyDotDispatchRecordSchema>;
