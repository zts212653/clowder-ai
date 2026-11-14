import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerCallbackMemoryCueRoutes } from '../../dist/routes/callback-memory-cue-routes.js';

test('prepare is an authenticated Host event with strict activity/query input and unknown delivery', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const principal = {
    invocationId: 'inv',
    userId: 'owner',
    threadId: 'thread',
    catId: 'codex61-sol',
    originTriggerMessageId: 'trigger',
  };
  const calls = [];
  app.addHook('preHandler', async (request) => {
    if (request.headers.authorization === 'test') request.callbackAuth = principal;
  });
  registerCallbackMemoryCueRoutes(app, {
    now: () => 1234,
    preparation: {
      async prepare(input) {
        calls.push(input);
        return { status: 'ok', delivery: 'unknown', pointers: [] };
      },
    },
  });
  const request = {
    method: 'POST',
    url: '/api/callbacks/memory-cues/prepare',
    headers: { authorization: 'test' },
    payload: { activity: 'video', query: 'the paper we just read' },
  };
  assert.equal((await app.inject({ ...request, headers: {} })).statusCode, 401);
  for (const bad of [
    { activity: 'other', query: 'x' },
    { activity: 'html', query: '' },
    { ...request.payload, scope: { ownerUserId: 'forged' } },
  ]) {
    assert.equal((await app.inject({ ...request, payload: bad })).statusCode, 400);
  }
  const response = await app.inject(request);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().delivery, 'unknown');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.deepEqual(call.auth, principal);
  assert.equal(call.receivedAt, 1234);
  assert.equal(call.activity, 'video');
});
