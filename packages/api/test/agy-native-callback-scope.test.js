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

test('AGY native callback policy persists only exact callback paths', () => {
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

test('callback allowlists intersect private Work scope on both auth paths, including policy exemptions', async () => {
  const record = {
    invocationId: 'native-private',
    userId: 'owner',
    catId: 'gemini38',
    threadId: 'private-thread',
    collectiveWorkBinding: { taskId: 'private-task' },
    toolExecutionPolicy: {
      mode: 'callback_allowlist',
      allowedCallbackRoutes: ['POST /api/callbacks/post-message', 'GET /api/callbacks/thread-context'],
    },
  };
  for (const prevalidated of [false, true]) {
    const app = Fastify();
    registerCallbackAuthHook(
      app,
      { verify: async () => ({ ok: true, record }) },
      { enforceToolExecutionPolicy: false },
    );
    if (prevalidated)
      app.addHook('preValidation', async (request) => {
        request.callbackAuth = record;
      });
    app.post('/api/callbacks/post-message', async () => ({ allowed: true }));
    app.get('/api/callbacks/thread-context', async () => ({ escaped: true }));
    app.post('/api/callbacks/refresh-token', async () => ({ escaped: true }));
    const headers = { 'x-invocation-id': 'native-private', 'x-callback-token': 'test-token' };
    try {
      const allowed = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers,
        payload: { threadId: 'private-thread', content: 'Current Work progress' },
      });
      assert.equal(allowed.statusCode, 200);
      const outsideThread = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers,
        payload: { threadId: 'unrelated-thread', content: 'Outside Work' },
      });
      assert.equal(outsideThread.statusCode, 403);
      assert.equal(outsideThread.json().reason, 'thread_outside_admitted_work');
      const outsideWork = await app.inject({ method: 'GET', url: '/api/callbacks/thread-context', headers });
      assert.equal(outsideWork.statusCode, 403);
      assert.equal(outsideWork.json().reason, 'tool_outside_admitted_work');
      const outsideAllowlist = await app.inject({ method: 'POST', url: '/api/callbacks/refresh-token', headers });
      assert.equal(outsideAllowlist.statusCode, 403);
      assert.equal(outsideAllowlist.json().reason, 'callback_allowlist_tool_policy');
    } finally {
      await app.close();
    }
  }
});
