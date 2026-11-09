import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { SessionImplementationRegistry } from '../src/domains/cats/services/agents/session-contract/implementation-registry.js';
import { recoverAgentClientMetadata } from '../src/domains/plugin/declared/agent-client-metadata.js';
import { ExternalPluginLifecycleService } from '../src/domains/plugin/external-plugin-lifecycle.js';
import { FilesystemVerifiedPluginPackageLocator } from '../src/domains/plugin/external-runtime/filesystem-package-locator.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { LocalPluginPackageAdmission } from '../src/domains/plugin/manager/local-package-admission.js';
import { bundledManifestDigest } from '../src/domains/plugin/official-catalog.js';
import { registerAgentClientLibraryRoutes } from '../src/routes/agent-client-library-routes.js';

async function fixture(t: TestContext, { count = 1, files = 0, declaration = false, fixed = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'package'), { recursive: true });
  await Promise.all(
    Array.from({ length: files }, (_, i) =>
      writeFile(join(source, `package/file-${i}.txt`), Buffer.alloc(16 * 1024, 'x')),
    ),
  );
  if (declaration || fixed)
    await writeFile(
      join(source, 'package/agent-provider.json'),
      JSON.stringify(
        fixed
          ? {
              id: 'codeagent',
              transport: 'acp',
              configurationKey: 'clients',
              acp: { command: 'codeagent', startupArgs: [] },
            }
          : { configurationKey: 'clients' },
      ),
    );
  const packages = new FilesystemVerifiedPluginPackageLocator(join(root, 'cache'));
  const store = new MemoryPluginInventoryStore();
  const admission = new LocalPluginPackageAdmission({
    inventory: new HostInventoryControlPlane(store),
    packagesRoot: packages.packagesRoot,
  });
  for (const i of Array.from({ length: count }, (_, i) => i)) {
    const manifest = {
      pluginId: `local.catalog-${i}`,
      version: '0.1.0',
      contractVersion: '0.1.0',
      name: `Catalog ${i}`,
      features: [{ id: 'agent', name: 'Agent', resources: [], capabilities: [] }],
      ...(declaration || fixed
        ? {
            configuration: [
              { key: 'clients', label: 'Clients', kind: 'string', required: false, default: fixed ? '{}' : '[]' },
            ],
          }
        : {}),
    };
    await writeFile(join(source, 'package/manifest.json'), JSON.stringify(manifest));
    const { stdout: bytes } = await promisify(execFile)('tar', ['-czf', '-', 'package'], {
      cwd: source,
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const archive = join(root, 'candidate.tgz');
    await writeFile(archive, bytes);
    await admission.install({ kind: 'local-archive', path: archive });
  }
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'] as string | undefined;
  });
  let clients = [{ id: 'first', name: 'First', command: 'node', startupArgs: [] }];
  const registry = new SessionImplementationRegistry();
  registerAgentClientLibraryRoutes(app, {
    inventory: store,
    packages,
    registry,
    configuration: { readConfig: async () => JSON.stringify(fixed ? { permissionPolicy: 'deny' } : clients) },
  });
  t.after(() => app.close());
  const read = () =>
    app.inject({
      url: '/api/agent-providers',
      headers: { host: 'localhost:4312', 'x-test-session-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user' },
    });
  return {
    app,
    read,
    packages,
    store,
    registry,
    admission,
    source,
    setClients: (value: typeof clients) => (clients = value),
  };
}

test('16 unrelated archives stay below the browser deadline without executable staging', async (t) => {
  const h = await fixture(t, { count: 16, files: 175 });
  const staged = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolveInstalledPackage');
  const scanned = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  const before = await readdir(h.packages.packagesRoot);
  const started = performance.now();
  const response = await h.read();
  const elapsed = performance.now() - started;
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { libraries: [] });
  assert.equal(staged.mock.callCount(), 0, 'listing absent declarations must not prepare executable trees');
  assert.equal(scanned.mock.callCount(), 0, 'member configuration must not scan plugin archives');
  assert.ok(elapsed < 30_000, `catalog exceeded the real browser deadline: ${elapsed} ms`);
  assert.deepEqual(await readdir(h.packages.packagesRoot), before);
  t.diagnostic(`16 archives / 2816 files: ${Math.round(elapsed)} ms`);
});

