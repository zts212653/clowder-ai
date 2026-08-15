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

function manifest() {
  return {
    pluginId: entry.pluginId,
    version: entry.version,
    contractVersion: '0.1.0',
    name: 'Feishu Meeting Intake',
    features: [{ id: 'source', name: 'Source', resources: [], capabilities: ['events.publish'] }],
    runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
  };
}

async function harness(options = {}) {
  let now = 1_000;
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => now++,
  });
  const installed = await inventory.installPackage({
    manifest: manifest(),
    computedPackageDigest: entry.packageDigest,
    expectedPackageDigest: entry.packageDigest,
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
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  registerOfficialPluginRoutes(app, {
    catalog: options.catalog ?? OFFICIAL_PLUGIN_CATALOG,
    inventory: store,
    lifecycle,
    installer: { install: async () => installed },
    ...(options.auth === undefined ? {} : { auth: options.auth }),
  });
  await app.ready();
  return { app, store, processCalls };
}

const ownerUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
const readHeaders = { 'x-test-session-user': ownerUserId };
const writeHeaders = {
  host: 'localhost:3004',
  origin: 'http://localhost:5173',
  'x-test-session-user': ownerUserId,
};

test('pins the runnable alpha.2 artifact and activates its package-owned owner auth contract', () => {
  assert.equal(entry.version, '0.1.0-alpha.2');
  assert.equal(
    entry.archiveUrl,
    'https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-0.1.0-alpha.2.tgz',
  );
  assert.equal(
    entry.packageDigest,
    'sha512-pLYTYEdGdAXrWBlKrLcUtrTJ6mszT6dmHpBDFOFLuPh1qkJAqwQ+S/xT/ORvjislG6jAgrzmYWnzlZMa778iEA==',
  );
  assert.deepEqual(entry.ownerAuth, {
    kind: 'lark-cli-device',
    runnerPath: 'node_modules/@larksuite/cli/scripts/run.js',
    domains: ['event', 'minutes', 'note', 'vc'],
  });
});

test('projects exact official catalog and durable installed state only to authenticated sessions', async () => {
  const { app } = await harness();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/official' })).statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json();
    assert.equal(body.plugins[0].catalogId, 'feishu-meeting-intake');
    assert.equal(body.plugins[0].version, '0.1.0-alpha.2');
    assert.equal(body.plugins[0].packageDigest, entry.packageDigest);
    assert.equal(body.plugins[0].ownerAuthAvailable, true);
    assert.equal(body.plugins[0].instance.lifecycleRevision, 1);
    assert.equal(body.plugins[0].instance.runtimeState, 'stopped');
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
