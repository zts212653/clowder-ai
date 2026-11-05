import {
  APPROVAL_PRODUCER_CATALOG,
  type ApprovalProducerId,
  approvalLifecycleProjectionSchema,
  approvalMaterializationSchema,
  type SettledApprovalHubItem,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import type { Terminal } from './approval-reconcile';

export type SettledResultItem = SettledApprovalHubItem & { resolution: Terminal['resolution'] };

const nonBlank = z.string().trim().min(1);
const ref = z.object({ threadId: nonBlank, messageId: nonBlank });
const navigation = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('anchored'),
    approvalCardRef: ref,
    originRef: z.discriminatedUnion('kind', [
      ref.extend({ kind: z.literal('message') }),
      z.object({ kind: z.literal('event'), anchor: nonBlank, summary: nonBlank, threadId: nonBlank.optional() }),
    ]),
  }),
  z.object({
    state: z.literal('legacy_unanchored'),
    legacyThreadId: nonBlank.optional(),
    legacyMessageId: nonBlank.optional(),
  }),
]);
const rowSchema = z.object({
  proposalId: nonBlank,
  sourceFeatureId: z.custom<ApprovalProducerId>(
    (v) => typeof v === 'string' && Object.hasOwn(APPROVAL_PRODUCER_CATALOG, v),
  ),
  requesterCatId: nonBlank,
  ownerUserId: nonBlank,
  summary: z.string(),
  detail: z.record(z.unknown()),
  navigation,
  createdAt: z.number().finite(),
  decidedAt: z.number().finite(),
  decidedBy: z.string(),
  resolution: z.enum(['accepted', 'rejected', 'closed_without_decision']),
  materialization: approvalMaterializationSchema,
  closedReason: z.enum(['expired', 'withdrawn']).optional(),
});

export const settledResultKey = (item: Pick<SettledApprovalHubItem, 'sourceFeatureId' | 'proposalId'>) =>
  JSON.stringify([item.sourceFeatureId, item.proposalId]);

export class SettledOwnerUnverified extends Error {}

/** A conflicting identity or lifecycle makes the read unavailable, never an empty or "latest wins" history. */
export function parseSettledResults(body: unknown, ownerUserId: string): SettledResultItem[] | null {
  const parsed = z.object({ items: z.array(rowSchema) }).safeParse(body);
  if (!parsed.success) return null;
  const keys = new Set<string>();
  for (const item of parsed.data.items) {
    const key = settledResultKey(item);
    if (
      item.ownerUserId !== ownerUserId ||
      keys.has(key) ||
      !approvalLifecycleProjectionSchema.safeParse({
        resolution: item.resolution,
        materialization: item.materialization,
        ...(item.closedReason ? { closedReason: item.closedReason } : {}),
      }).success
    )
      return null;
    keys.add(key);
  }
  return parsed.data.items;
}

export async function readSettledResults(
  ownerUserId: string,
  signal: AbortSignal,
  limit: 30 | 50 | 200 = 50,
): Promise<SettledResultItem[] | null | 'preparing'> {
  try {
    return await readOwnedSettledResults(ownerUserId, signal, limit);
  } catch {
    return null;
  }
}

/** The cache distinguishes a failed update from lost identity; legacy exact readers still return null for either. */
export async function readOwnedSettledResults(
  ownerUserId: string,
  signal: AbortSignal,
  limit: 30 | 50 | 200 = 50,
): Promise<SettledResultItem[] | null | 'preparing'> {
  const response = await apiFetch(`/api/approval-hub/settled?limit=${limit}`, { signal }, { afterCurrentGet: true });
  const body: unknown = await response.json().catch(() => null);
  // Even a refused/preparing response may follow a changed cookie. It cannot keep the former owner's rows visible.
  const principal = await apiFetch('/api/session', { signal }, { afterCurrentGet: true }).catch(() => null);
  const session = z
    .object({ userId: nonBlank })
    .safeParse(principal?.ok ? await principal.json().catch(() => null) : null);
  if (!session.success || session.data.userId !== ownerUserId || response.status === 401 || response.status === 403)
    throw new SettledOwnerUnverified('History identity could not be confirmed');
  if (response.status === 503) {
    const error = z.object({ code: z.literal('APPROVAL_HISTORY_PREPARING') }).safeParse(body);
    return error.success ? 'preparing' : null;
  }
  if (!response.ok) return null;
  return parseSettledResults(body, ownerUserId);
}
