import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coCreatorDisplay } from '@cat-cafe/shared';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { getCoCreatorConfig } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { cursorFor } from '../dist/domains/cats/services/stores/cursor.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { projectQueuedCallbackMessageBody } from '../dist/routes/callback-message-body.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-runtime-quote.json', import.meta.url), 'utf8'));

async function setup(overrides = {}) {
  const messageStore = adaptMessageStore(new MessageStore());
  const threadStore = new ThreadStore();
  const registry = new InvocationRegistry();
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} },
    ...overrides,
  });
  const { invocationId, callbackToken } = await registry.create('default-user', 'codex61-sol');
  const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  return { app, messageStore, headers, invocationId };
}

test('queued transcript timestamps retain durable source time across repeated reads', async (t) => {
  const f = await createCallbackContextFixture(t);
  const timestamp = 1350;
  const admitted = await f.enqueue('queued user notice', {}, { timestamp });
  for (let i = 0; i < 2; i++) {
    const result = await f.read();
    assert.equal(result.statusCode, 200, result.body);
    const projected = result.json().messages.find((m) => m.id === admitted.message.id);
    assert.equal(projected.timestamp, timestamp, 'reading must not manufacture an event time');
  }
  assert.equal(f.messages.getById(admitted.message.id).lifecycle.dispatchRefs.length, 1);
});

test('queued runtime quote retains the complete body in context and exact drill', async (t) => {
  const f = await createCallbackContextFixture(t);
  const admitted = await f.enqueue('', {}, { timestamp: fixture.timestamp, contentBlocks: fixture.contentBlocks });
  const context = await f.read();
  const drill = await f.app.inject({
    url: `/api/callbacks/get-message?messageId=${admitted.message.id}&mode=full`,
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
  });
  assert.equal(context.statusCode, 200, context.body);
  assert.equal(drill.statusCode, 200, drill.body);
  const projected = context.json().messages.find((m) => m.id === admitted.message.id);
  assert.equal(projected.content, drill.json().message.content);
  assert.deepEqual(projected.contentBlocks, fixture.contentBlocks);
  assert.match(projected.content, /可以啊 你喊他继续啊/);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['codex']);
});

for (const sourceCase of ['missing', 'foreign', 'unavailable']) {
  test(`queued body projection withholds ${sourceCase} persisted source without a text fallback`, async () => {
    const result = await projectQueuedCallbackMessageBody(
      { entryId: 'owned-entry', messageId: 'source-id', content: 'queue text alone is incomplete' },
      {
        getById: async () => {
          if (sourceCase === 'unavailable') throw new Error('owned store unavailable');
          return sourceCase === 'missing'
            ? null
            : {
                id: 'source-id',
                threadId: 'owned-thread',
                userId: 'foreign-owner',
                from: { kind: 'user', userId: 'foreign-owner' },
                content: 'private content',
                contentBlocks: fixture.contentBlocks,
              };
        },
      },
      { threadId: 'owned-thread', userId: 'owner', catId: 'opus', viewer: { type: 'cat', catId: 'opus' } },
    );
    assert.equal(result.content, '');
    assert.equal(result.contentLength, 0);
    assert.equal(result.contentBlocks, undefined);
    assert.equal(
      result.sourceUnavailableReason,
      sourceCase === 'unavailable' ? 'queued_body_source_unavailable' : 'queued_body_source_changed',
    );
  });
}

test('runtime quote source retains the paired owner comment and original provenance in both full readers', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const message = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: '',
      contentBlocks: fixture.contentBlocks,
      mentions: [],
      timestamp: fixture.timestamp,
    });
    const context = await app.inject({ url: '/api/callbacks/thread-context?responseMode=full', headers });
    const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(drill.statusCode, 200, drill.body);
    for (const projected of [context.json().messages[0], drill.json().message]) {
      assert.deepEqual(projected.contentBlocks, fixture.contentBlocks);
      assert.match(projected.content, /可以啊 你喊他继续啊/);
      assert.equal(projected.contentLength, projected.content.length);
      assert.equal(projected.truncated, false);
      const coCreator = getCoCreatorConfig();
      assert.equal(projected.speaker, coCreator.nickname ?? coCreatorDisplay(coCreator).nickname);
    }
    assert.equal(context.json().messages[0].content, drill.json().message.content);
  } finally {
    await app.close();
  }
});

