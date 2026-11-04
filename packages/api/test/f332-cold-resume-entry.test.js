// @ts-check
/**
 * F332 / #1087 cold-recovery first slice: deterministic resume coordinates.
 *
 * S1a — only “接着做” is unread: a canonical cold turn must still point the cat
 * at where it stopped (its own last terminal reply and that reply's sources),
 * without replaying the old body or turning recency into an instruction.
 * S1b — a large unread gap: the tombstone carries exact message coordinates
 * (range bounds + already-selected anchor IDs) instead of only a keyword search,
 * while canonical cold still never re-introduces anchor bodies.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';

const { assembleIncrementalContext: assembleIncrementalContextWithoutCapacity } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');
const { buildTombstone, formatTombstone, buildTombstoneCoordinates } = await import(
  '../dist/domains/cats/services/agents/routing/context-transport.js'
);
const { formatNavigationHeader } = await import('../dist/domains/cats/services/agents/routing/navigation-context.js');
const { resolveResumeStopPoint } = await import('../dist/domains/cats/services/agents/routing/resume-stop-point.js');
const { MESSAGE_RECIPIENT_FIELDS } = await import(
  '../dist/domains/cats/services/stores/redis/redis-message-recipient-fields.js'
);

const THREAD = 'thread-cold-resume';
const USER = 'user-cold-resume';
const CAT = 'opus';
const VIEWER = /** @type {const} */ ({ type: 'cat', catId: CAT });

function assembleIncrementalContext(deps, userId, threadId, catId, currentUserMessageId, thinkingMode, options) {
  return assembleIncrementalContextWithoutCapacity(deps, userId, threadId, catId, currentUserMessageId, thinkingMode, {
    ...options,
    effectiveMaxContextTokens: options?.effectiveMaxContextTokens ?? 500_000,
  });
}

function projection(contextMode) {
  return {
    coordinate: {
      providerCarrier: { provider: 'claude', carrier: 'print_sdk' },
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
    },
    contextEpoch: 2,
    contextMode,
    transition: contextMode === 'hot' ? 'resumed' : 'unknown',
    reason: contextMode === 'hot' ? 'resume_confirmed' : 'carrier_unsupported',
  };
}

function mockThreadStore(title = '冷恢复首包') {
  return {
    get: async () => ({ id: THREAD, title, userId: USER, createdAt: 1 }),
    getThreadMemory: async () => null,
    updateThreadMemory: async () => {},
  };
}

function buildDeps(messageStore, deliveryCursorStore) {
  return {
    services: {},
    invocationDeps: { threadStore: mockThreadStore() },
    messageStore,
    deliveryCursorStore,
  };
}

function userMessage(store, content, timestamp, extra = {}) {
  return store.append({
    threadId: THREAD,
    userId: USER,
    catId: null,
    content,
    mentions: [],
    timestamp,
    ...extra,
  });
}

function catResponse(store, { catId = CAT, inputMessageIds, status = 'completed', timestamp, content, invocationId }) {
  return store.append({
    threadId: THREAD,
    userId: USER,
    from: { kind: 'agent', catId },
    content,
    mentions: [],
    origin: 'stream',
    timestamp,
    lifecycle: {
      kind: 'response',
      orderKey: `${timestamp}:${invocationId}`,
      invocationId,
      targetId: catId,
      inputEntryIds: inputMessageIds.map((id) => `entry-${id}`),
      inputMessageIds,
      status,
      startedAt: timestamp,
      ...(status === 'processing' ? {} : { completedAt: timestamp }),
    },
  });
}

