import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OFFICIAL_PLUGIN_CATALOG,
} from '../dist/domains/plugin/index.js';
import { registerOfficialPluginRoutes } from '../dist/routes/plugin-official-routes.js';

const entry = OFFICIAL_PLUGIN_CATALOG[0];

function manifest(overrides = {}) {
  return {
    pluginId: entry.pluginId,
    version: entry.version,
    contractVersion: '0.1.0',
    name: 'Feishu Meeting Intake',
    features: [{ id: 'source', name: 'Source', resources: [], capabilities: ['events.publish'] }],
    runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
    ...overrides,
  };
}

async function harness(options = {}) {
  let now = 1_000;
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => now++,
  });
  const installedVersion = options.installedVersion ?? entry.version;
  const installedDigest = options.installedDigest ?? entry.packageDigest;
  const installed = await inventory.installPackage({
    manifest: manifest({ version: installedVersion }),
    computedPackageDigest: installedDigest,
    expectedPackageDigest: installedDigest,
    packagePluginId: entry.pluginId,
    effectiveGrants: ['events.publish'],
  });
  const processCalls = [];
  const lifecycle = new ExternalPluginLifecycleService({
    store,
    now: () => now++,
    supervisor: {
      start: async (instanceId) => processCalls.push(`start:${instanceId}`),
      stop: async (instanceId) => processCalls.push(`stop:${instanceId}`),
    },
  });
  const app = Fastify();
  const updateCalls = [];
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  registerOfficialPluginRoutes(app, {
    catalog: options.catalog ?? OFFICIAL_PLUGIN_CATALOG,
    inventory: store,
    lifecycle,
    installer: {
      install: async () => installed,
      update: async (catalogId, instanceId, expectedRevision) => {
        updateCalls.push({ catalogId, instanceId, expectedRevision });
        return inventory.upgradePackage({
          pluginInstanceId: instanceId,
          expectedLifecycleRevision: expectedRevision,
          expectedGrantRevision: 1,
          manifest: manifest(),
          computedPackageDigest: entry.packageDigest,
          expectedPackageDigest: entry.packageDigest,
          packagePluginId: entry.pluginId,
          effectiveGrants: ['events.publish'],
        });
      },
    },
    ...(options.auth === undefined ? {} : { auth: options.auth }),
  });
  await app.ready();
  return { app, store, processCalls, updateCalls };
}

const ownerUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
const readHeaders = { 'x-test-session-user': ownerUserId };
const writeHeaders = {
  host: 'localhost:3004',
  origin: 'http://localhost:5173',
  'x-test-session-user': ownerUserId,
};

test('pins the runnable alpha.3 artifact and activates its package-owned owner auth contract', () => {
  assert.equal(entry.version, '0.1.0-alpha.3');
  assert.equal(
    entry.archiveUrl,
    'https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-0.1.0-alpha.3.tgz',
  );
  assert.equal(
    entry.packageDigest,
    'sha512-cIrmZGup33W/L0XP9Q6b/OxgNR2oC5lCs1EAc3FcXhfQSJLDw3e/9di1vOGQZwN1Fm19Q0gMXKCxT1rg6WDNBg==',
  );
  assert.deepEqual(entry.ownerAuth, {
    kind: 'lark-cli-device',
    runnerPath: 'node_modules/@larksuite/cli/scripts/run.js',
    domains: ['event', 'minutes', 'note', 'vc'],
  });
});

test('projects exact official catalog and durable installed state only to authenticated sessions', async () => {
  const { app, store } = await harness();
  try {
    await store.transaction((transaction) => {
      const instance = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...instance,
        lastRuntimeError: {
          code: 'EVENT_BUS_CONFLICT',
          exitCode: 17,
          signal: null,
          occurredAt: 1_234,
        },
      });
    });
    assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/official' })).statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json();
    assert.equal(body.plugins[0].catalogId, 'feishu-meeting-intake');
    assert.equal(body.plugins[0].version, '0.1.0-alpha.3');
    assert.equal(body.plugins[0].availableVersion, '0.1.0-alpha.3');
    assert.equal(body.plugins[0].packageDigest, entry.packageDigest);
    assert.equal(body.plugins[0].updateAvailable, false);
    assert.equal(body.plugins[0].ownerAuthAvailable, true);
    assert.equal(body.plugins[0].instance.lifecycleRevision, 1);
    assert.equal(body.plugins[0].instance.installedVersion, '0.1.0-alpha.3');
    assert.equal(body.plugins[0].instance.packageDigest, entry.packageDigest);
    assert.equal(body.plugins[0].instance.runtimeState, 'stopped');
    assert.deepEqual(body.plugins[0].instance.lastRuntimeError, {
      code: 'EVENT_BUS_CONFLICT',
      exitCode: 17,
      signal: null,
      occurredAt: 1_234,
    });
  } finally {
    await app.close();
  }
});

