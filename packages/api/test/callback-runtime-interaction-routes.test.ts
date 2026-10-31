import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RuntimeInteractionError } from '../src/domains/runtime-interaction/RuntimeInteractionError.js';
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
  let managementCalls: Array<{ method: string; input: unknown }>;
  beforeEach(async () => {
    taskReads = 0;
    interactionRequests = 0;
    managementCalls = [];
    const registry = new InvocationRegistry();
    const credentials = await registry.create(
      'user-1',
      'codex-sol',
      'thread-1',
      undefined,
      undefined,
      undefined,
      'owner-message-1',
      'strict',
    );
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
        settleFromOwnerMessage: async (input: unknown) => {
          managementCalls.push({ method: 'settle', input });
          return { status: 'answered' };
        },
        withdrawConversationDecision: async (input: unknown) => {
          managementCalls.push({ method: 'withdraw', input });
          return { status: 'cancelled' };
        },
        supersedeConversationDecision: async (input: unknown) => {
          managementCalls.push({ method: 'supersede', input });
          return { status: 'cancelled' };
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

  it('binds conversation management to the authenticated requester identity', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/runtime-interactions/conversation/manage',
      headers,
      payload: {
        interactionId: 'conversation-1',
        expectedRevision: 2,
        operationId: 'settle-1',
        action: { kind: 'settle_from_message', responseMessageId: 'owner-message-1' },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(managementCalls, [
      {
        method: 'settle',
        input: {
          interactionId: 'conversation-1',
          requester: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol' },
          ownerMessageAuth: { ownerAuthProvenance: 'strict', originTriggerMessageId: 'owner-message-1' },
          expectedRevision: 2,
          operationId: 'settle-1',
          responseMessageId: 'owner-message-1',
        },
      },
    ]);
    const wrongSource = await app.inject({
      method: 'POST',
      url: '/api/callbacks/runtime-interactions/conversation/manage',
      headers,
      payload: {
        interactionId: 'conversation-1',
        expectedRevision: 2,
        operationId: 'settle-wrong-source',
        action: { kind: 'settle_from_message', responseMessageId: 'unread-owner-message' },
      },
    });
    assert.equal(wrongSource.statusCode, 404);
    assert.equal(managementCalls.length, 1);
  });

  it('routes withdraw and supersede without accepting an unversioned transition', async () => {
    for (const [action, method] of [
      [{ kind: 'withdraw' }, 'withdraw'],
      [{ kind: 'supersede', replacementInteractionId: 'conversation-2' }, 'supersede'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/runtime-interactions/conversation/manage',
        headers,
        payload: {
          interactionId: 'conversation-1',
          expectedRevision: 3,
          operationId: `operation-${method}`,
          action,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(managementCalls.at(-1)?.method, method);
    }
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/callbacks/runtime-interactions/conversation/manage',
      headers,
      payload: {
        interactionId: 'conversation-1',
        operationId: 'missing-revision',
        action: { kind: 'withdraw' },
      },
    });
    assert.equal(invalid.statusCode, 400);
  });

  it('does not reveal a foreign conversation decision through management errors', async () => {
    const registry = new InvocationRegistry();
    const credentials = await registry.create(
      'user-1',
      'codex-sol',
      'thread-1',
      undefined,
      undefined,
      undefined,
      'message-1',
      'strict',
    );
    const foreignApp = Fastify();
    await foreignApp.register(callbackRuntimeInteractionRoutes, {
      registry,
      service: {
        settleFromOwnerMessage: async () => {
          throw new RuntimeInteractionError('unauthorized', 'foreign requester');
        },
      } as never,
    });
    const response = await foreignApp.inject({
      method: 'POST',
      url: '/api/callbacks/runtime-interactions/conversation/manage',
      headers: {
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      payload: {
        interactionId: 'foreign-conversation',
        expectedRevision: 2,
        operationId: 'foreign-settle',
        action: { kind: 'settle_from_message', responseMessageId: 'message-1' },
      },
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'Interaction not found' });
    await foreignApp.close();
  });
});
