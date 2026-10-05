import type { CompanionReply } from '@clowder-ai/plugin-contract';
import { z } from 'zod';
import type { CompanionOwnerClient } from './companion-owner-client.js';

const pageSchema = z.object({
  status: z.literal('available'),
  approvalCount: z.number().int().nonnegative(),
  needsMeCount: z.number().int().nonnegative(),
  otherNeedsMeCount: z.number().int().nonnegative(),
  approvals: z.array(
    z
      .object({
        proposalId: z.string(),
        sourceFeatureId: z.string(),
        summary: z.string(),
        resolution: z.enum(['open', 'accepted', 'rejected', 'closed_without_decision']),
        materialization: z.object({
          state: z.enum(['not_started', 'outcome_unknown', 'in_progress', 'succeeded', 'failed']),
        }),
        linkedNeedsMe: z.unknown().optional(),
      })
      .passthrough(),
  ),
  otherNeedsMe: z.array(
    z
      .object({
        envelope: z.object({ subjectRef: z.string() }).passthrough(),
        brief: z.unknown().optional(),
      })
      .passthrough(),
  ),
  page: z
    .object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(20),
      hasMoreApprovals: z.boolean(),
      hasMoreNeedsMe: z.boolean(),
    })
    .passthrough(),
});

/** Strip F246/F310 internals before the read-only public renderer bridge. */
export async function readCompanionDecisions(
  client: CompanionOwnerClient,
  offset: number,
  limit: number,
): Promise<CompanionReply> {
  const page = pageSchema.parse(await client.request(`/api/concierge/work/decisions?offset=${offset}&limit=${limit}`));
  return {
    kind: 'decisions',
    status: 'available',
    approvalCount: page.approvalCount,
    needsMeCount: page.needsMeCount,
    otherNeedsMeCount: page.otherNeedsMeCount,
    approvals: page.approvals.map((item) => ({
      proposalId: item.proposalId,
      sourceFeatureId: item.sourceFeatureId,
      summary: item.summary.slice(0, 500),
      resolution: item.resolution,
      materializationState: item.materialization.state,
      linkedNeedsMe: item.linkedNeedsMe !== undefined,
    })),
    otherNeedsMe: page.otherNeedsMe.map((item) => {
      const brief = z
        .object({ outcome: z.object({ value: z.string() }).passthrough().optional() })
        .passthrough()
        .safeParse(item.brief);
      return {
        subjectRef: item.envelope.subjectRef,
        summary: (brief.success ? brief.data.outcome?.value : undefined)?.slice(0, 500) ?? '待处理事项',
      };
    }),
    page: {
      offset: page.page.offset,
      limit: page.page.limit,
      hasMoreApprovals: page.page.hasMoreApprovals,
      hasMoreNeedsMe: page.page.hasMoreNeedsMe,
    },
  };
}
