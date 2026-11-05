import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { matchesEvalRepairCard } from './eval-repair-model';
import type { RepairCoordinate } from './read-eval-repair';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
/** Read the existing owner-auth message history until the exact live publication, never a guessed card at the same address. */
export async function readEvalRepairPublication(item: ApprovalHubItem, coordinate: RepairCoordinate): Promise<boolean> {
  let before: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ threadId: coordinate.threadId, limit: '50', ...(before ? { before } : {}) });
    const response = await apiFetch(`/api/messages?${params}`, {}, { afterCurrentGet: true });
    const body: unknown = response.ok ? await response.json() : null;
    if (!record(body) || !Array.isArray(body.messages)) return false;
    const messages = body.messages.filter(record),
      copies = messages.filter((message) => message.id === coordinate.messageId);
    if (copies.length > 1) return false;
    if (copies.length === 1) {
      const message = copies[0];
      if (
        message.deletedAt !== undefined ||
        message._tombstone === true ||
        message.catId !== item.requesterCatId ||
        (message.threadId !== undefined && message.threadId !== coordinate.threadId) ||
        (message.userId !== undefined && message.userId !== item.ownerUserId)
      )
        return false;
      const extra = message.extra,
        rich = record(extra) ? extra.rich : null;
      if (!record(rich) || !Array.isArray(rich.blocks)) return false;
      const expectedId = `eval-repair-proposal-${item.proposalId}`;
      const blocks = rich.blocks.filter((block: unknown) => {
        if (!record(block)) return false;
        const stamp = record(block.meta) ? block.meta.approval : null;
        return (
          block.id === expectedId ||
          (record(stamp) && stamp.producerId === 'F266' && stamp.canonicalProposalId === item.proposalId)
        );
      });
      return (
        blocks.length === 1 && record(blocks[0]) && matchesEvalRepairCard(blocks[0] as unknown as RichCardBlock, item)
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
