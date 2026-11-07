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
