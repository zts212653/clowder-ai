import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('external-review-verdict-tool.ts', undefined, {
  resourceFamily: 'tracking-review',
  authority: 'callback-owner',
});

const deliverySchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('delivered'),
        githubUrl: z
          .string()
          .url()
          .describe('GitHub review/comment URL for this exact repository and PR; the API verifies its anchor.'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('pending_delivery'),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe('Why GitHub delivery did not happen in this turn; responsibility remains persistent and owned.'),
      })
      .strict(),
  ])
  .describe('Mandatory delivery custody: either verifiable GitHub proof or persistent pending_delivery reason.');

export const externalReviewVerdictInputSchema = {
  repoFullName: z.string().min(1).describe('External repository in owner/repo format, e.g. "acme/widgets".'),
  prNumber: z.number().int().positive().describe('External pull request number.'),
  reviewedHeadSha: z
    .string()
    .min(7)
    .max(64)
    .describe('Exact Git commit SHA reviewed in this turn; stale HEAD claims fail closed.'),
  verdict: z
    .enum(['approved', 'changes_requested', 'commented'])
    .describe('Reviewer conclusion for the exact reviewed HEAD.'),
  summary: z.string().trim().min(1).max(4000).describe('Concise review conclusion and material findings.'),
  userNudgeRequired: z
    .boolean()
    .optional()
    .describe(
      'Set true only when the operator explicitly had to remind the assigned reviewer for this review generation.',
    ),
  delivery: deliverySchema,
  actionLeaseRef: z
    .object({
      leaseId: z.string().min(1).describe('Canonical action-successor lease id.'),
      generation: z.number().int().positive().describe('Canonical action-successor lease generation.'),
    })
    .strict()
    .optional()
    .describe('Required only when the external-review case carries an action-successor lease fence.'),
};

export async function handleExternalReviewVerdict(input: {
  repoFullName: string;
  prNumber: number;
  reviewedHeadSha: string;
  verdict: 'approved' | 'changes_requested' | 'commented';
  summary: string;
  userNudgeRequired?: boolean;
  delivery: { kind: 'delivered'; githubUrl: string } | { kind: 'pending_delivery'; reason: string };
  actionLeaseRef?: { leaseId: string; generation: number };
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/record-external-review-verdict', {
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    reviewedHeadSha: input.reviewedHeadSha,
    verdict: input.verdict,
    summary: input.summary,
    ...(input.userNudgeRequired === true ? { userNudgeRequired: true } : {}),
    delivery: input.delivery,
    ...(input.actionLeaseRef ? { actionLeaseRef: input.actionLeaseRef } : {}),
  });
}

export const externalReviewVerdictTools = [
  defineTool({
    name: 'cat_cafe_record_external_review_verdict',
    description:
      'Atomically record an external PR review verdict together with its delivery custody for the current HEAD. ' +
      'Use when: you were woken to re-review a configured maintainer-owned external PR and have reached a verdict in this turn. ' +
      'NOT for: ordinary PR tracking, cloud-review progress, self-authored PRs, merging/closing a PR, or a verdict that is not ready to be externally delivered. ' +
      'Output: appends one durable F168 verdict event and returns canonical delivered or pending_delivery state; it never merges or closes GitHub objects. ' +
      'GOTCHA: there is no naked-verdict branch—choose delivered with a same-PR GitHub review/comment URL, or pending_delivery with a concrete reason. ' +
      'GOTCHA: set userNudgeRequired=true only for an explicit operator reminder, never from inferred chat tone. ' +
      'GOTCHA: reviewedHeadSha, assigned reviewer identity, repo policy, terminal state, and optional action lease are verified server-side using invocation credentials; stale or agent-key-only calls fail closed.',
    inputSchema: externalReviewVerdictInputSchema,
    handler: handleExternalReviewVerdict,
    governance: {
      implementationExport: 'handleExternalReviewVerdict',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
