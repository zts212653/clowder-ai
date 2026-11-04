import type { UnifiedAttentionRuntimeInteraction } from '@cat-cafe/shared';
import { richBlockSchema, unifiedAttentionChoiceRequestSchema } from '@cat-cafe/shared';
import { z } from 'zod';

const base = unifiedAttentionChoiceRequestSchema.omit({ questions: true });
const provider = base.extend({
  sourceKind: z.literal('provider_request').optional(),
  kind: z.enum(['approval', 'question', 'elicitation']),
});
const conversation = base.extend({
  sourceKind: z.literal('conversation_decision'),
  kind: z.literal('conversation_decision'),
  presentation: richBlockSchema,
  allowTextResponse: z.boolean(),
  deadlineAt: z.number().int().nonnegative().optional(),
});

/** Retain canonical card identity privately; the renderer receives only an opaque navigation reference. */
export const companionRuntimeInteractionSchema = z.union([provider, conversation]).transform((value, context) => {
  if (value.kind !== 'conversation_decision') return value;
  if (
    value.revision < 1 ||
    !value.cardRef.blockDigest ||
    value.cardRef.publishedAt === undefined ||
    value.presentation.kind !== 'interactive' ||
    value.presentation.id !== value.cardRef.blockId
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Runtime card identity is not verified' });
    return z.NEVER;
  }
  return { ...value, presentation: value.presentation } satisfies UnifiedAttentionRuntimeInteraction;
});
