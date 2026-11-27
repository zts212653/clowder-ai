import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { successorFixture } from './helpers/successor-routing-fixture.js';

async function setup(t) {
  const h = successorFixture(t);
  const registry = new InvocationRegistry();
  const broadcasts = [];
  const app = Fastify();
  const socketManager = {
    broadcastAgentMessage() {},
    emitToUser() {},
    broadcastToRoom: (...args) => broadcasts.push(args),
  };
  await app.register(messagesRoutes, {
    registry,
    router: h.router,
    messageStore: h.messages,
    threadStore: h.threads,
    invocationQueue: h.queue,
    socketManager,
  });
  await app.register(callbacksRoutes, { registry, messageStore: h.messages, threadStore: h.threads, socketManager });
  t.after(() => app.close());
  return { ...h, registry, app, broadcasts };
}

async function requestRename(h, idempotencyKey = randomUUID()) {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: '请把当前对话改名为指定标题', idempotencyKey },
  });
  assert.equal(response.statusCode, 202, response.body);
  const source = await h.messages.getById(response.json().userMessageId);
  const auth = await h.registry.create('owner', 'codex', h.threadId, undefined, undefined, undefined, source.id);
  return { source, auth };
}

function rename(h, auth, title = '用户指定标题') {
  return h.app.inject({
    method: 'POST',
    url: '/api/callbacks/set-thread-metadata',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: { title, titleIntent: 'user_requested' },
  });
}

for (const menuAction of ['different title', 'same title', 'change and restore']) {
  test(`a pending rename preserves a newer menu decision: ${menuAction}`, async (t) => {
    const h = await setup(t);
    const key = randomUUID();
    const { source } = await requestRename(h, key);
    const original = h.threads.get(h.threadId).title;
    if (menuAction !== 'same title') h.threads.updateTitle(h.threadId, '菜单新决定');
    if (menuAction !== 'different title') h.threads.updateTitle(h.threadId, original);
    const latest = h.threads.get(h.threadId).title;
    const replay = await requestRename(h, key);
    assert.equal(replay.source.id, source.id);
    const read = await h.app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-metadata',
      headers: { 'x-invocation-id': replay.auth.invocationId, 'x-callback-token': replay.auth.callbackToken },
    });
    assert.equal(read.json().title, latest);
    h.broadcasts.length = 0;
    const response = await rename(h, replay.auth);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().titleApplied, false);
    assert.equal(response.json().titleReason, 'newer_protected_title');
    assert.equal(response.json().title, latest);
    assert.deepEqual(h.broadcasts, []);
    assert.equal(h.threads.get(h.threadId).title, latest);
    const fresh = await requestRename(h);
    assert.equal((await rename(h, fresh.auth)).json().titleApplied, true);
  });
}

test('first temporary naming and cat progress do not invalidate a user request; a second user write does', async (t) => {
  const h = await setup(t);
  const { auth } = await requestRename(h);
  h.threads.setAutomaticTitle(h.threadId, '猫的简短标题', 'cat', 'codex');
  h.threads.setAutomaticTitle(h.threadId, 'issue#2006 修复中', 'cat', 'codex', 'update');
  const applied = await rename(h, auth);
  assert.equal(applied.json().titleApplied, true);
  assert.equal(applied.json().titleSource, 'user');
  assert.equal(h.threads.get(h.threadId).titleCatId, undefined);
  assert.equal((await rename(h, auth, '旧请求再次写入')).json().titleApplied, false);
  assert.equal(h.threads.setAutomaticTitle(h.threadId, '自动覆盖', 'cat', 'codex', 'update'), false);
});

for (const invalidSource of ['missing', 'agent', 'system', 'other user', 'other thread', 'A2A', 'no snapshot']) {
  test(`user-requested rename rejects an unbound source: ${invalidSource}`, async (t) => {
    const h = await setup(t);
    const { source } = await requestRename(h);
    let sourceId = source.id;
    if (['agent', 'system', 'other user', 'other thread', 'no snapshot'].includes(invalidSource)) {
      const userId = invalidSource === 'other user' ? 'other' : 'owner';
      const from =
        invalidSource === 'agent'
          ? { kind: 'agent', catId: 'codex' }
          : invalidSource === 'system'
            ? { kind: 'system', service: 'test' }
            : { kind: 'user', userId };
      const message = h.messages.append({
        from,
        userId,
        threadId: invalidSource === 'other thread' ? h.threads.create('owner').id : h.threadId,
        content: '改名',
        mentions: [],
        timestamp: Date.now(),
        ...(invalidSource === 'no snapshot' ? {} : { extra: { userTitleRevisionAtRequest: 0 } }),
      });
      sourceId = message.id;
    }
    const auth = await h.registry.create(
      'owner',
      'codex',
      h.threadId,
      undefined,
      invalidSource === 'A2A' ? sourceId : undefined,
      undefined,
      invalidSource === 'missing' ? undefined : sourceId,
    );
    const previous = h.threads.get(h.threadId).title;
    h.broadcasts.length = 0;
    const response = await rename(h, auth);
    assert.equal(response.statusCode, invalidSource === 'no snapshot' ? 409 : 403, response.body);
    assert.equal(h.threads.get(h.threadId).title, previous);
    assert.deepEqual(h.broadcasts, []);
  });
}
