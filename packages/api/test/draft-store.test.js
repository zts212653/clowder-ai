import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { DraftStore } from '../dist/domains/cats/services/stores/ports/DraftStore.js';

describe('DraftStore (in-memory)', () => {
  /** @type {DraftStore} */
  let store;

  beforeEach(() => {
    store = new DraftStore({ ttlMs: 5000 });
  });

  const makeDraft = (overrides = {}) => ({
    userId: 'user-1',
    threadId: 'thread-1',
    invocationId: 'inv-1',
    catId: 'opus',
    content: 'Hello world',
    updatedAt: Date.now(),
    ...overrides,
  });

  describe('upsert + getByThread', () => {
    it('stores and retrieves a draft', () => {
      store.upsert(makeDraft());
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].content, 'Hello world');
      assert.equal(drafts[0].invocationId, 'inv-1');
    });

    it('upsert overwrites existing draft with same key', () => {
      store.upsert(makeDraft({ content: 'v1' }));
      store.upsert(makeDraft({ content: 'v2' }));
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].content, 'v2');
    });

    it('stores multiple drafts for different invocations', () => {
      store.upsert(makeDraft({ invocationId: 'inv-1', catId: 'opus' }));
      store.upsert(makeDraft({ invocationId: 'inv-2', catId: 'codex' }));
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 2);
    });
  });

  describe('userId isolation (R1 P1-1)', () => {
    it('different users cannot see each other drafts', () => {
      store.upsert(makeDraft({ userId: 'user-A' }));
      store.upsert(makeDraft({ userId: 'user-B', content: 'secret' }));
      const draftsA = store.getByThread('user-A', 'thread-1');
      const draftsB = store.getByThread('user-B', 'thread-1');
      assert.equal(draftsA.length, 1);
      assert.equal(draftsA[0].content, 'Hello world');
      assert.equal(draftsB.length, 1);
      assert.equal(draftsB[0].content, 'secret');
    });
  });

  describe('touch', () => {
    it('updates the updatedAt timestamp', () => {
      const oldTime = Date.now() - 3000;
      store.upsert(makeDraft({ updatedAt: oldTime }));
      store.touch('user-1', 'thread-1', 'inv-1');
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 1);
      assert(drafts[0].updatedAt > oldTime, 'updatedAt should be refreshed');
    });

    it('no-op for non-existent draft', () => {
      // Should not throw
      store.touch('user-1', 'thread-1', 'no-such-inv');
    });
  });

  describe('TTL expiration', () => {
    it('expired drafts are filtered on read', () => {
      const expiredTime = Date.now() - 10_000; // 10s ago, TTL is 5s
      store.upsert(makeDraft({ updatedAt: expiredTime }));
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 0);
      assert.equal(store.size, 0, 'expired entry should be purged');
    });

    it('non-expired drafts are returned', () => {
      store.upsert(makeDraft({ updatedAt: Date.now() }));
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 1);
    });
  });

  describe('delete', () => {
    it('removes a specific draft', () => {
      store.upsert(makeDraft({ invocationId: 'inv-1' }));
      store.upsert(makeDraft({ invocationId: 'inv-2' }));
      store.delete('user-1', 'thread-1', 'inv-1');
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].invocationId, 'inv-2');
    });

    it('no-op for non-existent draft', () => {
      store.delete('user-1', 'thread-1', 'no-such');
      assert.equal(store.size, 0);
    });
  });

  describe('deleteByThread', () => {
    it('removes all drafts for a user+thread', () => {
      store.upsert(makeDraft({ invocationId: 'inv-1' }));
      store.upsert(makeDraft({ invocationId: 'inv-2' }));
      store.upsert(makeDraft({ threadId: 'thread-2', invocationId: 'inv-3' }));
      store.deleteByThread('user-1', 'thread-1');
      const draftsT1 = store.getByThread('user-1', 'thread-1');
      const draftsT2 = store.getByThread('user-1', 'thread-2');
      assert.equal(draftsT1.length, 0);
      assert.equal(draftsT2.length, 1);
    });

    it('does not affect other users', () => {
      store.upsert(makeDraft({ userId: 'user-A' }));
      store.upsert(makeDraft({ userId: 'user-B' }));
      store.deleteByThread('user-A', 'thread-1');
      const draftsA = store.getByThread('user-A', 'thread-1');
      const draftsB = store.getByThread('user-B', 'thread-1');
      assert.equal(draftsA.length, 0);
      assert.equal(draftsB.length, 1);
    });
  });

  describe('toolEvents persistence', () => {
    it('stores and retrieves toolEvents', () => {
      store.upsert(
        makeDraft({
          toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'Read', timestamp: 1 }],
        }),
      );
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts[0].toolEvents?.length, 1);
      assert.equal(drafts[0].toolEvents[0].label, 'Read');
    });
  });

  describe('thinking persistence (Bug A)', () => {
    it('stores and retrieves thinking content', () => {
      store.upsert(
        makeDraft({
          thinking: 'Let me analyze this step by step...',
        }),
      );
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts[0].thinking, 'Let me analyze this step by step...');
    });

    it('upsert overwrites thinking', () => {
      store.upsert(makeDraft({ thinking: 'v1 thinking' }));
      store.upsert(makeDraft({ thinking: 'v2 thinking' }));
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].thinking, 'v2 thinking');
    });

    it('omitting thinking returns undefined', () => {
      store.upsert(makeDraft());
      const drafts = store.getByThread('user-1', 'thread-1');
      assert.equal(drafts[0].thinking, undefined);
    });
  });
});
