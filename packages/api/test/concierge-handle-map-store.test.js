/**
 * ConciergeHandleMapStore tests (F229 KD-17)
 *
 * Per-concierge-thread short handle → anchor mapping.
 * R1/R2/... → {threadId, messageId, title, type}
 * Max 20 handles per thread, rolling eviction (oldest first).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('MemoryConciergeHandleMapStore', () => {
  let MemoryConciergeHandleMapStore;

  beforeEach(async () => {
    const mod = await import('../dist/domains/concierge/ConciergeHandleMapStore.js');
    MemoryConciergeHandleMapStore = mod.MemoryConciergeHandleMapStore;
  });

  it('setHandles stores and getHandle retrieves by label', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_123', title: 'F229 讨论', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'thread_def', title: 'F155 引导', type: 'feature' } },
    ];
    await store.setHandles('thread_concierge_1', handles);

    const r1 = await store.getHandle('thread_concierge_1', 'R1');
    assert.ok(r1, 'R1 should exist');
    assert.equal(r1.threadId, 'thread_abc');
    assert.equal(r1.messageId, 'msg_123');
    assert.equal(r1.title, 'F229 讨论');

    const r2 = await store.getHandle('thread_concierge_1', 'R2');
    assert.ok(r2, 'R2 should exist');
    assert.equal(r2.threadId, 'thread_def');
    assert.equal(r2.type, 'feature');
  });

  it('getHandle returns null for unknown label', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const result = await store.getHandle('thread_x', 'R99');
    assert.strictEqual(result, null);
  });

  it('getHandle returns null for unknown threadId', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_a', [{ label: 'R1', anchor: { threadId: 't1', title: 'test', type: 'thread' } }]);
    const result = await store.getHandle('thread_nonexistent', 'R1');
    assert.strictEqual(result, null);
  });

  it('setHandles replaces existing handles for the same threadId', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [{ label: 'R1', anchor: { threadId: 't_old', title: 'Old', type: 'thread' } }]);
    await store.setHandles('thread_c', [{ label: 'R1', anchor: { threadId: 't_new', title: 'New', type: 'thread' } }]);
    const r1 = await store.getHandle('thread_c', 'R1');
    assert.ok(r1);
    assert.equal(r1.threadId, 't_new');
    assert.equal(r1.title, 'New');
  });

  it('different threads have independent handle maps', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_1', [{ label: 'R1', anchor: { threadId: 'a', title: 'Alpha', type: 'thread' } }]);
    await store.setHandles('thread_2', [{ label: 'R1', anchor: { threadId: 'b', title: 'Beta', type: 'thread' } }]);
    const r1_t1 = await store.getHandle('thread_1', 'R1');
    const r1_t2 = await store.getHandle('thread_2', 'R1');
    assert.equal(r1_t1?.threadId, 'a');
    assert.equal(r1_t2?.threadId, 'b');
  });

  it('enforces max 20 handles — oldest evicted when exceeded', async () => {
    const store = new MemoryConciergeHandleMapStore();
    // Create 22 handles — R1..R22
    const handles = Array.from({ length: 22 }, (_, i) => ({
      label: `R${i + 1}`,
      anchor: { threadId: `t_${i + 1}`, title: `Item ${i + 1}`, type: 'thread' },
    }));
    await store.setHandles('thread_full', handles);

    // R1 and R2 should be evicted (oldest)
    const r1 = await store.getHandle('thread_full', 'R1');
    const r2 = await store.getHandle('thread_full', 'R2');
    assert.strictEqual(r1, null, 'R1 should be evicted');
    assert.strictEqual(r2, null, 'R2 should be evicted');

    // R3 should survive (first non-evicted)
    const r3 = await store.getHandle('thread_full', 'R3');
    assert.ok(r3, 'R3 should survive');
    assert.equal(r3.threadId, 't_3');

    // R22 should survive (newest)
    const r22 = await store.getHandle('thread_full', 'R22');
    assert.ok(r22, 'R22 should survive');
    assert.equal(r22.threadId, 't_22');
  });

  it('clearHandles removes all handles for a thread', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_d', [{ label: 'R1', anchor: { threadId: 't1', title: 'Test', type: 'thread' } }]);
    await store.clearHandles('thread_d');
    const r1 = await store.getHandle('thread_d', 'R1');
    assert.strictEqual(r1, null);
  });

  it('clearHandles is no-op for unknown threadId', async () => {
    const store = new MemoryConciergeHandleMapStore();
    // Should not throw
    await store.clearHandles('thread_nonexistent');
  });

  it('getAllHandles returns all handles for a thread', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_e', [
      { label: 'R1', anchor: { threadId: 't1', title: 'A', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 't2', title: 'B', type: 'feature' } },
    ]);
    const all = await store.getAllHandles('thread_e');
    assert.equal(all.length, 2);
    assert.equal(all[0].label, 'R1');
    assert.equal(all[1].label, 'R2');
  });

  it('getAllHandles returns empty array for unknown thread', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const all = await store.getAllHandles('thread_unknown');
    assert.deepStrictEqual(all, []);
  });
});
