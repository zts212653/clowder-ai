import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { RuntimeInteractionRequest } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { RuntimeInteractionService } from '../src/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';
import { runtimeInteractionRoutes } from '../src/routes/runtime-interaction-routes.js';

const request: RuntimeInteractionRequest = {
  version: 1,
  interactionId: 'route-interaction',
  kind: 'approval',
  owner: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'route-invocation' },
  provider: {
    providerId: 'openai',
    method: 'item/fileChange/requestApproval',
    requestId: 'rpc-route',
    threadId: 'provider-thread',
    turnId: 'provider-turn',
    itemId: 'provider-item',
  },
  createdAt: 1000,
  title: 'Apply file changes?',
  decisions: [
    { id: 'accept', label: 'Apply', outcome: 'accept' },
    { id: 'decline', label: 'Decline', outcome: 'decline' },
  ],
};

const cardRef = {
  threadId: 'thread-1',
  messageId: 'message-route',
  blockId: 'runtime-interaction:route-interaction',
};

describe('runtime interaction routes', () => {
  let app: ReturnType<typeof Fastify>;
  let service: RuntimeInteractionService;
  let pendingResponse: Promise<unknown>;

  beforeEach(async () => {
    app = Fastify();
    service = new RuntimeInteractionService({
      store: new InMemoryRuntimeInteractionStore(),
      hostEpoch: 'route-host',
      now: () => 2000,
      cardPublisher: { publish: async () => cardRef, isLive: async () => true },
    });
    await app.register(runtimeInteractionRoutes, { service });
    pendingResponse = service.request(request);
    void pendingResponse.catch(() => {});
    for (let index = 0; index < 20; index += 1) {
      if ((await service.getForOwner(request.interactionId, 'user-1'))?.status === 'pending') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  afterEach(async () => {
    await service.invalidateInvocation('route-invocation', 'provider_cancelled');
    await app.close();
  });

  it('returns canonical owner-bound state and hides it from another owner', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/runtime-interactions/route-interaction',
    });
    assert.equal(unauthenticated.statusCode, 401);

    const response = await app.inject({
      method: 'GET',
      url: '/api/runtime-interactions/route-interaction',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().interaction.request.provider.requestId, 'rpc-route');
    assert.equal(response.json().interaction.status, 'pending');

    const crossOwner = await app.inject({
      method: 'GET',
      url: '/api/runtime-interactions/route-interaction',
      headers: { 'x-cat-cafe-user': 'user-2' },
    });
    assert.equal(crossOwner.statusCode, 404);
  });

  it('requires strict identity for mutation and resumes the exact waiter once', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/runtime-interactions/route-interaction/respond',
      payload: { cardRef, response: { kind: 'decision', decisionId: 'accept' } },
    });
    assert.equal(unauthenticated.statusCode, 401);

    const answered = await app.inject({
      method: 'POST',
      url: '/api/runtime-interactions/route-interaction/respond',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { cardRef, response: { kind: 'decision', decisionId: 'accept' } },
    });
    assert.equal(answered.statusCode, 200);
    assert.equal(answered.json().interaction.status, 'answered');
    assert.deepEqual(await pendingResponse, { kind: 'decision', decisionId: 'accept' });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/runtime-interactions/route-interaction/respond',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { cardRef, response: { kind: 'decision', decisionId: 'accept' } },
    });
    assert.equal(replay.statusCode, 409);
  });

  it('rejects invalid decisions and copied cards without consuming pending state', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/runtime-interactions/route-interaction/respond',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { cardRef, response: { kind: 'decision', decisionId: 'invented' } },
    });
    assert.equal(invalid.statusCode, 400);

    const copied = await app.inject({
      method: 'POST',
      url: '/api/runtime-interactions/route-interaction/respond',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        cardRef: { ...cardRef, messageId: 'copied-message' },
        response: { kind: 'decision', decisionId: 'accept' },
      },
    });
    assert.equal(copied.statusCode, 404);

    const wrongThread = await app.inject({
      method: 'POST',
      url: '/api/runtime-interactions/route-interaction/respond',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        cardRef: { ...cardRef, threadId: 'thread-copied' },
        response: { kind: 'decision', decisionId: 'accept' },
      },
    });
    assert.equal(wrongThread.statusCode, 404);
    assert.equal((await service.getForOwner(request.interactionId, 'user-1'))?.status, 'pending');
  });
});
