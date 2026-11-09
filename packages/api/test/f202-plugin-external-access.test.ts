import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  FilePluginExternalAccessStore,
  MemoryPluginExternalAccessStore,
  PluginExternalAccessService,
} from '../src/domains/plugin/external-access/plugin-external-access.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { pluginExternalRequestRoutes } from '../src/routes/plugin/plugin-external-request-routes.js';

const instance = (overrides: Record<string, unknown> = {}) => ({
  pluginInstanceId: 'instance-a',
  pluginId: 'fixture.plugin',
  packageDigest: `sha512-${Buffer.alloc(64).toString('base64')}`,
  lifecycleState: 'installed',
  configReadiness: 'ready',
  activationState: 'enabled',
  runtimeState: 'healthy',
  lifecycleRevision: 1,
  installedAt: 1,
  updatedAt: 1,
  ...overrides,
});

test('production preserves the converged generic external request route without an endpoint override', async () => {
  const [indexSource, compositionSource, routeSource] = await Promise.all([
    readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/domains/plugin/runtime-composition.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/plugin/plugin-external-request-routes.ts', import.meta.url), 'utf8'),
  ]);
  const compositionPath = compositionSource.match(/externalRequestEndpoint \?\? '([^']+)'/)?.[1];
  const registeredPath = routeSource.match(/app\.post\('([^']+)'/)?.[1];

  assert.doesNotMatch(indexSource, /\bexternalRequestEndpoint\s*:/);
  assert.doesNotMatch(indexSource, /['"]\/plugin\/mcp['"]/);
  assert.equal(compositionPath, '/api/plugin-runtime/handle');
  assert.equal(registeredPath, compositionPath);
});

test('an imported legacy token survives store recreation and can be revoked without minting a replacement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-legacy-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'access.json');
  const first = new FilePluginExternalAccessStore(path);
  await first.adopt('instance-a', 'old-token');
  const second = new FilePluginExternalAccessStore(path);
  assert.deepEqual(await second.find('instance-a'), { instanceId: 'instance-a', token: 'old-token' });
  await second.revoke('instance-a');
  assert.equal(await first.resolve('old-token'), undefined);
  assert.equal(await first.find('instance-a'), undefined);
  assert.equal('ensure' in first, false);
  assert.equal('rotate' in first, false);
});

test('a verified legacy installation adopts its existing credential as the same fixed-port token', async () => {
  const store = new MemoryPluginExternalAccessStore();
  await store.adopt('instance-a', 'a'.repeat(64));
  assert.deepEqual(await store.adopt('instance-a', 'a'.repeat(64)), {
    instanceId: 'instance-a',
    token: 'a'.repeat(64),
  });
  assert.equal(await store.resolve('a'.repeat(64)), 'instance-a');
  await assert.rejects(() => store.adopt('instance-b', 'a'.repeat(64)), /already belongs/);
});

test('ordinary module projection does not mint a new legacy raw credential', async () => {
  const store = new MemoryPluginExternalAccessStore();
  const service = new PluginExternalAccessService({
    endpoint: '/api/plugin-runtime/handle',
    store,
    inventory: { snapshot: async () => ({ schemaVersion: 1, packages: [], grants: [], instances: [instance()] }) },
    handler: {
      async handle() {
        return { status: 200 };
      },
    },
  });
  assert.deepEqual(await service.legacyAccess('instance-a'), { endpoint: '', token: '' });
  assert.equal(await store.resolve('must-not-be-minted'), undefined);
});

