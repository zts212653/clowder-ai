import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  normalizeToolExecutionPolicy,
  toolExecutionPolicyAllowedToolNames,
  toolExecutionPolicyDenial,
} from '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js';
import {
  claimWatcherTicket,
  WATCHER_TOOL_ROUTES,
} from '../dist/domains/cats/services/agents/invocation/WatcherToolTicket.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';

const policy = {
  mode: 'watcher',
  allowedToolNames: ['cat_cafe_read_memory'],
  allowedCallbackRoutes: ['GET /api/callbacks/memory-matters/:matterId'],
  maxToolCalls: 6,
};

test('watcher policy exposes the exact MCP names and accepts registered templates only', () => {
  assert.deepEqual(toolExecutionPolicyAllowedToolNames(normalizeToolExecutionPolicy(policy)), policy.allowedToolNames);
  assert.equal(toolExecutionPolicyDenial(policy, 'GET /api/callbacks/memory-matters/:matterId'), null);
  assert.equal(toolExecutionPolicyDenial(policy, 'cat_cafe_read_memory'), null);
  assert.ok(toolExecutionPolicyDenial(policy, 'POST /api/callbacks/memory-matters/write'));
  assert.ok(toolExecutionPolicyDenial(policy, 'cat_cafe_hold_ball'));
});

test('watcher callback policy uses the matched template rather than a raw path or prefix', async () => {
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'codex61-sol', 'line', undefined, undefined, policy);
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  app.get('/api/callbacks/memory-matters/:matterId', async () => ({ ok: true }));
  app.post('/api/callbacks/memory-matters/write', async () => ({ ok: true }));
  await registry.consumeWatcherToolCall(auth.invocationId, 'read-matter-1', 'cat_cafe_read_memory');
  const headers = {
    'x-invocation-id': auth.invocationId,
    'x-callback-token': auth.callbackToken,
    'x-watcher-tool-call-id': 'read-matter-1',
  };
  assert.equal(
    (await app.inject({ url: '/api/callbacks/memory-matters/matter-1?cursor=next', headers })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/callbacks/memory-matters/write', headers })).statusCode,
    403,
  );
  await app.close();
});

test('a watcher credential never replaces the working cat credential in the same thread', async () => {
  const registry = new InvocationRegistry();
  const work = await registry.create('owner', 'codex61-sol', 'line');
  const watch = await registry.create('owner', 'codex61-sol', 'line', undefined, undefined, policy);
  assert.equal((await registry.verifyLatest(work.invocationId, work.callbackToken)).ok, true);
  assert.equal((await registry.verifyLatest(watch.invocationId, watch.callbackToken)).ok, true);
});

test('one unified read ticket binds exactly one previously allowed callback, never another branch', () => {
  for (const route of WATCHER_TOOL_ROUTES.cat_cafe_read_memory) {
    const ticket = { toolName: 'cat_cafe_read_memory', route: WATCHER_TOOL_ROUTES.cat_cafe_read_memory[0] };
    assert.equal(claimWatcherTicket(ticket, 'POST /api/callbacks/memory-cues/drill', 'request').kind, 'denied');
    assert.equal(claimWatcherTicket(ticket, route, 'request').kind, 'claimed');
    const different = WATCHER_TOOL_ROUTES.cat_cafe_read_memory.find((candidate) => candidate !== route);
    assert.equal(claimWatcherTicket(ticket, different, 'request').kind, 'denied');
    assert.equal(claimWatcherTicket(ticket, route, 'changed-request').kind, 'denied');
    ticket.response = { statusCode: 200, body: 'original receipt' };
    assert.equal(claimWatcherTicket(ticket, route, 'request').kind, 'completed');
  }
});
