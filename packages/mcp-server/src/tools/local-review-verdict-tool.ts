import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

export const localReviewVerdictInputSchema = {
  messageId: z
    .string()
    .regex(/^[^:\s]+$/)
    .describe('Persisted local verdict message returned to the author with post_message or cross_post_message.'),
  reviewedHeadSha: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .describe('Exact lowercase Git object ID reviewed by this action-successor generation.'),
  verdict: z
    .enum(['approved', 'changes_requested', 'commented'])
    .describe('Canonical verdict token already present in the persisted verdict message.'),
  actionLeaseRef: z
    .object({
      leaseId: z.string().min(1).describe('Canonical action-successor lease id.'),
      generation: z.number().int().positive().describe('Canonical action-successor lease generation.'),
    })
    .strict()
    .optional()
    .describe('Usually recovered from the invocation carrier; an explicit value must match that carrier exactly.'),
};

export async function handleLocalReviewVerdict(input: {
  messageId: string;
  reviewedHeadSha: string;
  verdict: 'approved' | 'changes_requested' | 'commented';
  actionLeaseRef?: { leaseId: string; generation: number };
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/record-local-review-verdict', {
    messageId: input.messageId,
    reviewedHeadSha: input.reviewedHeadSha,
    verdict: input.verdict,
    ...(input.actionLeaseRef ? { actionLeaseRef: input.actionLeaseRef } : {}),
  });
}

export const localReviewVerdictTools = [
  {
    name: 'cat_cafe_record_local_review_verdict',
    description:
      'Complete one local-cat review action from an already persisted exact-HEAD verdict message. ' +
      'Use when: you are the current local reviewer lease holder and have returned APPROVE, REQUEST_CHANGES, or COMMENT to the author. ' +
      'NOT for: external/community reviews, self-review, drafting verdict text, GitHub delivery, or merging. ' +
      'Output: machine-verifies the message author, tenant, holder thread, predecessor route, generation, exact HEAD, and verdict token, then settles only that lease fence. ' +
      'GOTCHA: call cat_cafe_post_message or cat_cafe_cross_post_message first and pass its messageId; this tool accepts no free-form review body and never substitutes for delivery.',
    inputSchema: localReviewVerdictInputSchema,
    handler: handleLocalReviewVerdict,
  },
] as const;
