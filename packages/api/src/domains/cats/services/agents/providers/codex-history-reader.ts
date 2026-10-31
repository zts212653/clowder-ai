import { asCodexAppServerRecord as asRecord } from './CodexAppServerEventMapper.js';

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const CODEX_TURN_METADATA_PAGE = { limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' } as const;

/** Pagination carries coordinates, never historical message/tool bodies. */
export async function* readCodexTurnMetadata(request: Request, threadId: string) {
  let page = asRecord(await request('thread/turns/list', { threadId, ...CODEX_TURN_METADATA_PAGE }));
  const cursors = new Set<string>();
  while (true) {
    if (!Array.isArray(page?.data)) throw new Error('Codex turn metadata page is invalid');
    for (const value of page.data) {
      const turn = asRecord(value);
      if (typeof turn?.id !== 'string' || !turn.id) throw new Error('Codex turn metadata has no id');
      yield {
        id: turn.id,
        ...(typeof turn.status === 'string' ? { status: turn.status } : {}),
        ...(typeof turn.startedAt === 'number' ? { startedAt: turn.startedAt } : {}),
      };
    }
    const cursor = page.nextCursor;
    if (cursor == null) return;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
      throw new Error('Codex turn metadata cursor did not advance');
    }
    cursors.add(cursor);
    page = asRecord(await request('thread/turns/list', { threadId, ...CODEX_TURN_METADATA_PAGE, cursor }));
  }
}

/** Keep the old diagnostics consumer shape, but read only metadata and an active turn coordinate. */
export async function readCodexActiveWriterMetadata(request: Request, threadId: string): Promise<unknown> {
  const result = asRecord(await request('thread/read', { threadId, includeTurns: false }));
  const thread = asRecord(result?.thread);
  if (thread?.id !== threadId) throw new Error('Codex active-writer thread id mismatch');
  const status = asRecord(thread.status);
  const turns: Array<{ id: string; status?: string; startedAt?: number }> = [];
  if (status?.type === 'active') {
    for await (const turn of readCodexTurnMetadata(request, threadId)) {
      if (turn.status === 'inProgress') {
        turns.push(turn);
        break;
      }
    }
  }
  return { thread: { id: threadId, status: { type: status?.type }, turns } };
}

/** Exact turn-scoped input evidence. RPC failures propagate; no full-history fallback. */
export async function inspectCodexInput(request: Request, threadId: string, turnId: string, deliveryId: string) {
  let cursor: string | undefined;
  const cursors = new Set<string>();
  while (true) {
    const page = asRecord(
      await request('thread/items/list', {
        threadId,
        turnId,
        limit: 50,
        sortDirection: 'desc',
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!Array.isArray(page?.data)) return 'unknown' as const;
    for (const value of page.data) {
      const entry = asRecord(value);
      const item = asRecord(entry?.item);
      if (entry?.turnId === turnId && item?.type === 'userMessage' && item.clientId === deliveryId)
        return 'accepted' as const;
    }
    if (page.nextCursor == null) return 'unknown' as const;
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) {
      throw new Error('Codex input history cursor did not advance');
    }
    cursor = page.nextCursor;
    cursors.add(cursor);
  }
}

/** The continuity event has no reason to own a provider's historical object graph. */
export function projectCodexThreadMetadata(response: unknown) {
  const result = asRecord(response);
  const thread = asRecord(result?.thread);
  return {
    thread: { id: thread?.id },
    ...(typeof result?.model === 'string' ? { model: result.model } : {}),
    ...(typeof result?.reasoningEffort === 'string' ? { reasoningEffort: result.reasoningEffort } : {}),
  };
}
