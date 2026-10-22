import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';
import {
  GitMarketplaceCatalog,
  validMarketplacePackages,
} from '../dist/domains/plugin/manager/marketplace/git-marketplace-catalog.js';
import { GitMarketplaceRepository } from '../dist/domains/plugin/manager/marketplace/git-marketplace-repository.js';
import { GitMarketplaceSources } from '../dist/domains/plugin/manager/marketplace/git-marketplace-sources.js';
import { PluginManagerService } from '../dist/domains/plugin/manager/plugin-manager-service.js';
import { registerPluginMarketplaceRoutes } from '../dist/routes/plugin-marketplace-routes.js';
import { manifest } from './plugin-official-package-installer.fixture.js';

const exec = promisify(execFile);
async function fixture(t, prepare) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'remote');
  await mkdir(join(upstream, 'packages/demo/dist'), { recursive: true });
  const git = (...args) => exec('git', args, { cwd: upstream });
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Marketplace test');
  await git('config', 'user.email', 'test@example.invalid');
  const publish = async (version) => {
    const value = manifest({
      pluginId: 'example.marketplace',
      version,
      signals: undefined,
      icon: { type: 'svg', src: 'assets/icon.svg' },
    });
    await mkdir(join(upstream, 'packages/demo/assets'), { recursive: true });
    await writeFile(join(upstream, 'packages/demo/assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(upstream, 'packages/demo/README.md'), '# Repository plugin\n');
    await writeFile(join(upstream, 'packages/demo/plugin.yaml'), JSON.stringify(value));
    await writeFile(
      join(upstream, 'packages/demo/package.json'),
      JSON.stringify({
        name: '@example/demo',
        version,
        type: 'module',
        files: ['plugin.yaml', 'dist', 'assets', 'README.md'],
      }),
    );
    await writeFile(join(upstream, 'packages/demo/dist/entrypoint.js'), '// fixture\n');
    await git('add', '.');
    await git('commit', '-m', version);
  };
  await publish('1.0.0');
  const repository = new GitMarketplaceRepository({ cacheRoot: join(root, 'clones') });
  const refreshErrors = new Map();
  const refresh = repository.refresh.bind(repository);
  repository.refresh = async (...args) => {
    try {
      const result = await refresh(...args);
      refreshErrors.delete(args[0]);
      return result;
    } catch (error) {
      refreshErrors.set(args[0], error);
      throw error;
    }
  };
  const sources = new GitMarketplaceSources({
    path: join(root, 'sources.json'),
    repository,
    officialUrl: 'file:///not-present-official-test',
    validateCatalog: validMarketplacePackages,
  });
  const url = pathToFileURL(upstream).href;
  await sources.add(url);
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_repo', now: () => 10 });
  const admission = new LocalPluginPackageAdmission({
    inventory,
    packagesRoot: join(root, 'installed'),
    grantPolicy: () => [],
  });
  const base = { snapshot: async () => ({ status: 'fresh', refreshedAt: 10, candidates: [] }) };
  const catalog = new GitMarketplaceCatalog({ base, sources, repository, localAdmission: admission, prepare });
  return { root, upstream, git, url, publish, repository, sources, store, catalog, refreshErrors };
}

test('local catalog projection delegates to the Host bundle without touching repository sources', async () => {
  let remoteReads = 0;
  let localReads = 0;
  let sourceReads = 0;
  const bundled = {
    catalogId: 'chatgpt-dot',
    pluginId: 'official.chatgpt-dot',
    packageName: '@clowder-ai/chatgpt-dot',
    version: '0.1.0',
    packageDigest: 'sha512-bundled',
    displayName: 'ChatGPT Dot',
    ownerAuthRequired: false,
    capabilities: [],
  };
  const catalog = new GitMarketplaceCatalog({
    base: {
      snapshot: async () => {
        remoteReads += 1;
        return new Promise(() => {});
      },
      localSnapshot: async () => {
        localReads += 1;
        return { candidates: [bundled], status: 'stale', refreshedAt: null };
      },
    },
    sources: {
      catalogs: async () => {
        sourceReads += 1;
        return [];
      },
      list: async () => {
        sourceReads += 1;
        return [];
      },
    },
    repository: {},
    localAdmission: {},
  });

  const snapshot = await catalog.localSnapshot();

  assert.equal(remoteReads, 0);
  assert.equal(localReads, 1);
  assert.equal(sourceReads, 0);
  assert.deepEqual(snapshot.candidates, [bundled]);
});

test('repository metadata, icon, directory install and later pull share the existing inventory', async (t) => {
  const f = await fixture(t);
  const candidate = (await f.catalog.snapshot()).candidates[0];
  assert.equal(candidate.pluginId, 'example.marketplace');
  assert.equal(candidate.packageDigest, null);
  assert.equal((await f.catalog.readIcon(candidate.pluginId)).contentType, 'image/svg+xml');
  assert.equal(await f.catalog.readReadme(candidate.pluginId), '# Repository plugin\n');
  const selection = candidate.directorySource.marketplace;
  await assert.rejects(f.catalog.install(f.url, { ...selection, pluginId: 'wrong.plugin' }), /selection/);
  assert.equal((await f.store.snapshot()).instances.length, 0);
  const installed = await f.catalog.install(f.url, selection);
  assert.equal(installed.pluginInstanceId, 'pi_repo');
  const inventory = await f.store.snapshot();
  assert.equal(inventory.instances[0].activationState, 'disabled');
  await f.publish('1.1.0');
  const refreshedSources = await f.sources.refresh();
  assert.equal(
    refreshedSources.find((source) => source.url === f.url).status,
    'ready',
    f.refreshErrors.get(f.url)?.stack,
  );
  assert.equal((await f.catalog.snapshot()).candidates[0].version, '1.1.0');
  assert.deepEqual(await f.store.snapshot(), inventory, 'discovery never upgrades the installed package');
  await assert.rejects(f.catalog.install(f.url, selection), /changed/);
  await f.sources.remove(selection.sourceId);
  assert.equal((await f.catalog.snapshot()).candidates.length, 0);
  assert.deepEqual(await f.store.snapshot(), inventory, 'removing a source keeps installed packages and data');
});

test('ordinary version update resolves the repository internally and retains instance identity', async (t) => {
  const f = await fixture(t);
  const initial = (await f.catalog.snapshot()).candidates[0];
  await f.catalog.install(f.url, initial.directorySource.marketplace);
  const manager = new PluginManagerService({
    catalog: f.catalog,
    inventory: f.store,
    installer: {
      install: async ({ request }) => {
        assert.equal(request.source.kind, 'git');
        const installed = await f.catalog.install(request.source.url, request.source.marketplace);
        return { pluginId: initial.pluginId, pluginInstanceId: installed.pluginInstanceId };
      },
    },
  });
  assert.equal((await manager.get(initial.pluginId)).plugin.actions.install, false);
  await f.publish('1.1.0');
  await f.sources.refresh();
  const newer = (await manager.get(initial.pluginId)).plugin;
  assert.equal(newer.actions.install, true);
  assert.equal(newer.source.url, f.url);
  assert.equal(Object.hasOwn(newer, 'installSources'), false);
  await assert.rejects(
    manager.update(initial.pluginId, { expectedVersion: '1.0.0', expectedRevision: newer.lifecycleRevision }),
  );
  const updated = await manager.update(initial.pluginId, {
    expectedVersion: newer.availableVersion,
    expectedRevision: newer.lifecycleRevision,
  });
  assert.equal(updated.pluginInstanceId, 'pi_repo');
  assert.equal((await manager.get(initial.pluginId)).plugin.installedVersion, '1.1.0');
  assert.equal((await manager.get(initial.pluginId)).plugin.actions.install, false);
});

test('repository API requires the existing owner/local boundary and only refresh mutates the checkout', async (t) => {
  const f = await fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  registerPluginMarketplaceRoutes(app, f.sources);
  const read = { host: 'localhost:3004', 'x-test-session-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user' };
  const write = { ...read, origin: 'http://localhost:5173' };
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugin-manager/marketplaces' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/plugin-manager/marketplaces/refresh',
        headers: { ...write, origin: 'https://outside.example' },
      })
    ).statusCode,
    403,
  );
  const before = (await f.sources.catalogs())[0].source.commit;
  await f.publish('1.2.0');
  const listed = await app.inject({ method: 'GET', url: '/api/plugin-manager/marketplaces', headers: read });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().sources.find((s) => s.origin === 'user').commit, before);
  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/plugin-manager/marketplaces/refresh',
    headers: write,
  });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(
    refreshed.json().sources.find((source) => source.url === f.url).status,
    'ready',
    f.refreshErrors.get(f.url)?.stack,
  );
  assert.notEqual(refreshed.json().sources.find((s) => s.origin === 'user').commit, before);
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/plugin-manager/marketplaces',
    headers: write,
    payload: { url: 'ext::sh -c invalid' },
  });
  assert.equal(rejected.statusCode, 422);
  assert.equal((await f.sources.list()).length, 2);
});

