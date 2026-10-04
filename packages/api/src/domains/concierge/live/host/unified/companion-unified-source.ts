import { isDeepStrictEqual } from 'node:util';
import {
  NEEDS_ME_PRODUCER_IDS,
  type UnifiedAttentionItemV1,
  type UnifiedAttentionReadV1,
  unifiedAttentionApprovalsSourceSchema,
  unifiedAttentionWorkSourceSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { CompanionBridgeError } from '../../companion-owner-client.js';

const source = z.object({
  status: z.enum(['available', 'unavailable', 'unauthenticated', 'forbidden', 'invalid']),
  startedAt: z.number().finite().nonnegative(),
  observedAt: z.number().finite().nonnegative(),
  coverage: z.enum(['all_registered_F246_producers', 'current_linked_F310_five_producers']),
  exhaustiveness: z.enum(['complete', 'partial', 'unknown']),
});
const row = z.object({
  decisionRef: z.string().min(1),
  kind: z.enum(['approval', 'judgment', 'repair']),
  summary: z.string(),
  approval: z.record(z.unknown()).optional(),
  linkedNeedsMe: z.array(z.object({ ownerRead: z.unknown(), receipt: z.unknown() })),
});
const read = z.object({
  version: z.literal(1),
  status: z.enum(['available', 'partial', 'unavailable']),
  scope: z.literal('owner_all_projects'),
  identity: z.object({ ownerUserId: z.string().min(1) }),
  observedAt: z.number().finite().nonnegative(),
  sources: z.object({ approvals: source, needsMe: source }),
  readWindow: z.object({
    startedAt: z.number(),
    endedAt: z.number(),
    consistency: z.literal('independent_source_reads'),
  }),
  consistency: z.object({ state: z.enum(['verified', 'uncertain']), reasons: z.array(z.string()) }),
  items: z.array(row).max(20),
  totalCount: z.number().int().nonnegative().max(1_000_000).optional(),
  page: z.object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(20),
    scope: z.literal('known_rows'),
    hasMore: z.boolean(),
  }),
});

function item(raw: z.infer<typeof row>, ownerUserId: string): UnifiedAttentionItemV1 {
  let approval: UnifiedAttentionItemV1['approval'];
  if (raw.approval) {
    if ('ownerUserId' in raw.approval && raw.approval.ownerUserId !== ownerUserId)
      throw new CompanionBridgeError('permission_required');
    const canonical = unifiedAttentionApprovalsSourceSchema.parse({
      items: [{ ...raw.approval, ownerUserId }],
    }).items[0]!;
    const { ownerUserId: _owner, ...visible } = canonical;
    approval = visible;
  }
  if ((raw.kind === 'approval') !== (approval !== undefined)) throw new CompanionBridgeError('unavailable');
  const linkedNeedsMe = raw.linkedNeedsMe.map((linked) => {
    const work = unifiedAttentionWorkSourceSchema.parse({ ownerReads: [linked.ownerRead] }).ownerReads[0]!;
    if (work.envelope.visibility.ownerUserId !== ownerUserId) throw new CompanionBridgeError('permission_required');
    const receipt = work.attentionReceipts.find((candidate) => isDeepStrictEqual(candidate, linked.receipt));
    if (
      !receipt ||
      !receipt.eligible ||
      receipt.taskRef.subjectRef !== work.envelope.subjectRef ||
      !NEEDS_ME_PRODUCER_IDS.some((id) => id === receipt.producer.producerId) ||
      !receipt.kind ||
      !receipt.recommendation ||
      !work.preparedArtifact ||
      work.brief?.current?.state === 'done' ||
      receipt.taskRef.observedRevision !== work.envelope.revision ||
      work.envelope.freshness?.state !== 'current' ||
      work.envelope.freshness.observedRevision !== work.envelope.revision ||
      receipt.action?.expectedProducerRevision !== receipt.producer.revision
    )
      throw new CompanionBridgeError('unavailable');
    return { ownerRead: work, receipt };
  });
  if (!approval && (!linkedNeedsMe.length || linkedNeedsMe.some(({ receipt }) => receipt.kind !== raw.kind)))
    throw new CompanionBridgeError('unavailable');
  return {
    decisionRef: raw.decisionRef,
    kind: raw.kind,
    summary: raw.summary,
    ...(approval ? { approval } : {}),
    linkedNeedsMe,
  };
}

/** Reuse the canonical source validators, then bind every retained row to this Host principal. */
export function parseUnifiedCompanionSource(
  body: unknown,
  ownerUserId: string,
  page: { offset: number; limit: number },
): UnifiedAttentionReadV1 {
  const parsed = read.parse(body);
  if (parsed.identity.ownerUserId !== ownerUserId) throw new CompanionBridgeError('permission_required');
  if (parsed.page.offset !== page.offset || parsed.page.limit !== page.limit || parsed.items.length > page.limit)
    throw new CompanionBridgeError('unavailable');
  if (
    parsed.sources.approvals.coverage !== 'all_registered_F246_producers' ||
    parsed.sources.needsMe.coverage !== 'current_linked_F310_five_producers'
  )
    throw new CompanionBridgeError('unavailable');
  const items = parsed.items.map((value) => item(value, ownerUserId));
  if (
    items.some(
      (value) =>
        (value.approval && parsed.sources.approvals.status !== 'available') ||
        (value.linkedNeedsMe.length > 0 && parsed.sources.needsMe.status !== 'available'),
    )
  )
    throw new CompanionBridgeError('unavailable');
  return { ...parsed, items };
}
