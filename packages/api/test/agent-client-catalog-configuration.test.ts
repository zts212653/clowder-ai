import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import Fastify from 'fastify';
import { SessionImplementationRegistry } from '../src/domains/cats/services/agents/session-contract/implementation-registry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { resolveAgentClientLibrary } from '../src/domains/plugin/declared/agent-client-library.js';
import { FilesystemVerifiedPluginPackageLocator } from '../src/domains/plugin/external-runtime/filesystem-package-locator.js';
import { readPluginConfig } from '../src/domains/plugin/plugin-config-store.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../src/domains/plugin/runtime-composition.js';
import { registerAgentClientLibraryRoutes } from '../src/routes/agent-client-library-routes.js';

// Run the actual production DI call, without executing index's service startup.
const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const productionCall = index.match(/registerAgentClientLibraryRoutes\(app, \{[\s\S]*?\n {2}\}\);/)?.[0];
assert.ok(productionCall, 'production must compose the member catalog route');
const registerFromProduction = new Function(
  'registerAgentClientLibraryRoutes',
  'app',
  'pluginRuntime',
  'pluginManagerRuntime',
  'sessionImplementations',
  productionCall,
);

async function fixture(
  t: TestContext,
  permissionPolicy: 'deny' | 'auto_allow' | undefined,
  fixed = false,
  name = 'Catalog configuration origin',
) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'catalog-config-origin-'));
  const source = join(projectRoot, 'source');
  await mkdir(source);
  const acp = { command: 'node', startupArgs: [], ...(permissionPolicy ? { permissionPolicy } : {}) };
  const declaration = fixed
    ? { id: 'fixed-client', transport: 'acp' as const, configurationKey: 'clients', acp }
    : { configurationKey: 'clients' };
  const value = JSON.stringify(fixed ? {} : [{ id: 'default-client', name: 'Default', ...acp }]);
  const pluginId = 'local.catalog-config-origin';
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      pluginId,
      version: '0.1.0',
      contractVersion: '0.1.0',
      name,
      features: [{ id: 'agent', name: 'Agent', resources: [], capabilities: [] }],
      configuration: [{ key: 'clients', label: 'Clients', kind: 'string', required: false, default: value }],
    }),
  );
  await writeFile(join(source, 'agent-provider.json'), JSON.stringify(declaration));
  const runtime = createDormantPluginRuntimeComposition({ projectRoot, messageStore: new MessageStore() });
  const manager = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
    catalogManifests: [],
  });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await runtime.shutdown();
    await rm(projectRoot, { recursive: true, force: true });
  });
  await manager.localAdmission.install({ kind: 'local-directory', path: source });
  const snapshot = await runtime.inventoryStore.snapshot();
  const admission = { instance: snapshot.instances[0]!, packageRecord: snapshot.packages[0]! };
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'] as string | undefined;
  });
  registerFromProduction(registerAgentClientLibraryRoutes, app, runtime, manager, new SessionImplementationRegistry());
  const staged = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolveInstalledPackage');
  const scanned = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  return {
    value,
    manager,
    stored: () => readPluginConfig(projectRoot, pluginId),
    read: () =>
      app.inject({
        url: '/api/agent-providers',
        headers: { host: 'localhost:4312', 'x-test-session-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user' },
      }),
    effective: () => manager.configuration.readActionInput(pluginId),
    execute: () =>
      resolveAgentClientLibrary({ declaration, admission, packageRoot: source, configuration: runtime.configuration }),
    save: async (saved = value) => {
      const current = (await runtime.inventoryStore.snapshot()).instances[0]!;
      await manager.configuration.configure(pluginId, current.pluginInstanceId, {
        expectedRevision: current.lifecycleRevision,
        updates: [{ key: 'clients', value: saved }],
      });
    },
    assertNoArchiveReads: () => {
      assert.equal(staged.mock.callCount(), 0);
      assert.equal(scanned.mock.callCount(), 0);
    },
  };
}

test('production catalog rejects unsaved auto_allow defaults and accepts the identical owner-saved value', async (t) => {
  const h = await fixture(t, 'auto_allow');
  assert.deepEqual(h.stored(), {});
  assert.equal((await h.effective()).clients, h.value, 'action inputs intentionally apply manifest defaults');
  const unsaved = (await h.read()).json().libraries[0];
  assert.match(unsaved.error ?? '', /owner/);
  assert.deepEqual(unsaved.clients, []);
  await assert.rejects(h.execute(), /owner/);
  await h.save();
  assert.equal(h.stored().clients, h.value);
  const saved = (await h.read()).json().libraries[0];
  assert.equal(saved.error, undefined);
  assert.equal(saved.clients[0].id, 'default-client');
  assert.equal((await h.execute())[0]?.acp.permissionPolicy, 'auto_allow');
  h.assertNoArchiveReads();
});

for (const policy of [undefined, 'deny'] as const) {
  test(`production catalog keeps unsaved ordinary defaults (${policy ?? 'unspecified'})`, async (t) => {
    const h = await fixture(t, policy);
    assert.deepEqual(h.stored(), {});
    const library = (await h.read()).json().libraries[0];
    assert.equal(library.error, undefined);
    assert.equal(library.clients[0].id, 'default-client');
    assert.equal((await h.execute())[0]?.acp.permissionPolicy, policy);
    h.assertNoArchiveReads();
  });
}

test('production catalog preserves the fixed-client form and live configuration without archive reads', async (t) => {
  const h = await fixture(t, 'deny', true);
  assert.deepEqual(h.stored(), {});
  const library = (await h.read()).json().libraries[0];
  assert.equal(library.configurationKey, 'clients');
  assert.equal(library.configurationMode, 'single');
  assert.deepEqual(library.defaultClient, {
    id: 'fixed-client',
    name: 'Catalog configuration origin',
    command: 'node',
    startupArgs: [],
    permissionPolicy: 'deny',
  });
  assert.equal(library.clients[0].id, 'fixed-client');
  assert.equal(library.error, undefined);
  assert.equal((await h.execute())[0]?.acp.permissionPolicy, 'deny');
  await h.save(JSON.stringify({ id: 'must-not-change' }));
  const broken = (await h.read()).json().libraries[0];
  assert.match(broken.error, /配置/);
  assert.equal(broken.configurationMode, 'single');
  assert.deepEqual(broken.defaultClient, library.defaultClient);
  assert.deepEqual(broken.clients, []);
  await h.save(JSON.stringify({ command: 'another-client', startupArgs: ['--acp'], permissionPolicy: 'auto_allow' }));
  const recovered = (await h.read()).json().libraries[0];
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.clients[0].id, 'fixed-client');
  assert.equal((await h.execute())[0]?.acp.command, 'another-client');
  assert.equal((await h.execute())[0]?.acp.permissionPolicy, 'auto_allow');
  h.assertNoArchiveReads();
});

test('fixed-client display metadata preserves names accepted by the plugin manifest', async (t) => {
  const name = 'Catalog '.repeat(15);
  const h = await fixture(t, 'deny', true, name);
  const library = (await h.read()).json().libraries[0];
  assert.equal(library.defaultClient.name, name);
  assert.equal(library.clients[0].name, name);
  h.assertNoArchiveReads();
});