test('the token selects exactly one current enabled instance before the fixed handler is entered', async () => {
  const store = new MemoryPluginExternalAccessStore();
  let current = instance();
  const seen: unknown[] = [];
  const service = new PluginExternalAccessService({
    endpoint: '/api/plugin-runtime/handle',
    store,
    inventory: { snapshot: async () => ({ schemaVersion: 1, packages: [], grants: [], instances: [current] }) },
    handler: {
      async handle(pluginInstanceId, request) {
        seen.push({ pluginInstanceId, request });
        return { status: 200, body: request.body };
      },
    },
  });
  await service.adopt('instance-a', 'instance-token');
  const access = await service.legacyAccess('instance-a');
  assert.deepEqual(access, { endpoint: '/api/plugin-runtime/handle', token: 'instance-token' });
  const body = { jsonrpc: '2.0', method: 'tools/list', pluginId: 'forged', contributionId: 'forged' };
  assert.deepEqual(await service.handle('instance-token', { method: 'POST', headers: {}, body }), {
    status: 200,
    body,
  });
  assert.deepEqual(seen, [{ pluginInstanceId: 'instance-a', request: { method: 'POST', headers: {}, body } }]);

  current = instance({ activationState: 'disabled', runtimeState: 'stopped' });
  await assert.rejects(() => service.handle('instance-token', { method: 'POST', headers: {}, body }), /not enabled/);
  current = instance({ lifecycleState: 'retired', activationState: 'disabled', runtimeState: 'stopped' });
  await assert.rejects(() => service.handle('instance-token', { method: 'POST', headers: {}, body }), /not current/);
  assert.equal(seen.length, 1, 'Host refusals must not enter package code');
});

test('the public route accepts the legacy token by bearer or exact URL query and exposes no selector', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const seen: unknown[] = [];
  await app.register(pluginExternalRequestRoutes, {
    external: {
      async handle(token, request) {
        seen.push({ token, request });
        return {
          status: 200,
          headers: { 'content-type': 'application/json', authorization: 'must-not-escape' },
          body: { ok: true },
        };
      },
    },
  });

  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', pluginId: 'forged' };
  const response = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/handle',
    headers: {
      authorization: 'Bearer plugin-token',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-session-id': 'session-one',
      'last-event-id': 'event-one',
      cookie: 'must-not-reach-plugin',
      'x-plugin-id': 'forged',
    },
    payload: body,
  });
  assert.equal(response.statusCode, 200, response.payload);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(response.headers.authorization, undefined);
  assert.deepEqual(seen, [
    {
      token: 'plugin-token',
      request: {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'last-event-id': 'event-one',
          'mcp-protocol-version': '2026-07-28',
          'mcp-session-id': 'session-one',
        },
        body,
      },
    },
  ]);

  const query = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/handle?token=plugin-token',
    payload: body,
  });
  assert.equal(query.statusCode, 200, query.payload);
  assert.deepEqual(seen.at(-1), {
    token: 'plugin-token',
    request: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    },
  });

  const ambiguous = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/handle?token=other-token',
    headers: { authorization: 'Bearer plugin-token' },
    payload: body,
  });
  assert.equal(ambiguous.statusCode, 401);

  const missing = await app.inject({ method: 'POST', url: '/api/plugin-runtime/handle', payload: body });
  assert.equal(missing.statusCode, 401);
  assert.equal(seen.length, 2);
});

test('the production runtime preserves imported legacy access until uninstall without minting new credentials', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'plugin-external-runtime-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const create = () =>
    createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore: new MessageStore(),
      externalRequestEndpoint: 'https://host.example/api/plugin-runtime/handle',
    });
  const first = create();
  const packageDigest = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const admitted = await first.inventory.installPackage({
    manifest: {
      pluginId: 'fixture.plugin',
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: 'External access fixture',
      features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    },
    computedPackageDigest: packageDigest,
    expectedPackageDigest: packageDigest,
    packagePluginId: 'fixture.plugin',
    effectiveGrants: [],
  });
  const instanceId = admitted.pluginInstanceId;
  await first.externalAccess.adopt(instanceId, 'imported-token');
  const initial = await first.externalAccess.legacyAccess(instanceId);
  assert.equal(initial.endpoint, 'https://host.example/api/plugin-runtime/handle');

  await first.supervisor.stop(instanceId, 'owner_disabled');
  assert.deepEqual(
    await first.externalAccess.legacyAccess(instanceId),
    initial,
    'disable keeps the installation identity',
  );
  const restarted = create();
  assert.deepEqual(
    await restarted.externalAccess.legacyAccess(instanceId),
    initial,
    'restart keeps the installation identity',
  );

  await restarted.supervisor.stop(instanceId, 'owner_uninstalled');
  const replacement = await restarted.externalAccess.legacyAccess(instanceId);
  assert.deepEqual(
    replacement,
    { endpoint: '', token: '' },
    'uninstall revokes the imported identity without minting one',
  );
});
