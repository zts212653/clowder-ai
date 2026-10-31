import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';

test('global message search reads the durable visibility index once per admission and return phase', async () => {
  const threads = Array.from({ length: 16 }, (_, i) => ({ id: `system-${i}`, createdBy: 'system', title: 'Shared' }));
  const visible = [...threads];
  let lists = 0;
  let retrievalLists;
  const messages = new Map(
    threads.map((t) => [
      t.id,
      { id: t.id, threadId: t.id, userId: 'owner', catId: null, content: 'piano', timestamp: 1000 },
    ]),
  );
  const service = new MessageSearchService({
    threadStore: {
      get: (id) => threads.find((t) => t.id === id),
      list: () => {
        lists++;
        return [...visible];
      },
    },
    messageStore: { getById: (id) => messages.get(id) },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async (_query, options) => {
        retrievalLists = lists;
        assert.equal(options.visibleThreadIds.length, 16);
        visible.pop(); // revoke one shared thread during retrieval
        return {
          passages: threads.map((t) => ({
            threadId: t.id,
            messageId: t.id,
            docAnchor: `thread-${t.id}`,
            passageId: `msg-${t.id}`,
            content: 'piano',
            match: 'lexical',
          })),
          meta: { effectiveMode: 'lexical', degraded: false, candidateLimit: 2000, semanticCandidatesLimited: false },
        };
      },
    },
  });
  const result = await service.search(
    { query: 'piano', mode: 'lexical' },
    { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } },
  );
  assert.equal(retrievalLists, 1, 'initial index must not be re-enumerated for every shared thread');
  assert.equal(lists, 2, 'return must use one new durable visibility snapshot');
  assert.equal(result.results.length, 15);
  assert.ok(!result.results.some((r) => r.threadId === 'system-15'), 'revoked grants must not be published');
});
