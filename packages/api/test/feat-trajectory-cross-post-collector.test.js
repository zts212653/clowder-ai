/**
 * F233 — CrossPostCollector tests (F252 Phase C prerequisite)
 *
 * CrossPostCollector scans messages with cross-post metadata to produce
 * `thread_merge` trajectory entries linking source→target threads.
 *
 * RED tests first — collector doesn't exist yet.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Helpers — inline stubs (no real Redis)
// ---------------------------------------------------------------------------

/** Stub message store that returns canned cross-post messages. */
function makeMessageStoreStub(messages = []) {
  return {
    listCrossPostMessages: async () => messages,
  };
}

/** Stub feat index lookup that maps threadId → featId. */
function makeFeatIndexStub(threadToFeat = {}) {
  return {
    lookupByThreadId: async (threadId) => threadToFeat[threadId] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeCrossPostMessage(overrides = {}) {
  return {
    id: 'msg_001',
    threadId: 'thread_target', // where the message landed
    catId: 'opus',
    timestamp: 1719360000000,
    extra: {
      crossPost: {
        sourceThreadId: 'thread_source', // where it came from
      },
    },
    ...overrides,
  };
}

// ==========================================================================
// Tests
// ==========================================================================

describe('F233 CrossPostCollector', () => {
  let CrossPostCollector;

  beforeEach(async () => {
    const mod = await import('../dist/domains/feat-trajectory/CrossPostCollector.js');
    CrossPostCollector = mod.CrossPostCollector;
  });

  it('produces thread_merge entry for cross-post message', async () => {
    const messages = [makeCrossPostMessage()];
    const messageStore = makeMessageStoreStub(messages);
    const featIndex = makeFeatIndexStub({ thread_source: 'F252' });

    const collector = new CrossPostCollector({ messageStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].kind, 'thread_merge');
    assert.equal(snapshots[0].sourceThreadId, 'thread_source');
    assert.equal(snapshots[0].targetThreadId, 'thread_target');
    assert.equal(snapshots[0].messageId, 'msg_001');
    assert.equal(snapshots[0].featId, 'F252');
    assert.equal(snapshots[0].catId, 'opus');
  });

  it('skips messages without crossPost metadata', async () => {
    const messages = [makeCrossPostMessage({ extra: {} }), makeCrossPostMessage({ extra: undefined })];
    const messageStore = makeMessageStoreStub(messages);
    const featIndex = makeFeatIndexStub({ thread_source: 'F252' });

    const collector = new CrossPostCollector({ messageStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 0);
  });

  it('skips messages where source thread has no feat association', async () => {
    const messages = [makeCrossPostMessage()];
    const messageStore = makeMessageStoreStub(messages);
    const featIndex = makeFeatIndexStub({}); // no feat for this thread

    const collector = new CrossPostCollector({ messageStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 0);
  });

  it('handles multiple cross-posts across different features', async () => {
    const messages = [
      makeCrossPostMessage({
        id: 'msg_a',
        threadId: 't_target_1',
        extra: { crossPost: { sourceThreadId: 't_source_1' } },
      }),
      makeCrossPostMessage({
        id: 'msg_b',
        threadId: 't_target_2',
        extra: { crossPost: { sourceThreadId: 't_source_2' } },
      }),
    ];
    const messageStore = makeMessageStoreStub(messages);
    const featIndex = makeFeatIndexStub({
      t_source_1: 'F100',
      t_source_2: 'F200',
    });

    const collector = new CrossPostCollector({ messageStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].featId, 'F100');
    assert.equal(snapshots[0].sourceThreadId, 't_source_1');
    assert.equal(snapshots[1].featId, 'F200');
    assert.equal(snapshots[1].sourceThreadId, 't_source_2');
  });

  it('uses message timestamp for postedAt', async () => {
    const messages = [makeCrossPostMessage({ timestamp: 1719360099000 })];
    const messageStore = makeMessageStoreStub(messages);
    const featIndex = makeFeatIndexStub({ thread_source: 'F252' });

    const collector = new CrossPostCollector({ messageStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots[0].postedAt, 1719360099000);
  });

  it('skips undelivered cross-posts (queued/canceled) (cloud R2 P2)', async () => {
    // Messages with deliveryStatus 'queued' or 'canceled' haven't reached
    // the target thread — they shouldn't produce thread_merge entries.
    const messages = [
      makeCrossPostMessage({ id: 'msg_queued', deliveryStatus: 'queued' }),
      makeCrossPostMessage({ id: 'msg_canceled', deliveryStatus: 'canceled' }),
      makeCrossPostMessage({ id: 'msg_delivered', deliveryStatus: 'delivered' }),
      makeCrossPostMessage({ id: 'msg_legacy' }), // no deliveryStatus = legacy delivered
    ];
    const messageStore = makeMessageStoreStub(messages);
    const featIndex = makeFeatIndexStub({ thread_source: 'F252' });

    const collector = new CrossPostCollector({ messageStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 2, 'only delivered + legacy should produce entries');
    const ids = snapshots.map((s) => s.messageId);
    assert.ok(ids.includes('msg_delivered'));
    assert.ok(ids.includes('msg_legacy'));
    assert.ok(!ids.includes('msg_queued'));
    assert.ok(!ids.includes('msg_canceled'));
  });

  it('also matches feat by target thread when source has no feat', async () => {
    // Cross-post from non-feat thread INTO a feat thread is still relevant
    const messages = [
      makeCrossPostMessage({
        threadId: 'thread_feat_target',
        extra: { crossPost: { sourceThreadId: 'thread_no_feat' } },
      }),
    ];
    const messageStore = makeMessageStoreStub(messages);
    const featIndex = makeFeatIndexStub({
      // source has no feat, but target does
      thread_feat_target: 'F300',
    });

    const collector = new CrossPostCollector({ messageStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].featId, 'F300');
  });
});
