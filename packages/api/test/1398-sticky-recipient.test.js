import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';

function input(f, mentions, extra = {}) {
  return f.messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: f.thread.id,
    content: mentions.length ? mentions.map((id) => `@${id}`).join(' ') : '继续',
    mentions,
    timestamp: Date.now(),
    ...extra,
  });
}

async function preview(f) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/routing/preview',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { scope: 'thread', threadId: f.thread.id, content: '继续' },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function send(f) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: f.thread.id, content: '继续', idempotencyKey: randomUUID() },
  });
  assert.equal(response.statusCode, 202, response.body);
  return f.queue.list(f.thread.id, 'owner').at(-1);
}

test('last Human mention survives two hours, six unaddressed inputs and A2A; busy stays queued for that cat', async (t) => {
  const f = await queueHttpFixture(t);
  input(f, ['codex'], { timestamp: Date.now() - 2 * 60 * 60 * 1000 });
  for (let i = 0; i < 6; i++) input(f, []);
  f.messages.append({
    from: { kind: 'agent', catId: 'codex' },
    userId: 'owner',
    threadId: f.thread.id,
    content: '@gemini please review',
    mentions: ['gemini'],
    timestamp: Date.now(),
  });
  f.reply('gemini');
  const tracker = new InvocationTracker();
  const controller = tracker.start(f.thread.id, 'codex', 'owner');
  t.after(() => tracker.complete(f.thread.id, 'codex', controller));
  assert.deepEqual((await preview(f)).targetCats, ['codex']);
  const entry = await send(f);
  assert.deepEqual(entry.targets, ['codex']);
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: tracker,
    invocationRecordStore: new InvocationRecordStore(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  await processor.requestDrain(f.thread.id);
  assert.deepEqual(
    f.queue.list(f.thread.id, 'owner').map((item) => [item.id, item.targets, item.status]),
    [[entry.id, ['codex'], 'queued']],
  );
  assert.equal(f.messages.getById(entry.payload.messageId).deliveryStatus, 'queued');
});

test('a newly queued Human mention replaces the previous default immediately', async (t) => {
  const f = await queueHttpFixture(t);
  input(f, ['opus'], { timestamp: Date.now() - 10000 });
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: f.thread.id, content: '@codex 新话题', idempotencyKey: randomUUID() },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(f.messages.getById(response.json().userMessageId).deliveryStatus, 'queued');
  assert.deepEqual((await preview(f)).targetCats, ['codex']);
  assert.deepEqual((await send(f)).targets, ['codex']);
});

test('late delivery of an earlier mention cannot replace the later Human choice', async (t) => {
  const f = await queueHttpFixture(t);
  const old = input(f, ['opus'], { timestamp: Date.now() - 10000, deliveryStatus: 'queued' });
  input(f, ['codex'], { timestamp: Date.now() - 5000 });
  await f.messages.markDelivered(old.id, Date.now());
  assert.deepEqual((await preview(f)).targetCats, ['codex']);
  assert.deepEqual((await send(f)).targets, ['codex']);
});

for (const multiple of [false, true]) {
  test(`unavailable last mention is explained and never restores an older named cat (multiple=${multiple})`, async (t) => {
    const f = await queueHttpFixture(t);
    input(f, ['opus'], { timestamp: Date.now() - 10000 });
    input(f, multiple ? ['codex', 'gemini', 'opus'] : ['codex']);
    f.reply('gemini');
    f.agents.markUnavailable('codex', { code: 'rejected-account-binding', message: 'temporarily unavailable' });
    f.router.refreshFromRegistry(f.agents);
    const result = await preview(f);
    assert.deepEqual(result.targetCats, ['gemini']);
    assert.deepEqual(result.unavailableTargets, ['codex']);
    assert.deepEqual((await send(f)).targets, ['gemini']);
  });
}
