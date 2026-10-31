import Fastify from 'fastify';
import type { IInvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { ITurnExecutionStore } from '../src/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { MemoryCueEpisodeStore } from '../src/domains/memory/cue/MemoryCueEpisodeStore.js';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';
import { memoryPageReadRoutes } from '../src/routes/memory-page-read.js';
import type { RecallPageSourceReaders } from '../src/routes/memory-recall-page.js';
import type { RecallReplyMessage } from '../src/routes/recall-reply-index.js';

type Invocation = NonNullable<Awaited<ReturnType<IInvocationRecordStore['get']>>>;
type Turn = NonNullable<Awaited<ReturnType<ITurnExecutionStore['get']>>>;
export async function recallFixture(mutate?: (readers: RecallPageSourceReaders) => void) {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const db = evidence.getDb();
  const now = Date.now();
  const threads = new Map([
    ['own', { id: 'own', createdBy: 'owner', title: '真实对话', deletedAt: null as number | null }],
    ['other', { id: 'other', createdBy: 'other-owner', title: '其他主人的秘密标题', deletedAt: null }],
    ['deleted', { id: 'deleted', createdBy: 'owner', title: '已删除对话', deletedAt: now }],
    ['system', { id: 'system', createdBy: 'system', title: '主人的系统对话', deletedAt: null }],
  ]);
  const indexed = ['own'];
  const invocations = new Map<string, Invocation>();
  const turns = new Map<string, Turn>();
  // Only the canonical scope fields participate in this reader. No runtime is started.
  const invocation = (id: string, userId = 'owner', threadId = 'own') =>
    invocations.set(id, { id, userId, threadId } as Invocation);
  const turn = (id: string, parentInvocationId: string, userId = 'owner', threadId = 'own') =>
    turns.set(id, { id, parentInvocationId, userId, threadId } as Turn);
  const replies = new Map<string, RecallReplyMessage[]>();
  const replyReads: Array<{ threadId: string; owner: string | undefined }> = [];
  const readers: RecallPageSourceReaders = {
    threadStore: { list: async () => indexed.map((id) => ({ id })), get: async (id) => threads.get(id) ?? null },
    messageStore: {
      getByThread: async (threadId, _limit, owner) => {
        replyReads.push({ threadId, owner });
        return replies.get(threadId) ?? [];
      },
    },
    invocationRecordStore: { get: async (id) => invocations.get(id) ?? null },
    turnExecutionStore: { get: async (id) => turns.get(id) ?? null },
  };
  mutate?.(readers);
  const insert = db.prepare(`INSERT INTO recall_events
    (recall_id, cat_id, invocation_id, tool_name, query, candidates_json, consumed_json,
    timestamp, thread_id, result_count, result_status, source, inspected)
    VALUES (@id, @cat, @invocation, 'search_evidence', @query, @candidates, '[]', @timestamp, @thread, 0, 'no_results', @source, @inspected)`);
  const recall = (
    id: string,
    overrides: {
      timestamp?: number;
      thread?: string;
      source?: 'pull' | 'push';
      cat?: string;
      candidates?: string;
      query?: string;
      inspected?: number;
    } = {},
  ) =>
    insert.run({
      id,
      cat: overrides.cat ?? 'sonnet',
      invocation: `inv-${id}`,
      query: overrides.query ?? id,
      timestamp: overrides.timestamp ?? now - 1000,
      thread: overrides.thread ?? 'own',
      source: overrides.source ?? 'pull',
      candidates: overrides.candidates ?? '[]',
      inspected: overrides.inspected ?? 0,
    });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'] as string | undefined;
  });
  await app.register(memoryPageReadRoutes, {
    ownerUserId: 'owner',
    catalog: { list: () => [] },
    stores: new Map(),
    evidenceDb: db,
    markerQueue: { list: async () => [] },
    recallSources: readers,
  });
  await app.ready();
  return {
    app,
    evidence,
    db,
    now,
    indexed,
    threads,
    readers,
    recall,
    invocation,
    turn,
    replies,
    replyReads,
    episodes: new MemoryCueEpisodeStore(db),
    get: (query = '') => app.inject({ url: `/api/memory/recall${query}`, headers: { 'x-test-session': 'owner' } }),
    close: async () => {
      await app.close();
      await evidence.close();
    },
  };
}