test('a declared library reads metadata and fresh configuration without archive admission', async (t) => {
  const h = await fixture(t, { declaration: true });
  const staged = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolveInstalledPackage');
  const first = (await h.read()).json().libraries;
  assert.equal(first[0]?.configurationKey, 'clients', JSON.stringify(first));
  assert.deepEqual(first[0].clients, [
    { id: 'first', name: 'First', ref: 'plugin:local.catalog-0/first', available: false },
  ]);
  h.setClients([{ id: 'second', name: 'Changed', command: 'node', startupArgs: [] }]);
  assert.equal((await h.read()).json().libraries[0]?.clients[0]?.id, 'second');
  assert.equal(staged.mock.callCount(), 0, 'a declared library list must not repeat execution admission');
});

test('a fixed connection keeps its identity and ordinary config editor without reading its archive', async (t) => {
  const h = await fixture(t, { fixed: true });
  const staged = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolveInstalledPackage');
  const scanned = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  for (const _read of [0, 1]) {
    const library = (await h.read()).json().libraries[0];
    assert.equal(library.configurationKey, 'clients', JSON.stringify(library));
    assert.equal(library.configurationMode, 'single');
    assert.deepEqual(library.clients, [
      { id: 'codeagent', name: 'Catalog 0', ref: 'plugin:local.catalog-0/codeagent', available: false },
    ]);
    assert.equal(library.error, undefined);
  }
  assert.equal(staged.mock.callCount(), 0);
  assert.equal(scanned.mock.callCount(), 0);
});

test('a corrupt archive cannot become trusted legacy metadata during restart recovery', async (t) => {
  const h = await fixture(t);
  const snapshot = await h.store.snapshot();
  const digest = snapshot.packages[0]!.packageDigest;
  await h.store.transaction(({ packages }) => {
    const { agentClientMetadata: _metadata, ...legacy } = packages.get(digest)!;
    packages.put(legacy);
  });
  await appendFile(join(h.packages.packageRoot(digest), 'package.tgz'), Buffer.from([0]));
  const staged = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolveInstalledPackage');
  const failures: string[] = [];
  await recoverAgentClientMetadata({ inventory: h.store, packages: h.packages, onFailure: (id) => failures.push(id) });
  assert.deepEqual(failures, ['local.catalog-0']);
  const response = await h.read();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().libraries.length, 1);
  assert.match(response.json().libraries[0].error, /尚未登记/);
  assert.equal(staged.mock.callCount(), 0);
});

test('legacy manifest drift fails metadata recovery without rescanning on GET', async (t) => {
  const h = await fixture(t);
  await h.store.transaction(({ packages }) => {
    const record = packages.list()[0]!;
    const { agentClientMetadata: _metadata, ...legacy } = record;
    packages.put({ ...legacy, manifest: { ...record.manifest!, name: 'Changed inventory identity' } });
  });
  const failures: string[] = [];
  await recoverAgentClientMetadata({ inventory: h.store, packages: h.packages, onFailure: (id) => failures.push(id) });
  assert.deepEqual(failures, ['local.catalog-0']);
  const response = await h.read();
  assert.match(response.json().libraries[0]?.error, /尚未登记/);
});

test('display metadata grants no authority to resolve a subsequently corrupted executable package', async (t) => {
  const h = await fixture(t, { declaration: true });
  const digest = (await h.store.snapshot()).packages[0]!.packageDigest;
  await appendFile(join(h.packages.packageRoot(digest), 'package.tgz'), Buffer.from([0]));
  const response = await h.read();
  assert.equal(response.json().libraries[0].clients[0].id, 'first');
  await assert.rejects(h.packages.resolveInstalledPackage(digest), /digest/);
});

test('unauthenticated reads do not inspect archives', async (t) => {
  const h = await fixture(t);
  const reads = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  assert.equal((await h.app.inject('/api/agent-providers')).statusCode, 401);
  assert.equal(reads.mock.callCount(), 0);
});

