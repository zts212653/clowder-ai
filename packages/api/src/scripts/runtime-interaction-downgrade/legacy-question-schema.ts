/**
 * Frozen pre-Phase-C question request schema.
 *
 * This is a deliberate copy of the shared question request contract *before*
 * `multiSelect` and `allowUnanswered` were added. It is the downgrade target:
 * a record is safe to hand to the previous host revision only when it parses
 * here. Do not extend it with new fields — changing it defeats its purpose.
 */

import { entrustedWorkTaskRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';

const nonBlank = z.string().trim().min(1);
const optionalProviderCoordinate = z.string().nullable().optional();

const questionOptionSchema = z
  .object({
    label: nonBlank,
    description: z.string().optional(),
  })
  .strict();

const questionSchema = z
  .object({
    id: nonBlank,
    header: nonBlank,
    question: nonBlank,
    isOther: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    options: z.array(questionOptionSchema).min(1).optional(),
  })
  .strict();

export const legacyRuntimeQuestionRequestSchema = z
  .object({
    version: z.literal(1),
    interactionId: nonBlank,
    owner: z
      .object({
        userId: nonBlank,
        threadId: nonBlank,
        catId: nonBlank,
        invocationId: nonBlank,
      })
      .strict(),
    provider: z
      .object({
        providerId: nonBlank,
        method: nonBlank,
        requestId: z.union([nonBlank, z.number().int()]),
        threadId: optionalProviderCoordinate,
        turnId: optionalProviderCoordinate,
        itemId: optionalProviderCoordinate,
      })
      .strict(),
    createdAt: z.number().int().nonnegative(),
    title: nonBlank,
    description: z.string().optional(),
    entrustedWorkTaskRef: entrustedWorkTaskRefV1Schema.optional(),
    kind: z.literal('question'),
    questions: z.array(questionSchema).min(1),
  })
  .strict()
  .superRefine((request, context) => {
    const ids = request.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'question ids must be unique' });
    }
  });
