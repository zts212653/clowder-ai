/**
 * ConciergeSearchContext tests (F229 KD-17)
 *
 * Pre-fetches search results, numbers them R1-R{n},
 * writes to HandleMap, returns formatted prompt context string.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('buildConciergeSearchContext', () => {
  let buildConciergeSearchContext;
  let MemoryConciergeHandleMapStore;

  beforeEach(async () => {
    const ctxMod = await import('../dist/domains/concierge/concierge-search-context.js');
    buildConciergeSearchContext = ctxMod.buildConciergeSearchContext;
    const storeMod = await import('../dist/domains/concierge/ConciergeHandleMapStore.js');
    MemoryConciergeHandleMapStore = storeMod.MemoryConciergeHandleMapStore;
  });

  /** Fake evidence store that returns canned results */
  function fakeEvidenceStore(items) {
    return {
      search: async (_query, _options) => items,
    };
  }

  it('numbers results R1..R{n} and writes to HandleMap', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'thread-thread_abc', title: 'F229 讨论', kind: 'thread', summary: '前台猫设计' },
      { anchor: 'feature:F155', title: 'F155 引导系统', kind: 'feature', summary: '引导流程' },
    ]);

    const result = await buildConciergeSearchContext({
      userMessage: '怎么用前台猫？',
      threadId: 'concierge_t1',
      handleMapStore: store,
      evidenceStore,
    });

    // Should have context string with R1, R2
    assert.ok(result.contextString.includes('R1'), 'context should contain R1');
    assert.ok(result.contextString.includes('R2'), 'context should contain R2');
    assert.ok(result.contextString.includes('F229 讨论'), 'context should contain title');
    assert.equal(result.handleCount, 2);

    // HandleMap should be populated
    const r1 = await store.getHandle('concierge_t1', 'R1');
    assert.ok(r1, 'R1 should exist in HandleMap');
    assert.equal(r1.title, 'F229 讨论');

    const r2 = await store.getHandle('concierge_t1', 'R2');
    assert.ok(r2, 'R2 should exist in HandleMap');
    assert.equal(r2.title, 'F155 引导系统');
  });

  it('returns empty context when no results found', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const evidenceStore = fakeEvidenceStore([]);

    const result = await buildConciergeSearchContext({
      userMessage: '完全不相关的话题',
      threadId: 'concierge_t2',
      handleMapStore: store,
      evidenceStore,
    });

    assert.equal(result.contextString, '');
    assert.equal(result.handleCount, 0);

    const all = await store.getAllHandles('concierge_t2');
    assert.equal(all.length, 0);
  });

  it('caps at maxResults (default 10)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const items = Array.from({ length: 15 }, (_, i) => ({
      anchor: `thread:t_${i}`,
      title: `Topic ${i}`,
      kind: 'thread',
      summary: `Summary ${i}`,
    }));
    const evidenceStore = fakeEvidenceStore(items);

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t3',
      handleMapStore: store,
      evidenceStore,
    });

    assert.ok(result.handleCount <= 10, 'should cap at 10 results');
    assert.ok(result.contextString.includes('R10'), 'should have R10');
    assert.ok(!result.contextString.includes('R11'), 'should not have R11');
  });

  it('extracts threadId from thread-type anchor (thread- prefix)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'thread-thread_xyz', title: '某个讨论', kind: 'thread', summary: '...' },
    ]);

    await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t4',
      handleMapStore: store,
      evidenceStore,
    });

    const r1 = await store.getHandle('concierge_t4', 'R1');
    assert.ok(r1);
    assert.equal(r1.threadId, 'thread_xyz');
    assert.equal(r1.type, 'thread');
  });

  it('handles non-thread anchors (feature/doc)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'feature:F229', title: 'F229 前台猫', kind: 'feature', summary: '...' },
    ]);

    await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t5',
      handleMapStore: store,
      evidenceStore,
    });

    const r1 = await store.getHandle('concierge_t5', 'R1');
    assert.ok(r1);
    assert.equal(r1.type, 'feature');
    // Non-thread anchors use the anchor string as threadId (best-effort)
    assert.equal(r1.threadId, 'feature:F229');
  });

  it('gracefully handles missing evidenceStore (returns empty)', async () => {
    const store = new MemoryConciergeHandleMapStore();

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t6',
      handleMapStore: store,
      evidenceStore: undefined,
    });

    assert.equal(result.contextString, '');
    assert.equal(result.handleCount, 0);
  });

  it('custom maxResults overrides default', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const items = Array.from({ length: 10 }, (_, i) => ({
      anchor: `thread:t_${i}`,
      title: `Topic ${i}`,
      kind: 'thread',
      summary: `S ${i}`,
    }));
    const evidenceStore = fakeEvidenceStore(items);

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t7',
      handleMapStore: store,
      evidenceStore,
      maxResults: 3,
    });

    assert.equal(result.handleCount, 3);
    assert.ok(result.contextString.includes('R3'));
    assert.ok(!result.contextString.includes('R4'));
  });

  // P1-1 fix: real memory index uses thread-{threadId} format, not thread:{threadId}
  it('parses real memory anchor format thread-{threadId}', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'thread-thread_real123', title: '真实讨论', kind: 'thread', summary: '...' },
    ]);

    await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_p1',
      handleMapStore: store,
      evidenceStore,
    });

    const r1 = await store.getHandle('concierge_p1', 'R1');
    assert.ok(r1);
    assert.equal(r1.threadId, 'thread_real123', 'should strip thread- prefix to get real threadId');
    assert.equal(r1.type, 'thread');
  });

  // P1-1 fix: drillDown.params has normalized threadId + messageId — use them
  it('uses drillDown.params for threadId/messageId when available', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const evidenceStore = fakeEvidenceStore([
      {
        anchor: 'thread-thread_abc',
        title: '带 drillDown 的结果',
        kind: 'thread',
        summary: '...',
        drillDown: {
          tool: 'cat_cafe_get_thread_context',
          params: { threadId: 'thread_abc', messageId: 'msg_456', before: '3', after: '3' },
          hint: '打开原文窗口',
        },
      },
    ]);

    await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_p1b',
      handleMapStore: store,
      evidenceStore,
    });

    const r1 = await store.getHandle('concierge_p1b', 'R1');
    assert.ok(r1);
    assert.equal(r1.threadId, 'thread_abc');
    assert.equal(r1.messageId, 'msg_456', 'should use drillDown.params.messageId');
  });

  // P1-2 fix: empty search results must clear stale handles
  it('clears stale handles when search returns empty', async () => {
    const store = new MemoryConciergeHandleMapStore();

    // First turn: populate handles
    const evidenceStore1 = fakeEvidenceStore([
      { anchor: 'thread-thread_old', title: 'Old Topic', kind: 'thread', summary: '...' },
    ]);
    await buildConciergeSearchContext({
      userMessage: 'first query',
      threadId: 'concierge_p2',
      handleMapStore: store,
      evidenceStore: evidenceStore1,
    });
    assert.ok(await store.getHandle('concierge_p2', 'R1'), 'R1 should exist after first turn');

    // Second turn: empty results → stale handles MUST be cleared
    const evidenceStore2 = fakeEvidenceStore([]);
    await buildConciergeSearchContext({
      userMessage: 'unrelated query',
      threadId: 'concierge_p2',
      handleMapStore: store,
      evidenceStore: evidenceStore2,
    });

    const staleR1 = await store.getHandle('concierge_p2', 'R1');
    assert.strictEqual(staleR1, null, 'stale R1 must be cleared after empty search');
  });

  // P1-2 fix: search failure must also clear stale handles
  it('clears stale handles when search throws', async () => {
    const store = new MemoryConciergeHandleMapStore();

    // First turn: populate
    const evidenceStore1 = fakeEvidenceStore([
      { anchor: 'thread-thread_old2', title: 'Old2', kind: 'thread', summary: '...' },
    ]);
    await buildConciergeSearchContext({
      userMessage: 'first',
      threadId: 'concierge_p2b',
      handleMapStore: store,
      evidenceStore: evidenceStore1,
    });
    assert.ok(await store.getHandle('concierge_p2b', 'R1'));

    // Second turn: search throws → stale handles MUST be cleared
    const brokenStore = {
      search: async () => {
        throw new Error('search failed');
      },
    };
    await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_p2b',
      handleMapStore: store,
      evidenceStore: brokenStore,
    });

    const staleR1 = await store.getHandle('concierge_p2b', 'R1');
    assert.strictEqual(staleR1, null, 'stale R1 must be cleared after search failure');
  });

  // P1-A + P1-C fix (AC-A3 recall, KD-19): search must request thread-scoped + hybrid + passage-level.
  // P1-C: scope=threads recalls discussion threads (AC-A3 finds discussions, not conclusion docs).
  // P1-A: depth=raw yields passage-level messageId (peek was always skipped without it).
  it('requests scope=threads, mode=hybrid, depth=raw from evidence search', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const calls = [];
    const evidenceStore = {
      search: async (query, options) => {
        calls.push({ query, options });
        return [{ anchor: 'thread-thread_x', title: 'T', kind: 'thread', summary: '...' }];
      },
    };

    await buildConciergeSearchContext({
      userMessage: '之前讨论 X 在哪',
      threadId: 'concierge_scope',
      handleMapStore: store,
      evidenceStore,
    });

    assert.equal(calls.length, 1, 'search called once');
    const opts = calls[0].options ?? {};
    assert.equal(opts.scope, 'threads', 'P1-C: should request thread-scoped recall');
    assert.equal(opts.mode, 'hybrid', 'should request hybrid mode');
    assert.equal(opts.depth, 'raw', 'P1-A: should request passage-level (messageId for peek)');
  });
});
