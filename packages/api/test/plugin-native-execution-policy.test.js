import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  normalizeToolExecutionPolicy,
  parseToolExecutionPolicy,
  toolExecutionPolicyDenial,
} from '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { pluginNativeActionRoutes } from '../dist/routes/plugin-native-action-routes.js';

const policy = () => ({
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'native',
  actionMethods: ['native.read'],
});
const target = () => ({ instanceId: 'instance', contributionId: 'native', method: 'native.read' });
const route = 'POST /api/plugin-runtime/action';

function admission(id = 'instance') {
  return {
    instance: {
      pluginInstanceId: id,
      packageDigest: 'digest',
      lifecycleRevision: 1,
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      manifest: {
        features: [
          {
            capabilities: [],
            contributions: ['native', 'other'].map((id) => ({ type: 'mcp', id })),
          },
        ],
        contributions: ['native', 'other'].map((id) => ({
          type: 'mcp',
          id,
          actions: [{ method: 'native.read' }, { method: 'native.write' }],
        })),
      },
    },
    effectiveGrants: [],
  };
}

async function fixture(t, options = {}) {
  const app = Fastify();
  t.after(() => app.close());
  const record = {
    invocationId: 'inv',
    callbackToken: 'secret',
    catId: 'codex',
    threadId: 'thread',
    userId: 'owner',
    toolExecutionPolicy: policy(),
  };
  let entered = 0;
  let current = true;
  const verify = async () => (current ? { ok: true, record } : { ok: false, reason: 'invalid_token' });
  const actions = new NativePluginActions(async (id) => {
    await options.beforeAdmission?.(record);
    return admission(id);
  });
  for (const id of ['instance', 'foreign']) {
    actions.activate(admission(id), 0, async () => {
      entered++;
      await options.inHandler?.(record);
      return 'private result';
    });
  }
  await app.register(pluginNativeActionRoutes, {
    actions,
    registry: { verify, verifyLatest: verify, isStartupRecoveryComplete: () => true },
    sources: { messageStore: { getById: async () => null } },
    threadStore: { get: async () => ({ createdBy: 'owner' }) },
  });
  return {
    record,
    actions,
    entered: () => entered,
    expire: () => {
      current = false;
    },
    request: (instanceId = 'instance', contributionId = 'native', method = 'native.read', input = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/plugin-runtime/action',
        headers: {
          'x-invocation-id': 'inv',
          'x-callback-token': 'secret',
          'x-clowder-plugin-action-token': actions.environment(instanceId, contributionId).CLOWDER_PLUGIN_ACTION_TOKEN,
        },
        payload: { method, input },
      }),
  };
}

test('plugin native scope normalizes and survives invocation policy persistence without input aliases', async () => {
  const input = { ...policy(), actionMethods: ['native.write', 'native.read', 'native.read'] };
  const expected = { ...policy(), actionMethods: ['native.read', 'native.write'] };
  assert.deepEqual(normalizeToolExecutionPolicy(input), expected);
  assert.deepEqual(parseToolExecutionPolicy(JSON.stringify(input)), expected);
  const registry = new InvocationRegistry();
  const issued = await registry.create('owner', 'codex', 'thread', undefined, undefined, input);
  input.actionMethods.push('native.admin');
  const verified = await registry.verify(issued.invocationId, issued.callbackToken);
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.record.toolExecutionPolicy, expected);
  for (const invalid of [
    { ...policy(), actionMethods: [] },
    { ...policy(), actionMethods: [42] },
    { ...policy(), contributionId: ' native' },
    { ...policy(), pluginInstanceId: '' },
    { ...policy(), actionMethods: Array(257).fill('native.read') },
    { ...policy(), allowedCallbackRoutes: ['POST /api/callbacks/post-message'] },
  ])
    assert.throws(() => normalizeToolExecutionPolicy(invalid));
});

test('plugin policy admits only the exact Host-resolved native action target', () => {
  assert.equal(toolExecutionPolicyDenial(policy(), route, target()), null);
  for (const candidate of [
    undefined,
    { ...target(), instanceId: 'foreign' },
    { ...target(), contributionId: 'other' },
    { ...target(), method: 'native.write' },
  ]) {
    assert.equal(toolExecutionPolicyDenial(policy(), route, candidate)?.reason, 'plugin_native_tool_policy');
  }
  for (const name of ['POST /api/callbacks/post-message', 'GET /api/plugin-runtime/action', 'native.read']) {
    assert.equal(toolExecutionPolicyDenial(policy(), name, target())?.reason, 'plugin_native_tool_policy');
  }
});

test('real native route checks token-bound instance and contribution, not target claims in tool input', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request()).statusCode, 200);
  for (const args of [
    ['foreign', 'native'],
    ['instance', 'other'],
    ['instance', 'native', 'native.write'],
  ]) {
    const [instanceId, contributionId, method = 'native.read'] = args;
    const response = await f.request(instanceId, contributionId, method, target());
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.equal(f.entered(), 1);
});

test('native target policy is rechecked after awaited admission and after the package result', async (t) => {
  const before = await fixture(t, {
    beforeAdmission: async (record) => {
      record.toolExecutionPolicy = { ...policy(), contributionId: 'other' };
    },
  });
  const denied = await before.request();
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal(before.entered(), 0);
  const after = await fixture(t, {
    inHandler: async (record) => {
      record.toolExecutionPolicy = { ...policy(), actionMethods: ['native.write'] };
    },
  });
  const withheld = await after.request();
  assert.equal(withheld.statusCode, 409, withheld.body);
  assert.equal(withheld.body.includes('private result'), false);
});

test('read-only callback exceptions do not bypass a plugin-native method scope', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let handled = false;
  registerCallbackAuthHook(
    app,
    {
      verify: async () => ({
        ok: true,
        record: {
          invocationId: 'inv',
          callbackToken: 'secret',
          catId: 'codex',
          userId: 'owner',
          threadId: 'thread',
          toolExecutionPolicy: policy(),
        },
      }),
    },
    { enforceToolExecutionPolicy: false },
  );
  app.get('/api/callbacks/read-entrusted-work', async () => {
    handled = true;
    return {};
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/callbacks/read-entrusted-work',
    headers: { 'x-invocation-id': 'inv', 'x-callback-token': 'secret' },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(handled, false);
});

test('an invocation expiring during native admission cannot enter the package handler', async () => {
  let current = true;
  let entered = 0;
  const actions = new NativePluginActions(async () => {
    current = false;
    return admission();
  });
  actions.activate(admission(), 0, async () => {
    entered++;
  });
  const token = actions.environment('instance', 'native').CLOWDER_PLUGIN_ACTION_TOKEN;
  await assert.rejects(
    actions.call(
      token,
      'native.read',
      {},
      {
        catId: 'codex',
        userId: 'owner',
        threadId: 'thread',
        invocationId: 'inv',
        assertCurrent: async () => {
          if (!current) throw new Error('expired invocation');
        },
      },
    ),
    /expired invocation/,
  );
  assert.equal(entered, 0);
});
