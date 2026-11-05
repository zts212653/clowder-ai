import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { FilePluginCapabilityKeyring } from '../src/domains/plugin/capability-token/plugin-capability-token.js';
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

test('production external forwarding targets the registered Host request route', async () => {
  const [accessSource, indexSource, compositionSource, routeSource] = await Promise.all([
    readFile(new URL('../src/domains/plugin/external-access/plugin-external-access.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/domains/plugin/runtime-composition.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/plugin/plugin-external-request-routes.ts', import.meta.url), 'utf8'),
  ]);
  const canonicalPath = accessSource.match(/PLUGIN_EXTERNAL_REQUEST_PATH = '([^']+)'/)?.[1];

  assert.equal(canonicalPath, '/api/plugin-runtime/handle');
  assert.match(indexSource, /const pluginExternalRequestPath = PLUGIN_EXTERNAL_REQUEST_PATH;/);
  assert.match(compositionSource, /externalRequestEndpoint \?\? PLUGIN_EXTERNAL_REQUEST_PATH/);
  assert.match(routeSource, /app\.post\(PLUGIN_EXTERNAL_REQUEST_PATH,/);
  assert.doesNotMatch(indexSource, /['"]\/plugin\/mcp['"]/);
});

test('one installation keeps one token across Host store recreation; rotate and uninstall revoke it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-external-access-'));
  const path = join(root, 'access.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = ['token-one', 'token-two'];
  const a = new FilePluginExternalAccessStore(path, { generateToken: () => generated.shift()! });

  assert.deepEqual(await a.ensure('instance-a'), { instanceId: 'instance-a', token: 'token-one' });
  assert.deepEqual(await a.ensure('instance-a'), { instanceId: 'instance-a', token: 'token-one' });
  const b = new FilePluginExternalAccessStore(path, { generateToken: () => generated.shift()! });
  assert.deepEqual(await b.ensure('instance-a'), { instanceId: 'instance-a', token: 'token-one' });
  assert.equal(await b.resolve('token-one'), 'instance-a');
  assert.deepEqual(await b.rotate('instance-a'), { instanceId: 'instance-a', token: 'token-two' });
  assert.equal(await b.resolve('token-one'), undefined);
  assert.equal(await b.resolve('token-two'), 'instance-a');
  await b.revoke('instance-a');
  assert.equal(await b.resolve('token-two'), undefined);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path, 'utf8'), /pluginId|method|allowed/i);
});

test('a verified legacy installation adopts its existing credential as the same fixed-port token', async () => {
  const store = new MemoryPluginExternalAccessStore({ generateToken: () => 'generated-token' });
  await store.adopt('instance-a', 'a'.repeat(64));
  assert.deepEqual(await store.ensure('instance-a'), { instanceId: 'instance-a', token: 'a'.repeat(64) });
  assert.equal(await store.resolve('a'.repeat(64)), 'instance-a');
  await assert.rejects(() => store.adopt('instance-b', 'a'.repeat(64)), /already belongs/);
});

test('the authenticated plugin issues and inspects only its declared external capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-signed-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const tokens = new FilePluginCapabilityKeyring({
    path: join(root, 'capability-keyring.json'),
    now: () => now,
  });
  let current = instance();
  const manifest = {
    pluginId: 'fixture.plugin',
    version: '1.0.0',
    contractVersion: '0.3.1-candidate.1',
    name: 'Signed external fixture',
    contributions: [{ type: 'external-request', id: 'fixture-mcp' }],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'external-request', id: 'fixture-mcp' }],
      },
    ],
  };
  const snapshot = async () => ({
    schemaVersion: 1 as const,
    packages: [{ pluginId: 'fixture.plugin', packageDigest: current.packageDigest, manifest }],
    grants: [],
    instances: [current],
  });
  const seen: unknown[] = [];
  const service = new PluginExternalAccessService({
    endpoint: '/api/plugin-runtime/handle',
    upstreamLoopbackOrigin: 'http://127.0.0.1:5182',
    store: new MemoryPluginExternalAccessStore(),
    tokens,
    now: () => now,
    inventory: { snapshot: snapshot as never },
    handler: {
      async handle(pluginInstanceId, request, credential) {
        seen.push({ pluginInstanceId, request, credential });
        return { status: 200, body: { ok: true } };
      },
    },
  });

  const issued = await service.issueExternal('instance-a', {
    capabilityId: 'fixture-mcp',
    ttlSeconds: 3_600,
  });
  assert.deepEqual(issued.forwarding, {
    upstreamLoopbackOrigin: 'http://127.0.0.1:5182',
    relativePath: '/api/plugin-runtime/handle',
    method: 'POST',
  });
  const initialStatus = await service.inspectExternal('instance-a', {
    token: issued.token,
    capabilityId: 'fixture-mcp',
  });
  assert.equal(initialStatus.usable, true);
  assert.equal(initialStatus.remainingSeconds, 3_600);
  assert.equal(initialStatus.refreshRecommended, true);
  now += 1_800_000;
  assert.equal(
    (
      await service.inspectExternal('instance-a', {
        token: issued.token,
        capabilityId: 'fixture-mcp',
      })
    ).remainingSeconds,
    1_800,
  );
  assert.equal(
    (
      await service.inspectExternal('instance-other', {
        token: issued.token,
        capabilityId: 'fixture-mcp',
      })
    ).usable,
    false,
  );
  await assert.rejects(
    service.issueExternal('instance-a', { capabilityId: 'undeclared', ttlSeconds: 60 }),
    /not declared/,
  );

  await service.handle(issued.token, { method: 'POST', headers: {}, body: { jsonrpc: '2.0' } });
  assert.deepEqual(seen, [
    {
      pluginInstanceId: 'instance-a',
      request: { method: 'POST', headers: {}, body: { jsonrpc: '2.0' } },
      credential: {
        sub: 'instance-a',
        cap: 'fixture-mcp',
        jti: issued.tokenId,
        iat: issued.issuedAt,
        exp: issued.expiresAt,
      },
    },
  ]);

  current = instance({ activationState: 'disabled', runtimeState: 'stopped' });
  await assert.rejects(service.handle(issued.token, { method: 'POST', headers: {}, body: {} }), /not enabled/);
  assert.equal(
    (
      await service.inspectExternal('instance-a', {
        token: issued.token,
        capabilityId: 'fixture-mcp',
      })
    ).usable,
    false,
  );
});

test('ordinary module projection does not mint a new legacy raw credential', async () => {
  const store = new MemoryPluginExternalAccessStore({ generateToken: () => 'must-not-be-minted' });
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
  const store = new MemoryPluginExternalAccessStore({ generateToken: () => 'instance-token' });
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
  const access = await service.access('instance-a');
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

test('the public route accepts the signed token by bearer or exact URL query and exposes no selector', async (t) => {
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

test('the production runtime owns one durable access identity and revokes it only on uninstall', async (t) => {
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
  const initial = await first.externalAccess.access(instanceId);
  assert.equal(initial.endpoint, 'https://host.example/api/plugin-runtime/handle');

  await first.supervisor.stop(instanceId, 'owner_disabled');
  assert.deepEqual(await first.externalAccess.access(instanceId), initial, 'disable keeps the installation identity');
  const restarted = create();
  assert.deepEqual(
    await restarted.externalAccess.access(instanceId),
    initial,
    'restart keeps the installation identity',
  );

  await restarted.supervisor.stop(instanceId, 'owner_uninstalled');
  const replacement = await restarted.externalAccess.access(instanceId);
  assert.notEqual(replacement.token, initial.token, 'uninstall revokes the old identity');
});
