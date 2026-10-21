import { z } from 'zod';
import { actionSubjectRefSchema } from './action-subject-ref.js';

export const ACTION_SUCCESSOR_ACTION_FAMILIES = [
  'review',
  'merge',
  'investigate',
  'implement',
  'verify',
  'vision_guard',
] as const;

export const ACTION_SUCCESSOR_SLOTS = [
  'reviewer',
  'merge_owner',
  'investigator',
  'implementer',
  'verifier',
  'vision_guardian',
] as const;

export type ActionSuccessorActionFamily = (typeof ACTION_SUCCESSOR_ACTION_FAMILIES)[number];
export type ActionSuccessorSlot = (typeof ACTION_SUCCESSOR_SLOTS)[number];
export type ActionSuccessorMode = 'single' | 'parallel';
export type ActionSuccessorClaimOrigin = 'structured_transfer' | 'existing_standing';

export const ACTION_TERMINAL_PREDICATE_KINDS = [
  'pr_merged',
  'ci_passed',
  'test_passed',
  'durable_verdict',
  'task_done',
] as const;

export type ActionTerminalPredicateKind = (typeof ACTION_TERMINAL_PREDICATE_KINDS)[number];

const canonicalGitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'expected a canonical 40- or 64-character lowercase Git OID');

export const DISPATCH_PROPOSED_ACTION_CAPABILITIES = [
  {
    actionFamily: 'implement',
    successorSlot: 'implementer',
    terminalPredicateKind: 'task_done',
  },
] as const;

const [implementProposalCapability] = DISPATCH_PROPOSED_ACTION_CAPABILITIES;

const proposedActionCommonShape = {
  mode: z
    .enum(['single', 'parallel'])
    .describe('single requires one unique target; parallel requires at least two unique targets.'),
  parallelIntent: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe('Required only for parallel mode; explain why the targets act independently.'),
  claimOrigin: z
    .literal('structured_transfer')
    .optional()
    .describe('Optional explicit default; approval proposals create only a new structured transfer.'),
};

const implementDispatchProposedActionSchema = z
  .object({
    subjectRef: z
      .string()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: U+001F is the identity-key delimiter and must be excluded explicitly.
      .regex(/^subject:task:[^\s\x1f]{1,200}$/)
      .describe('Exact task subject: subject:task:<taskId>.'),
    actionFamily: z.literal(implementProposalCapability.actionFamily).describe('Executable family: implement.'),
    successorSlot: z
      .literal(implementProposalCapability.successorSlot)
      .describe('Required slot for implementation: implementer.'),
    ...proposedActionCommonShape,
    terminalPredicate: z
      .object({
        kind: z
          .literal(implementProposalCapability.terminalPredicateKind)
          .describe('Implementation completion is the canonical task status transition to done.'),
      })
      .strict()
      .describe('Task-backed implementation completion predicate.'),
  })
  .strict();

export const dispatchProposedActionInputSchema = implementDispatchProposedActionSchema.superRefine((value, ctx) => {
  if (value.mode === 'parallel' && !value.parallelIntent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parallelIntent'],
      message: 'parallel proposed action requires explicit parallelIntent',
    });
  }
  if (value.mode === 'single' && value.parallelIntent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parallelIntent'],
      message: 'single proposed action cannot declare parallel intent',
    });
  }
});

export type DispatchProposedActionInput = z.infer<typeof dispatchProposedActionInputSchema>;

export const actionTerminalPredicateInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr_merged') }).strict(),
  z.object({ kind: z.literal('ci_passed'), headSha: canonicalGitObjectIdSchema }).strict(),
  z
    .object({
      kind: z.literal('test_passed'),
      commandDigest: z.string().trim().min(1).max(128),
      revisionSha: z.string().trim().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('durable_verdict'),
      verdictRef: z.string().trim().min(1).max(300),
      freshnessKey: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal('task_done') }).strict(),
]);

export type ActionTerminalPredicateInput = z.infer<typeof actionTerminalPredicateInputSchema>;

const ACTION_SLOTS: Record<ActionSuccessorActionFamily, ReadonlySet<ActionSuccessorSlot>> = {
  review: new Set(['reviewer']),
  merge: new Set(['reviewer', 'merge_owner', 'vision_guardian']),
  investigate: new Set(['investigator', 'reviewer']),
  implement: new Set(['implementer']),
  verify: new Set(['verifier', 'reviewer']),
  vision_guard: new Set(['vision_guardian']),
};

