import { type ApprovalHubItem, isPersonMemoryProposalCardBlock, type RichCardBlock } from '@cat-cafe/shared';
import { z } from 'zod';
import { matchHostedApproval } from '@/components/shell/mailbox/approval-match';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';

const receiptSchema = z.object({
  decisionId: z.string().min(1),
  materializedClaimIds: z.array(z.string()),
  materializedRelationshipIds: z.array(z.string()),
  materializedEventIds: z.array(z.string()),
});
const snapshotSchema = z.object({
  proposalId: z.string(),
  status: z.enum(['pending_approval', 'not_now', 'partially_materialized', 'materialized', 'rejected', 'withdrawn']),
  remainingDraftIds: z.array(z.string()).optional(),
  publicationState: z.literal('anchored'),
  approvalCardMessageId: z.string(),
  replacedByProposalId: z.string().min(1).optional(),
  hasRetainedWrites: z.boolean().optional(),
  materialized: z
    .object({
      claims: z.number().int().nonnegative(),
      relationships: z.number().int().nonnegative(),
      events: z.number().int().nonnegative(),
    })
    .optional(),
  undoApplied: z.boolean().optional(),
  decisionReceipt: receiptSchema.optional(),
  undoReceipt: z
    .object({
      requestId: z.string(),
      verdict: z.literal('undone'),
      candidateId: z.string().optional(),
      candidateState: z.enum(['pending_approval', 'partially_materialized', 'withdrawn']).optional(),
    })
    .optional(),
});
export type PersonMemorySnapshot = z.infer<typeof snapshotSchema>;
export type PersonMemoryCoordinate = { threadId: string; messageId: string };
export function isPersonMemoryPending(snapshot: PersonMemorySnapshot): boolean {
  return ['pending_approval', 'not_now', 'partially_materialized'].includes(snapshot.status);
}
export async function readPersonMemorySnapshot(
  proposalId: string,
  messageId: string,
): Promise<PersonMemorySnapshot | null> {
  const response = await apiFetch(
    `/api/person-memory-proposals/${encodeURIComponent(proposalId)}`,
    {},
    { afterCurrentGet: true },
  );
  const parsed = snapshotSchema.safeParse(response.ok ? await response.json() : null);
  return parsed.success && parsed.data.proposalId === proposalId && parsed.data.approvalCardMessageId === messageId
    ? parsed.data
    : null;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
/** A typed display block is a locator. The original owner-scoped publication and current producer DTO authorize the controller. */
async function published(
  item: ApprovalHubItem,
  ref: PersonMemoryCoordinate,
  original?: RichCardBlock,
): Promise<boolean> {
  let before: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ threadId: ref.threadId, limit: '50', ...(before ? { before } : {}) });
    const response = await apiFetch(`/api/messages?${params}`, {}, { afterCurrentGet: true });
    const body: unknown = response.ok ? await response.json() : null;
    if (!record(body) || !Array.isArray(body.messages)) return false;
    const messages = body.messages.filter(record),
      matches = messages.filter((m) => m.id === ref.messageId);
    if (matches.length > 1) return false;
    if (matches.length === 1) {
      const message = matches[0],
        rich = record(message.extra) ? message.extra.rich : null;
      if (
        message.deletedAt !== undefined ||
        message._tombstone === true ||
        message.catId !== item.requesterCatId ||
        (message.userId !== undefined && message.userId !== item.ownerUserId) ||
        (message.threadId !== undefined && message.threadId !== ref.threadId) ||
        !record(rich) ||
        !Array.isArray(rich.blocks)
      )
        return false;
      const blocks = rich.blocks.filter(
        (b) =>
          record(b) &&
          (b.id === `person-memory-${item.proposalId}` || (record(b.meta) && b.meta.candidateId === item.proposalId)),
      );
      if (blocks.length !== 1 || !isPersonMemoryProposalCardBlock(blocks[0])) return false;
      const block = blocks[0];
      const stamp = block.meta.approval;
      if (!record(stamp) || stamp.producerId !== 'F276' || stamp.canonicalProposalId !== item.proposalId) return false;
      return (
        block.meta.candidateId === item.proposalId &&
        block.id === `person-memory-${item.proposalId}` &&
        block.meta.subjectDisplayName === item.detail.displayName &&
        (!original || JSON.stringify(original) === JSON.stringify(block))
      );
    }
    if (body.hasMore !== true || !messages.length) return false;
    const oldest = messages[0];
    if (typeof oldest.timestamp !== 'number' || !Number.isFinite(oldest.timestamp) || typeof oldest.id !== 'string')
      return false;
    const cursor = `${oldest.timestamp}:${oldest.id}`;
    if (cursor === before) return false;
    before = cursor;
  }
}
export async function readPersonMemorySource(
  proposalId: string,
  ref: PersonMemoryCoordinate,
  original?: RichCardBlock,
  expected?: ApprovalHubItem,
  expectedOwnerUserId?: string,
): Promise<{ snapshot: PersonMemorySnapshot; item: ApprovalHubItem | null } | null> {
  try {
    const session = await apiFetch('/api/session', {}, { afterCurrentGet: true });
    const owner: unknown = session.ok ? await session.json() : null;
    if (
      !record(owner) ||
      typeof owner.userId !== 'string' ||
      !owner.userId ||
      (expectedOwnerUserId !== undefined && expectedOwnerUserId !== owner.userId) ||
      (expected && expected.ownerUserId !== owner.userId)
    )
      return null;
    const snapshot = await readPersonMemorySnapshot(proposalId, ref.messageId);
    if (!snapshot) return null;
    if (!isPersonMemoryPending(snapshot)) return { snapshot, item: null };
    await useApprovalHubStore.getState().fetchPending();
    const store = useApprovalHubStore.getState();
    if (!store.pendingReadAvailable || store.isLoading) return null;
    const copies = store.items.filter((i) => i.proposalId === proposalId && i.sourceFeatureId === 'F276');
    if (copies.length !== 1) return null;
    const item = copies[0];
    if (
      item.ownerUserId !== owner.userId ||
      item.decisionMode !== 'claim-select' ||
      !item.inlineApprovable ||
      item.navigation.state !== 'anchored' ||
      item.navigation.approvalCardRef.threadId !== ref.threadId ||
      item.navigation.approvalCardRef.messageId !== ref.messageId ||
      item.resolution !== 'open' ||
      JSON.stringify(item.detail.remainingDraftIds) !== JSON.stringify(snapshot.remainingDraftIds) ||
      !Array.isArray(item.detail.drafts) ||
      typeof item.detail.displayName !== 'string' ||
      !(await published(item, ref, original))
    )
      return null;
    if (
      expected &&
      (matchHostedApproval({ read: expected, readOwnerUserId: owner.userId, storeItems: [item], now: Date.now() })
        .kind !== 'matched' ||
        JSON.stringify(expected.detail) !== JSON.stringify(item.detail))
    )
      return null;
    return { snapshot, item };
  } catch {
    return null;
  }
}

export function personMemoryUndoRequestId(proposalId: string, decisionId: string): string {
  const input = `${proposalId}\0${decisionId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `f276_undo_${(hash >>> 0).toString(16)}`;
}
