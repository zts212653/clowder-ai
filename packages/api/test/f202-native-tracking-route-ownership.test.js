import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

test('Host callback router has no legacy tracking writes and preserves deployment registration', async () => {
  const app = Fastify();
  try {
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      messageStore: new MessageStore(),
      taskStore: new TaskStore(),
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {} },
      evidenceStore: { search: async () => [], health: async () => true },
      reflectionService: { reflect: async () => '' },
      deploymentObservationProvider: { observe: async () => null },
      deploymentWaitLifecycleHolder: {},
    });
    await app.ready();
    for (const suffix of ['register-pr-tracking', 'register-issue-tracking', 'unregister-tracking']) {
      assert.equal(app.hasRoute({ method: 'POST', url: `/api/callbacks/${suffix}` }), false, suffix);
    }
    assert.ok(app.hasRoute({ method: 'POST', url: '/api/callbacks/register-deployment-wait' }));
    assert.ok(app.hasRoute({ method: 'POST', url: '/api/callbacks/refresh-token' }));
  } finally {
    await app.close();
  }
});
