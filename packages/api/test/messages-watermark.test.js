import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

async function fixture(t) {
  const store = new MessageStore();
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, { messageStore: store, router: {}, registry: {}, socketManager: {} });
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
    const response = await get('/api/messages/watermark?threadId=thread');
    assert.equal(response.statusCode, 200);
    return response.json().watermark;
  };
  return { store, get, append, watermark };
}

test('watermark detects an in-place final even when a newer input exists', async (t) => {
  const f = await fixture(t);
  const empty = await f.get('/api/messages/watermark?threadId=thread');
  assert.equal(empty.statusCode, 200);
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
    source: { connector: 'routing-guard-failure', label: 'internal' },
  });
  assert.equal(await f.watermark(), visible);
  const history = (await f.get('/api/messages?threadId=thread')).json();
  assert.deepEqual(
    history.messages.map((message) => message.content),
    ['visible'],
  );
  assert.equal(history.historyWatermark, visible);
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