for (const outerComment of ['', '请按这段批注继续']) {
  test(`pending mention anchor/full retains the runtime quote with ${outerComment ? 'an outer comment' : 'empty text'}`, async () => {
    const { app, messageStore, headers } = await setup();
    try {
      const message = messageStore.append({
        userId: 'default-user',
        catId: null,
        content: outerComment,
        contentBlocks: fixture.contentBlocks,
        mentions: ['codex61-sol'],
        timestamp: fixture.timestamp,
      });
      const full = await app.inject({ url: '/api/callbacks/pending-mentions?responseMode=full', headers });
      const anchor = await app.inject({ url: '/api/callbacks/pending-mentions', headers });
      const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
      assert.equal(full.statusCode, 200, full.body);
      assert.equal(anchor.statusCode, 200, anchor.body);
      assert.equal(drill.statusCode, 200, drill.body);
      const complete = full.json().mentions[0];
      const excerpt = anchor.json().mentions[0];
      assert.equal(complete.id, message.id);
      assert.deepEqual(complete.contentBlocks, fixture.contentBlocks);
      assert.match(complete.message, /可以啊 你喊他继续啊/);
      assert.equal(complete.message, drill.json().message.content);
      assert.equal(complete.contentLength, complete.message.length);
      assert.equal(complete.requiresDrill, false);
      const coCreator = getCoCreatorConfig();
      assert.equal(complete.from, coCreator.nickname ?? coCreatorDisplay(coCreator).nickname);
      if (outerComment) assert.ok(complete.message.startsWith(outerComment));
      assert.ok(excerpt.message.length > 0);
      assert.equal(excerpt.contentLength, complete.contentLength);
      assert.equal(excerpt.requiresDrill, excerpt.message !== complete.message);
      assert.equal(excerpt.drillDown.args.messageId, message.id);
      assert.equal(excerpt.contentBlocks, undefined, 'anchor remains bounded; full drill retains attachments');
    } finally {
      await app.close();
    }
  });
}

test('oversized quote remains unseen until its full drill is actually returned', async () => {
  const deliveryCursorStore = new DeliveryCursorStore();
  const { app, messageStore, headers } = await setup({ deliveryCursorStore });
  try {
    const attachment = structuredClone(fixture.contentBlocks[0].attachment);
    attachment.text = 'x'.repeat(15000);
    const message = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: '',
      contentBlocks: [{ type: 'context_attachment', attachment }],
      mentions: [],
      timestamp: 1,
    });
    const response = await app.inject({
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Buffer.byteLength(response.body) <= 24000);
    const projected = response.json().messages[0];
    assert.equal(projected.id, message.id);
    assert.equal(projected.oversized, true);
    assert.equal(projected.truncated, true);
    assert.ok(projected.contentLength > 15000);
    assert.equal(await deliveryCursorStore.getSeenCursor('default-user', 'codex61-sol', 'default'), undefined);
    const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
    assert.equal(drill.statusCode, 200, drill.body);
    assert.equal(drill.json().message.contentBlocks[0].attachment.text, attachment.text);
  } finally {
    await app.close();
  }
});

