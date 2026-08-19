import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('local-review-verdict-tool.ts', undefined, {
  resourceFamily: 'tracking-review',
  authority: 'callback-owner',
});

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

export const localReviewRecoveryInputSchema = {
  messageId: localReviewVerdictInputSchema.messageId,
  reviewedHeadSha: localReviewVerdictInputSchema.reviewedHeadSha,
  verdict: localReviewVerdictInputSchema.verdict,
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

export async function handleRecoverLocalReviewVerdict(input: {
  messageId: string;
  reviewedHeadSha: string;
  verdict: 'approved' | 'changes_requested' | 'commented';
  actionLeaseRef: { leaseId: string; generation: number };
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/recover-local-review-verdict', input);
}

export const localReviewVerdictTools = [
  defineTool({
    name: 'cat_cafe_record_local_review_verdict',
    description:
      'Complete one local-cat review action from an already persisted exact-HEAD verdict message. ' +
      'Use when: you are the current local reviewer lease holder and have returned APPROVE, REQUEST_CHANGES, or COMMENT to the author. ' +
      'NOT for: external/community reviews, self-review, drafting verdict text, GitHub delivery, or merging. ' +
      'Output: machine-verifies the message author, tenant, holder thread, predecessor route, generation, exact HEAD, and verdict token, then settles only that lease fence. ' +
      'GOTCHA: call cat_cafe_post_message or cat_cafe_cross_post_message first and pass its messageId; this tool accepts no free-form review body and never substitutes for delivery.',
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
      'Output: re-verifies the exact structured predecessor route, sole holder message provenance, frozen HEAD, advanced server HEAD, untouched generation, and then records one existing-lease CAS outcome. ' +
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
