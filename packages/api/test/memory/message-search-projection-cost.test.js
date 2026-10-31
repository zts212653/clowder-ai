import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';

function fixture(count) {
  const reads = [];
  const messages = new Map();
  const candidates = Array.from({ length: count }, (_, index) => {
    const id = `message-${index}`;
    const content = `piano discussion ${index}`;
    messages.set(id, {
      id,
      threadId: 'visible',
      userId: 'owner',
      catId: null,
      content,
      timestamp: Date.UTC(2026, 9, 9) + index,
    });
    return {
      threadId: 'visible',
      messageId: id,
      docAnchor: 'thread-visible',
      passageId: `msg-${id}`,
      content,
      match: 'lexical',
    };
  });
  const thread = { id: 'visible', createdBy: 'owner', title: 'Piano' };
  const service = new MessageSearchService({
    threadStore: { get: () => thread, list: () => [thread] },
    messageStore: {
      getById: (id) => {
        reads.push(id);
        return messages.get(id);
      },
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async () => ({
        passages: candidates,
        meta: { effectiveMode: 'lexical', degraded: false, candidateLimit: 2000, semanticCandidatesLimited: false },
      }),
    },
  });
  return { service, reads, messages, candidates };
}

const principal = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
const input = { query: 'piano', mode: 'lexical', sort: 'relevance', limit: 3 };

test('relevance search hydrates only the requested valid results and one hasMore witness', async () => {
  const f = fixture(2000);
  const result = await f.service.search(input, principal);
  assert.deepEqual(
    result.results.map((hit) => hit.messageId),
    ['message-0', 'message-1', 'message-2'],
  );
  assert.equal(result.meta.hasMore, true);
  assert.equal(f.reads.length, 4, 'limit=3 must not hydrate the whole 2,000-candidate pool');
});

test('out-of-window, unauthorized, duplicate and stale candidates do not consume the page budget', async () => {
  const f = fixture(100);
  f.messages.get('message-0').timestamp = Date.UTC(2026, 9, 8);
  f.messages.get('message-1').userId = 'other-owner';
  f.messages.get('message-2').content = 'changed canonical body';
  f.candidates.splice(4, 0, f.candidates[3]);
  const result = await f.service.search(
    { ...input, limit: 1, dateFrom: '2026-10-09', dateTo: '2026-10-09' },
    principal,
  );
  assert.deepEqual(
    result.results.map((hit) => hit.messageId),
    ['message-3'],
  );
  assert.equal(result.meta.hasMore, true);
  assert.deepEqual(f.reads, ['message-0', 'message-1', 'message-2', 'message-3', 'message-4']);
});

test('time search still orders by canonical timestamps before applying the visible limit', async () => {
  const f = fixture(20);
  f.messages.get('message-19').timestamp = Date.UTC(2026, 9, 8);
  const result = await f.service.search({ ...input, sort: 'time', limit: 1 }, principal);
  assert.deepEqual(
    result.results.map((hit) => hit.messageId),
    ['message-19'],
  );
  assert.equal(result.meta.hasMore, true);
  assert.equal(f.reads.length, 20);
});
