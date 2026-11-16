import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';

for (const source of ['user', 'cat'] as const) {
  test(`a cat title request honestly reports a protected ${source} title without losing other metadata`, async () => {
    const threads = new ThreadStore();
    const thread = threads.create('u', source === 'user' ? 'Chosen name' : undefined);
    if (source === 'cat') threads.setAutomaticTitle(thread.id, 'Chosen name', 'cat', 'sonnet');
    const registry = new InvocationRegistry();
    const auth = await registry.create('u', 'codex', thread.id);
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      threadStore: threads,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {} },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/set-thread-metadata',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: { title: 'Another name', notes: { validation: 'retained' } },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().titleApplied, false);
      assert.equal(response.json().titleSource, source);
      assert.equal(response.json().title, 'Chosen name');
      assert.equal(response.json().notes.validation, 'retained');
      assert.equal(threads.get(thread.id)?.titleSource, source);
    } finally {
      await app.close();
    }
  });
}

(
  [
    ['temporary', 'update', true],
    ['temporary', 'user_requested', true],
    ['cat', 'update', true],
    ['user', 'update', false],
    ['cat', 'user_requested', true],
    ['user', 'user_requested', true],
  ] as const
).forEach(([source, titleIntent, applied]) => {
  test(`${titleIntent} on a ${source} title returns the saved title and broadcasts only an applied update`, async (t) => {
    const threads = new ThreadStore();
    const thread = threads.create('u', source === 'user' ? 'Chosen name' : undefined);
    if (source === 'cat') threads.setAutomaticTitle(thread.id, 'Chosen name', 'cat', 'sonnet');
    const registry = new InvocationRegistry();
    const auth = await registry.create('u', 'codex', thread.id);
    const broadcasts: unknown[][] = [];
    const app = Fastify();
    t.after(() => app.close());
    await app.register(callbacksRoutes, {
      registry,
      threadStore: threads,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom: (...args: unknown[]) => broadcasts.push(args) },
    });
    const title = 'issue#2006 PR#123 会话标题更新';
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/set-thread-metadata',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { title, titleIntent, notes: { validation: 'retained' } },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().titleApplied, applied);
    assert.equal(response.json().title, applied ? title : 'Chosen name');
    assert.equal(response.json().titleSource, applied ? (titleIntent === 'user_requested' ? 'user' : 'cat') : source);
    assert.equal(response.json().notes.validation, 'retained');
    assert.equal(threads.get(thread.id)?.title, response.json().title);
    assert.deepEqual(
      broadcasts,
      applied ? [[`thread:${thread.id}`, 'thread_updated', { threadId: thread.id, title }]] : [],
    );
    assert.equal('titleIntent' in (threads.get(thread.id)?.threadMetadata ?? {}), false);
  });
});

[{ titleIntent: 'update' }, { title: 'New title', titleIntent: 'force' }].forEach((payload) => {
  test(`invalid title intent request is rejected before mutation: ${JSON.stringify(payload)}`, async (t) => {
    const threads = new ThreadStore();
    const thread = threads.create('u');
    const registry = new InvocationRegistry();
    const auth = await registry.create('u', 'codex', thread.id);
    const app = Fastify();
    t.after(() => app.close());
    await app.register(callbacksRoutes, {
      registry,
      threadStore: threads,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {} },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/set-thread-metadata',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(threads.get(thread.id)?.title, null);
    assert.deepEqual(threads.get(thread.id)?.threadMetadata ?? {}, {});
  });
});
