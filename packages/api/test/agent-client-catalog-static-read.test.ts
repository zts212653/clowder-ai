import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { SessionImplementationRegistry } from '../src/domains/cats/services/agents/session-contract/implementation-registry.js';
import { FilesystemVerifiedPluginPackageLocator } from '../src/domains/plugin/external-runtime/filesystem-package-locator.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { registerAgentClientLibraryRoutes } from '../src/routes/agent-client-library-routes.js';

async function fixture(t: TestContext, { count = 1, files = 0, declaration = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'package'), { recursive: true });
  await Promise.all(
    Array.from({ length: files }, (_, i) =>
      writeFile(join(source, `package/file-${i}.txt`), Buffer.alloc(16 * 1024, 'x')),
    ),
  );
  if (declaration)
    await writeFile(join(source, 'package/agent-provider.json'), JSON.stringify({ configurationKey: 'clients' }));
  const packages = new FilesystemVerifiedPluginPackageLocator(join(root, 'cache'));
  const store = new MemoryPluginInventoryStore();
  for (const i of Array.from({ length: count }, (_, i) => i)) {
    const manifest = {
      pluginId: `local.catalog-${i}`,
      version: '0.1.0',
      contractVersion: '0.1.0',
      name: `Catalog ${i}`,
      features: [{ id: 'agent', name: 'Agent', resources: [], capabilities: [] }],
      ...(declaration
        ? { configuration: [{ key: 'clients', label: 'Clients', kind: 'string', required: false, default: '[]' }] }
        : {}),
    };
    await writeFile(join(source, 'package/manifest.json'), JSON.stringify(manifest));
    const { stdout: bytes } = await promisify(execFile)('tar', ['-czf', '-', 'package'], {
      cwd: source,
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    await mkdir(packages.packageRoot(digest), { recursive: true });
    await writeFile(join(packages.packageRoot(digest), 'package.tgz'), bytes);
    await store.transaction(({ packages: records, instances }) => {
      records.put({
        packageDigest: digest,
        pluginId: manifest.pluginId,
        version: manifest.version,
        contractVersion: manifest.contractVersion,
        manifest,
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      });
      instances.put({
        pluginId: manifest.pluginId,
        pluginInstanceId: `pi_catalog_${i}`,
        packageDigest: digest,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      });
    });
  }
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'] as string | undefined;
  });
  let clients = [{ id: 'first', name: 'First', command: 'node', startupArgs: [] }];
  registerAgentClientLibraryRoutes(app, {
    inventory: store,
    packages,
    registry: new SessionImplementationRegistry(),
    configuration: { readConfig: async () => JSON.stringify(clients) },
  });
  t.after(() => app.close());
  const read = () =>
    app.inject({
      url: '/api/agent-providers',
      headers: { host: 'localhost:4312', 'x-test-session-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user' },
    });
  return { app, read, packages, store, setClients: (value: typeof clients) => (clients = value) };
}

test('16 unrelated archives stay below the browser deadline without executable staging', async (t) => {
  const h = await fixture(t, { count: 16, files: 175 });
  const staged = t.mock.method(h.packages, 'resolveInstalledPackage');
  const before = await readdir(h.packages.packagesRoot);
  const started = performance.now();
  const response = await h.read();
  const elapsed = performance.now() - started;
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { libraries: [] });
  assert.equal(staged.mock.callCount(), 0, 'listing absent declarations must not prepare executable trees');
  assert.ok(elapsed < 30_000, `catalog exceeded the real browser deadline: ${elapsed} ms`);
  assert.deepEqual(await readdir(h.packages.packagesRoot), before);
  t.diagnostic(`16 archives / 2816 files: ${Math.round(elapsed)} ms`);
});

test('a declared library retains full admission, disabled availability and fresh configuration', async (t) => {
  const h = await fixture(t, { declaration: true });
  const staged = t.mock.method(h.packages, 'resolveInstalledPackage');
  const first = (await h.read()).json().libraries;
  assert.equal(first[0]?.configurationKey, 'clients', JSON.stringify(first));
  assert.deepEqual(first[0].clients, [
    { id: 'first', name: 'First', ref: 'plugin:local.catalog-0/first', available: false },
  ]);
  h.setClients([{ id: 'second', name: 'Changed', command: 'node', startupArgs: [] }]);
  assert.equal((await h.read()).json().libraries[0]?.clients[0]?.id, 'second');
  assert.equal(staged.mock.callCount(), 2);
});

test('bad archive digests reject without falling back to executable staging', async (t) => {
  const h = await fixture(t);
  const snapshot = await h.store.snapshot();
  const digest = snapshot.packages[0]!.packageDigest;
  await appendFile(join(h.packages.packageRoot(digest), 'package.tgz'), Buffer.from([0]));
  const staged = t.mock.method(h.packages, 'resolveInstalledPackage');
  const response = await h.read();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().libraries.length, 1);
  assert.match(response.json().libraries[0].error, /digest/);
  assert.equal(staged.mock.callCount(), 0);
});

test('a static manifest mismatch cannot silently omit a package', async (t) => {
  const h = await fixture(t);
  await h.store.transaction(({ packages }) => {
    const record = packages.list()[0]!;
    packages.put({ ...record, manifest: { ...record.manifest!, name: 'Changed inventory identity' } });
  });
  const response = await h.read();
  assert.match(response.json().libraries[0]?.error, /权威不一致/);
});

test('a declared archive changed after static discovery still fails full admission', async (t) => {
  const h = await fixture(t, { declaration: true });
  const original = h.packages.readInstalledStaticFile.bind(h.packages);
  t.mock.method(h.packages, 'readInstalledStaticFile', async (...args: Parameters<typeof original>) => {
    const file = await original(...args);
    await appendFile(join(h.packages.packageRoot(args[0]), 'package.tgz'), Buffer.from([0]));
    return file;
  });
  const response = await h.read();
  assert.deepEqual(response.json().libraries[0].clients, []);
  assert.match(response.json().libraries[0].error, /digest/);
});

test('unauthenticated reads do not inspect archives', async (t) => {
  const h = await fixture(t);
  const reads = t.mock.method(h.packages, 'readInstalledStaticFile');
  assert.equal((await h.app.inject('/api/agent-providers')).statusCode, 401);
  assert.equal(reads.mock.callCount(), 0);
});