test('legacy inventory is prepared once at restart and the metadata survives a stored snapshot round trip', async (t) => {
  const h = await fixture(t, { declaration: true });
  await h.store.transaction(({ packages }) => {
    const { agentClientMetadata: _metadata, ...legacy } = packages.list()[0]!;
    packages.put(legacy);
  });
  const scanned = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  const staged = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolveInstalledPackage');
  await recoverAgentClientMetadata({ inventory: h.store, packages: h.packages, onFailure: assert.fail });
  assert.equal(scanned.mock.callCount(), 1);
  assert.equal(staged.mock.callCount(), 1);
  const persisted = JSON.parse(JSON.stringify(await h.store.snapshot()));
  const restarted = new MemoryPluginInventoryStore(persisted);
  await recoverAgentClientMetadata({ inventory: restarted, packages: h.packages, onFailure: assert.fail });
  assert.equal(scanned.mock.callCount(), 1, 'a subsequent restart must reuse persisted metadata');
  assert.equal(staged.mock.callCount(), 1);
  assert.deepEqual((await restarted.snapshot()).packages[0]?.agentClientMetadata, {
    catalog: { configurationKey: 'clients', presets: [], clients: [] },
  });
  assert.throws(
    () =>
      new MemoryPluginInventoryStore({
        ...persisted,
        packages: [{ ...persisted.packages[0], agentClientMetadata: { catalog: 'invalid persisted metadata' } }],
      }),
    { code: 'CORRUPT_SNAPSHOT' },
  );
  assert.equal((await h.read()).json().libraries[0].configurationKey, 'clients');
  assert.equal(scanned.mock.callCount(), 1, 'opening the editor does not repeat recovery');
});

test('install/update/uninstall replace or remove the metadata source without a list-time archive read', async (t) => {
  const h = await fixture(t, { declaration: true });
  const manifestPath = join(h.source, 'package/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '0.2.0' }));
  await writeFile(
    join(h.source, 'package/agent-provider.json'),
    JSON.stringify({
      id: 'updated',
      transport: 'acp',
      acp: { command: 'node', startupArgs: [] },
    }),
  );
  await h.admission.install({ kind: 'local-directory', path: join(h.source, 'package') });
  const scanned = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  const staged = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolveInstalledPackage');
  const updated = (await h.read()).json().libraries;
  assert.equal(updated.length, 1);
  assert.equal(updated[0].configurationKey, null);
  assert.equal(updated[0].clients[0].id, 'updated');
  const instance = (await h.store.snapshot()).instances[0]!;
  const lifecycle = new ExternalPluginLifecycleService({
    store: h.store,
    supervisor: { start: async () => {}, stop: async () => {} },
  });
  await lifecycle.uninstall(instance.pluginInstanceId, instance.lifecycleRevision);
  assert.deepEqual((await h.read()).json(), { libraries: [] });
  assert.equal(scanned.mock.callCount(), 0);
  assert.equal(staged.mock.callCount(), 0);
});

test('an empty plugin inventory supplies no prerequisite to ordinary manual ACP configuration', async (t) => {
  const h = await fixture(t, { count: 0 });
  const scanned = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  assert.deepEqual((await h.read()).json(), { libraries: [] });
  assert.equal(scanned.mock.callCount(), 0);
});

test('historical Host builtin registrations never acquire an archive dependency during recovery', async (t) => {
  const h = await fixture(t, { count: 0 });
  const manifest = {
    pluginId: 'local.bundled-history',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Host builtin',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin' },
  };
  const digest = bundledManifestDigest(manifest);
  await new HostInventoryControlPlane(h.store).installPackage({
    manifest,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: manifest.pluginId,
  });
  const scanned = t.mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'readInstalledStaticFile');
  await recoverAgentClientMetadata({ inventory: h.store, packages: h.packages, onFailure: assert.fail });
  assert.equal(scanned.mock.callCount(), 0);
  assert.deepEqual((await h.read()).json(), { libraries: [] });
});
