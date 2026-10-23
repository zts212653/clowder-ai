import { isValidRichBlock, type RichCardBlock, type SettledApprovalHubItem } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

function publishedBlock(
  item: SettledApprovalHubItem,
  message: Record<string, unknown>,
  threadId: string,
): RichCardBlock | null {
  const rich = object(message.extra) ? message.extra.rich : null;
  if (
    message.deletedAt !== undefined ||
    message._tombstone === true ||
    message.catId !== item.requesterCatId ||
    (message.userId !== undefined && message.userId !== item.ownerUserId) ||
    (message.threadId !== undefined && message.threadId !== threadId) ||
    !object(rich) ||
    !Array.isArray(rich.blocks)
  )
    return null;
  const prefix =
    item.sourceFeatureId === 'F225' ? 'handoff' : item.sourceFeatureId === 'F276' ? 'person-memory' : 'profile-update';
  const blocks = rich.blocks.filter((b) => object(b) && b.id === `${prefix}-${item.proposalId}`);
  if (blocks.length !== 1 || !isValidRichBlock(blocks[0]) || blocks[0].kind !== 'card') return null;
  const block = blocks[0],
    stamp = block.meta?.approval;
  if (item.sourceFeatureId === 'F276' && block.meta?.candidateId !== item.proposalId) return null;
  return object(stamp) && stamp.producerId === item.sourceFeatureId && stamp.canonicalProposalId === item.proposalId
    ? { ...block, actions: undefined }
    : null;
}

/** Read-only original publication, not an ApprovalSession or a capability to write. */
export async function readSettledOriginalBlock(
  item: SettledApprovalHubItem,
  signal: AbortSignal,
): Promise<RichCardBlock | null> {
  if (!['F225', 'F231', 'F276'].includes(item.sourceFeatureId) || item.navigation.state !== 'anchored') return null;
  const ref = item.navigation.approvalCardRef;
  let before: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const params = new URLSearchParams({ threadId: ref.threadId, limit: '50', ...(before ? { before } : {}) });
    const response = await apiFetch(`/api/messages?${params}`, { signal }, { afterCurrentGet: true });
    const body: unknown = response.ok ? await response.json() : null;
    if (!object(body) || !Array.isArray(body.messages)) return null;
    const messages = body.messages.filter(object),
      matches = messages.filter((m) => m.id === ref.messageId);
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      return publishedBlock(item, matches[0], ref.threadId);
    }
    if (body.hasMore !== true || !messages.length) return null;
    const oldest = messages[0];
    if (typeof oldest.timestamp !== 'number' || !Number.isFinite(oldest.timestamp) || typeof oldest.id !== 'string')
      return null;
    const next = `${oldest.timestamp}:${oldest.id}`;
    if (cursors.has(next)) return null;
    cursors.add(next);
    before = next;
  }
}
