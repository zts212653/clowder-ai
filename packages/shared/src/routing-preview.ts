import { z } from 'zod';
import type { CatId } from './types/ids.js';

/** Why the server would route the draft to the projected recipients. */
const ROUTING_PREVIEW_BASE_REASONS = [
  'current_message_mentions',
  'previous_user_mentions',
  'recent_replier',
  'preferred_cat',
  'default_cat',
  'preferred_parallel',
  'concierge_preferred',
  'available_participant',
] as const;

export type RoutingPreviewBaseReasonKind = (typeof ROUTING_PREVIEW_BASE_REASONS)[number];
export type RoutingPreviewReasonKind = RoutingPreviewBaseReasonKind | 'thread_policy';

export type RoutingPreviewReason =
  | { kind: RoutingPreviewBaseReasonKind }
  | {
      kind: 'thread_policy';
      /** Present only when a thread routing policy changed the base fallback choice. */
      baseKind?: RoutingPreviewBaseReasonKind;
    };

export const routingPreviewReasonSchema: z.ZodType<RoutingPreviewReason> = z.union([
  z.object({ kind: z.enum(ROUTING_PREVIEW_BASE_REASONS) }).strict(),
  z
    .object({
      kind: z.literal('thread_policy'),
      baseKind: z.enum(ROUTING_PREVIEW_BASE_REASONS).optional(),
    })
    .strict(),
]);

/** Read-only projection from the same AgentRouter path used by message admission. */
export interface RoutingPreviewResponse {
  targetCats: CatId[];
  reason: RoutingPreviewReason;
  /** Known recipients skipped because they cannot run, never because they are busy. */
  unavailableTargets?: CatId[];
  /** A named recipient is unavailable; public admission requires human approval of the replacement. */
  requiresConfirmation?: boolean;
}

export const routingPreviewResponseSchema: z.ZodType<RoutingPreviewResponse, z.ZodTypeDef, unknown> = z
  .object({
    targetCats: z
      .array(z.string().trim().min(1))
      .max(50)
      .transform((catIds) => catIds as CatId[]),
    reason: routingPreviewReasonSchema,
    unavailableTargets: z
      .array(z.string().trim().min(1))
      .max(50)
      .transform((ids) => ids as CatId[])
      .optional(),
    requiresConfirmation: z.boolean().optional(),
  })
  .strict();

const routingConfirmationMemberSchema = z.object({ catId: z.string().min(1), displayName: z.string().min(1) }).strict();

export const routingConfirmationRequiredSchema = z
  .object({
    code: z.literal('ROUTING_CONFIRMATION_REQUIRED'),
    error: z.string(),
    unavailable: z.array(routingConfirmationMemberSchema).min(1).max(50),
    targets: z.array(routingConfirmationMemberSchema).min(1).max(50),
  })
  .strict();
