import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

async function fixture(t) {
  const store = new MessageStore();
  const threads = new ThreadStore();
  threads.ensureThread('thread', 'Owned thread').createdBy = 'owner';
  threads.ensureThread('default', 'Lobby');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, {
    messageStore: store,
    threadStore: threads,
    router: {},
    registry: {},
    socketManager: {},
  });
  const get = (url, userId = 'owner') => app.inject({ url, headers: { 'x-cat-cafe-user': userId } });
  const append = (content, patch = {}) =>
    store.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'thread',
      content,
      mentions: [],
      timestamp: Date.now(),
      ...patch,
    });
  const watermark = async () => {
    const response = await get('/api/threads/thread/watermark');
    assert.equal(response.statusCode, 200);
    return response.json().watermark;
  };
  return { app, store, get, append, watermark };
}

test('watermark detects an in-place final even when a newer input exists', async (t) => {
  const f = await fixture(t);
  const empty = await f.get('/api/threads/thread/watermark');
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.headers['cache-control'], 'no-store');
  assert.deepEqual(empty.json(), { watermark: null });
  const source = f.append('question');
  const initialWatermark = await f.watermark();
  const admitted = f.store.appendAndObservePriorFrontier({
    from: { kind: 'agent', catId: 'opus' },
    userId: 'owner',
    threadId: 'thread',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: Date.now(),
    lifecycle: {
      kind: 'response',
      orderKey: 'response-order',
      invocationId: 'child',
      targetId: 'opus',
      inputEntryIds: ['entry'],
      inputMessageIds: [source.id],
      status: 'processing',
      startedAt: Date.now(),
    },
  });
  const processing = await f.watermark();
  assert.equal(processing, initialWatermark);
  assert.equal(processing, f.store.getLatestVisibleCursor('thread').cursor);
  f.append('another question');
  const beforeCommit = await f.watermark();
  const terminal = f.store.commitLifecycleResponseTerminal(admitted.message.id, {
    invocationId: 'child',
    status: 'completed',
    completedAt: Date.now(),
    content: 'complete answer',
    mentions: [],
    origin: 'stream',
  });
  assert.equal(terminal.kind, 'applied');
  assert.equal(terminal.message.id, admitted.message.id);
  assert.notEqual(await f.watermark(), beforeCommit);
  assert.equal((await f.get('/api/messages?threadId=thread')).json().historyWatermark, await f.watermark());
});

test('browser watermark follows History owner and hidden-diagnostic boundaries', async (t) => {
  const f = await fixture(t);
  f.append('visible');
  const visible = await f.watermark();
  f.append('another owner', { userId: 'someone-else', from: { kind: 'user', userId: 'someone-else' } });
  f.append('retired diagnostic', {
    userId: 'system',
    from: { kind: 'system', service: 'routing-guard-failure' },
    source: { connector: 'routing-guard-failure', label: 'internal', icon: 'alert-triangle' },
  });
  assert.equal(await f.watermark(), visible);
  const history = (await f.get('/api/messages?threadId=thread')).json();
  assert.deepEqual(
    history.messages.map((message) => message.content),
    ['visible'],
  );
  assert.equal(history.historyWatermark, visible);
});

test('watermark enforces identity and thread ownership, including the public default thread', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get(`/api/threads/${'x'.repeat(101)}/watermark`)).statusCode, 404);
  assert.equal((await f.get('/api/threads/missing/watermark')).statusCode, 404);
  assert.equal((await f.get('/api/threads/thread/watermark', 'someone-else')).statusCode, 403);
  assert.equal((await f.get('/api/threads/default/watermark', 'someone-else')).statusCode, 200);
  const anonymous = await f.app.inject({ url: '/api/threads/thread/watermark' });
  assert.equal(anonymous.statusCode, 401);
});

test('browser frontier includes seen recall placeholders and queued cat speech, then falls back after deletion', async (t) => {
  const f = await fixture(t);
  f.append('first');
  const previous = await f.watermark();
  const recalled = f.append('legacy seen recall');
  Object.assign(recalled, {
    content: '',
    deliveryStatus: 'canceled',
    _tombstone: true,
    recall: { version: 1, exposure: 'seen', recalledAt: Date.now() },
  });
  const seen = await f.watermark();
  assert.notEqual(seen, previous);
  assert.equal((await f.get('/api/messages?threadId=thread')).json().historyWatermark, seen);
  f.append('queued owner work', { deliveryStatus: 'queued' });
  assert.equal(await f.watermark(), seen);
  const speech = f.append('queued public speech', {
    from: { kind: 'agent', catId: 'opus' },
    origin: 'callback',
    deliveryStatus: 'queued',
  });
  assert.notEqual(await f.watermark(), seen);
  f.store.softDelete(speech.id, 'owner');
  assert.equal(await f.watermark(), seen);
});

test('a failed watermark read does not make the History page fail or acknowledge an unknown position', async (t) => {
  const f = await fixture(t);
  f.append('visible');
  f.store.getLatestVisibleCursor = () => {
    throw new Error('visibility read unavailable');
  };
  const result = await f.get('/api/messages?threadId=thread');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(
    result.json().messages.map((message) => message.content),
    ['visible'],
  );
  assert.equal(Object.hasOwn(result.json(), 'historyWatermark'), false);
});

