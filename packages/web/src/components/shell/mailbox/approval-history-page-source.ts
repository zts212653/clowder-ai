import type { ApprovalHistoryPage, ApprovalHistoryPageRequest, ApprovalProducerId } from '@cat-cafe/shared';
import { APPROVAL_PRODUCER_CATALOG, compareApprovalHistoryItems } from '@cat-cafe/shared';
import { z } from 'zod';
import { approvalResultRead } from '@/lib/approval-result-read';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity, observeApiSessionOwner } from '@/utils/api-session-identity';
import {
  parseSettledResults,
  SettledOwnerUnverified,
  type SettledResultItem,
  settledResultKey,
} from './settled-results-source';

const producer = z.custom<ApprovalProducerId>(
  (id) => typeof id === 'string' && Object.hasOwn(APPROVAL_PRODUCER_CATALOG, id),
);
const envelope = z.object({
  items: z.array(z.unknown()),
  count: z.number().int().nonnegative(),
  identity: z.object({ ownerUserId: z.string().min(1) }),
  manifest: z.array(z.object({ id: producer })),
  page: z.object({
    limit: z.number().int().positive(),
    nextCursor: z.string().min(1).max(2048).nullable(),
    hasMore: z.boolean(),
  }),
  coverage: z.object({ state: z.literal('complete'), orderVersion: z.literal(1), sources: z.array(producer) }),
});
export type OwnedApprovalHistoryPage = Omit<ApprovalHistoryPage, 'items'> & { items: SettledResultItem[] };

export function retainSettledResult(item: SettledResultItem, observation?: number): SettledResultItem {
  const key = { owner: item.ownerUserId, producer: item.sourceFeatureId, proposalId: item.proposalId };
  const previous = approvalResultRead.snapshot<SettledResultItem>(key, 'settled').value;
  const adopted = previous && JSON.stringify(previous) === JSON.stringify(item) ? previous : item;
  const facts: Record<string, unknown> = { settled: adopted };
  const witness = item.detail.createdThreadProof;
  if (item.sourceFeatureId === 'F128' && witness && typeof witness === 'object' && !Array.isArray(witness)) {
    const proof = witness as Record<string, unknown>;
    if (
      proof.proposalId === item.proposalId &&
      proof.ownerUserId === item.ownerUserId &&
      typeof proof.threadId === 'string' &&
      proof.threadId === item.detail.createdThreadId
    )
      facts['verified-thread'] = proof.threadId;
  }
  if (!approvalResultRead.seedFacts(key, facts, observation))
    return approvalResultRead.snapshot<SettledResultItem>(key, 'settled').value ?? item;
  if (item.resolution !== 'accepted' || item.materialization.state === 'succeeded' || item.sourceFeatureId === 'F306')
    approvalResultRead.terminal(key);
  return adopted;
}

/** The page and its post-read session bind the same owner. The old 200-item exact-confirmation reader is independent. */
export async function readApprovalHistoryPage(
  owner: string,
  signal: AbortSignal,
  request: ApprovalHistoryPageRequest = { limit: 30 },
): Promise<OwnedApprovalHistoryPage | null | 'preparing'> {
  const observation = approvalResultRead.beginObservation(),
    identityGeneration = apiSessionIdentity.getSnapshot().generation;
  const query = new URLSearchParams({ limit: String(request.limit ?? 30) });
  if (request.cursor) query.set('cursor', request.cursor);
  if (request.producer) query.set('producer', request.producer);
  if (request.resolution) query.set('resolution', request.resolution);
  const response = await apiFetch(`/api/approval-hub/settled/page?${query}`, { signal }, { afterCurrentGet: true });
  const body: unknown = await response.json().catch(() => null);
  const session = await apiFetch('/api/session', { signal }, { afterCurrentGet: true }).catch(() => null);
  const principal = z
    .object({ userId: z.string().min(1) })
    .safeParse(session?.ok ? await session.json().catch(() => null) : null);
  signal.throwIfAborted();
  if (
    apiSessionIdentity.getSnapshot().generation !== identityGeneration &&
    apiSessionIdentity.getSnapshot().ownerUserId !== owner
  )
    throw new SettledOwnerUnverified('History owner changed');
  if (!principal.success || principal.data.userId !== owner || response.status === 401 || response.status === 403) {
    observeApiSessionOwner(principal.success ? principal.data.userId : null);
    throw new SettledOwnerUnverified('History owner unavailable');
  }
  signal.throwIfAborted();
  if (
    apiSessionIdentity.getSnapshot().generation !== identityGeneration &&
    apiSessionIdentity.getSnapshot().ownerUserId !== owner
  )
    throw new SettledOwnerUnverified('History owner changed');
  observeApiSessionOwner(principal.data.userId);
  if (response.status === 503)
    return z.object({ code: z.literal('APPROVAL_HISTORY_PREPARING') }).safeParse(body).success ? 'preparing' : null;
  if (!response.ok) return null;
  const decoded = envelope.safeParse(body);
  if (!decoded.success) return null;
  if (decoded.data.identity.ownerUserId !== owner) throw new SettledOwnerUnverified('History owner mismatch');
  const items = parseSettledResults(body, owner);
  if (!items) return null;
  const page = decoded.data.page;
  const sources = decoded.data.coverage.sources;
  const expected = decoded.data.manifest
    .map((entry) => entry.id)
    .filter((id) => !request.producer || id === request.producer);
  if (
    page.limit !== (request.limit ?? 30) ||
    items.length > page.limit ||
    items.length !== decoded.data.count ||
    page.hasMore !== (page.nextCursor !== null) ||
    page.nextCursor === request.cursor ||
    new Set(sources).size !== sources.length ||
    JSON.stringify([...sources].sort()) !== JSON.stringify([...expected].sort()) ||
    items.some(
      (item) =>
        !sources.includes(item.sourceFeatureId) ||
        !Number.isSafeInteger(item.decidedAt) ||
        item.decidedAt < 0 ||
        (request.producer && item.sourceFeatureId !== request.producer) ||
        (request.resolution && item.resolution !== request.resolution),
    )
  )
    return null;
  if (new Set(items.map(settledResultKey)).size !== items.length) return null;
  if (items.some((item, index) => index > 0 && compareApprovalHistoryItems(items[index - 1], item) > 0)) return null;
  return {
    ...decoded.data,
    items: items.map((item) => {
      retainSettledResult(item, observation);
      return item;
    }),
  };
}
