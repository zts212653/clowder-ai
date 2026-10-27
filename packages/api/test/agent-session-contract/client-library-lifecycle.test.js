import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { declaredAgentSessionProviders } from '../../dist/domains/plugin/declared/declared-agent-session-providers.js';
import { DeclaredRuntimeContributions } from '../../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { FilesystemVerifiedPluginPackageLocator } from '../../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../../dist/domains/plugin/index.js';
import { registerAgentClientLibraryRoutes } from '../../dist/routes/agent-client-library-routes.js';
import { collect, FakeSessionProvider, options } from './fake-session-provider.js';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'client-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await cp(new URL('../fixtures/agent-session-reference/plugin/', import.meta.url), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.configuration = [{ key: 'clients', label: 'Clients', kind: 'string', required: false, default: '[]' }];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'agent-provider.json'), JSON.stringify({ configurationKey: 'clients' }));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store);
  const packagesRoot = join(root, 'packages');
  await new LocalPluginPackageAdmission({ inventory, packagesRoot }).install({
    kind: 'local-directory',
    path: source,
  });
  const snapshot = await store.snapshot();
  const admission = { instance: snapshot.instances[0], packageRecord: snapshot.packages[0] };
  const packages = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
  const registry = new SessionImplementationRegistry();
  let clients = [
    { id: 'first', name: 'First', command: 'node', startupArgs: [] },
    { id: 'second', name: 'Second', command: 'node', startupArgs: [] },
  ];
  let reads = 0;
  const configuration = {
    readConfig: async () => {
      reads++;
      return JSON.stringify(clients);
    },
  };
  const created = [];
  const ref = { pluginId: manifest.pluginId, contributionId: 'first' };
  const service = new RegisteredSessionAgentService({ catId: 'codex', ref, registry });
  const lifecycle = declaredAgentSessionProviders({
    settings: { mode: 'plugin', bindings: new Map() },
    packages,
    registry,
    services: new Map([['codex', service]]),
    configuration,
    createProvider: (declaration) => {
      const provider = new FakeSessionProvider();
      created.push({ declaration, provider });
      return provider;
    },
  });
  const runtime = new DeclaredRuntimeContributions({ packages, configuration, agentSessionProviders: lifecycle });
  t.after(() => runtime.deactivateAll());
  return {
    runtime,
    admission,
    registry,
    service,
    created,
    ref,
    store,
    packages,
    configuration,
    set: (value) => {
      clients = value;
    },
    reads: () => reads,
  };
}

test('multi-client registration and disable release persisted member bindings without environment entries', async (t) => {
  const h = await harness(t);
  await h.runtime.activate(h.admission, () => assert.fail('data-only plugin executed code'));
  assert.ok(h.registry.has(h.ref));
  assert.ok(h.registry.has({ ...h.ref, contributionId: 'second' }));
  await collect(h.service.invoke('first turn', options({ hostSessionId: 'host' })));
  await h.runtime.deactivate(h.admission.instance.pluginInstanceId);
  assert.equal(h.registry.has(h.ref), false);
  assert.equal(h.created[0].provider.calls.release[0].reason, 'implementation_unregistered');
  const unavailable = await collect(h.service.invoke('must fail closed', options({ hostSessionId: 'host' })));
  assert.equal(unavailable[0].errorCode, 'session_implementation_unavailable');
  h.set([{ id: 'first', name: 'Changed', command: 'node', startupArgs: ['external.js'] }]);
  await h.runtime.activate(h.admission, () => {});
  await collect(h.service.invoke('new config', options({ hostSessionId: 'new-host' })));
  assert.deepEqual(h.created[1].declaration.acp.startupArgs, ['external.js']);
  assert.equal(h.registry.has({ ...h.ref, contributionId: 'second' }), false);
});

test('configuration refresh replaces live registrations and releases the previous provider', async (t) => {
  const h = await harness(t);
  await h.runtime.activate(h.admission, () => {});
  await collect(h.service.invoke('old', options({ hostSessionId: 'host' })));
  h.set([{ id: 'first', name: 'Refreshed', command: 'node', startupArgs: ['changed.js'] }]);
  await h.runtime.refreshAgentSessionProviders(h.admission);
  assert.equal(h.created[0].provider.calls.release[0].reason, 'implementation_unregistered');
  await collect(h.service.invoke('new', options({ hostSessionId: 'host' })));
  assert.deepEqual(h.created[1].declaration.acp.startupArgs, ['changed.js']);
  assert.equal(h.registry.has({ ...h.ref, contributionId: 'second' }), false);
});

test('invalid library activation is atomic, including duplicate registry coordinates', async (t) => {
  const h = await harness(t);
  const occupied = { ...h.ref, contributionId: 'second' };
  const release = h.registry.register(occupied, () => new FakeSessionProvider());
  await assert.rejects(
    h.runtime.activate(h.admission, () => {}),
    /Duplicate session/,
  );
  assert.equal(h.registry.has(h.ref), false);
  assert.equal(h.registry.has(occupied), true);
  release();
  h.set([
    { id: 'duplicate', name: 'A', command: 'node', startupArgs: [] },
    { id: 'duplicate', name: 'B', command: 'node', startupArgs: [] },
  ]);
  await assert.rejects(
    h.runtime.activate(h.admission, () => {}),
    /ID/,
  );
  assert.equal(h.registry.has(h.ref), false);
});

test('owner catalog stays available while disabled and never starts a client; anonymous access is denied', async (t) => {
  const h = await harness(t);
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  registerAgentClientLibraryRoutes(app, {
    inventory: h.store,
    packages: h.packages,
    configuration: h.configuration,
    registry: h.registry,
  });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/agent-providers')).statusCode, 401);
  assert.equal(h.reads(), 0);
  const headers = { host: 'localhost:4312', 'x-test-session-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user' };
  const disabled = await app.inject({ url: '/api/agent-providers', headers });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().libraries[0].configurationKey, 'clients');
  assert.deepEqual(
    disabled.json().libraries[0].clients.map((client) => client.available),
    [false, false],
  );
  assert.equal(h.created.length, 0);
  await h.runtime.activate(h.admission, () => {});
  const enabled = await app.inject({ url: '/api/agent-providers', headers });
  assert.deepEqual(
    enabled.json().libraries[0].clients.map((client) => client.available),
    [true, true],
  );
  assert.equal(h.created.length, 1, 'activation prepares the persisted member for Host capability admission');
  assert.equal(h.created[0].provider.calls.open.length, 0, 'preparation does not open an agent session');
  assert.equal(h.created[0].provider.calls.start.length, 0, 'reading the catalog never starts a client turn');
});