export function isAllowedActionSuccessorSlot(
  actionFamily: ActionSuccessorActionFamily,
  successorSlot: string,
): successorSlot is ActionSuccessorSlot {
  return ACTION_SLOTS[actionFamily].has(successorSlot as ActionSuccessorSlot);
}

export const actionSuccessorMetadataObjectSchema = z.object({
  subjectRef: actionSubjectRefSchema,
  actionFamily: z.enum(ACTION_SUCCESSOR_ACTION_FAMILIES),
  successorSlot: z.enum(ACTION_SUCCESSOR_SLOTS),
  mode: z.enum(['single', 'parallel']),
  parallelIntent: z.string().min(1).max(120).optional(),
  claimOrigin: z
    .enum(['structured_transfer', 'existing_standing'])
    .optional()
    .describe('Defaults to structured_transfer; existing_standing reuses the same custody CAS after grounding.'),
  groundingEvidenceRef: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Required durable grounding for claimOrigin=existing_standing. For a canonical Task-owner replacement of an initial terminal delegate in the same approved child, pass the exact direct-human message:<id>; the server re-reads it and never treats prose alone as the grant.',
    ),
  terminalPredicate: actionTerminalPredicateInputSchema
    .optional()
    .describe('Typed completion parameters; server catalog owns predicate semantics and subject binding.'),
  replace: z
    .object({
      leaseId: z.string().min(1).max(200),
      expectedGeneration: z.number().int().positive(),
    })
    .optional(),
  returnToPredecessor: z
    .object({
      leaseId: z.string().min(1).max(200),
      expectedGeneration: z.number().int().positive(),
      groundingEvidenceRef: z
        .string()
        .min(1)
        .max(300)
        .describe('Evidence that the current holder is not the correct owner.'),
    })
    .describe(
      'Reject current custody: single mode atomically returns to the predecessor; parallel mode terminates only the rejecting holder.',
    )
    .optional(),
});

export type ActionSuccessorMetadataValue = z.infer<typeof actionSuccessorMetadataObjectSchema>;

function refineSlotAndMode(value: ActionSuccessorMetadataValue, ctx: z.RefinementCtx): void {
  if (!isAllowedActionSuccessorSlot(value.actionFamily, value.successorSlot)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['successorSlot'],
      message: `successor slot ${value.successorSlot} is not allowed for ${value.actionFamily}`,
    });
  }
  if (value.mode === 'parallel' && !value.parallelIntent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parallelIntent'],
      message: 'parallel action requires explicit parallelIntent',
    });
  }
  if (value.mode === 'single' && value.parallelIntent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parallelIntent'],
      message: 'single action cannot declare parallel intent',
    });
  }
}

function refineClaimOrigin(value: ActionSuccessorMetadataValue, ctx: z.RefinementCtx): void {
  if (value.claimOrigin === 'existing_standing' && !value.groundingEvidenceRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groundingEvidenceRef'],
      message: 'existing-standing claim requires groundingEvidenceRef',
    });
  }
  if (value.claimOrigin === 'existing_standing' && value.mode !== 'single') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claimOrigin'],
      message: 'existing-standing claim requires single mode',
    });
  }
}

function refineReturn(value: ActionSuccessorMetadataValue, ctx: z.RefinementCtx): void {
  if (value.returnToPredecessor && value.replace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['returnToPredecessor'],
      message: 'return-to-predecessor and replace are mutually exclusive',
    });
  }
  if (value.returnToPredecessor && value.claimOrigin === 'existing_standing') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claimOrigin'],
      message: 'return-to-predecessor is only valid for a structured transfer',
    });
  }
}

function refineTerminalPredicate(value: ActionSuccessorMetadataValue, ctx: z.RefinementCtx): void {
  if (!value.returnToPredecessor && !value.terminalPredicate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['terminalPredicate'],
      message: 'new action custody requires a typed terminalPredicate',
    });
  }
}

export function refineActionSuccessorMetadata(value: ActionSuccessorMetadataValue, ctx: z.RefinementCtx): void {
  refineSlotAndMode(value, ctx);
  refineClaimOrigin(value, ctx);
  refineReturn(value, ctx);
  refineTerminalPredicate(value, ctx);
}

export const actionSuccessorMetadataSchema =
  actionSuccessorMetadataObjectSchema.superRefine(refineActionSuccessorMetadata);

export type ActionSuccessorRequestMetadata = z.infer<typeof actionSuccessorMetadataSchema>;
