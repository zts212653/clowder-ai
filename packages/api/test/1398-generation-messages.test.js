import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

test('generation notice counts only published, unadopted, cat-visible freshness candidates inside its boundary', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const messages = new MessageStore();
  const append = (at, content, patch = {}) => {
    t.mock.timers.setTime(at);
    return messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'thread',
      content,
      mentions: [],
      timestamp: at,
      ...patch,
    });
  };
  const initial = append(1000, 'start');
  const parent = append(1050, '@opus expected reply', { from: { kind: 'agent', catId: 'codex' }, mentions: ['opus'] });
  const response = append(1100, 'working', {
    from: { kind: 'agent', catId: 'codex' },
    lifecycle: {
      kind: 'response',
      orderKey: '1100:response',
      invocationId: 'run',
      targetId: 'codex',
      inputEntryIds: ['entry-initial'],
      inputMessageIds: [initial.id],
      startedAt: 1100,
      status: 'processing',
    },
  });
  const other = append(1200, 'another question');
  const adopted = append(1300, 'append to this run');
  response.lifecycle.inputMessageIds.push(adopted.id);
  append(1400, 'own callback', { from: { kind: 'agent', catId: 'codex' } });
  append(1500, 'expected reply', { from: { kind: 'agent', catId: 'opus' }, replyTo: parent.id });
  const parallelSelf = append(1600, 'parallel self', {
    from: { kind: 'agent', catId: 'codex' },
    extra: { crossPost: { sourceThreadId: 'other-thread' } },
  });
  append(1700, 'private to another cat', { visibility: 'whisper', whisperTo: ['gemini'] });
  const privateOwn = append(1800, 'private to this cat', { visibility: 'whisper', whisperTo: ['codex'] });
  append(1850, 'not published', { deliveryStatus: 'queued' });
  append(1900, 'internal briefing', { origin: 'briefing' });
  response.lifecycle.status = 'completed';
  response.lifecycle.completedAt = 2000;
  append(2100, 'arrived after completion');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, { messageStore: messages, router: {}, registry: {}, socketManager: {} });
  const url = `/api/threads/thread/messages/${response.id}/generation-messages`;
  const result = await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().messageIds, [other.id, parallelSelf.id, privateOwn.id]);
  assert.equal(result.json().hasAppendedInputs, true);
  assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'another-owner' } })).statusCode, 404);
  assert.equal((await app.inject({ url })).statusCode, 401);
});

test('publication time survives queue delay, completion reordering and visibility-sequence clock drift', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const messages = new MessageStore();
  const append = (content, patch = {}) =>
    messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'thread',
      content,
      mentions: [],
      timestamp: 1000,
      ...patch,
    });
  const initial = append('start');
  const earlyQueued = append('written before start; delivered during generation', { deliveryStatus: 'queued' });
  const oldCat = append('cat speech already visible before generation', {
    from: { kind: 'agent', catId: 'opus' },
    deliveryStatus: 'queued',
  });
  t.mock.timers.setTime(1100);
  const response = append('done', {
    from: { kind: 'agent', catId: 'codex' },
    lifecycle: {
      kind: 'response',
      orderKey: '1100:response',
      invocationId: 'run',
      targetId: 'codex',
      inputEntryIds: ['entry'],
      inputMessageIds: [initial.id],
      startedAt: 1100,
      status: 'completed',
      completedAt: 1200,
    },
  });
  for (let index = 0; index < 150; index++) append('internal', { origin: 'briefing' });
  t.mock.timers.setTime(1150);
  messages.markDelivered(earlyQueued.id, 1150);
  messages.markDelivered(oldCat.id, 1150);
  const during = append('published during generation', { from: { kind: 'agent', catId: 'opus' }, timestamp: 1150 });
  during.timelineOrderAt = 1300;
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, { messageStore: messages, router: {}, registry: {}, socketManager: {} });
  const url = `/api/threads/thread/messages/${response.id}/generation-messages`;
  const result = await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().messageIds, [earlyQueued.id, during.id]);
  assert.equal(result.json().hasAppendedInputs, false);
  delete response.lifecycle.completedAt;
  assert.deepEqual((await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } })).json().messageIds, []);
});