test('projects installed versus available truth and explicitly updates without starting', async () => {
  const oldDigest = 'sha512-pLYTYEdGdAXrWBlKrLcUtrTJ6mszT6dmHpBDFOFLuPh1qkJAqwQ+S/xT/ORvjislG6jAgrzmYWnzlZMa778iEA==';
  const { app, processCalls, updateCalls } = await harness({
    installedVersion: '0.1.0-alpha.2',
    installedDigest: oldDigest,
  });
  try {
    const before = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(before.statusCode, 200, before.payload);
    assert.equal(before.json().plugins[0].availableVersion, '0.1.0-alpha.3');
    assert.equal(before.json().plugins[0].updateAvailable, true);
    assert.equal(before.json().plugins[0].instance.installedVersion, '0.1.0-alpha.2');
    assert.equal(before.json().plugins[0].instance.packageDigest, oldDigest);

    const updated = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/update',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1 },
    });
    assert.equal(updated.statusCode, 200, updated.payload);
    assert.deepEqual(updateCalls, [
      { catalogId: 'feishu-meeting-intake', instanceId: 'pi_official', expectedRevision: 1 },
    ]);
    assert.equal(updated.json().updateAvailable, false);
    assert.equal(updated.json().instance.installedVersion, '0.1.0-alpha.3');
    assert.equal(updated.json().instance.packageDigest, entry.packageDigest);
    assert.equal(updated.json().instance.activationState, 'disabled');
    assert.equal(updated.json().instance.runtimeState, 'stopped');
    assert.deepEqual(processCalls, []);
  } finally {
    await app.close();
  }
});

test('official plugin auth action is owner-only and gates enable until user OAuth completes', async () => {
  const authEntry = {
    ...entry,
    ownerAuth: {
      kind: 'lark-cli-device',
      runnerPath: 'node_modules/@larksuite/cli/scripts/run.js',
      domains: ['event', 'minutes', 'note', 'vc'],
    },
  };
  let authStatus = 'not_connected';
  const auth = {
    status: async () => ({ status: authStatus }),
    start: async () => ({
      status: 'waiting',
      verificationUrl: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=opaque&user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      qrDataUrl: 'data:image/png;base64,qr',
    }),
  };
  const { app, processCalls } = await harness({ catalog: [authEntry], auth });
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/plugins/official/pi_official/auth' });
    assert.equal(unauthenticated.statusCode, 401);

    const initial = await app.inject({
      method: 'GET',
      url: '/api/plugins/official/pi_official/auth',
      headers: readHeaders,
    });
    assert.equal(initial.statusCode, 200, initial.payload);
    assert.deepEqual(initial.json(), { status: 'not_connected' });

    const remoteStart = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/auth/start',
      headers: writeHeaders,
      remoteAddress: '203.0.113.10',
    });
    assert.equal(remoteStart.statusCode, 403);

    const started = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/auth/start',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(started.statusCode, 200, started.payload);
    assert.equal(started.json().status, 'waiting');
    assert.equal(started.json().userCode, 'ABCD-EFGH');
    assert.equal('deviceCode' in started.json(), false);

    const installed = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(installed.statusCode, 200, installed.payload);

    const blockedEnable = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/enable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(blockedEnable.statusCode, 409, blockedEnable.payload);
    assert.equal(blockedEnable.json().code, 'AUTH_REQUIRED');
    assert.deepEqual(processCalls, []);

    authStatus = 'connected';
    const enabled = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/enable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.deepEqual(processCalls, ['start:pi_official']);
  } finally {
    await app.close();
  }
});

test('install prepares but does not start; only explicit fenced enable starts the runtime', async () => {
  const { app, processCalls } = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('auth start is not expected after a verified login');
      },
    },
  });
  try {
    const installed = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(installed.statusCode, 200, installed.payload);
    assert.equal(installed.json().instance.configReadiness, 'ready');
    assert.equal(installed.json().instance.activationState, 'disabled');
    assert.deepEqual(processCalls, []);

    const enabled = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/enable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.equal(enabled.json().instance.activationState, 'enabled');
    assert.deepEqual(processCalls, ['start:pi_official']);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/disable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(stale.statusCode, 409, stale.payload);
    assert.deepEqual(processCalls, ['start:pi_official']);
  } finally {
    await app.close();
  }
});

test('official plugin mutations require direct localhost owner access', async () => {
  const { app } = await harness();
  try {
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(noSession.statusCode, 401);

    const remote = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: writeHeaders,
      remoteAddress: '203.0.113.10',
    });
    assert.equal(remote.statusCode, 403);
  } finally {
    await app.close();
  }
});
