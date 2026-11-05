import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  normalizeToolExecutionPolicy,
  parseToolExecutionPolicy,
  toolExecutionPolicyDenial,
} from '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';

test('ordinary Native callbacks share owner authentication without a provider tool shortlist', async () => {
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'gemini38', 'thread');
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  const routes = [
    ['GET', '/api/callbacks/thread-context'],
    ['GET', '/api/callbacks/search-evidence'],
    ['POST', '/api/callbacks/post-message'],
  ];
  for (const [method, url] of routes)
    app.route({
      method,
      url,
      handler: async (request) => ({ catId: request.callbackAuth.catId, threadId: request.callbackAuth.threadId }),
    });
  try {
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url, headers });
      assert.equal(response.statusCode, 200, url);
      assert.deepEqual(response.json(), { catId: 'gemini38', threadId: 'thread' });
      assert.notEqual(
        (await app.inject({ method, url, headers: { ...headers, 'x-callback-token': 'foreign-token' } })).statusCode,
        200,
      );
    }
  } finally {
    await app.close();
  }
});

test('explicit callback policy persists only exact callback paths', () => {
  const policy = { mode: 'callback_allowlist', allowedCallbackRoutes: ['GET /api/callbacks/thread-context'] };
  assert.deepEqual(normalizeToolExecutionPolicy(policy), policy);
  assert.deepEqual(parseToolExecutionPolicy(JSON.stringify(policy)), policy);
  assert.equal(toolExecutionPolicyDenial(policy, 'GET /api/callbacks/thread-context?limit=40'), null);
  for (const path of [
    'POST /api/callbacks/post-message',
    'POST /api/callbacks/thread-context',
    'GET /api/plugin-manager/plugins',
  ]) {
    assert.equal(toolExecutionPolicyDenial(policy, path).reason, 'callback_allowlist_tool_policy');
  }
  for (const path of [
    'GET /api/callbacks/*',
    'GET /api/callbacks/../post-message',
    'GET /api/plugin-manager/plugins',
  ]) {
    assert.throws(() => normalizeToolExecutionPolicy({ ...policy, allowedCallbackRoutes: [path] }), /callback/i);
  }
});

test('a callback-scoped invocation token is denied outside its exact path, including read-policy exemptions', async () => {
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'gemini38', 'thread', undefined, undefined, {
    mode: 'callback_allowlist',
    allowedCallbackRoutes: ['GET /api/callbacks/thread-context'],
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const app = Fastify();
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, registry, { enforceToolExecutionPolicy: false });
    scope.get('/api/callbacks/thread-context', async () => ({ allowed: true }));
    scope.post('/api/callbacks/post-message', async () => ({ escaped: true }));
    scope.get('/api/plugin-manager/plugins', async () => ({ escaped: true }));
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/callbacks/thread-context', headers })).statusCode, 200);
    for (const [method, url] of [
      ['POST', '/api/callbacks/post-message'],
      ['GET', '/api/plugin-manager/plugins'],
    ]) {
      const response = await app.inject({ method, url, headers });
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.json().reason, 'callback_allowlist_tool_policy');
    }
  } finally {
    await app.close();
  }
});
