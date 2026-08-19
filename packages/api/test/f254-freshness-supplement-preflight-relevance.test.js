import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { scanFreshnessSupplementPreflight } = await import(
  '../dist/domains/cats/services/freshness/FreshnessSupplementPreflight.js'
);
const { cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');

function message(id, overrides = {}) {
  return {
    id,
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: `body:${id}`,
    mentions: [],
    timestamp: Number(id.slice(4)),
    ...overrides,
  };
}

function reader(messages) {
  const ordered = [...messages].sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(ordered.map((item) => [item.id, item]));
  return {
    getById: async (id) => byId.get(id) ?? null,
    getByThreadAfter: async (_threadId, cursor, limit) => ordered.filter((item) => item.id > cursor).slice(0, limit),
  };
}

describe('F254 supplement preflight parallel-self relevance', () => {
  it('retains a same-cat cross-thread A2A message as independent late work', async () => {
    const supplement = {
      id: 'supplement-1',
      lineageId: 'msg-1',
      seq: 1,
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      originalMessageId: 'msg-1',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      status: 'pending',
      replayUnsafeToolNames: [],
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    };
    const messages = [
      message('msg-1'),
      message('msg-2'),
      message('msg-3', {
        catId: 'codex-sol',
        extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'inv-source' } },
      }),
    ];

    const result = await scanFreshnessSupplementPreflight({
      supplement,
      messageStore: reader(messages),
    });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(result.requiredMessageIds, ['msg-2', 'msg-3']);
  });

  it('advances multi-page scans with the visibility cursor returned by the store', async () => {
    const supplement = {
      id: 'supplement-visibility-pagination',
      lineageId: 'msg-origin',
      seq: 1,
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      originalMessageId: 'msg-origin',
      requiredMessageIds: ['msg-frontier'],
      requiredFrontierMessageId: 'msg-frontier',
      status: 'pending',
      replayUnsafeToolNames: [],
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    };
    const firstPage = Array.from({ length: 20 }, (_, index) =>
      message(`msg-page-${String(index + 1).padStart(2, '0')}`, { visibilitySeq: index + 2 }),
    );
    const finalMessage = message('msg-final', { visibilitySeq: 22 });
    const expectedSecondCursor = cursorFor(firstPage.at(-1));
    const requestedCursors = [];
    const messageStore = {
      getById: async () => null,
      getByThreadAfter: async (_threadId, cursor) => {
        requestedCursors.push(cursor);
        if (cursor === supplement.requiredFrontierMessageId) return firstPage;
        if (cursor === expectedSecondCursor) return [finalMessage];
        throw new Error(`unexpected pagination cursor: ${cursor}`);
      },
    };

    const result = await scanFreshnessSupplementPreflight({ supplement, messageStore });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(requestedCursors, [supplement.requiredFrontierMessageId, expectedSecondCursor]);
  });
});
