import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook, requireCallbackAuth } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackRememberRoutes } from '../dist/routes/callback-remember-routes.js';

async function fixture(t) {
  const app = Fastify(),
    registry = new InvocationRegistry(),
    messages = new MessageStore(),
    calls = [];
  t.after(() => app.close());
  const source = messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: 'thread',
    content: '请记下这几件事。',
    mentions: [],
    timestamp: Date.now(),
  });
  const auth = await registry.create('owner', 'codex-astra', 'thread', undefined, undefined, undefined, source.id);
  registerCallbackAuthHook(app, registry);
  for (const [target, path] of Object.entries({
    profile: 'propose-profile-update',
    taste: 'propose-taste',
    person: 'propose-person-memory',
    matter: 'memory-matters/write',
  })) {
    app.post(`/api/callbacks/${path}`, async (request, reply) => {
      const caller = requireCallbackAuth(request, reply);
      if (!caller) return;
      calls.push({ target, body: request.body, owner: caller.userId, source: caller.originTriggerMessageId });
      if (target === 'person') return reply.code(422).send({ error: 'source_not_eligible' });
      if (target === 'matter') return { matterId: 'matter-1', revision: 2, outcome: 'applied' };
      return { proposalId: `${target}-1`, status: 'pending', messageId: `${target}-card` };
    });
  }
  registerCallbackRememberRoutes(app, {
    registry,
    messageStore: messages,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const submit = (payload) => app.inject({ method: 'POST', url: '/api/callbacks/remember', headers, payload });
  return { app, registry, messages, calls, source, auth, submit, headers };
}
const items = ['profile', 'taste', 'person', 'matter'].map((target) => ({
  itemId: target,
  target,
  payload: { marker: target },
}));

test('one request delegates four rows to the existing authenticated routes and preserves each original result', async (t) => {
  const f = await fixture(t);
  const response = await f.submit({ clientRequestId: 'remember-one', items });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.match(result.groupId, /^remember_[a-f0-9]{32}$/);
  assert.deepEqual(
    f.calls.map((c) => c.target),
    ['profile', 'taste', 'person', 'matter'],
  );
  assert.ok(f.calls.every((c) => c.owner === 'owner' && c.source === f.source.id));
  assert.deepEqual(
    result.results.map((r) => r.statusCode),
    [200, 200, 422, 200],
  );
  assert.equal(result.results[0].result.proposalId, 'profile-1');
  assert.equal(result.results[2].result.error, 'source_not_eligible');
  assert.equal(result.results[3].result.matterId, 'matter-1');
  const group = await f.messages.getById(result.messageId);
  assert.equal(group.threadId, 'thread');
  assert.equal(group.extra.rich.blocks[0].meta.memoryGroup.groupId, result.groupId);
  assert.equal(group.extra.rich.blocks[0].meta.memoryGroup.rows[0].proposalId, 'profile-1');
});
test('five rows and duplicate item ids are rejected before any original submit', async (t) => {
  const f = await fixture(t);
  for (const bad of [
    [...items, { ...items[0], itemId: 'fifth' }],
    [items[0], items[0]],
  ]) {
    const response = await f.submit({ clientRequestId: 'invalid', items: bad });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(f.calls.length, 0);
});
test('the thin route does not create another authority or accept an unauthenticated caller', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/remember',
    payload: { clientRequestId: 'no-auth', items },
  });
  assert.equal(response.statusCode, 401, response.body);
  assert.equal(f.calls.length, 0);
});

test('permission to call remember does not bypass the original route allowlist', async (t) => {
  const f = await fixture(t);
  const limited = await f.registry.create(
    'owner',
    'codex-astra',
    'thread',
    undefined,
    undefined,
    { mode: 'callback_allowlist', allowedCallbackRoutes: ['POST /api/callbacks/remember'] },
    f.source.id,
  );
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/remember',
    headers: { 'x-invocation-id': limited.invocationId, 'x-callback-token': limited.callbackToken },
    payload: { clientRequestId: 'limited', items: [items[0]] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().results[0].statusCode, 403);
  assert.equal(response.json().results[0].result.error, 'tool_policy_violation');
  assert.equal(f.calls.length, 0);
});
