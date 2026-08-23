import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';

import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('local-review-verdict-tool.ts', undefined, {
  resourceFamily: 'tracking-review',
  authority: 'callback-owner',
});

export const localReviewVerdictInputSchema = {
  messageId: z
    .string()
    .regex(/^[^:\s]+$/)
    .describe('Persisted local verdict message returned to the author with post_message or cross_post_message.'),
  actionLeaseRef: z
    .object({
      leaseId: z.string().min(1).describe('Canonical action-successor lease id.'),
      generation: z.number().int().positive().describe('Canonical action-successor lease generation.'),
    })
    .strict()
    .optional()
    .describe('Usually recovered from the invocation carrier; an explicit value must match that carrier exactly.'),
};

export const localReviewRecoveryInputSchema = {
  messageId: localReviewVerdictInputSchema.messageId,
  actionLeaseRef: z
    .object({
      leaseId: z.string().min(1).describe('Exact active stale review lease id.'),
      generation: z.number().int().positive().describe('Exact active stale review lease generation.'),
    })
    .strict()
    .describe('Required locator; authority is re-resolved from predecessor custody and persisted server truth.'),
};

export async function handleLocalReviewVerdict(input: {
  messageId: string;
  actionLeaseRef?: { leaseId: string; generation: number };
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/record-local-review-verdict', {
    messageId: input.messageId,
    ...(input.actionLeaseRef ? { actionLeaseRef: input.actionLeaseRef } : {}),
  });
}

export async function handleRecoverLocalReviewVerdict(input: {
  messageId: string;
  actionLeaseRef: { leaseId: string; generation: number };
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/recover-local-review-verdict', input);
}

export const localReviewVerdictTools = [
  defineTool({
    name: 'cat_cafe_record_local_review_verdict',
    description:
      'Replay settlement for one already persisted typed local-review terminal message. ' +
      'Use when: a prior post_message/cross_post_message with localReviewVerdict persisted but its inline settlement response was interrupted. ' +
      'NOT for: ordinary review delivery (put localReviewVerdict on the terminal post), external/community reviews, self-review, GitHub delivery, or merging. ' +
      'Output: re-resolves the typed message fact and invocation carrier, derives subject/HEAD/holder/route/tenant/lease/generation server-side, and idempotently settles that fence. ' +
      'GOTCHA: messageId is only a locator; public message prose and caller-supplied verdict/HEAD never authorize settlement.',
    inputSchema: localReviewVerdictInputSchema,
    handler: handleLocalReviewVerdict,
    governance: {
      implementationExport: 'handleLocalReviewVerdict',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_recover_local_review_verdict',
    description:
      'Settle one active stale local-review generation from a verdict already returned to its persisted predecessor. ' +
      'Use when: the sole holder verdict is durable, its exact lease carrier is unavailable, and the server-observed PR HEAD has advanced. ' +
      'NOT for: ordinary holder completion, ordinary active replacement, returned generations, admin closure, current-HEAD reviews, or caller-authored verdicts. ' +
      'Output: authenticates the persisted predecessor cat and tenant from any later invocation, re-verifies the typed message fact, exact structured route, sole holder provenance, server-owned frozen HEAD, advanced server HEAD, untouched generation, and then records one idempotent existing-lease CAS outcome. ' +
      'GOTCHA: actionLeaseRef is only a locator; it grants no authority and must name the exact active generation.',
    inputSchema: localReviewRecoveryInputSchema,
    handler: handleRecoverLocalReviewVerdict,

    governance: {
      implementationExport: 'handleRecoverLocalReviewVerdict',
      action: 'recover',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
