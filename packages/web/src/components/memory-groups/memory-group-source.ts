import {
  isValidRichBlock,
  REMEMBER_TARGETS,
  type RememberGroup,
  type RememberGroupRow,
  type RichCardBlock,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { apiFetch } from '@/utils/api-client';

const schema = z.object({
  v: z.literal(1),
  groupId: z.string().min(1),
  rows: z
    .array(
      z.object({
        itemId: z.string().min(1),
        target: z.enum(REMEMBER_TARGETS),
        statusCode: z.number().int(),
        proposalId: z.string().optional(),
        messageId: z.string().optional(),
        resultRef: z.string().optional(),
        personId: z.string().optional(),
        status: z.string().optional(),
        error: z.string().optional(),
      }),
    )
    .min(1)
    .max(4),
});
export function readMemoryGroup(block: RichCardBlock): RememberGroup | null {
  if (block.meta?.kind !== 'memory_group') return null;
  const parsed = schema.safeParse(block.meta.memoryGroup);
  return parsed.success ? parsed.data : null;
}
const producers: Partial<Record<RememberGroupRow['target'], string>> = {
  profile: 'F231',
  taste: 'F221',
  person: 'F276',
  entity: 'F260',
  event_correction: 'F321',
};
export function isMemoryGroupProposal(row: RememberGroupRow): boolean {
  return row.statusCode < 400 && !row.error && !!row.proposalId && !!producers[row.target];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export interface OriginalMemoryGroupCard {
  proposalId: string;
  block: RichCardBlock;
  coordinate: PublishedMessageCoordinate;
}
function originalInMessage(
  row: RememberGroupRow,
  message: Record<string, unknown>,
  threadId: string,
): OriginalMemoryGroupCard | null {
  if (
    typeof message.timestamp !== 'number' ||
    typeof message.id !== 'string' ||
    (row.messageId && row.messageId !== message.id) ||
    message.deletedAt ||
    message._tombstone
  )
    return null;
  const rich = record(message.extra) ? message.extra.rich : null;
  if (!record(rich) || !Array.isArray(rich.blocks)) return null;
  const block = rich.blocks.filter(isValidRichBlock).find((candidate) => {
    if (candidate.kind !== 'card') return false;
    const stamp = candidate.meta?.approval;
    return record(stamp) && stamp.producerId === producers[row.target] && stamp.canonicalProposalId === row.proposalId;
  });
  return block?.kind === 'card' && row.proposalId
    ? {
        proposalId: row.proposalId,
        block,
        coordinate: { threadId, messageId: message.id, messageRevision: String(message.timestamp) },
      }
    : null;
}
function nextCursor(messages: Record<string, unknown>[], hasMore: unknown, previous: string | undefined) {
  const oldest = messages[0];
  if (hasMore !== true || !oldest || typeof oldest.timestamp !== 'number' || typeof oldest.id !== 'string') return null;
  const cursor = `${oldest.timestamp}:${oldest.id}`;
  return cursor !== previous ? cursor : null;
}
async function readOriginalPage(threadId: string, signal: AbortSignal, before?: string) {
  const params = new URLSearchParams({ threadId, limit: '50', ...(before ? { before } : {}) });
  const response = await apiFetch(`/api/messages?${params}`, { signal }, { afterCurrentGet: true });
  const body: unknown = response.ok ? await response.json() : null;
  if (!record(body) || !Array.isArray(body.messages)) throw new Error('原消息暂时无法读取');
  return { messages: body.messages.filter(record), hasMore: body.hasMore };
}
/** Locate publications only. Existing original-card controllers own current reads, permissions and decisions. */
export async function readMemoryGroupOriginals(group: RememberGroup, threadId: string, signal: AbortSignal) {
  const wanted = group.rows.filter(isMemoryGroupProposal);
  const found: Record<string, OriginalMemoryGroupCard> = {};
  let before: string | undefined;
  while (wanted.some((row) => !found[row.itemId])) {
    const page = await readOriginalPage(threadId, signal, before);
    for (const row of wanted.filter((row) => !found[row.itemId])) {
      const original = page.messages.map((message) => originalInMessage(row, message, threadId)).find(Boolean);
      if (original) found[row.itemId] = original;
    }
    const cursor = nextCursor(page.messages, page.hasMore, before);
    if (!cursor) break;
    before = cursor;
  }
  return found;
}
