import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { createModuleHostInvocation } from '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import {
  InstalledPluginOperations,
  pluginOperationRoutes,
} from '../dist/domains/plugin/operations/plugin-operation-routes.js';
import { readPluginConfig, readPluginOperationState } from '../dist/domains/plugin/plugin-config-store.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';

const pluginId = 'dev.clowder.owner-operation';
const instanceId = 'owner-operation-instance';
const owner = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'operation-owner';
const validResult = () => ({ render: 'status', data: { checked: true } });

// Authentication and inventory persistence are explicit in-memory seams. Route declaration
// resolution and the module action call are production implementations, not success substitutes.
async function fixture(
  t,
  handler,
  { timeoutMs = 1000, beforeStateRead, disk = false, beforeCommit, cookieAuth = false } = {},
) {
  const instance = {
    pluginId,
    pluginInstanceId: instanceId,
    packageDigest: 'sha512-owner-operation-fixture',
    lifecycleState: 'installed',
    activationState: 'enabled',
    runtimeState: 'healthy',
    configReadiness: 'ready',
    lifecycleRevision: 1,
    installedAt: 1,
    updatedAt: 1,
  };
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Owner operation fixture',
    configuration: [
      { key: 'recoveryToken', kind: 'text', label: 'Token', required: false },
      {
        key: 'recovery',
        kind: 'operation',
        label: 'Recovery',
        required: false,
        target: ['recoveryToken'],
        actions: [{ id: 'reconcile', label: 'Reconcile', render: 'row', action: { method: 'recovery.reconcile' } }],
      },
    ],
    features: [{ id: 'main', name: 'Main', capabilities: [], contributions: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  };
  const records = [];
  const writes = [];
  const grant = { pluginInstanceId: instanceId, grantRevision: 1 };
  const activation = new AbortController();
  let authenticatedSessionCurrent = true;
  const actions = {
    'recovery.reconcile': async (input, native, context) => {
      records.push({ input, native, context });
      return handler({ input, native, context, instance, invocation });
    },
  };
  const invocation = createModuleHostInvocation({
    runtime: {
      actions: (id) => (id === instanceId && !activation.signal.aborted ? actions : undefined),
      operationActivationSignal: () => activation.signal,
    },
  });
  const packageRecord = { packageDigest: instance.packageDigest, pluginId, manifest, packageState: 'installed' };
  const inventory = {
    snapshot: async () => ({
      schemaVersion: 1,
      instances: [structuredClone(instance)],
      grants: [structuredClone(grant)],
      packages: [structuredClone(packageRecord)],
    }),
    transaction: async (work) => {
      // Delay happens before the synchronous production storage callback, like a queued lock.
      await beforeCommit?.({ instance, grant });
      return work({
        instances: { getCurrent: () => structuredClone(instance), put: (next) => Object.assign(instance, next) },
        packages: { get: () => structuredClone(packageRecord) },
        grants: { get: () => structuredClone(grant) },
      });
    },
  };
  let projectRoot;
  if (disk) {
    projectRoot = await mkdtemp(join(tmpdir(), 'owner-operation-store-'));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
  }
  const operations = new InstalledPluginOperations({
    inventory,
    configuration: disk
      ? new HostPluginConfigurationService({
          projectRoot,
          inventory,
          lifecycle: {
            async runWithRuntimeSuspended({ preflight, operation }) {
              await preflight();
              instance.runtimeState = 'stopped';
              try {
                await operation(structuredClone(instance));
              } finally {
                instance.runtimeState = 'healthy';
              }
            },
          },
        })
      : {
          readActionInput: async () => ({}),
          readOperationState: async () => {
            await beforeStateRead?.(instance);
            return undefined;
          },
          writeOperationState: async (...args) => {
            writes.push(args);
          },
          clearOperationState: async () => {},
          configureOperationTargets: async () => {
            throw Error('Unexpected target write');
          },
        },
    invocation,
    timeoutMs,
  });
  const app = Fastify();
  t.after(() => app.close());
  let sessionCookie;
  if (cookieAuth) {
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: owner });
  } else {
    app.decorateRequest('sessionUserId', undefined);
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-test-auth'] === 'authenticated') request.sessionUserId = owner;
      request.assertSessionCurrent = () => {
        if (!authenticatedSessionCurrent) throw Error('Test session expired');
      };
    });
  }
  await app.register(pluginOperationRoutes, { operations });
  if (cookieAuth) {
    const established = await app.inject({
      method: 'GET',
      url: '/api/session',
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost:5173' },
    });
    assert.equal(established.statusCode, 200);
    sessionCookie = established.headers['set-cookie'].split(';')[0];
  }
  return {
    instance,
    grant,
    activation,
    records,
    writes,
    invocation,
    operations,
    projectRoot,
    revokeSession: () => {
      authenticatedSessionCurrent = false;
    },
    call: ({ authenticated = true, payload = { operationId: 'held-1', userId: 'forged-owner' } } = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/recovery/reconcile`,
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          ...(authenticated ? (cookieAuth ? { cookie: sessionCookie } : { 'x-test-auth': 'authenticated' }) : {}),
        },
        payload,
      }),
  };
}

test('owner operation rejects an unauthenticated request before module entry', async (t) => {
  const f = await fixture(t, validResult);
  const response = await f.call({ authenticated: false });
  assert.equal(response.statusCode, 401, response.payload);
  assert.equal(f.records.length, 0);
  assert.equal(f.writes.length, 0);
});

test('ordinary module invocation does not mint an owner operation context', async (t) => {
  const f = await fixture(t, validResult);
  await f.invocation.invoke(instanceId, 'recovery.reconcile', { input: { userId: owner } });
  assert.equal(f.records[0].native, undefined);
  assert.equal(f.records[0].context, undefined);
});

test('authenticated Manager action supplies exact owner tuple independently of input identity', async (t) => {
  let current = false;
  const f = await fixture(t, async ({ context }) => {
    if (context) {
      await context.assertCurrent();
      current = true;
    }
    return validResult();
  });
  const response = await f.call();
  assert.equal(response.statusCode, 200, response.payload);
  const { input, native, context } = f.records[0];
  assert.ok(context, 'Host owner operation context missing');
  assert.equal(current, true);
  assert.equal(input.input.userId, 'forged-owner');
  assert.equal(native, undefined);
  assert.equal(context.kind, 'owner-operation');
  assert.equal(context.userId, owner);
  assert.equal(context.pluginInstanceId, instanceId);
  assert.equal(context.operationKey, 'recovery');
  assert.equal(context.actionId, 'reconcile');
  assert.equal(typeof context.requestId, 'string');
  assert.ok(context.requestId.length > 0);
  assert.equal(Object.isFrozen(context), true);
});

test('completed Manager action invalidates its saved owner authority', async (t) => {
  const f = await fixture(t, validResult);
  assert.equal((await f.call()).statusCode, 200);
  const context = f.records[0].context;
  assert.ok(context, 'Host owner operation context missing');
  assert.equal(context.signal.aborted, true);
  await assert.rejects(() => context.assertCurrent());
});

test('Manager timeout invalidates owner authority while the module promise is unfinished', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    t,
    async () => {
      await pending;
      return validResult();
    },
    { timeoutMs: 20 },
  );
  try {
    assert.equal((await f.call()).statusCode, 504);
    const context = f.records[0].context;
    assert.ok(context, 'Host owner operation context missing');
    assert.equal(context.signal.aborted, true);
    await assert.rejects(() => context.assertCurrent());
    assert.equal(f.writes.length, 0);
  } finally {
    release();
  }
});

test('late module result cannot write operation state after lifecycle changes', async (t) => {
  const f = await fixture(t, async ({ instance }) => {
    instance.lifecycleRevision += 1;
    instance.activationState = 'disabled';
    return validResult();
  });
  await f.call();
  assert.equal(f.writes.length, 0, 'Stale module result wrote Host operation state');
});

test('lifecycle change during state preparation fences the final operation write', async (t) => {
  const f = await fixture(t, validResult, {
    beforeStateRead: async (instance) => {
      instance.lifecycleRevision += 1;
      instance.activationState = 'disabled';
    },
  });
  await f.call();
  assert.equal(f.writes.length, 0, 'Expired request preparation wrote Host operation state');
});

test('a nested ordinary invoke cannot inherit the Manager owner context', async (t) => {
  const f = await fixture(t, async ({ input, context, invocation }) => {
    if (input.input.nested) {
      assert.equal(context, undefined);
    } else {
      assert.ok(context);
      await invocation.invoke(instanceId, 'recovery.reconcile', { input: { nested: true } });
      await context.assertCurrent();
    }
    return validResult();
  });
  assert.equal((await f.call()).statusCode, 200);
  assert.equal(f.records.length, 2);
});

test('grant revision changes invalidate the live context and prevent state commit', async (t) => {
  let f;
  f = await fixture(t, async ({ context }) => {
    f.grant.grantRevision += 1;
    await assert.rejects(() => context.assertCurrent());
    return validResult();
  });
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.writes.length, 0);
});

test('stopped activation aborts the context and fences a late result', async (t) => {
  let f;
  f = await fixture(t, async ({ context }) => {
    f.activation.abort();
    assert.equal(context.signal.aborted, true);
    await assert.rejects(() => context.assertCurrent());
    return validResult();
  });
  const response = await f.call();
  assert.notEqual(response.statusCode, 200);
  assert.equal(f.writes.length, 0);
});

test('session invalidation after module entry prevents operation state commit', async (t) => {
  let f;
  f = await fixture(t, async ({ context }) => {
    f.revokeSession();
    await assert.rejects(() => context.assertCurrent());
    return validResult();
  });
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.writes.length, 0);
});

test('handler failure expires its context and never writes state', async (t) => {
  const f = await fixture(t, async () => {
    throw Error('Module rejected recovery');
  });
  assert.equal((await f.call()).statusCode, 502);
  const context = f.records[0].context;
  assert.equal(context.signal.aborted, true);
  await assert.rejects(() => context.assertCurrent());
  assert.equal(f.writes.length, 0);
});

test('direct runAction without route admission cannot acquire owner authority', async (t) => {
  const f = await fixture(t, ({ context }) => {
    assert.equal(context, undefined);
    return validResult();
  });
  const result = await f.operations.runAction(pluginId, 'recovery', 'reconcile', { userId: owner });
  assert.equal(result.status, 200);
  assert.equal(f.records[0].context, undefined);
});

test('current owner result persists target values and operation state in real config storage', async (t) => {
  const f = await fixture(t, () => ({ ...validResult(), targetValues: { recoveryToken: 'accepted' } }), { disk: true });
  const response = await f.call();
  assert.equal(response.statusCode, 200, response.payload);
  assert.equal(readPluginConfig(f.projectRoot, pluginId).recoveryToken, 'accepted');
  assert.equal(response.json().data.checked, true);
  assert.equal(readPluginOperationState(f.projectRoot, pluginId, 'recovery').lastResult, undefined);
});

for (const edge of ['target', 'state']) {
  test(`revocation while waiting for the ${edge} transaction leaves real storage untouched`, async (t) => {
    const f = await fixture(
      t,
      () => ({ ...validResult(), ...(edge === 'target' ? { targetValues: { recoveryToken: 'stale' } } : {}) }),
      {
        disk: true,
        beforeCommit: async ({ grant }) => {
          grant.grantRevision += 1;
        },
      },
    );
    const response = await f.call();
    assert.equal(response.statusCode, 409, response.payload);
    assert.deepEqual(readPluginConfig(f.projectRoot, pluginId), {});
    assert.equal(readPluginOperationState(f.projectRoot, pluginId, 'recovery'), undefined);
  });
}

test('timeout while waiting for storage cannot commit after the transaction is released', async (t) => {
  let release;
  let committed;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const finished = new Promise((resolve) => {
    committed = resolve;
  });
  const f = await fixture(t, validResult, {
    disk: true,
    timeoutMs: 30,
    beforeCommit: async () => {
      await pending;
      setImmediate(committed);
    },
  });
  try {
    assert.equal((await f.call()).statusCode, 504);
  } finally {
    release();
  }
  await finished;
  assert.deepEqual(readPluginConfig(f.projectRoot, pluginId), {});
  assert.equal(readPluginOperationState(f.projectRoot, pluginId, 'recovery'), undefined);
});

test('real cookie bootstrap and session authentication supply Manager owner authority', async (t) => {
  const f = await fixture(
    t,
    async ({ context }) => {
      assert.equal(context.userId, owner);
      await context.assertCurrent();
      return validResult();
    },
    { cookieAuth: true },
  );
  const response = await f.call();
  assert.equal(response.statusCode, 200, response.payload);
  assert.equal(f.records.length, 1);
  assert.equal((await f.call({ authenticated: false })).statusCode, 401);
});
