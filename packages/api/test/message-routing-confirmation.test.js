import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { routingPreviewRoutes } from '../dist/routes/routing-preview.js';

async function fixture(t, unavailable = true) {
  const agents = new AgentRegistry();
  const original = catRegistry.getAllConfigs();
  const base = original.opus;
  catRegistry.reset();
  Object.entries(original)
    .filter(([id]) => !['dsh', 'kimi'].includes(id))
    .forEach(([id, config]) => catRegistry.register(id, config));
  t.after(() => {
    catRegistry.reset();
    Object.entries(original).forEach(([id, config]) => catRegistry.register(id, config));
  });
  for (const [id, displayName, nickname] of [
    ['dsh', '小鲸鱼', '鲸鲸'],
    ['kimi', '梵花猫', '墨墨'],
  ]) {
    catRegistry.register(id, { ...base, id, displayName, nickname, mentionPatterns: [`@${id}`, `@${displayName}`] });
  }
  for (const id of ['dsh', 'codex', 'kimi', 'opus']) {
    agents.register(id, {
      async *invoke() {
        assert.fail('admission must not invoke a model');
      },
    });
  }
  if (unavailable)
    agents.markUnavailable('dsh', { code: 'ACP_BOOTSTRAP_UNAVAILABLE', message: 'secret_dsh_patch_changed' });
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner', 'DSH routing confirmation');
  const registry = new InvocationRegistry();
  const router = new AgentRouter({ agentRegistry: agents, registry, messageStore: messages, threadStore: threads });
  const queue = new InvocationQueue(undefined, {
    resolveTargets: (targets, threadId, content, exact) => router.resolveSendTargets(targets, threadId, content, exact),
  });
  messages.append({
    from: { kind: 'agent', catId: 'kimi' },
    userId: 'owner',
    threadId: thread.id,
    content: 'existing reply',
    mentions: [],
    timestamp: Date.now() - 1000,
  });
  threads.updateParticipantActivity(thread.id, 'kimi', true);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(routingPreviewRoutes, { threadStore: threads, router });
  await app.register(messagesRoutes, {
    registry,
    router,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: queue,
    socketManager: { broadcastToRoom() {}, emitToUser() {}, broadcastAgentMessage() {} },
  });
  const payload = { threadId: thread.id, content: '@dsh 你怎么没有回复', idempotencyKey: randomUUID() };
  const send = (overrides = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { ...payload, ...overrides },
    });
  return { app, agents, messages, threads, thread, router, queue, send };
}

test('unavailable named member requires confirmation before any source or Queue write', async (t) => {
  const f = await fixture(t);
  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/routing/preview',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { scope: 'thread', threadId: f.thread.id, content: '@dsh 你怎么没有回复' },
  });
  assert.deepEqual(preview.json().targetCats, ['kimi']);
  const response = await f.send();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'ROUTING_CONFIRMATION_REQUIRED');
  assert.deepEqual(
    response.json().targets.map((target) => target.catId),
    ['kimi'],
  );
  assert.equal(response.json().unavailable[0].catId, 'dsh');
  assert.match(response.json().unavailable[0].displayName, /小鲸鱼/);
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
  assert.equal(f.messages.getByThread(f.thread.id).filter((message) => message.from.kind === 'user').length, 0);
});

test('confirmed recipient is exact and an identical retry retains its source and target', async (t) => {
  const f = await fixture(t);
  const response = await f.send({ confirmedTargetCats: ['kimi'] });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(
    response.json().entries.map((entry) => entry.targetCatId),
    ['kimi'],
  );
  const retry = await f.send({ confirmedTargetCats: ['kimi'] });
  assert.equal(retry.statusCode, 202, retry.body);
  assert.equal(retry.json().userMessageId, response.json().userMessageId);
  assert.deepEqual(
    f.queue.list(f.thread.id, 'owner').map((entry) => entry.targets),
    [['kimi']],
  );
});

test('an empty structured mention list cannot skip confirmation for an unavailable prose mention', async (t) => {
  const f = await fixture(t);
  const response = await f.send({ mentions: [] });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'ROUTING_CONFIRMATION_REQUIRED');
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
});

test('confirmed recipient becoming unavailable cannot silently substitute Codex', async (t) => {
  const f = await fixture(t);
  f.agents.markUnavailable('kimi', { code: 'CLI_UNAVAILABLE', message: 'fixture offline after confirmation' });
  f.router.refreshFromRegistry(f.agents);
  const response = await f.send({ confirmedTargetCats: ['kimi'] });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
});