describe('M1a: tombstone carries exact coordinates for an omitted range', () => {
  const omitted = Array.from({ length: 6 }, (_, i) => ({
    id: `m-${i}`,
    threadId: THREAD,
    userId: USER,
    catId: null,
    content: `omitted body ${i} https://example.com/x BODYSENTINEL${i}`,
    mentions: [],
    timestamp: 1_000 + i,
  }));

  test('range bounds plus selected anchors, deduplicated and capped', () => {
    const coordinates = buildTombstoneCoordinates(omitted, ['m-0', 'm-3', 'm-5', 'm-3', 'm-4', 'm-2'], THREAD);
    assert.deepEqual(coordinates, {
      threadId: THREAD,
      firstMessageId: 'm-0',
      lastMessageId: 'm-5',
      keyMessageIds: ['m-3', 'm-4', 'm-2'],
    });
    assert.equal(buildTombstoneCoordinates([], ['m-1'], THREAD), null);
  });

  test('anchor IDs outside the omitted range are never emitted', () => {
    const coordinates = buildTombstoneCoordinates(omitted, ['not-omitted', 'm-1'], THREAD);
    assert.deepEqual(coordinates?.keyMessageIds, ['m-1']);
  });

  test('formatted tombstone exposes a deterministic read entry and keeps search as fallback', () => {
    const tombstone = buildTombstone(omitted, '冷恢复首包', { maxTombstoneKeywords: 4 }, THREAD);
    assert.ok(tombstone);
    const plain = formatTombstone(tombstone);
    assert.doesNotMatch(plain, /Coordinates:/, 'without coordinates the legacy tombstone is unchanged');

    const text = formatTombstone(tombstone, {
      coordinates: buildTombstoneCoordinates(omitted, ['m-2'], THREAD),
    });
    assert.match(text, /\[System: skipped 6 messages/);
    assert.match(text, /Coordinates: first m-0; last m-5; key m-2\./);
    assert.match(
      text,
      /cat_cafe_get_thread_context\(\{ threadId: "thread-cold-resume", messageId: "<id>", responseMode: "full" \}\)/,
    );
    assert.match(text, /search_evidence\(/, 'keyword search stays available as a fallback');
    // Frequency keywords are pre-existing F148 behaviour; a once-only body token
    // proves the coordinates themselves smuggle no message text.
    assert.doesNotMatch(text, /BODYSENTINEL/, 'coordinates never carry message bodies');
  });
});

describe('M1b: resolveResumeStopPoint reads the original lifecycle records', () => {
  test('finds this cat’s latest terminal reply and its readable sources', async () => {
    const store = adaptMessageStore(new MessageStore());
    const request = userMessage(store, '@opus 帮我整理冷恢复需求', 10);
    const older = catResponse(store, {
      inputMessageIds: [request.id],
      timestamp: 11,
      content: 'old',
      invocationId: 'inv-1',
    });
    const followUp = userMessage(store, '@opus 再补充验收', 12);
    const latest = catResponse(store, {
      inputMessageIds: [followUp.id],
      timestamp: 13,
      content: 'latest body',
      invocationId: 'inv-2',
    });
    catResponse(store, {
      catId: 'codex',
      inputMessageIds: [followUp.id],
      timestamp: 14,
      content: 'x',
      invocationId: 'inv-3',
    });
    catResponse(store, {
      inputMessageIds: [],
      timestamp: 15,
      content: '',
      invocationId: 'inv-current',
      status: 'processing',
    });

    const result = await resolveResumeStopPoint({
      messageStore: store,
      threadId: THREAD,
      userId: USER,
      catId: CAT,
      viewer: VIEWER,
      scanLimit: 200,
    });
    assert.equal(result.kind, 'found');
    assert.equal(result.stopPoint.responseMessageId, latest.id);
    assert.notEqual(result.stopPoint.responseMessageId, older.id);
    assert.equal(result.stopPoint.status, 'completed');
    assert.equal(result.stopPoint.at, 13);
    assert.deepEqual(result.stopPoint.sourceMessageIds, [followUp.id]);
    assert.equal(result.stopPoint.unreadableSourceCount, 0);
  });

  test('deleted or invisible sources are counted, never emitted', async () => {
    const store = adaptMessageStore(new MessageStore());
    const deleted = userMessage(store, '@opus 已删除的请求', 10);
    const hidden = store.append({
      threadId: THREAD,
      userId: USER,
      from: { kind: 'agent', catId: 'codex' },
      content: 'whisper to someone else',
      mentions: [],
      timestamp: 11,
      visibility: 'whisper',
      whisperTo: ['gemini'],
    });
    const visible = userMessage(store, '@opus 可见请求', 12);
    store.softDelete(deleted.id, 'tester');
    const response = catResponse(store, {
      inputMessageIds: [deleted.id, hidden.id, visible.id],
      timestamp: 13,
      content: 'reply',
      invocationId: 'inv-1',
    });
    const result = await resolveResumeStopPoint({
      messageStore: store,
      threadId: THREAD,
      userId: USER,
      catId: CAT,
      viewer: VIEWER,
      scanLimit: 200,
    });
    assert.equal(result.kind, 'found');
    assert.equal(result.stopPoint.responseMessageId, response.id);
    assert.deepEqual(result.stopPoint.sourceMessageIds, [visible.id]);
    assert.equal(result.stopPoint.unreadableSourceCount, 2);
  });

  test('distinguishes “no history” from “not within the scanned window”', async () => {
    const empty = adaptMessageStore(new MessageStore());
    userMessage(empty, 'hello', 1);
    assert.deepEqual(
      await resolveResumeStopPoint({
        messageStore: empty,
        threadId: THREAD,
        userId: USER,
        catId: CAT,
        viewer: VIEWER,
        scanLimit: 50,
      }),
      { kind: 'none' },
    );

    const deep = adaptMessageStore(new MessageStore());
    const request = userMessage(deep, '@opus first', 1);
    catResponse(deep, {
      inputMessageIds: [request.id],
      timestamp: 2,
      content: 'early reply',
      invocationId: 'inv-early',
    });
    for (let i = 0; i < 30; i++) userMessage(deep, `chatter ${i}`, 10 + i);
    const windowed = await resolveResumeStopPoint({
      messageStore: deep,
      threadId: THREAD,
      userId: USER,
      catId: CAT,
      viewer: VIEWER,
      scanLimit: 10,
    });
    assert.equal(windowed.kind, 'not_in_window');
    assert.equal(windowed.scannedCount, 10);
  });

  test('a quiet thread keeps its stop point while other threads are busy (review P2)', async () => {
    const store = adaptMessageStore(new MessageStore());
    const request = userMessage(store, '@opus 帮我整理冷恢复需求', 10);
    const reply = catResponse(store, {
      inputMessageIds: [request.id],
      timestamp: 11,
      content: 'reply',
      invocationId: 'inv-q',
    });
    for (let i = 0; i < 150; i++) {
      store.append({
        threadId: 'thread-busy-neighbour',
        userId: USER,
        catId: null,
        content: `neighbour ${i}`,
        mentions: [],
        timestamp: 100 + i,
      });
    }
    const result = await resolveResumeStopPoint({
      messageStore: store,
      threadId: THREAD,
      userId: USER,
      catId: CAT,
      viewer: VIEWER,
    });
    assert.equal(result.kind, 'found', 'neighbour activity must not push a quiet thread out of the window');
    assert.equal(result.stopPoint.responseMessageId, reply.id);
    assert.deepEqual(result.stopPoint.sourceMessageIds, [request.id]);
  });

  test('the main scan requests only the recipient projection and resolves from recipient fields alone', async () => {
    const calls = [];
    const fullReply = {
      id: 'resp-projected',
      threadId: THREAD,
      userId: USER,
      from: { kind: 'agent', catId: CAT },
      catId: CAT,
      content: 'reply body',
      contentBlocks: [{ type: 'text', text: 'block body' }],
      thinking: 'thinking',
      metadata: { provider: 'test' },
      toolEvents: [{ type: 'tool_use', label: 'tool payload' }],
      replyTo: 'src-projected',
      timestamp: 11,
      deliveryStatus: 'delivered',
      lifecycle: {
        kind: 'response',
        orderKey: '11:inv',
        invocationId: 'inv',
        targetId: CAT,
        inputEntryIds: ['entry-src'],
        inputMessageIds: ['src-projected'],
        status: 'completed',
        startedAt: 11,
        completedAt: 11,
      },
    };
    // Exactly the row shape Redis returns for recipientProjection (HMGET MESSAGE_RECIPIENT_FIELDS).
    const projectedReply = Object.fromEntries(
      MESSAGE_RECIPIENT_FIELDS.filter((field) => field in fullReply).map((field) => [field, fullReply[field]]),
    );
    for (const field of ['content', 'contentBlocks', 'thinking', 'metadata', 'toolEvents', 'replyTo'])
      assert.equal(field in projectedReply, false, `recipient rows carry no ${field}`);
    const source = {
      id: 'src-projected',
      threadId: THREAD,
      userId: USER,
      from: { kind: 'user', userId: USER },
      catId: null,
      content: 'request',
      timestamp: 10,
      deliveryStatus: 'delivered',
    };
    const result = await resolveResumeStopPoint({
      messageStore: {
        getByThreadBeforeBounded: (...args) => {
          calls.push(args);
          return { messages: [projectedReply], scannedCount: 1, storageRoundTrips: 1, exhausted: true };
        },
        getById: (id) => (id === source.id ? source : null),
      },
      threadId: THREAD,
      userId: USER,
      catId: CAT,
      viewer: VIEWER,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], THREAD);
    assert.deepEqual(
      calls[0][6],
      { recipientProjection: true },
      'main scan must use the recipient thread-index read: no bodies, no contentBlocks, not both projections',
    );
    assert.equal(result.kind, 'found');
    assert.equal(result.stopPoint.responseMessageId, 'resp-projected');
    assert.deepEqual(result.stopPoint.sourceMessageIds, ['src-projected']);
  });

  test('a failing read is reported as unavailable instead of guessed', async () => {
    const result = await resolveResumeStopPoint({
      messageStore: {
        getByThreadBeforeBounded: () => {
          throw new Error('store down');
        },
        getById: () => null,
      },
      threadId: THREAD,
      userId: USER,
      catId: CAT,
      viewer: VIEWER,
      scanLimit: 50,
    });
    assert.deepEqual(result, { kind: 'unavailable' });
  });
});

describe('M1b: navigation renders the stop point as a pointer, not an instruction', () => {
  test('found stop point lists coordinates, status and a read template without bodies', () => {
    const text = formatNavigationHeader({
      threadId: THREAD,
      baton: null,
      tasks: [],
      resumeStopPoint: {
        kind: 'found',
        stopPoint: {
          responseMessageId: 'resp-1',
          status: 'interrupted',
          at: Date.UTC(2026, 10, 3, 9, 0),
          sourceMessageIds: ['src-1', 'src-2'],
          unreadableSourceCount: 1,
        },
      },
    });
    assert.match(
      text,
      /上次停点（仅定位，非当前指令）: 你在本线程的上一条回复 resp-1（.*，已中断）← 来源 src-1, src-2（另有 1 条未列出：不可读或系统内部）/,
    );
    assert.match(
      text,
      /读原文: cat_cafe_get_thread_context\(\{ threadId: "thread-cold-resume", messageId: "resp-1", responseMode: "full" \}\)/,
    );
  });

  test('missing sources, window limits and unavailable reads stay honest; no history renders nothing', () => {
    const noSources = formatNavigationHeader({
      threadId: THREAD,
      baton: null,
      tasks: [],
      resumeStopPoint: {
        kind: 'found',
        stopPoint: {
          responseMessageId: 'resp-2',
          status: 'completed',
          at: 1,
          sourceMessageIds: [],
          unreadableSourceCount: 0,
        },
      },
    });
    assert.match(noSources, /← 来源未记录/);
    assert.match(
      formatNavigationHeader({
        threadId: THREAD,
        baton: null,
        tasks: [],
        resumeStopPoint: { kind: 'not_in_window', scannedCount: 200 },
      }),
      /上次停点: 最近 200 条消息内未找到你的回复记录/,
    );
    assert.match(
      formatNavigationHeader({ threadId: THREAD, baton: null, tasks: [], resumeStopPoint: { kind: 'unavailable' } }),
      /上次停点: 当前无法读取（不按最近发言推断）/,
    );
    assert.doesNotMatch(
      formatNavigationHeader({ threadId: THREAD, baton: null, tasks: [], resumeStopPoint: { kind: 'none' } }),
      /上次停点/,
    );
    assert.doesNotMatch(formatNavigationHeader({ threadId: THREAD, baton: null, tasks: [] }), /上次停点/);
  });
});

describe('S1a: only “接着做” is unread on a canonical cold turn', () => {
  async function seedS1a() {
    const store = adaptMessageStore(new MessageStore());
    const cursors = new DeliveryCursorStore();
    const request = userMessage(store, '@opus 帮我整理冷恢复需求', 10, { mentions: ['opus'] });
    const reply = catResponse(store, {
      inputMessageIds: [request.id],
      timestamp: 11,
      content: 'OLD-REPLY-BODY-SENTINEL 需求稿第三版',
      invocationId: 'inv-yesterday',
    });
    await cursors.ackCursor(USER, CAT, THREAD, cursorFor(reply));
    const resume = userMessage(store, '接着做', 20);
    return { store, cursors, request, reply, resume };
  }

  test('the cold packet points at where the cat stopped without replaying it', async () => {
    const { store, cursors, request, reply, resume } = await seedS1a();
    const result = await assembleIncrementalContext(buildDeps(store, cursors), USER, THREAD, CAT, resume.id, 'play', {
      contextProjection: projection('cold'),
    });
    assert.match(result.contextText, /接着做/);
    assert.match(result.contextText, new RegExp(`上次停点（仅定位，非当前指令）: 你在本线程的上一条回复 ${reply.id}`));
    assert.ok(result.contextText.includes(`← 来源 ${request.id}`), 'the reply’s original request is a coordinate');
    assert.ok(!result.contextText.includes('OLD-REPLY-BODY-SENTINEL'), 'own output is never replayed');
    assert.ok(!result.exposedMessageIds.includes(reply.id), 'pointers do not count as exposure');
  });

  test('proven hot continuation and legacy paths do not add the stop point', async () => {
    for (const options of [{ contextProjection: projection('hot') }, {}]) {
      const { store, cursors, resume } = await seedS1a();
      const result = await assembleIncrementalContext(
        buildDeps(store, cursors),
        USER,
        THREAD,
        CAT,
        resume.id,
        'play',
        options,
      );
      assert.doesNotMatch(result.contextText, /上次停点/);
    }
  });
});

describe('S1b: a large unread gap on a canonical cold turn', () => {
  test('tombstone carries exact coordinates while anchor bodies stay out', async () => {
    const store = adaptMessageStore(new MessageStore());
    const cursors = new DeliveryCursorStore();
    const opener = userMessage(store, 'THREAD-OPENER-BODY-SENTINEL 怎么设计冷恢复？', 1);
    const seeded = [opener];
    for (let i = 0; i < 80; i++) {
      seeded.push(userMessage(store, `讨论第 ${i} 条：Redis deployment notes ${'内容'.repeat(20)}`, 100 + i * 60_000));
    }
    const resume = userMessage(store, '@opus 接着做', 100 + 81 * 60_000, { mentions: ['opus'] });

    const result = await assembleIncrementalContext(buildDeps(store, cursors), USER, THREAD, CAT, resume.id, 'play', {
      contextProjection: projection('cold'),
    });
    const text = result.contextText;
    assert.match(text, /\[System: skipped \d+ messages/);
    const coordinates = /Coordinates: first (\S+); last (\S+?)(?:; key ([^.]+))?\./.exec(text);
    assert.ok(coordinates, `coordinates missing: ${text.slice(0, 600)}`);
    assert.equal(coordinates[1], opener.id, 'the omitted range starts at the thread opener');
    assert.ok(
      seeded.some((message) => message.id === coordinates[2]),
      'the last bound is a seeded omitted message',
    );
    assert.match(text, /search_evidence\(/, 'the keyword search remains a fallback entry');
    assert.ok(!text.includes('[Anchor '), 'canonical cold still has no anchor section');
    assert.ok(!text.includes('[Thread opener @'), 'canonical cold still has no primacy anchor body');
    assert.ok(!text.includes('THREAD-OPENER-BODY-SENTINEL'), 'coordinates do not smuggle the opener body back in');
  });
});
