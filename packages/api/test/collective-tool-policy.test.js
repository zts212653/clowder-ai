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
import { registerCollectiveParticipationCallbacks } from '../dist/routes/callback-collective-participation-routes.js';

const policy = { mode: 'collective_participation' };
const source = {
  serviceInstanceId: 'svc_100000000000',
  collectiveId: 'col_100000000000',
  connectionId: 'con_100000000000',
  eventId: 'evt_100000000000',
  location: { channelId: 'A' },
  catId: 'codex-astra',
  participationRevision: 1,
  actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
};
const grant = { kind: 'collective-participation', originTriggerMessageId: 'msg_1', source };

test('public participation exposes exactly current-context/read/reply and no owner callbacks', () => {
  assert.deepEqual(normalizeToolExecutionPolicy(policy), policy);
  assert.deepEqual(parseToolExecutionPolicy(JSON.stringify(policy)), policy);
  for (const tool of ['collective_current_context', 'collective_read_context', 'collective_reply']) {
    assert.equal(toolExecutionPolicyDenial(policy, `cat_cafe_${tool}`), null);
    assert.equal(toolExecutionPolicyDenial(policy, `/api/callbacks/${tool.replaceAll('_', '-')}`), null);
  }
  for (const tool of [
    'post_message',
    'collective_connector',
    'create_task',
    'search_evidence',
    'hold_ball',
    'get_thread_context',
    'update_task',
    'limb_invoke_tool',
  ]) {
    assert.equal(toolExecutionPolicyDenial(policy, tool).reason, 'collective_participation_tool_policy');
  }
});

test('invocation admission binds the grant to exact source/cat and forbids owner escalation', async () => {
  const registry = new InvocationRegistry();
  const create = (overrides = {}) =>
    registry.create(
      'owner',
      overrides.catId ?? 'codex-astra',
      'thread',
      undefined,
      undefined,
      policy,
      overrides.messageId ?? 'msg_1',
      overrides.provenance ?? 'unknown',
      undefined,
      grant,
    );
  const auth = await create();
  assert.deepEqual((await registry.verify(auth.invocationId, auth.callbackToken)).record.executionGrant, grant);
  await assert.rejects(create({ provenance: 'strict' }), /owner/i);
  await assert.rejects(create({ catId: 'opus' }), /source/i);
  await assert.rejects(create({ messageId: 'msg_other' }), /source/i);
  await assert.rejects(registry.create('owner', 'codex-astra', 'thread', undefined, undefined, policy), /grant/i);
});

test('real callback authentication accepts the public tools but rejects owner actions and caller-selected coordinates', async () => {
  const registry = new InvocationRegistry();
  const auth = await registry.create(
    'owner',
    source.catId,
    'thread',
    undefined,
    undefined,
    policy,
    'msg_1',
    'unknown',
    undefined,
    grant,
  );
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const calls = [];
  const context = {
    async current(record) {
      calls.push(record);
      return { kind: 'collective' };
    },
    async read(record, ...args) {
      calls.push(record);
      return { page: args };
    },
    async reply(record, ...args) {
      calls.push(record);
      return { submitted: args };
    },
  };
  const app = Fastify();
  await registerCollectiveParticipationCallbacks(app, { registry, context });
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, registry);
    scope.post('/api/callbacks/create-task', async () => {
      throw new Error('PUBLIC_OWNER_ESCALATION');
    });
  });
  try {
    const post = (name, payload, credentials = headers) =>
      app.inject({ method: 'POST', url: `/api/callbacks/${name}`, headers: credentials, payload });
    assert.equal((await post('collective-current-context', {}, {})).statusCode, 401);
    assert.equal(
      (await post('collective-current-context', {}, { ...headers, 'x-callback-token': 'forged' })).statusCode,
      401,
    );
    for (const payload of [
      { connectionId: 'another' },
      { sourceEventId: 'another' },
      { ownerAuthProvenance: 'strict' },
    ]) {
      assert.equal((await post('collective-current-context', payload)).statusCode, 400);
    }
    assert.equal((await post('create-task', { title: 'owner-only attack' })).statusCode, 403);
    assert.equal(calls.length, 0);
    assert.equal((await post('collective-current-context', {})).statusCode, 200);
    assert.equal((await post('collective-read-context', { contextRef: 'opaque', limit: 10 })).statusCode, 200);
    assert.equal(
      (await post('collective-reply', { returnRef: 'opaque', replyOperationRef: 'opaque-op', body: 'named reply' }))
        .statusCode,
      200,
    );
    assert.equal(calls.length, 3);
    for (const record of calls) {
      assert.deepEqual(record.executionGrant, grant);
      assert.equal(record.ownerAuthProvenance, 'unknown');
    }
    assert.equal(
      (
        await post('collective-reply', {
          returnRef: 'opaque',
          replyOperationRef: 'opaque-op',
          body: 'named reply',
          clientEventId: 'model-chosen',
        })
      ).statusCode,
      400,
    );
    assert.equal((await post('collective-read-context', { contextRef: 'opaque', limit: 101 })).statusCode, 400);
    assert.equal(calls.length, 3);
  } finally {
    await app.close();
  }
});
