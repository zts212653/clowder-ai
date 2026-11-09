import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createModuleHostInvocation } from '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';

async function fixture(t, hooks = {}) {
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  const record = {
    invocationId: 'direct-inv',
    callbackToken: 'fixture-token',
    threadId: 'outside-thread',
    catId: 'codex-sol',
    userId: owner,
    ownerAuthProvenance: 'unknown',
    originTriggerMessageId: 'request-message',
    clientMessageIds: new Set(),
    createdAt: Date.now(),
    expiresAt: null,
    state: 'active',
  };
  const manifest = {
    pluginId: 'dev.clowder.direct-caller',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Fixture',
    runtime: { transport: 'builtin' },
    features: [{ id: 'main', name: 'Main', resources: [], contributions: [{ type: 'tool', id: 'prepare' }] }],
    contributions: [
      {
        type: 'tool',
        id: 'prepare',
        name: 'prepare_material',
        inputSchema: { type: 'object' },
        action: { method: 'example.prepare' },
      },
    ],
  };
  const instance = {
    pluginInstanceId: 'direct-instance',
    pluginId: manifest.pluginId,
    packageDigest: 'fixture-digest',
    lifecycleRevision: 1,
    activationState: 'enabled',
    lifecycleState: 'installed',
    configReadiness: 'ready',
  };
  const packageRecord = {
    pluginId: manifest.pluginId,
    packageDigest: instance.packageDigest,
    packageState: 'installed',
    manifest,
  };
  let valid = true,
    deleted = false,
    entered = 0,
    effects = 0,
    captured;
  const verify = async (id, token) =>
    valid && id === record.invocationId && token === record.callbackToken
      ? { ok: true, record }
      : { ok: false, reason: 'invalid_token' };
  const router = new PluginRuntimeCarrierRouter({
    snapshot: async () => ({ instances: [instance], packages: [packageRecord] }),
    readAuthority: async (id) =>
      id === instance.pluginInstanceId ? { instance, current: instance, packageRecord } : undefined,
    readCurrentAuthority: async (pluginId) =>
      pluginId === instance.pluginId ? { instance, current: instance, packageRecord } : undefined,
  });
  const controls = {
    record,
    instance,
    expire: () => {
      valid = false;
    },
    deleteThread: () => {
      deleted = true;
    },
    stop: () => router.stop(instance.pluginInstanceId, 'test'),
    restart: () => router.start(instance.pluginInstanceId),
  };
  const actions = {
    'example.prepare': async (input, caller) => {
      entered++;
      captured = caller;
      await hooks.beforeEffect?.(controls);
      if (caller) await caller.assertCurrent();
      else if (!hooks.allowHuman) throw new Error('outside_operator_identity_required');
      effects++;
      await hooks.afterEffect?.(controls);
      return { artifact: 'private-material-reference', input };
    },
  };
  const module = createModuleHostInvocation({ runtime: { actions: () => actions } });
  router.register({
    claims: () => true,
    start: async () => {},
    stop: async () => {},
    stopAll: async () => {},
    invoke: module.invoke,
  });
  await router.start(instance.pluginInstanceId);
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-owner']) request.sessionUserId = owner;
  });
  registerPluginManagerRoutes(app, {
    manager: {},
    contributions: router,
    callbackRegistry: { verify, ...(hooks.noLatest ? {} : { verifyLatest: verify }) },
    threadStore: { get: async () => ({ deletedAt: deleted ? 1 : null }) },
    auditLog: { append: async () => hooks.audit?.(controls) },
  });
  t.after(async () => {
    await app.close();
    await router.stopAll('test_cleanup');
  });
  const headers = {
    host: 'localhost:3004',
    origin: 'http://localhost:3004',
    'x-invocation-id': record.invocationId,
    'x-callback-token': record.callbackToken,
  };
  return {
    ...controls,
    entered: () => entered,
    effects: () => effects,
    captured: () => captured,
    call: (human = false) =>
      app.inject({
        method: 'POST',
        url: `/api/plugin-manager/plugins/${manifest.pluginId}/contributions/call`,
        headers: human ? { host: 'localhost:3004', origin: 'http://localhost:3004', 'x-test-owner': 'true' } : headers,
        payload: {
          contributionId: 'prepare',
          toolName: 'prepare_material',
          arguments: { claimedIdentity: { catId: 'spoof', threadId: 'spoof' } },
        },
      }),
  };
}

test('declared direct tool carries the verified caller through Router into the actual Module Host', async (t) => {
  const f = await fixture(t);
  const result = await f.call();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(f.effects(), 1);
  const caller = f.captured();
  assert.equal(caller.catId, 'codex-sol');
  assert.equal(caller.threadId, 'outside-thread');
  assert.equal(caller.originTriggerMessageId, 'request-message');
  assert.equal(caller.ownerAuthProvenance, 'unknown');
  assert.equal(caller.nativeAction, undefined, 'a direct call cannot mint native-token authority');
  assert.equal(caller.callbackToken, undefined);
  assert.equal(Object.isFrozen(caller), true);
  await assert.rejects(caller.assertCurrent(), /current/);
});

test('revocation during audit prevents the direct tool from entering the package', async (t) => {
  const f = await fixture(t, { audit: ({ expire }) => expire() });
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.entered(), 0);
});

test('a direct tool cannot act after its authenticated identity changes across an await', async (t) => {
  const f = await fixture(t, {
    beforeEffect: ({ record }) => {
      record.threadId = 'other-thread';
    },
  });
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.effects(), 0);
});

test('revocation after handler completion withholds its private result', async (t) => {
  const f = await fixture(t, { afterEffect: ({ expire }) => expire() });
  const result = await f.call();
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.includes('private-material-reference'), false);
  assert.equal(f.effects(), 1);
});

test('same-instance stop/restart cannot revive an old direct call', async (t) => {
  const f = await fixture(t, {
    beforeEffect: async ({ stop, restart }) => {
      await stop();
      await restart();
    },
  });
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.effects(), 0);
});

test('inventory revocation is checked before the direct tool applies a material', async (t) => {
  const f = await fixture(t, {
    beforeEffect: ({ instance }) => {
      instance.activationState = 'disabled';
    },
  });
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.effects(), 0);
});

test('an authenticated direct tool refuses a registry without uncached currentness', async (t) => {
  const f = await fixture(t, { noLatest: true });
  assert.equal((await f.call()).statusCode, 503);
  assert.equal(f.entered(), 0);
});

test('deleting the outside thread during audit prevents package entry', async (t) => {
  const f = await fixture(t, { audit: ({ deleteThread }) => deleteThread() });
  assert.equal((await f.call()).statusCode, 410);
  assert.equal(f.entered(), 0);
});

test('human direct calls still have no fabricated cat identity', async (t) => {
  const f = await fixture(t, { allowHuman: true });
  assert.equal((await f.call(true)).statusCode, 200);
  assert.equal(f.captured(), undefined);
});
