import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { registerCallbackDevelopmentReturnRoutes } from '../../src/routes/callback-development-return-routes.js';

test('return callback derives all owner coordinates from invocation auth and rejects mixed actions', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const registry = new InvocationRegistry();
  const auth = await registry.create('human', 'codex-sol', 'original');
  const seen: unknown[] = [];
  await registerCallbackDevelopmentReturnRoutes(app, {
    registry,
    service: {
      readForActor(actor) {
        seen.push(actor);
        return [];
      },
      async register() {
        throw new Error('wrong action');
      },
      async report() {
        throw new Error('wrong action');
      },
    },
  });
  const url = '/api/callbacks/development-return';
  assert.equal((await app.inject({ method: 'POST', url, payload: { action: 'read' } })).statusCode, 401);
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { action: 'read' } })).statusCode, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].threadId, 'original');
  for (const payload of [
    { action: 'read', ownerCatId: 'other' },
    { action: 'read', taskId: 'secret' },
    { action: 'report' },
  ]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 400);
  }
});
