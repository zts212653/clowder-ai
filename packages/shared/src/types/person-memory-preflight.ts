import { z } from 'zod';
import { personMemorySourceRefSchema } from './person-memory-base.js';
import {
  personMemoryAssertionRoleSchema,
  personMemoryInteractionEvidenceFieldSchema,
} from './person-memory-source-bundle.js';

export const PERSON_MEMORY_PREFLIGHT_ISSUE_CODES = [
  'source_not_eligible',
  'assertion_not_materializable',
  'owner_confirmation_required',
  'informed_approval_incomplete',
  'evidence_excerpt_budget_exceeded',
  'card_token_budget_exceeded',
] as const;

export const personMemoryProposalPreflightIssueSchema = z
  .object({
    code: z.enum(PERSON_MEMORY_PREFLIGHT_ISSUE_CODES),
    message: z.string().trim().min(1).max(400),
    action: z.string().trim().min(1).max(400),
    path: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

export const personMemoryProposalPreflightBudgetSchema = z
  .object({
    kind: z.enum(['evidence_excerpt', 'evidence_excerpt_aggregate', 'candidate_card']),
    estimatedTokens: z.number().int().nonnegative().optional(),
    maxTokens: z.number().int().positive(),
  })
  .strict();

export const personMemoryProposalPreflightBlockSchema = z
  .object({
    status: z.literal('blocked'),
    phase: z.enum(['source', 'materializability', 'informed_approval', 'card_budget']),
    issues: z.array(personMemoryProposalPreflightIssueSchema).min(1).max(24),
    budget: personMemoryProposalPreflightBudgetSchema.optional(),
  })
  .strict();

export const personMemoryInformedEvidenceSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(120),
    sourceKind: z.enum(['message_text', 'message_attachment', 'owner_confirmed_transcript', 'owner_private_artifact']),
    assertionRoles: z
      .array(personMemoryAssertionRoleSchema.exclude(['agent_inference']))
      .min(1)
      .max(3),
    targetFields: z.array(personMemoryInteractionEvidenceFieldSchema).min(1).max(6),
    boundedExcerpt: z.string().trim().min(1).max(800),
    confirmationScope: z.literal('transcript_accuracy').optional(),
    drillSourceRef: personMemorySourceRefSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.assertionRoles).size !== value.assertionRoles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assertionRoles'],
        message: 'informed evidence assertion roles must be unique',
      });
    }
    if (new Set(value.targetFields).size !== value.targetFields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetFields'],
        message: 'informed evidence target fields must be unique',
      });
    }
  });

export type PersonMemoryProposalPreflightIssue = z.infer<typeof personMemoryProposalPreflightIssueSchema>;
export type PersonMemoryProposalPreflightBudget = z.infer<typeof personMemoryProposalPreflightBudgetSchema>;
export type PersonMemoryProposalPreflightBlock = z.infer<typeof personMemoryProposalPreflightBlockSchema>;
export type PersonMemoryInformedEvidence = z.infer<typeof personMemoryInformedEvidenceSchema>;