test('History captures its watermark before reading the page and older pages do not acknowledge it', async (t) => {
  const f = await fixture(t);
  f.append('before');
  const captured = await f.watermark();
  const read = f.store.getByThread.bind(f.store);
  f.store.getByThread = (...args) => {
    const page = read(...args);
    f.append('committed during page read');
    return page;
  };
  const result = (await f.get('/api/messages?threadId=thread')).json();
  assert.equal(result.historyWatermark, captured);
  assert.notEqual(result.historyWatermark, await f.watermark());
  assert.deepEqual(
    result.messages.map((message) => message.content),
    ['before'],
  );
  const older = (await f.get(`/api/messages?threadId=thread&before=${Date.now() + 1000}`)).json();
  assert.equal(Object.hasOwn(older, 'historyWatermark'), false);
});

test('History recovers every late final beyond the latest timeline page before acknowledging it', async (t) => {
  const f = await fixture(t);
  const responses = [1, 2].map(
    (n) =>
      f.store.appendAndObservePriorFrontier({
        userId: 'owner',
        threadId: 'thread',
        content: '',
        mentions: [],
        from: { kind: 'agent', catId: 'opus' },
        origin: 'stream',
        timestamp: 1100 + n,
        lifecycle: {
          kind: 'response',
          orderKey: `order-${n}`,
          invocationId: `child-${n}`,
          targetId: 'opus',
          inputEntryIds: ['entry'],
          inputMessageIds: ['input'],
          status: 'processing',
          startedAt: 1100 + n,
        },
      }).message,
  );
  Array.from({ length: 60 }, (_, n) => f.append(`newer-${n}`));
  const baseline = (await f.get('/api/messages?threadId=thread&limit=50')).json().historyWatermark;
  responses.forEach((response, n) =>
    assert.equal(
      f.store.commitLifecycleResponseTerminal(response.id, {
        invocationId: `child-${n + 1}`,
        status: 'completed',
        completedAt: Date.now(),
        content: `late final ${n + 1}`,
        mentions: [],
        origin: 'stream',
      }).kind,
      'applied',
    ),
  );
  const recovered = (
    await f.get(`/api/messages?threadId=thread&limit=50&afterVisibility=${encodeURIComponent(baseline)}`)
  ).json();
  responses.forEach((response) => assert.ok(recovered.messages.some((message) => message.id === response.id)));
  assert.equal(recovered.historyWatermark, await f.watermark());
});

test('hidden-only progress stays private and cannot consume a lost response or a second client', async (t) => {
  const f = await fixture(t);
  f.append('baseline');
  const baseline = (await f.get('/api/messages?threadId=thread')).json().historyWatermark;
  const probe = `/api/threads/thread/watermark?afterVisibility=${encodeURIComponent(baseline)}`;
  const before = (await f.get(probe)).body;
  const hidden = Array.from({ length: 52 }, () =>
    f.append('private body', {
      userId: 'other',
      from: { kind: 'user', userId: 'other' },
    }),
  );
  assert.equal((await f.get(probe)).body, before);
  assert.equal((await f.get(probe)).body, before);
  const first = f.append('first visible delta');
  f.append('private suffix', { userId: 'other', from: { kind: 'user', userId: 'other' } });
  const second = f.append('second visible delta');
  const observed = await f.get(probe);
  hidden.forEach((message) => assert.equal(observed.body.includes(message.id), false));
  assert.deepEqual(observed.json(), { watermark: await f.watermark() });
  const url = `/api/messages?threadId=thread&afterVisibility=${encodeURIComponent(baseline)}`;
  // The first reply can be lost; another surface with the same cursor still needs both records.
  for (const _ of [1, 2]) {
    const page = (await f.get(url)).json();
    [first, second].forEach((message) => assert.ok(page.messages.some((row) => row.id === message.id)));
    assert.equal(page.historyWatermark, observed.json().watermark);
  }
});

test('a quiet hidden range is not scanned again merely because wall time passed', async (t) => {
  const f = await fixture(t);
  f.append('baseline');
  const baseline = (await f.get('/api/messages?threadId=thread')).json().historyWatermark;
  Array.from({ length: 100 }, () => f.append('hidden', { userId: 'other', from: { kind: 'user', userId: 'other' } }));
  const probe = `/api/threads/thread/watermark?afterVisibility=${encodeURIComponent(baseline)}`;
  assert.equal((await f.get(probe)).json().watermark, baseline);
  assert.equal((await f.get(probe)).json().watermark, baseline);
  const scan = f.store.getBrowserHistoryChanges.bind(f.store);
  let scans = 0;
  f.store.getBrowserHistoryChanges = (...args) => {
    scans++;
    return scan(...args);
  };
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  const later = realNow() + 600_001;
  Date.now = () => later;
  assert.equal((await f.get(probe)).json().watermark, baseline);
  assert.equal(scans, 0);
});

test('a visible publication behind 500 unscanned hidden records is discovered on the eleventh probe', async (t) => {
  const f = await fixture(t);
  f.append('baseline');
  const baseline = (await f.get('/api/messages?threadId=thread')).json().historyWatermark;
  Array.from({ length: 500 }, () => f.append('hidden', { userId: 'other', from: { kind: 'user', userId: 'other' } }));
  const visible = f.append('visible after backlog');
  const probe = `/api/threads/thread/watermark?afterVisibility=${encodeURIComponent(baseline)}`;
  for (const _ of Array.from({ length: 10 })) {
    assert.equal((await f.get(probe)).json().watermark, baseline);
  }
  const discovered = (await f.get(probe)).json().watermark;
  assert.notEqual(discovered, baseline);
  const page = (await f.get(`/api/messages?threadId=thread&afterVisibility=${encodeURIComponent(baseline)}`)).json();
  assert.ok(page.messages.some((message) => message.id === visible.id));
  assert.equal(page.historyWatermark, discovered);
});
