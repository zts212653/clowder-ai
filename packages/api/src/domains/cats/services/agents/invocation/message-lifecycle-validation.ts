import type { LifecycleResponseBubble, MessageContent } from '@cat-cafe/shared';
import { CatRoutingErrorSchema, MessageContentsSchema } from '@cat-cafe/shared';
import { z } from 'zod';

export type LifecycleQueueEntryValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const NonEmptyStringSchema = z.string().min(1);
const UniqueTargetsSchema = z
  .array(NonEmptyStringSchema)
  .refine((targets) => new Set(targets).size === targets.length, 'targets must be unique');
const NonEmptyUniqueTargetsSchema = z
  .array(NonEmptyStringSchema)
  .min(1)
  .refine((targets) => new Set(targets).size === targets.length, 'targets must be unique');

const LifecycleMessageFromSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal('agent'), catId: NonEmptyStringSchema }).strict(),
  z
    .object({
      kind: z.literal('external'),
      connectorId: NonEmptyStringSchema,
      sender: z.object({ id: NonEmptyStringSchema, name: z.string().optional() }).strict().optional(),
      address: z
        .object({ chatId: NonEmptyStringSchema, messageId: NonEmptyStringSchema.optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('plugin'), instanceId: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal('system'), service: NonEmptyStringSchema }).strict(),
]);

const InlinePayloadSchema = z
  .object({
    type: z.literal('inline'),
    body: MessageContentsSchema,
    routingWarnings: z.array(CatRoutingErrorSchema).optional(),
  })
  .strict();

const MessageRefPayloadSchema = z.object({ type: z.literal('message_ref'), messageId: NonEmptyStringSchema }).strict();

const queueEntryBaseShape = {
  id: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  from: LifecycleMessageFromSchema,
  ownerAuthProvenance: z.enum(['strict', 'compatibility_fallback', 'unknown']),
  priority: z.enum(['urgent', 'normal']),
  enqueuedAt: z.number().finite(),
};

/** Complete runtime counterpart of the shared LifecycleQueueEntry union. */
export const LifecycleQueueEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...queueEntryBaseShape,
      kind: z.literal('conversation_input'),
      sourceRecordId: NonEmptyStringSchema,
      payload: InlinePayloadSchema,
      targets: UniqueTargetsSchema,
      position: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...queueEntryBaseShape,
      kind: z.literal('message_wake'),
      sourceRecordId: z.undefined().optional(),
      payload: MessageRefPayloadSchema,
      targets: NonEmptyUniqueTargetsSchema,
      position: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...queueEntryBaseShape,
      kind: z.literal('private_input'),
      sourceRecordId: z.undefined().optional(),
      payload: InlinePayloadSchema,
      targets: NonEmptyUniqueTargetsSchema,
      position: z.undefined().optional(),
    })
    .strict(),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidQueueEntryReason(value: Record<string, unknown>, path: PropertyKey | undefined): string {
  switch (path) {
    case 'id':
    case 'threadId':
      return 'invalid_identity';
    case 'from':
      return 'invalid_from';
    case 'targets':
      return 'invalid_targets';
    case 'ownerAuthProvenance':
      return 'invalid_owner_auth_provenance';
    case 'priority':
      return 'invalid_priority';
    case 'enqueuedAt':
      return 'invalid_enqueued_at';
    case 'position':
      return 'invalid_position';
    case 'payload':
      return isRecord(value.payload) ? `invalid_${String(value.kind)}` : 'invalid_payload';
    default:
      return ['conversation_input', 'message_wake', 'private_input'].includes(String(value.kind))
        ? `invalid_${String(value.kind)}`
        : 'invalid_kind';
  }
}

/** Validate the complete discriminated Queue envelope before owner lookup or client effect. */
export function validateLifecycleQueueEntry(value: unknown): LifecycleQueueEntryValidation {
  if (!isRecord(value)) return { valid: false, reason: 'entry_not_object' };
  const result = LifecycleQueueEntrySchema.safeParse(value);
  if (result.success) return { valid: true };
  return { valid: false, reason: invalidQueueEntryReason(value, result.error.issues[0]?.path[0]) };
}

export interface LifecycleTerminalInput {
  readonly status: Exclude<LifecycleResponseBubble['status'], 'processing'>;
  readonly body: readonly MessageContent[];
  readonly completedAt: number;
  readonly reason?: string;
}

const LifecycleTerminalInputSchema = z
  .object({
    status: z.enum(['completed', 'failed', 'canceled', 'interrupted']),
    body: MessageContentsSchema,
    completedAt: z.number().finite(),
    reason: z.string().optional(),
  })
  .strict();

export function isLifecycleTerminalInput(value: unknown): value is LifecycleTerminalInput {
  return LifecycleTerminalInputSchema.safeParse(value).success;
}