test('repository preparation cannot substitute a different plugin or version after selection', async (t) => {
  for (const change of [{ pluginId: 'example.other' }, { version: '9.0.0' }]) {
    const f = await fixture(t, async (directory) => {
      const manifestPath = join(directory, 'plugin.yaml');
      const packagePath = join(directory, 'package.json');
      const value = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
      const metadata = JSON.parse(await (await import('node:fs/promises')).readFile(packagePath, 'utf8'));
      Object.assign(value, change);
      if (change.version) metadata.version = change.version;
      await writeFile(manifestPath, JSON.stringify(value));
      await writeFile(packagePath, JSON.stringify(metadata));
    });
    const candidate = (await f.catalog.snapshot()).candidates[0];
    await assert.rejects(f.catalog.install(f.url, candidate.directorySource.marketplace), /selected package identity/);
    assert.equal((await f.store.snapshot()).instances.length, 0);
  }
});

test('strict manifest rejection keeps the last-good catalog installable after history rewrite', async (t) => {
  const f = await fixture(t);
  const before = (await f.catalog.snapshot()).candidates[0];
  await f.git('checkout', '--orphan', 'rewritten');
  await f.publish('2.0.0');
  await f.git('branch', '-M', 'main');
  await writeFile(join(f.upstream, 'packages/demo/plugin.yaml'), JSON.stringify({ pluginId: 'invalid' }));
  await f.git('add', '.');
  await f.git('commit', '-m', 'invalid manifest');
  await f.sources.refresh();
  const degraded = await f.catalog.snapshot();
  assert.equal(degraded.status, 'degraded');
  assert.deepEqual(degraded.candidates, [before]);
  const installed = await f.catalog.install(f.url, before.directorySource.marketplace);
  assert.equal(installed.pluginInstanceId, 'pi_repo');
  await f.publish('2.1.0');
  const recovered = await f.sources.refresh();
  assert.equal(recovered.find((source) => source.url === f.url).status, 'ready');
  assert.equal((await f.catalog.snapshot()).candidates[0].version, '2.1.0');
});
