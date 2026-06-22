/**
 * F236 Phase A — callback anchor helpers (projection layer, AC-A1~A5 / AC-B1)
 *
 * Pure-function unit tests for the anchor-first projection helpers used by
 * callback routes (thread-context / pending-mentions / list-tasks). These run
 * against compiled dist (same convention as callback-routes.test.js).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  PREVIEW_MAX_CHARS,
  truncateHead,
  truncateHeadTail,
  truncateAroundMatch,
  anchorThreadMessage,
  anchorPendingMention,
  anchorTaskWhy,
} = await import('../dist/routes/callback-anchor-helpers.js');

describe('callback-anchor-helpers (F236 Phase A)', () => {
  // ---- constant ----
  test('PREVIEW_MAX_CHARS is 280', () => {
    assert.equal(PREVIEW_MAX_CHARS, 280);
  });

  // ---- truncateHead (head-only, AC-A1/A2 thread-context + AC-A4 task why) ----
  test('truncateHead: short text passes through untruncated', () => {
    const r = truncateHead('hello', 280);
    assert.equal(r.preview, 'hello');
    assert.equal(r.truncated, false);
  });

  test('truncateHead: long text truncated to max, truncated=true, is a real prefix', () => {
    const long = 'x'.repeat(500);
    const r = truncateHead(long, 280);
    assert.equal(r.preview.length, 280);
    assert.equal(r.truncated, true);
    assert.ok(long.startsWith(r.preview), 'preview must be a genuine prefix of the original');
  });

  test('truncateHead: exact-boundary text is not truncated', () => {
    const exact = 'x'.repeat(280);
    const r = truncateHead(exact, 280);
    assert.equal(r.truncated, false);
    assert.equal(r.preview, exact);
  });

  test('truncateHead: defaults to PREVIEW_MAX_CHARS when max omitted', () => {
    const long = 'y'.repeat(400);
    const r = truncateHead(long);
    assert.equal(r.preview.length, 280);
    assert.equal(r.truncated, true);
  });

  // ---- truncateHeadTail (AC-A3 pending mentions — handoff instruction often in tail) ----
  test('truncateHeadTail: short text passes through untruncated', () => {
    const r = truncateHeadTail('hello', 280);
    assert.equal(r.preview, 'hello');
    assert.equal(r.truncated, false);
  });

  test('truncateHeadTail: long text keeps BOTH head and tail + honest omission marker', () => {
    const head = 'HEAD_INSTRUCTION ';
    const middle = 'm'.repeat(500);
    const tail = ' TAIL_HANDOFF @opus go';
    const text = head + middle + tail;
    const r = truncateHeadTail(text, 280);
    assert.equal(r.truncated, true);
    assert.ok(r.preview.startsWith('HEAD_INSTRUCTION'), 'head preserved');
    assert.ok(r.preview.endsWith('TAIL_HANDOFF @opus go'), 'tail (handoff) preserved — not lost');
    assert.match(r.preview, /\bchars\b/, 'omission marker must be honest about how much was cut');
  });

  // ---- truncateAroundMatch (F236 R1 / 砚砚 P1 anti-变瞎子) ----
  test('truncateAroundMatch: short text passes through untruncated', () => {
    const r = truncateAroundMatch('hello world', ['world'], 280);
    assert.equal(r.preview, 'hello world');
    assert.equal(r.truncated, false);
  });

  test('truncateAroundMatch: keyword hit in the TAIL surfaces in preview + honest head omission', () => {
    const text = `${'A'.repeat(500)} SENTINEL_MATCH tail`;
    const r = truncateAroundMatch(text, ['SENTINEL_MATCH'], 280);
    assert.equal(r.truncated, true);
    assert.ok(r.preview.includes('SENTINEL_MATCH'), 'keyword hit must appear in preview (not blind)');
    assert.match(r.preview, /\bchars\b/, 'omitted head honestly marked');
  });

  test('truncateAroundMatch: keyword hit in the MIDDLE surfaces in preview', () => {
    const text = `${'x'.repeat(400)} MIDHIT ${'y'.repeat(400)}`;
    const r = truncateAroundMatch(text, ['MIDHIT'], 280);
    assert.equal(r.truncated, true);
    assert.ok(r.preview.includes('MIDHIT'), 'mid keyword hit must appear in preview');
  });

  test('truncateAroundMatch: case-insensitive match', () => {
    const text = `${'A'.repeat(500)} NeedLE end`;
    const r = truncateAroundMatch(text, ['needle'], 280);
    assert.ok(r.preview.includes('NeedLE'), 'match is case-insensitive');
  });

  test('truncateAroundMatch: no keyword hit falls back to head-only prefix', () => {
    const text = 'Z'.repeat(500);
    const r = truncateAroundMatch(text, ['absent'], 280);
    assert.equal(r.truncated, true);
    assert.ok(text.startsWith(r.preview), 'no-hit fallback is a genuine head prefix');
    assert.equal(r.preview.length, 280);
  });

  test('anchorThreadMessage: keywordTerms route preview through match window', () => {
    const item = { id: 'k1', userId: 'u', catId: null, content: `${'A'.repeat(500)} KWHIT z`, timestamp: 1 };
    const a = anchorThreadMessage(item, { effectiveThreadId: 't', speaker: 'co-creator', keywordTerms: ['KWHIT'] });
    assert.equal(a.truncated, true);
    assert.ok(a.preview.includes('KWHIT'), 'keyword-ranked anchor preview must show why it matched');
  });

  test('anchorThreadMessage: agent-key caller drillDown carries agentKeyCatId (F236 R1/云端 P2)', () => {
    const item = { id: 'ak1', userId: 'u', catId: null, content: 'x', timestamp: 1 };
    const a = anchorThreadMessage(item, { effectiveThreadId: 't', speaker: 'co-creator', agentKeyCatId: 'antig-opus' });
    assert.deepEqual(a.drillDown, {
      tool: 'cat_cafe_get_message',
      args: { messageId: 'ak1', mode: 'full', agentKeyCatId: 'antig-opus' },
    });
  });

  test('anchorThreadMessage: invocation caller drillDown omits agentKeyCatId', () => {
    const item = { id: 'inv1', userId: 'u', catId: null, content: 'x', timestamp: 1 };
    const a = anchorThreadMessage(item, { effectiveThreadId: 't', speaker: 'co-creator' });
    assert.equal('agentKeyCatId' in a.drillDown.args, false);
  });

  // ---- anchorThreadMessage (AC-A1/A2) ----
  test('anchorThreadMessage: short message → anchor shape with injected threadId', () => {
    const item = { id: 'm1', userId: 'user-1', catId: null, content: 'Message 1', timestamp: 1 };
    const a = anchorThreadMessage(item, { effectiveThreadId: 'thread-x', speaker: 'co-creator' });
    assert.equal(a.id, 'm1');
    assert.equal(a.threadId, 'thread-x'); // AC: injected effectiveThreadId
    assert.equal(a.timestamp, 1);
    assert.equal(a.speaker, 'co-creator'); // F236 R1: caller-supplied via sender-display, never raw userId
    assert.equal(a.preview, 'Message 1');
    assert.equal(a.contentLength, 9);
    assert.equal(a.truncated, false);
    assert.deepEqual(a.drillDown, {
      tool: 'cat_cafe_get_message',
      args: { messageId: 'm1', mode: 'full' },
    });
  });

  test('anchorThreadMessage: speaker is passed through verbatim (caller resolves sender-display)', () => {
    const item = { id: 'm2', userId: 'user-1', catId: 'opus', content: 'Reply 1', timestamp: 2 };
    const a = anchorThreadMessage(item, { effectiveThreadId: 'thread-x', speaker: '布偶猫 Opus 4.6' });
    assert.equal(a.speaker, '布偶猫 Opus 4.6');
  });

  test('anchorThreadMessage: omits content/contentBlocks/userId/catId (token-lean anchor)', () => {
    const item = {
      id: 'm3',
      userId: 'user-1',
      catId: 'opus',
      content: 'hi',
      timestamp: 3,
      contentBlocks: [{ type: 'text', text: 'hi' }],
    };
    const a = anchorThreadMessage(item, { effectiveThreadId: 't', speaker: 'co-creator' });
    assert.equal('content' in a, false);
    assert.equal('contentBlocks' in a, false);
    assert.equal('userId' in a, false);
    assert.equal('catId' in a, false);
  });

  test('anchorThreadMessage: long content truncated head-only with contentLength', () => {
    const item = { id: 'm4', userId: 'u', catId: null, content: 'A'.repeat(400), timestamp: 4 };
    const a = anchorThreadMessage(item, { effectiveThreadId: 't', speaker: 'co-creator' });
    assert.equal(a.truncated, true);
    assert.equal(a.preview.length, 280);
    assert.equal(a.contentLength, 400);
  });

  test('anchorThreadMessage: preserves image hints when provided', () => {
    const item = { id: 'm5', userId: 'u', catId: null, content: 'pic', timestamp: 5 };
    const a = anchorThreadMessage(item, {
      effectiveThreadId: 't',
      speaker: 'co-creator',
      imagePaths: ['/abs/x.png'],
      imageUrls: ['http://h/uploads/x.png'],
    });
    assert.deepEqual(a.imagePaths, ['/abs/x.png']);
    assert.deepEqual(a.imageUrls, ['http://h/uploads/x.png']);
  });

  test('anchorThreadMessage: no image fields when none provided', () => {
    const item = { id: 'm6', userId: 'u', catId: null, content: 'x', timestamp: 6 };
    const a = anchorThreadMessage(item, { effectiveThreadId: 't', speaker: 'co-creator' });
    assert.equal('imagePaths' in a, false);
    assert.equal('imageUrls' in a, false);
  });

  // ---- anchorPendingMention (AC-A3) ----
  test('anchorPendingMention: short mention keeps from/message, requiresDrill=false', () => {
    const item = { id: 'p1', userId: 'user-1', catId: null, content: '@opus help me', timestamp: 1 };
    const a = anchorPendingMention(item, { from: 'co-creator' });
    assert.equal(a.id, 'p1');
    assert.equal(a.from, 'co-creator'); // F236 R1: caller-supplied, never raw userId
    assert.equal(a.message, '@opus help me');
    assert.equal(a.timestamp, 1);
    assert.equal(a.contentLength, 13);
    assert.equal(a.requiresDrill, false);
    assert.deepEqual(a.drillDown, {
      tool: 'cat_cafe_get_message',
      args: { messageId: 'p1', mode: 'full' },
    });
  });

  test('anchorPendingMention: long mention → head+tail, requiresDrill=true, tail handoff preserved', () => {
    const content = '@opus ' + 'context '.repeat(80) + 'FINAL: @sonnet take over now';
    const item = { id: 'p2', userId: 'user-1', catId: null, content, timestamp: 2 };
    const a = anchorPendingMention(item, { from: 'co-creator' });
    assert.equal(a.requiresDrill, true);
    assert.ok(a.message.startsWith('@opus'), 'head preserved');
    assert.ok(a.message.endsWith('FINAL: @sonnet take over now'), 'handoff instruction in tail not lost');
    assert.equal(a.contentLength, content.length);
  });

  test('anchorPendingMention: includes acked only when provided', () => {
    const item = { id: 'p3', userId: 'u', catId: null, content: 'x', timestamp: 3 };
    assert.equal(anchorPendingMention(item, { from: 'co-creator', acked: true }).acked, true);
    assert.equal('acked' in anchorPendingMention(item, { from: 'co-creator' }), false);
  });

  // ---- anchorTaskWhy (AC-A4) ----
  test('anchorTaskWhy: short why untruncated, whyTruncated=false, no drillDown', () => {
    const task = { id: 't1', threadId: 'th', title: 'T', why: 'short reason', status: 'todo', ownerCatId: 'opus' };
    const a = anchorTaskWhy(task);
    assert.equal(a.why, 'short reason');
    assert.equal(a.whyLength, 'short reason'.length);
    assert.equal(a.whyTruncated, false);
    assert.equal('drillDown' in a, false);
    assert.equal(a.title, 'T'); // other fields preserved
    assert.equal(a.ownerCatId, 'opus');
  });

  test('anchorTaskWhy: long why truncated head-only with whyLength + drillDown to list_tasks', () => {
    const why = 'W'.repeat(600);
    const task = { id: 't2', threadId: 'th', title: 'T', why, status: 'todo' };
    const a = anchorTaskWhy(task);
    assert.equal(a.whyTruncated, true);
    assert.equal(a.why.length, 280);
    assert.equal(a.whyLength, 600);
    assert.deepEqual(a.drillDown, { tool: 'cat_cafe_list_tasks', args: { taskId: 't2' } });
  });

  test('anchorTaskWhy: full mode returns complete why, whyTruncated=false, no drillDown', () => {
    const why = 'W'.repeat(600);
    const task = { id: 't3', threadId: 'th', title: 'T', why, status: 'todo' };
    const a = anchorTaskWhy(task, { full: true });
    assert.equal(a.why, why);
    assert.equal(a.whyLength, 600);
    assert.equal(a.whyTruncated, false);
    assert.equal('drillDown' in a, false);
  });

  test('anchorTaskWhy: does not touch automationState (no scope creep)', () => {
    const task = {
      id: 't4',
      threadId: 'th',
      title: 'T',
      why: 'x',
      status: 'todo',
      automationState: { ci: { state: 'green' } },
    };
    const a = anchorTaskWhy(task);
    assert.deepEqual(a.automationState, { ci: { state: 'green' } });
  });
});
