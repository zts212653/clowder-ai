/**
 * ConciergeSearchContext tests (F229 KD-23)
 *
 * Pre-fetches search results, numbers them R1-R{n},
 * returns handle table + formatted prompt context string.
 *
 * KD-23: No HandleMapStore — handle table is a per-invocation flowing value.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('buildConciergeSearchContext', () => {
  let buildConciergeSearchContext;
  let computeConciergeHandleDigest;
  let formatConciergeHandleBinding;
  let normalizeConciergeHandleTitle;

  beforeEach(async () => {
    const ctxMod = await import('../dist/domains/concierge/concierge-search-context.js');
    buildConciergeSearchContext = ctxMod.buildConciergeSearchContext;
    computeConciergeHandleDigest = ctxMod.computeConciergeHandleDigest;
    formatConciergeHandleBinding = ctxMod.formatConciergeHandleBinding;
    normalizeConciergeHandleTitle = ctxMod.normalizeConciergeHandleTitle;
  });

  /** Fake evidence store that returns canned results */
  function fakeEvidenceStore(items) {
    return {
      search: async (_query, _options) => items,
    };
  }

  it('normalizes every marker delimiter and newline before formatting a binding', () => {
    assert.equal(
      normalizeConciergeHandleTitle('  F229｜猫猫球 | [concierge]\nfeature  '),
      'F229 猫猫球 concierge feature',
    );
    const anchor = { threadId: 'thread_a', title: 'F229｜[猫猫球]\nfeature', type: 'thread' };
    assert.equal(
      formatConciergeHandleBinding('R1', anchor),
      `R1｜F229 猫猫球 feature｜${computeConciergeHandleDigest('R1', anchor)}`,
    );
  });

  it('formats an empty normalized title with a copyable canonical fallback', () => {
    const anchor = { threadId: 'thread_empty', title: '[｜|]\n', type: 'thread' };
    assert.equal(normalizeConciergeHandleTitle('[｜|]\n'), '未命名记录');
    assert.equal(
      formatConciergeHandleBinding('R1', anchor),
      `R1｜未命名记录｜${computeConciergeHandleDigest('R1', anchor)}`,
    );
  });

  it('formats markdown metacharacters with a copyable canonical-safe title', () => {
    const anchor = {
      threadId: 'thread_md',
      title: 'Bug *fix* _audit_ `cmd` \\path [link](target) ~done~',
      type: 'thread',
    };
    assert.equal(normalizeConciergeHandleTitle(anchor.title), 'Bug *fix* _audit_ `cmd` \\path link (target) ~done~');
    assert.equal(
      formatConciergeHandleBinding('R1', anchor),
      `R1｜Bug ＊fix＊ ＿audit＿ ｀cmd｀ ＼path link （target） ～done～｜${computeConciergeHandleDigest('R1', anchor)}`,
    );
  });

  it('escapes autolink delimiters so remarkGfm cannot split the marker', () => {
    // P2 R3 fix: titles containing an angle-bracket autolink (e.g. `Spec <https://example.com>`)
    // would leak raw `<`/`>` into the generated marker; ReactMarkdown/remarkGfm then treats the
    // URL as its own autolink node and the marker regex no longer sees one contiguous marker.
    // The canonical Markdown-safe mapping must neutralize angle brackets.
    const anchor = {
      threadId: 'thread_autolink',
      title: 'Spec <https://example.com>',
      type: 'thread',
    };
    const binding = formatConciergeHandleBinding('R1', anchor);
    assert.equal(binding, `R1｜Spec ＜https://example.com＞｜${computeConciergeHandleDigest('R1', anchor)}`);
    // Also verify no raw autolink delimiter survives — belt-and-suspenders against future regex drift.
    assert.ok(!binding.includes('<'), 'binding must not contain raw < after escape');
    assert.ok(!binding.includes('>'), 'binding must not contain raw > after escape');
  });

  it('gives duplicate titles different anchor digests', () => {
    const first = { threadId: 'thread_a', title: '同名讨论', type: 'thread' };
    const second = { threadId: 'thread_b', title: '同名讨论', type: 'thread' };

    assert.notEqual(computeConciergeHandleDigest('R1', first), computeConciergeHandleDigest('R2', second));
  });

  it('numbers results R1..R{n} and returns handles', async () => {
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'thread-thread_abc', title: 'F229 讨论', kind: 'thread', summary: '前台猫设计' },
      { anchor: 'feature:F155', title: 'F155 引导系统', kind: 'feature', summary: '引导流程' },
    ]);

    const result = await buildConciergeSearchContext({
      userMessage: '怎么用前台猫？',
      threadId: 'concierge_t1',
      evidenceStore,
    });

    // Should have context string with R1, R2
    assert.ok(result.contextString.includes('R1'), 'context should contain R1');
    assert.ok(result.contextString.includes('R2'), 'context should contain R2');
    assert.ok(result.contextString.includes('F229 讨论'), 'context should contain title');
    assert.equal(result.handleCount, 2);

    // KD-23: handles returned directly (not stored)
    assert.equal(result.handles.length, 2);
    assert.equal(result.handles[0].label, 'R1');
    assert.equal(result.handles[0].anchor.title, 'F229 讨论');
    assert.equal(result.handles[1].label, 'R2');
    assert.equal(result.handles[1].anchor.title, 'F155 引导系统');
    const r1Binding = formatConciergeHandleBinding(result.handles[0].label, result.handles[0].anchor);
    assert.ok(
      result.contextString.includes(`[跳过去 ${r1Binding}]`),
      'each result should provide a copyable bound marker',
    );
  });

  it('returns empty context when no results found', async () => {
    const evidenceStore = fakeEvidenceStore([]);

    const result = await buildConciergeSearchContext({
      userMessage: '完全不相关的话题',
      threadId: 'concierge_t2',
      evidenceStore,
    });

    assert.equal(result.contextString, '');
    assert.equal(result.handleCount, 0);
    assert.deepEqual(result.handles, []);
  });

  it('caps at maxResults (default 10)', async () => {
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
      evidenceStore,
    });

    assert.ok(result.handleCount <= 10, 'should cap at 10 results');
    assert.ok(result.contextString.includes('R10'), 'should have R10');
    assert.ok(!result.contextString.includes('R11'), 'should not have R11');
    assert.equal(result.handles.length, 10);
  });

  it('extracts threadId from thread-type anchor (thread- prefix)', async () => {
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'thread-thread_xyz', title: '某个讨论', kind: 'thread', summary: '...' },
    ]);

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t4',
      evidenceStore,
    });

    const r1 = result.handles[0];
    assert.ok(r1);
    assert.equal(r1.anchor.threadId, 'thread_xyz');
    assert.equal(r1.anchor.type, 'thread');
  });

  it('handles non-thread anchors (feature/doc)', async () => {
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'feature:F229', title: 'F229 前台猫', kind: 'feature', summary: '...' },
    ]);

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t5',
      evidenceStore,
    });

    const r1 = result.handles[0];
    assert.ok(r1);
    assert.equal(r1.anchor.type, 'feature');
    assert.equal(r1.anchor.threadId, 'feature:F229');
  });

  it('gracefully handles missing evidenceStore (returns empty)', async () => {
    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_t6',
      evidenceStore: undefined,
    });

    assert.equal(result.contextString, '');
    assert.equal(result.handleCount, 0);
    assert.deepEqual(result.handles, []);
  });

  it('custom maxResults overrides default', async () => {
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
      evidenceStore,
      maxResults: 3,
    });

    assert.equal(result.handleCount, 3);
    assert.ok(result.contextString.includes('R3'));
    assert.ok(!result.contextString.includes('R4'));
    assert.equal(result.handles.length, 3);
  });

  it('parses real memory anchor format thread-{threadId}', async () => {
    const evidenceStore = fakeEvidenceStore([
      { anchor: 'thread-thread_real123', title: '真实讨论', kind: 'thread', summary: '...' },
    ]);

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_p1',
      evidenceStore,
    });

    const r1 = result.handles[0];
    assert.ok(r1);
    assert.equal(r1.anchor.threadId, 'thread_real123', 'should strip thread- prefix to get real threadId');
    assert.equal(r1.anchor.type, 'thread');
  });

  it('uses drillDown.params for threadId/messageId when available', async () => {
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

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_p1b',
      evidenceStore,
    });

    const r1 = result.handles[0];
    assert.ok(r1);
    assert.equal(r1.anchor.threadId, 'thread_abc');
    assert.equal(r1.anchor.messageId, 'msg_456', 'should use drillDown.params.messageId');
  });

  // KD-23: Cross-turn isolation — each invocation builds its own handle table.
  // Previous turn's handles are NOT available (no shared store to leak from).
  it('each invocation returns independent handles (cross-turn isolation)', async () => {
    const evidenceStore1 = fakeEvidenceStore([
      { anchor: 'thread-thread_old', title: 'Turn 1 Topic', kind: 'thread', summary: '...' },
    ]);
    const result1 = await buildConciergeSearchContext({
      userMessage: 'first query',
      threadId: 'concierge_iso',
      evidenceStore: evidenceStore1,
    });

    const evidenceStore2 = fakeEvidenceStore([
      { anchor: 'thread-thread_new', title: 'Turn 2 Topic', kind: 'thread', summary: '...' },
    ]);
    const result2 = await buildConciergeSearchContext({
      userMessage: 'second query',
      threadId: 'concierge_iso',
      evidenceStore: evidenceStore2,
    });

    // Each result has its own independent handles
    assert.equal(result1.handles[0].anchor.threadId, 'thread_old');
    assert.equal(result2.handles[0].anchor.threadId, 'thread_new');

    // Turn 1's R1 still points to old topic (it's a snapshot, not a reference)
    assert.equal(result1.handles[0].anchor.title, 'Turn 1 Topic');
    assert.equal(result2.handles[0].anchor.title, 'Turn 2 Topic');
  });

  // KD-23: Empty search returns empty handles (no stale data possible)
  it('empty search returns empty handles — no stale data possible', async () => {
    const emptyStore = fakeEvidenceStore([]);
    const result = await buildConciergeSearchContext({
      userMessage: 'unrelated',
      threadId: 'concierge_empty',
      evidenceStore: emptyStore,
    });

    assert.deepEqual(result.handles, []);
    assert.equal(result.handleCount, 0);
  });

  it('search failure returns empty handles — no crash', async () => {
    const brokenStore = {
      search: async () => {
        throw new Error('search failed');
      },
    };

    const result = await buildConciergeSearchContext({
      userMessage: 'test',
      threadId: 'concierge_fail',
      evidenceStore: brokenStore,
    });

    assert.equal(result.contextString, '');
    assert.equal(result.handleCount, 0);
    assert.deepEqual(result.handles, []);
  });

  it('requests scope=threads, mode=hybrid, depth=raw from evidence search', async () => {
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
      evidenceStore,
    });

    assert.equal(calls.length, 1, 'search called once');
    const opts = calls[0].options ?? {};
    assert.equal(opts.scope, 'threads', 'P1-C: should request thread-scoped recall');
    assert.equal(opts.mode, 'hybrid', 'should request hybrid mode');
    assert.equal(opts.depth, 'raw', 'P1-A: should request passage-level (messageId for peek)');
  });
});
