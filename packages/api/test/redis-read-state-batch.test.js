import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('RedisThreadReadStateStore batch unread projection', () => {
  it('pipelines read cursors and delegates every live cursor to one message projection', async () => {
    const { RedisThreadReadStateStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'
    );

    const cursorByKey = new Map([
      ['read-state:user-1:thread-a', { lastReadMessageId: 'a-1', updatedAt: '1' }],
      ['read-state:user-1:thread-b', { lastReadMessageId: 'b-1', updatedAt: '2' }],
      ['read-state:user-1:thread-c', { lastReadMessageId: 'c-1', updatedAt: '3' }],
    ]);
    let pipelineExecs = 0;
    let directCursorReads = 0;
    const queuedKeys = [];
    const redis = {
      hgetall: async (key) => {
        directCursorReads += 1;
        return cursorByKey.get(key) ?? {};
      },
      pipeline: () => ({
        hgetall(key) {
          queuedKeys.push(key);
          return this;
        },
        async exec() {
          pipelineExecs += 1;
          return queuedKeys.map((key) => [null, cursorByKey.get(key) ?? {}]);
        },
      }),
    };

    const projectionCalls = [];
    const messageStore = {
      async getUnreadSummaryProjection(cursors, userId) {
        projectionCalls.push({ cursors, userId });
        return cursors.map(({ threadId }) => ({ threadId, unreadCount: 0, hasUserMention: false }));
      },
      getByThreadAfter() {
        throw new Error('serial unread hydration must not run when batch projection is available');
      },
    };

    const store = new RedisThreadReadStateStore(redis);
    const summaries = await store.getUnreadSummaries('user-1', ['thread-a', 'thread-b', 'thread-c'], messageStore);

    assert.equal(pipelineExecs, 1);
    assert.equal(directCursorReads, 0);
    assert.equal(projectionCalls.length, 1);
    assert.equal(projectionCalls[0].userId, 'user-1');
    assert.deepEqual(projectionCalls[0].cursors, [
      { threadId: 'thread-a', afterId: 'a-1' },
      { threadId: 'thread-b', afterId: 'b-1' },
      { threadId: 'thread-c', afterId: 'c-1' },
    ]);
    assert.deepEqual(
      summaries,
      ['thread-a', 'thread-b', 'thread-c'].map((threadId) => ({
        threadId,
        unreadCount: 0,
        hasUserMention: false,
      })),
    );
  });
});