test('multipart confirmation admits only the approved recipient', async (t) => {
  const f = await fixture(t);
  const boundary = 'routing-confirmation-fixture';
  const fields = { threadId: f.thread.id, content: '@dsh hello', confirmedTargetCats: 'kimi' };
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload:
      Object.entries(fields)
        .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
        .join('') + `--${boundary}--\r\n`,
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(
    response.json().entries.map((entry) => entry.targetCatId),
    ['kimi'],
  );
  assert.deepEqual(
    f.queue.list(f.thread.id, 'owner').map((entry) => entry.targets),
    [['kimi']],
  );
});

test('confirmed replacement remains exact if it becomes unavailable before Queue drain', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send({ confirmedTargetCats: ['kimi'] })).statusCode, 202);
  f.agents.markUnavailable('kimi', { code: 'CLI_UNAVAILABLE', message: 'fixture offline before drain' });
  f.router.refreshFromRegistry(f.agents);
  const deliveries = [];
  f.router.routeExecution = async function* (...args) {
    deliveries.push(args[4]);
  };
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: new InvocationTracker(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  await processor.requestDrain(f.thread.id);
  assert.deepEqual(deliveries, [], 'an approved recipient cannot turn into a different model invocation');
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
  assert.ok(f.messages.getByThread(f.thread.id).some((row) => row.lifecycle?.reason === 'invalid_explicit_target'));
});

test('a ready named member becoming unavailable after preview cannot silently substitute Kimi', async (t) => {
  const f = await fixture(t, false);
  const preview = f.router.previewTargets.bind(f.router);
  f.router.previewTargets = async (...args) => {
    const result = await preview(...args);
    f.agents.markUnavailable('dsh', { code: 'CLI_UNAVAILABLE', message: 'offline after preview' });
    f.router.refreshFromRegistry(f.agents);
    return result;
  };
  const response = await f.send();
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(
    response.json().entries.map((entry) => entry.targetCatId),
    ['dsh'],
  );
  const retry = await f.send();
  assert.equal(retry.statusCode, 202, retry.body);
  assert.equal(retry.json().userMessageId, response.json().userMessageId);
});

test('a ready named member becoming unavailable before drain cannot invoke another member', async (t) => {
  const f = await fixture(t, false);
  assert.equal((await f.send()).statusCode, 202);
  f.agents.markUnavailable('dsh', { code: 'CLI_UNAVAILABLE', message: 'offline before drain' });
  f.router.refreshFromRegistry(f.agents);
  const deliveries = [];
  f.router.routeExecution = async function* (...args) {
    deliveries.push(args[4]);
  };
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: new InvocationTracker(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  await processor.requestDrain(f.thread.id);
  assert.deepEqual(deliveries, []);
  assert.ok(f.messages.getByThread(f.thread.id).some((row) => row.lifecycle?.reason === 'invalid_explicit_target'));
});

test('@all and a named DSH member both include the actual DSH service once ready', async (t) => {
  const f = await fixture(t, false);
  const group = await f.send({ content: '@all 打个招呼吧' });
  assert.equal(group.statusCode, 202, group.body);
  assert.deepEqual(
    new Set(group.json().entries.map((entry) => entry.targetCatId)),
    new Set(['dsh', 'codex', 'kimi', 'opus']),
  );
  const named = await f.send({ idempotencyKey: randomUUID() });
  assert.equal(named.statusCode, 202, named.body);
  assert.deepEqual(
    named.json().entries.map((entry) => entry.targetCatId),
    ['dsh'],
  );
});

test('@all retry retains the admitted members after the available roster changes', async (t) => {
  const f = await fixture(t, false);
  const first = await f.send({ content: '@all hello' });
  assert.equal(first.statusCode, 202, first.body);
  f.agents.markUnavailable('dsh', { code: 'CLI_UNAVAILABLE', message: 'offline before retry' });
  f.router.refreshFromRegistry(f.agents);
  const retry = await f.send({ content: '@all hello' });
  assert.equal(retry.statusCode, 202, retry.body);
  assert.equal(retry.json().userMessageId, first.json().userMessageId);
  assert.deepEqual(retry.json().entries, first.json().entries);
});

test('a different confirmed recipient cannot rewrite an admitted message key', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send({ confirmedTargetCats: ['kimi'] })).statusCode, 202);
  const conflict = await f.send({ confirmedTargetCats: ['codex'] });
  assert.ok(conflict.statusCode >= 400, conflict.body);
  assert.deepEqual(
    f.queue.list(f.thread.id, 'owner').map((entry) => entry.targets),
    [['kimi']],
  );
});
