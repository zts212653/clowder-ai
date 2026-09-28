import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { callbackRuntimeInteractionRoutes } from '../src/routes/callback-runtime-interaction-routes.js';

const payload = {
  questions: [
    { header: 'Decision', question: 'Choose a product direction?', options: [{ label: 'A' }, { label: 'B' }] },
  ],
};

describe('retired Default-mode question callback', () => {
  let app: ReturnType<typeof Fastify>;
  let headers: Record<string, string>;
  let taskReads: number;
  let interactionRequests: number;
  beforeEach(async () => {
    taskReads = 0;
    interactionRequests = 0;
    const registry = new InvocationRegistry();
    const credentials = await registry.create('user-1', 'codex-sol', 'thread-1');
    headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
    app = Fastify();
    const routeOptions = {
      registry,
      taskStore: {
        listByThread: async () => {
          taskReads += 1;
          return [];
        },
      },
      service: {
        request: async () => {
          interactionRequests += 1;
          return { kind: 'answers' as const, answers: { q1: ['A'] } };
        },
      },
    };
    await app.register(callbackRuntimeInteractionRoutes, routeOptions);
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns retirement without a card, Task lookup, waiter, or approval', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/callbacks/request-user-input', headers, payload });
    assert.equal(response.statusCode, 410);
    const notice = response.json();
    assert.equal(notice.status, 'retired');
    assert.equal(notice.approvalGranted, false);
    assert.equal(notice.questionCreated, false);
    assert.equal(notice.response, undefined);
    assert.equal(interactionRequests, 0);
    assert.equal(taskReads, 0);
  });

  it('does not need obsolete question fields to explain the retired route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-user-input',
      headers,
      payload: {},
    });
    assert.equal(response.statusCode, 410);
    assert.equal(interactionRequests, 0);
  });

  it('still rejects unauthenticated and invalid-token callers', async () => {
    for (const auth of [{}, { ...headers, 'x-callback-token': 'incorrect' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/request-user-input',
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 401);
    }
    assert.equal(interactionRequests, 0);
  });
});
