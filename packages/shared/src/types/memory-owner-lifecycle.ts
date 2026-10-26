import { z } from 'zod';
import { ENTITY_STANCES } from './entity-proposal.js';
import { COGNITIVE_TRANSITIONS, EVENT_CONFIDENCES } from './event-memory.js';

export const memoryOwnerRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const memoryOwnerRequestIdSchema = z
  .string()
  .trim()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const MEMORY_LIFECYCLE_STATUSES = ['active', 'retired'] as const;
export type MemoryLifecycleStatus = (typeof MEMORY_LIFECYCLE_STATUSES)[number];

const ownerActionBase = {
  requestId: memoryOwnerRequestIdSchema,
  expectedRevision: memoryOwnerRevisionSchema,
};

const hardForgetActionSchema = z
  .object({
    action: z.literal('hard_forget'),
    ...ownerActionBase,
    confirmed: z.literal(true),
  })
  .strict();

const retireActionSchema = z
  .object({
    action: z.literal('retire'),
    ...ownerActionBase,
  })
  .strict();

export const profileMemoryOwnerActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('replace_content'),
      ...ownerActionBase,
      content: z.string().min(1).max(20_000),
    })
    .strict(),
  hardForgetActionSchema,
]);
export type ProfileMemoryOwnerAction = z.infer<typeof profileMemoryOwnerActionSchema>;

export const TASTE_DIMENSIONS = [
  'relationship-stance',
  'cognitive-honesty',
  'architecture-aesthetics',
  'visual-quality',
  'authentic-expression',
  'system-philosophy',
  'creative-craft',
] as const;

const tasteCorrectionPatchSchema = z
  .object({
    takeaway: z.string().trim().min(1).max(500).nullable().optional(),
    quotes: z.array(z.string().trim().min(1).max(2_000)).max(16).optional(),
    scene: z.string().trim().min(1).max(8_000).optional(),
    tags: z.array(z.string().trim().min(1).max(160)).min(1).max(24).optional(),
    dimension: z.enum(TASTE_DIMENSIONS).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Taste correction patch must not be empty' });
export type TasteMemoryCorrectionPatch = z.infer<typeof tasteCorrectionPatchSchema>;

export const MEMORY_CORRECTION_REASONS = ['unsupported_by_source', 'outdated', 'not_applicable_here'] as const;
export const memoryCorrectionReasonSchema = z.enum(MEMORY_CORRECTION_REASONS);
export type MemoryCorrectionReason = z.infer<typeof memoryCorrectionReasonSchema>;

const tasteVignetteAnchorSchema = z
  .string()
  .regex(/^taste-vignette:(?:docs\/taste\/vignettes|private\/taste)\/[\p{L}\p{N}][\p{L}\p{N}._-]*\.md$/u);

export const tasteMemoryCorrectionTargetSchema = z
  .object({
    sourceAnchor: tasteVignetteAnchorSchema,
    expectedRevision: memoryOwnerRevisionSchema,
    reason: memoryCorrectionReasonSchema,
    suggestedPatch: tasteCorrectionPatchSchema,
  })
  .strict();
export type TasteMemoryCorrectionTarget = z.infer<typeof tasteMemoryCorrectionTargetSchema>;

export const tasteMemoryCorrectionProposalInputSchema = z
  .object({
    target: tasteMemoryCorrectionTargetSchema,
    clientRequestId: memoryOwnerRequestIdSchema,
  })
  .strict();
export type TasteMemoryCorrectionProposalInput = z.infer<typeof tasteMemoryCorrectionProposalInputSchema>;

export const tasteMemoryOwnerActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('confirm_takeaway'),
      ...ownerActionBase,
      candidateRevision: memoryOwnerRevisionSchema,
      takeaway: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal('correct'),
      ...ownerActionBase,
      patch: tasteCorrectionPatchSchema,
    })
    .strict(),
  retireActionSchema,
  hardForgetActionSchema,
]);
export type TasteMemoryOwnerAction = z.infer<typeof tasteMemoryOwnerActionSchema>;

const entityCorrectionPatchSchema = z
  .object({
    entityType: z.enum(['person', 'cat', 'feature', 'concept', 'external']).optional(),
    canonicalName: z.string().trim().min(1).max(200).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    stance: z.enum(ENTITY_STANCES).optional(),
    visibilityScope: z.literal('workspace').optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Entity correction patch must not be empty' });
export type EntityMemoryCorrectionPatch = z.infer<typeof entityCorrectionPatchSchema>;

export const entityMemoryOwnerActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('correct'),
      ...ownerActionBase,
      patch: entityCorrectionPatchSchema,
    })
    .strict(),
  retireActionSchema,
  hardForgetActionSchema,
]);
export type EntityMemoryOwnerAction = z.infer<typeof entityMemoryOwnerActionSchema>;

const eventCorrectionPatchSchema = z
  .object({
    summary: z.string().trim().min(1).max(1_000_000).optional(),
    cognitiveTransition: z.enum(COGNITIVE_TRANSITIONS).nullable().optional(),
    relatedHarness: z.array(z.string().trim().min(1).max(500)).max(24).nullable().optional(),
    confidence: z.enum(EVENT_CONFIDENCES).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Event correction patch must not be empty' });
export type EventMemoryCorrectionPatch = z.infer<typeof eventCorrectionPatchSchema>;

export const eventMemoryCorrectionProposalInputSchema = z
  .object({
    eventId: z.string().trim().min(1).max(200),
    expectedRevision: memoryOwnerRevisionSchema,
    reason: memoryCorrectionReasonSchema,
    suggestedPatch: eventCorrectionPatchSchema,
    clientRequestId: memoryOwnerRequestIdSchema,
  })
  .strict();
export type EventMemoryCorrectionProposalInput = z.infer<typeof eventMemoryCorrectionProposalInputSchema>;

export const eventMemoryOwnerActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('correct'),
      ...ownerActionBase,
      patch: eventCorrectionPatchSchema,
    })
    .strict(),
  retireActionSchema,
  hardForgetActionSchema,
]);
export type EventMemoryOwnerAction = z.infer<typeof eventMemoryOwnerActionSchema>;

export type MemoryOwnerAction =
  | ProfileMemoryOwnerAction
  | TasteMemoryOwnerAction
  | EntityMemoryOwnerAction
  | EventMemoryOwnerAction;

export type MemoryOwnerActionKind = MemoryOwnerAction['action'];
export type MemoryOwnerActionOutcome = 'applied' | 'replayed';
export type MemoryOwnerActionError =
  | 'invalid_content'
  | 'not_available'
  | 'stale_revision'
  | 'source_unavailable'
  | 'candidate_unavailable'
  | 'conflict'
  | 'idempotency_conflict'
  | 'mutation_unavailable';

export interface MemoryOwnerForgetScope {
  canonicalMemory: 'deleted';
  derivedProjections: 'invalidated';
  originalSource: 'preserved';
  immutableAudit: 'not_applicable' | 'redacted' | 'retained';
}

export interface MemoryOwnerActionReceipt {
  action: MemoryOwnerActionKind;
  outcome: MemoryOwnerActionOutcome;
  memoryId: string;
  revision?: string;
  status?: MemoryLifecycleStatus;
  forgetScope?: MemoryOwnerForgetScope;
}

export interface MemoryOwnerSourceCoordinate {
  label: string;
  occurredAt: number | null;
  canOpen: boolean;
  threadId?: string;
  messageId?: string;
}

export interface MemoryOwnerSourceResponse {
  status: 'ready' | 'not_recorded' | 'unavailable';
  sources: MemoryOwnerSourceCoordinate[];
}
