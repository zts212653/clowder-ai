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