test('full-body budget includes structured attachments and paginates without dropping any source', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const expected = [];
    for (let i = 0; i < 8; i++) {
      const attachment = structuredClone(fixture.contentBlocks[0].attachment);
      attachment.text = `quote-${i}-` + 'x'.repeat(1800);
      expected.push(
        messageStore.append({
          userId: 'default-user',
          catId: null,
          content: 'outer comment',
          contentBlocks: [
            { type: 'context_attachment', attachment },
            { type: 'file', url: '/uploads/notes.txt', fileName: 'notes.txt', mimeType: 'text/plain', fileSize: 30 },
          ],
          mentions: [],
          timestamp: i + 1,
        }).id,
      );
    }
    const actual = [];
    let cursor;
    do {
      const params = new URLSearchParams({ responseMode: 'full', limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const response = await app.inject({ url: `/api/callbacks/thread-context?${params}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(Buffer.byteLength(response.body) <= 24000);
      const body = response.json();
      for (const msg of body.messages) {
        assert.equal(msg.contentBlocks.length, 2);
        assert.match(msg.content, /outer comment/);
        assert.ok(msg.contentLength > 1800);
        assert.equal(msg.truncated, false);
        actual.push(msg.id);
      }
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(actual, expected);
  } finally {
    await app.close();
  }
});

test('richBlocks are returned in full by get-message(mode=full), context neighbors, and thread-context(responseMode=full), while preview/anchor return bounded richBlocksSummary', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const neighborBlocks = [
      { id: 'card-1', kind: 'card', v: 1, title: '评审卡片', tone: 'info', bodyMarkdown: '邻居卡片正文' },
    ];
    const targetBlocks = [
      {
        id: 'dolphin-svg',
        kind: 'html_widget',
        v: 1,
        title: '深海跃浪的小海豚',
        html: '<div class="dolphin"><svg viewBox="0 0 200 120"><path d="M10 80 Q90 10 180 75"/></svg></div>',
        height: 260,
      },
      {
        id: 'check-1',
        kind: 'checklist',
        v: 1,
        title: '绘画要素',
        items: [
          { id: 'i1', text: '流线型背鳍', checked: true },
          { id: 'i2', text: '跃水浪花', checked: true },
        ],
      },
    ];
    const neighbor = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-argon',
      content: '先放一张卡片',
      mentions: [],
      timestamp: 10,
      extra: { rich: { v: 1, blocks: neighborBlocks } },
    });
    const target = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-carbon',
      content: '画好啦！',
      mentions: [],
      timestamp: 20,
      extra: { rich: { v: 1, blocks: targetBlocks } },
    });

    const previewRes = await app.inject({
      url: `/api/callbacks/get-message?messageId=${target.id}&contextCount=1`,
      headers,
    });
    assert.equal(previewRes.statusCode, 200, previewRes.body);
    const previewPayload = previewRes.json();
    assert.equal(previewPayload.message.content, '画好啦！');
    assert.equal(previewPayload.message.contentLength, '画好啦！'.length);
    assert.equal(previewPayload.message.truncated, true, 'omitted richBlocks in preview must set truncated=true');
    assert.equal(previewPayload.message.richBlocks, undefined, 'preview must not inline heavy richBlocks');
    assert.deepEqual(previewPayload.message.drillDown, {
      tool: 'cat_cafe_get_message',
      args: { messageId: target.id, mode: 'full' },
    });
    assert.deepEqual(previewPayload.message.richBlocksSummary, [
      {
        id: 'dolphin-svg',
        kind: 'html_widget',
        title: '深海跃浪的小海豚',
        htmlLength: targetBlocks[0].html.length,
        height: 260,
      },
      { id: 'check-1', kind: 'checklist', title: '绘画要素', itemCount: 2 },
    ]);
    assert.equal(previewPayload.context.length, 1);
    assert.equal(previewPayload.context[0].id, neighbor.id);
    assert.equal(previewPayload.context[0].truncated, true);
    assert.equal(previewPayload.context[0].richBlocks, undefined);
    assert.equal(previewPayload.context[0].richBlocksSummary[0].id, 'card-1');

    const fullDrillRes = await app.inject({
      url: `/api/callbacks/get-message?messageId=${target.id}&mode=full&contextCount=1`,
      headers,
    });
    assert.equal(fullDrillRes.statusCode, 200, fullDrillRes.body);
    const fullDrill = fullDrillRes.json();
    assert.equal(fullDrill.message.truncated, false);
    assert.equal(fullDrill.message.contentLength, fullDrill.message.content.length);
    assert.deepEqual(fullDrill.message.richBlocks, targetBlocks);
    assert.equal(fullDrill.message.richBlocksSummary, undefined);
    assert.deepEqual(fullDrill.context[0].richBlocks, neighborBlocks);

    const anchorCtxRes = await app.inject({ url: '/api/callbacks/thread-context', headers });
    assert.equal(anchorCtxRes.statusCode, 200, anchorCtxRes.body);
    const anchorTarget = anchorCtxRes.json().messages.find((m) => m.id === target.id);
    assert.equal(anchorTarget.truncated, true);
    assert.equal(anchorTarget.richBlocks, undefined);
    assert.equal(anchorTarget.richBlocksSummary[0].title, '深海跃浪的小海豚');

    const keywordCtxRes = await app.inject({
      url: `/api/callbacks/thread-context?keyword=${encodeURIComponent('深海跃浪')}`,
      headers,
    });
    assert.equal(keywordCtxRes.statusCode, 200, keywordCtxRes.body);
    assert.deepEqual(
      keywordCtxRes.json().messages.map((m) => m.id),
      [target.id],
      'keyword search should match richBlock title even when prose body is brief',
    );

    const fullCtxRes = await app.inject({ url: '/api/callbacks/thread-context?responseMode=full', headers });
    assert.equal(fullCtxRes.statusCode, 200, fullCtxRes.body);
    const fullCtxTarget = fullCtxRes.json().messages.find((m) => m.id === target.id);
    const fullCtxNeighbor = fullCtxRes.json().messages.find((m) => m.id === neighbor.id);
    assert.equal(fullCtxTarget.truncated, false);
    assert.equal(fullCtxTarget.contentLength, fullCtxTarget.content.length);
    assert.deepEqual(fullCtxTarget.richBlocks, targetBlocks);
    assert.deepEqual(fullCtxNeighbor.richBlocks, neighborBlocks);
  } finally {
    await app.close();
  }
});

test('queued message and pending-mentions preserve richBlocks in full mode and flag drill in anchor mode', async (t) => {
  const richBlocks = [
    { id: 'queued-widget', kind: 'html_widget', v: 1, title: 'Queued SVG', html: '<svg><circle r="10"/></svg>' },
  ];
  const f = await createCallbackContextFixture(t);
  const admitted = await f.enqueue(
    '请看附件组件',
    {},
    { timestamp: 2000, extra: { rich: { v: 1, blocks: richBlocks } } },
  );
  const context = await f.read();
  const drill = await f.app.inject({
    url: `/api/callbacks/get-message?messageId=${admitted.message.id}&mode=full`,
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
  });
  assert.equal(context.statusCode, 200, context.body);
  assert.equal(drill.statusCode, 200, drill.body);
  const projected = context.json().messages.find((m) => m.id === admitted.message.id);
  assert.deepEqual(projected.richBlocks, richBlocks);
  assert.deepEqual(drill.json().message.richBlocks, richBlocks);

  const { app, messageStore, headers } = await setup();
  try {
    const mentionMsg = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-argon',
      content: '@codex61-sol 帮看这个 widget',
      mentions: ['codex61-sol'],
      timestamp: 3000,
      extra: { rich: { v: 1, blocks: richBlocks } },
    });
    const anchorMentions = await app.inject({ url: '/api/callbacks/pending-mentions', headers });
    const fullMentions = await app.inject({ url: '/api/callbacks/pending-mentions?responseMode=full', headers });
    assert.equal(anchorMentions.statusCode, 200, anchorMentions.body);
    assert.equal(fullMentions.statusCode, 200, fullMentions.body);
    const excerpt = anchorMentions.json().mentions[0];
    const complete = fullMentions.json().mentions[0];
    assert.equal(excerpt.id, mentionMsg.id);
    assert.equal(excerpt.requiresDrill, true);
    assert.equal(excerpt.richBlocksSummary[0].id, 'queued-widget');
    assert.deepEqual(complete.richBlocks, richBlocks);
    assert.equal(complete.requiresDrill, false);
  } finally {
    await app.close();
  }
});

test('thread-context(responseMode=full) paginates richBlocks within 24KB and degrades >24KB single html_widget to oversized anchor without advancing seenCursor', async () => {
  const deliveryCursorStore = new DeliveryCursorStore();
  const { app, messageStore, headers } = await setup({ deliveryCursorStore });
  try {
    const pagedIds = [];
    for (let i = 0; i < 4; i++) {
      pagedIds.push(
        messageStore.append({
          userId: 'default-user',
          catId: 'gemini-carbon',
          content: `widget-${i}`,
          mentions: [],
          timestamp: i + 1,
          extra: {
            rich: {
              v: 1,
              blocks: [
                {
                  id: `w-${i}`,
                  kind: 'html_widget',
                  v: 1,
                  title: `Widget ${i}`,
                  html: `<svg data-idx="${i}">${'M10 10 '.repeat(1100)}</svg>`,
                },
              ],
            },
          },
        }).id,
      );
    }
    const collected = [];
    let cursor;
    let pageCount = 0;
    do {
      const params = new URLSearchParams({ responseMode: 'full', limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const res = await app.inject({ url: `/api/callbacks/thread-context?${params}`, headers });
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(Buffer.byteLength(res.body) <= 24000, 'each page must stay within 24KB envelope');
      pageCount += 1;
      const body = res.json();
      for (const msg of body.messages) {
        assert.equal(msg.truncated, false);
        assert.equal(msg.richBlocks?.length, 1);
        collected.push(msg.id);
      }
      cursor = body.nextCursor;
    } while (cursor);
    assert.ok(pageCount >= 2, '4 x ~8KB widgets must paginate across multiple 24KB pages');
    assert.deepEqual(collected, pagedIds);

    // Single >24KB html_widget in unread mode must fall back to oversizedProjection and remain unseen
    const seenBeforeOversized = await deliveryCursorStore.getSeenCursor('default-user', 'codex61-sol', 'default');
    assert.equal(
      typeof seenBeforeOversized,
      'string',
      'contiguous full read of normal widgets must establish a string seenCursor',
    );
    assert.ok(
      seenBeforeOversized.includes(pagedIds[3]),
      'baseline seenCursor must point at the last fully read normal widget',
    );

    const hugeHtml = `<svg>${'L20 30 '.repeat(4500)}</svg>`;
    const hugeMsg = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-hydrogen',
      content: '超大画布海豚',
      mentions: [],
      timestamp: 100,
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'huge-dolphin', kind: 'html_widget', v: 1, title: '巨型海豚', html: hugeHtml }],
        },
      },
    });
    const trailingNormalMsg = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-argon',
      content: '巨型富块之后的普通消息',
      mentions: [],
      timestamp: 101,
    });
    const unreadRes = await app.inject({
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
      headers,
    });
    assert.equal(unreadRes.statusCode, 200, unreadRes.body);
    // Drain until we reach hugeMsg and trailingNormalMsg
    let hugeProjected = unreadRes.json().messages.find((m) => m.id === hugeMsg.id);
    let trailingProjected = unreadRes.json().messages.find((m) => m.id === trailingNormalMsg.id);
    let unreadCursor = unreadRes.json().nextCursor;
    while ((!hugeProjected || !trailingProjected) && unreadCursor) {
      const nextRes = await app.inject({
        url: `/api/callbacks/thread-context?${new URLSearchParams({
          readIntent: 'unread',
          responseMode: 'full',
          cursor: unreadCursor,
        })}`,
        headers,
      });
      assert.equal(nextRes.statusCode, 200, nextRes.body);
      assert.ok(Buffer.byteLength(nextRes.body) <= 24000);
      hugeProjected ??= nextRes.json().messages.find((m) => m.id === hugeMsg.id);
      trailingProjected ??= nextRes.json().messages.find((m) => m.id === trailingNormalMsg.id);
      unreadCursor = nextRes.json().nextCursor;
    }
    assert.ok(hugeProjected, 'oversized html_widget message must still be surfaced as an oversized anchor');
    assert.ok(trailingProjected, 'trailing normal message must still be reachable via unread pagination');
    assert.equal(hugeProjected.oversized, true);
    assert.equal(hugeProjected.truncated, true);
    assert.equal(hugeProjected.richBlocks, undefined);
    assert.deepEqual(hugeProjected.richBlocksSummary, [
      { id: 'huge-dolphin', kind: 'html_widget', title: '巨型海豚', htmlLength: hugeHtml.length },
    ]);
    assert.deepEqual(hugeProjected.drillDown, {
      tool: 'cat_cafe_get_message',
      args: { messageId: hugeMsg.id, mode: 'full' },
    });
    const seenAfterOversized = await deliveryCursorStore.getSeenCursor('default-user', 'codex61-sol', 'default');
    assert.equal(
      seenAfterOversized,
      seenBeforeOversized,
      'oversized richBlock anchor must keep seenCursor strictly at seenBeforeOversized instead of advancing across hugeMsg',
    );
    const secondUnreadRes = await app.inject({
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
      headers,
    });
    assert.equal(secondUnreadRes.statusCode, 200, secondUnreadRes.body);
    assert.equal(
      secondUnreadRes.json().messages[0]?.id,
      hugeMsg.id,
      'fresh unread read must still surface hugeMsg first until it is fully drilled/covered',
    );

    const drillHuge = await app.inject({
      url: `/api/callbacks/get-message?messageId=${hugeMsg.id}&mode=full`,
      headers,
    });
    assert.equal(drillHuge.statusCode, 200, drillHuge.body);
    assert.equal(drillHuge.json().message.richBlocks[0].html, hugeHtml);

    // Fault-injection proof: if seenCursor were erroneously pushed to hugeMsg, both cursor equality
    // and the fresh unread re-read assertions above would fail.
    await deliveryCursorStore.ackSeenCursor('default-user', 'codex61-sol', 'default', cursorFor(hugeMsg));
    const seenAfterFault = await deliveryCursorStore.getSeenCursor('default-user', 'codex61-sol', 'default');
    assert.notEqual(seenAfterFault, seenBeforeOversized);
    const unreadAfterFault = await app.inject({
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
      headers,
    });
    assert.equal(unreadAfterFault.statusCode, 200, unreadAfterFault.body);
    assert.equal(
      unreadAfterFault.json().messages.some((m) => m.id === hugeMsg.id),
      false,
      'fault-injected seenCursor advance removes hugeMsg from unread delta, proving the pre-fault assertions are non-vacuous',
    );
  } finally {
    await app.close();
  }
});

test('adversarial schema-valid richBlocks (25KB id, 150 widgets, 25KB mimeType) stay <=24KB with 200 in thread-context anchor/full and get-message preview while preserving full drill', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const hugeIdMsg = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-carbon',
      content: '25KB widget id',
      mentions: [],
      timestamp: 201,
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'x'.repeat(25_000), kind: 'html_widget', v: 1, html: '<svg/>' }],
        },
      },
    });
    const manyWidgetsMsg = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-argon',
      content: '@codex61-sol 150 widgets',
      mentions: ['codex61-sol'],
      timestamp: 202,
      extra: {
        rich: {
          v: 1,
          blocks: Array.from({ length: 150 }, (_, idx) => ({
            id: `mw-${idx}`,
            kind: 'html_widget',
            v: 1,
            title: 'T'.repeat(120),
            html: '<svg/>',
          })),
        },
      },
    });
    const hugeMimeMsg = messageStore.append({
      userId: 'default-user',
      catId: 'gemini-hydrogen',
      content: '25KB file mimeType',
      mentions: [],
      timestamp: 203,
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              id: 'file-1',
              kind: 'file',
              v: 1,
              url: '/uploads/demo.bin',
              fileName: 'demo.bin',
              mimeType: 'm'.repeat(25_000),
            },
          ],
        },
      },
    });

    for (const responseMode of ['anchor', 'full']) {
      const seenMessages = new Map();
      let cursor;
      do {
        const params = new URLSearchParams({ responseMode, limit: '20' });
        if (cursor) params.set('cursor', cursor);
        const res = await app.inject({ url: `/api/callbacks/thread-context?${params}`, headers });
        assert.equal(res.statusCode, 200, `${responseMode} failed: ${res.body}`);
        assert.ok(
          Buffer.byteLength(res.body, 'utf8') <= 24_000,
          `${responseMode} exceeded 24KB: ${Buffer.byteLength(res.body, 'utf8')}`,
        );
        const body = res.json();
        for (const m of body.messages) seenMessages.set(m.id, m);
        cursor = body.nextCursor;
      } while (cursor);

      for (const target of [hugeIdMsg, manyWidgetsMsg, hugeMimeMsg]) {
        const projected = seenMessages.get(target.id);
        assert.ok(projected, `${target.id} missing in ${responseMode}`);
        assert.equal(projected.truncated, true);
        assert.equal(projected.richBlocksSummaryTruncated, true);
        if (responseMode === 'full') assert.equal(projected.oversized, true);
        assert.deepEqual(projected.drillDown, {
          tool: 'cat_cafe_get_message',
          args: { messageId: target.id, mode: 'full' },
        });
      }
      const manyProjected = seenMessages.get(manyWidgetsMsg.id);
      assert.equal(manyProjected.richBlocksTotalCount, 150);
      assert.equal(manyProjected.richBlocksOmittedCount, 150 - manyProjected.richBlocksSummary.length);
    }

    const pendingAnchorRes = await app.inject({ url: '/api/callbacks/pending-mentions', headers });
    assert.equal(pendingAnchorRes.statusCode, 200, pendingAnchorRes.body);
    assert.ok(Buffer.byteLength(pendingAnchorRes.body, 'utf8') <= 4_096);
    const pendingMention = pendingAnchorRes.json().mentions.find((m) => m.id === manyWidgetsMsg.id);
    assert.ok(pendingMention);
    assert.equal(pendingMention.requiresDrill, true);
    assert.equal(pendingMention.richBlocksSummaryTruncated, true);
    assert.equal(pendingMention.richBlocksTotalCount, 150);
    assert.equal(pendingMention.richBlocksOmittedCount, 150 - pendingMention.richBlocksSummary.length);

    for (const target of [hugeIdMsg, manyWidgetsMsg, hugeMimeMsg]) {
      const previewRes = await app.inject({
        url: `/api/callbacks/get-message?messageId=${target.id}`,
        headers,
      });
      assert.equal(previewRes.statusCode, 200, previewRes.body);
      assert.ok(
        Buffer.byteLength(previewRes.body, 'utf8') <= 4_096,
        `get-message preview exceeded 4KB: ${Buffer.byteLength(previewRes.body, 'utf8')}`,
      );
      const previewMsg = previewRes.json().message;
      assert.equal(previewMsg.truncated, true);
      assert.equal(previewMsg.richBlocksSummaryTruncated, true);
      assert.deepEqual(previewMsg.drillDown, {
        tool: 'cat_cafe_get_message',
        args: { messageId: target.id, mode: 'full' },
      });

      const fullRes = await app.inject({
        url: `/api/callbacks/get-message?messageId=${previewMsg.drillDown.args.messageId}&mode=${previewMsg.drillDown.args.mode}`,
        headers,
      });
      assert.equal(fullRes.statusCode, 200, fullRes.body);
      assert.deepEqual(fullRes.json().message.richBlocks, target.extra.rich.blocks);
    }
  } finally {
    await app.close();
  }
});
