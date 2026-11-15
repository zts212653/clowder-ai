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
  summarizeRichBlocks,
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
    const head = 'HEAD:' + 'a'.repeat(275);
    const long = head + 'MIDDLE:' + 'b'.repeat(200) + ':TAIL';
    const r = truncateHead(long, 280);
    assert.equal(r.preview.length, 280);
    assert.equal(r.truncated, true);
    assert.equal(r.preview, head, 'keep the head, not a same-length middle or suffix');
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
    const head = 'HEAD:' + 'h'.repeat(135);
    const middle = 'm'.repeat(500);
    const tail = 't'.repeat(135) + ':TAIL';
    const r = truncateHeadTail(head + middle + tail, 280);
    assert.equal(r.truncated, true);
    assert.equal(r.preview, `${head}…[+500 chars]…${tail}`, 'keep both ends and report exactly the omitted middle');
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

  // ---- Rich blocks anchor summary (honesty contract without payload bloat) ----
  test('summarizeRichBlocks: returns undefined when blocks are absent or empty', () => {
    assert.equal(summarizeRichBlocks(undefined), undefined);
    assert.equal(summarizeRichBlocks([]), undefined);
  });

  test('summarizeRichBlocks: projects bounded metadata per kind without heavy bodies', () => {
    const longTitle = 'T'.repeat(200);
    const summary = summarizeRichBlocks([
      {
        id: 'w1',
        kind: 'html_widget',
        v: 1,
        title: longTitle,
        html: '<svg>' + 'x'.repeat(5000) + '</svg>',
        height: 320,
      },
      {
        id: 'c1',
        kind: 'card',
        v: 1,
        title: 'Status Card',
        tone: 'info',
        bodyMarkdown: 'secret body',
        fields: [{ label: 'a', value: 'b' }],
      },
      {
        id: 'cl1',
        kind: 'checklist',
        v: 1,
        title: 'Steps',
        items: [
          { id: '1', text: 'one', checked: true },
          { id: '2', text: 'two' },
        ],
      },
      { id: 'd1', kind: 'diff', v: 1, filePath: 'src/index.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
      {
        id: 'f1',
        kind: 'file',
        v: 1,
        url: '/uploads/spec.pdf',
        fileName: 'spec.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
      },
    ]);
    assert.equal(summary.length, 5);
    assert.equal(summary[0].id, 'w1');
    assert.equal(summary[0].kind, 'html_widget');
    assert.equal(summary[0].title.length, 120);
    assert.equal(summary[0].summaryTruncated, true);
    assert.equal(summary[0].htmlLength, 5011);
    assert.equal(summary[0].height, 320);
    assert.equal('html' in summary[0], false);
    assert.deepEqual(summary[1], {
      id: 'c1',
      kind: 'card',
      title: 'Status Card',
      tone: 'info',
      bodyLength: 'secret body'.length,
      fieldCount: 1,
    });
    assert.deepEqual(summary[2], { id: 'cl1', kind: 'checklist', title: 'Steps', itemCount: 2 });
    assert.deepEqual(summary[3], { id: 'd1', kind: 'diff', filePath: 'src/index.ts', diffLength: 21 });
    assert.deepEqual(summary[4], {
      id: 'f1',
      kind: 'file',
      fileName: 'spec.pdf',
      mimeType: 'application/pdf',
      fileSize: 1024,
    });
  });

  test('anchorThreadMessage: bounds oversized block id, mimeType, and high block counts with honest omission flags', () => {
    const hugeIdItem = anchorThreadMessage(
      {
        id: 'rb-huge-id',
        userId: 'user-1',
        catId: 'gemini-carbon',
        content: 'short',
        timestamp: 20,
        extra: {
          rich: {
            v: 1,
            blocks: [{ id: 'x'.repeat(25_000), kind: 'html_widget', v: 1, html: '<svg/>' }],
          },
        },
      },
      { effectiveThreadId: 'thread-x', speaker: '碳碳·烁烁' },
    );
    assert.equal(hugeIdItem.truncated, true);
    assert.equal(hugeIdItem.richBlocksSummaryTruncated, true);
    assert.equal(hugeIdItem.richBlocksSummary[0].summaryTruncated, true);
    assert.ok(hugeIdItem.richBlocksSummary[0].id.length <= 64);
    assert.ok(Buffer.byteLength(JSON.stringify(hugeIdItem), 'utf8') <= 2_500);

    const hugeMimeItem = anchorThreadMessage(
      {
        id: 'rb-huge-mime',
        userId: 'user-1',
        catId: 'gemini-carbon',
        content: 'short',
        timestamp: 21,
        extra: {
          rich: {
            v: 1,
            blocks: [
              {
                id: 'f-mime',
                kind: 'file',
                v: 1,
                url: '/uploads/a.bin',
                fileName: 'a.bin',
                mimeType: 'm'.repeat(25_000),
              },
            ],
          },
        },
      },
      { effectiveThreadId: 'thread-x', speaker: '碳碳·烁烁' },
    );
    assert.equal(hugeMimeItem.richBlocksSummaryTruncated, true);
    assert.equal(hugeMimeItem.richBlocksSummary[0].summaryTruncated, true);
    assert.ok(hugeMimeItem.richBlocksSummary[0].mimeType.length <= 80);
    assert.ok(Buffer.byteLength(JSON.stringify(hugeMimeItem), 'utf8') <= 2_500);

    const manyBlocksItem = anchorThreadMessage(
      {
        id: 'rb-many',
        userId: 'user-1',
        catId: 'gemini-carbon',
        content: 'many widgets',
        timestamp: 22,
        extra: {
          rich: {
            v: 1,
            blocks: Array.from({ length: 150 }, (_, idx) => ({
              id: `w-${idx}`,
              kind: 'html_widget',
              v: 1,
              title: '标'.repeat(120),
              html: '<svg/>',
            })),
          },
        },
      },
      { effectiveThreadId: 'thread-x', speaker: '碳碳·烁烁' },
    );
    assert.equal(manyBlocksItem.truncated, true);
    assert.equal(manyBlocksItem.richBlocksSummaryTruncated, true);
    assert.equal(manyBlocksItem.richBlocksTotalCount, 150);
    assert.ok(manyBlocksItem.richBlocksSummary.length >= 1 && manyBlocksItem.richBlocksSummary.length <= 8);
    assert.equal(manyBlocksItem.richBlocksOmittedCount, 150 - manyBlocksItem.richBlocksSummary.length);
    assert.ok(Buffer.byteLength(JSON.stringify(manyBlocksItem), 'utf8') <= 2_500);
    assert.deepEqual(manyBlocksItem.drillDown, {
      tool: 'cat_cafe_get_message',
      args: { messageId: 'rb-many', mode: 'full' },
    });
  });

  test('anchorThreadMessage: short prose with extra.rich.blocks flags truncated=true and includes richBlocksSummary', () => {
    const item = {
      id: 'rb1',
      userId: 'user-1',
      catId: 'gemini-carbon',
      content: '画好啦 🐬',
      timestamp: 10,
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'dolphin', kind: 'html_widget', v: 1, title: '深海跃浪的小海豚', html: '<svg>dolphin</svg>' }],
        },
      },
    };
    const a = anchorThreadMessage(item, { effectiveThreadId: 'thread-x', speaker: '碳碳·烁烁' });
    assert.equal(a.preview, '画好啦 🐬');
    assert.equal(a.truncated, true, 'withheld richBlocks must mark anchor as truncated so callers drill');
    assert.equal('richBlocks' in a, false);
    assert.deepEqual(a.richBlocksSummary, [
      { id: 'dolphin', kind: 'html_widget', title: '深海跃浪的小海豚', htmlLength: '<svg>dolphin</svg>'.length },
    ]);
    assert.deepEqual(a.drillDown, {
      tool: 'cat_cafe_get_message',
      args: { messageId: 'rb1', mode: 'full' },
    });
  });

  test('anchorPendingMention: short mention with extra.rich.blocks sets requiresDrill=true and includes richBlocksSummary', () => {
    const item = {
      id: 'pm-rb1',
      userId: 'user-1',
      catId: 'gemini-argon',
      content: '@gemini-carbon 看看我的海豚',
      timestamp: 11,
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'dolphin', kind: 'html_widget', v: 1, title: 'Argon Dolphin', html: '<svg>argon</svg>' }],
        },
      },
    };
    const a = anchorPendingMention(item, { from: '闪闪·烁烁' });
    assert.equal(a.requiresDrill, true);
    assert.deepEqual(a.richBlocksSummary, [
      { id: 'dolphin', kind: 'html_widget', title: 'Argon Dolphin', htmlLength: '<svg>argon</svg>'.length },
    ]);
  });
});
