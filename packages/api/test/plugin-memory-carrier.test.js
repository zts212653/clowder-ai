import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryDescriptor } from '@clowder-ai/plugin-memory-contract';
import Fastify from 'fastify';
import { resolveMemoryDataLocations } from '../dist/config/memory-data-locations.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryPluginHost } from '../dist/domains/plugin/host-surface/memory-plugin-host.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { prepareHostInitialPlugins } from '../dist/domains/plugin/manager/initial-plugin-installation.js';
import { memoryRoutes } from '../dist/routes/memory.js';
import { createMemoryRouteProvider } from '../dist/routes/memory-route-provider.js';
import { catalogEntry, manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

const pluginId = 'official.memory';
const packageName = '@clowder-ai/memory-plugin';

test('the Manager updates a memory worker and restores the previous worker with the same thread data after rejection', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'memory-carrier-'));
  const app = Fastify();
  const provider = new MemoryPluginHost();
  const threads = new ThreadStore();
  const evidenceDbPath = join(projectRoot, 'evidence.sqlite');
  const memoryData = resolveMemoryDataLocations({ sqlitePath: evidenceDbPath, dataDir: join(projectRoot, 'data') });
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    threadStore: threads,
    threadOwnerUserId: 'owner',
    memory: { provider, evidenceDbPath, data: memoryData, ephemeral: true },
  });
  t.after(async () => {
    await app.close();
    await runtime.shutdown('test');
    await rm(projectRoot, { recursive: true, force: true });
  });
  await app.register(memoryRoutes, {
    memoryStore: createMemoryRouteProvider(provider),
    deploymentOwnerUserId: 'owner',
    threadStore: threads,
  });

  const artifacts = new Map();
  let published;
  async function publish(version, storageFormat = 1) {
    const archive = await packageArchive({
      packageManifest: manifest({
        pluginId,
        version,
        name: 'Memory',
        signals: undefined,
        features: [{ id: 'memory', name: 'Memory', resources: [], capabilities: [] }],
        runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js', dataDirectory: 'memory' },
      }),
      includeSchema: false,
      extraFiles: {
        'package.json': JSON.stringify({ name: packageName, version, type: 'module' }),
        'dist/entrypoint.js': `
          export default {create() {return {async start(host) {
            if (host.memoryDatabase.canonicalPath !== ${JSON.stringify(evidenceDbPath)}) throw Error('wrong database');
            if (host.memoryData.eventDbPath !== ${JSON.stringify(memoryData.eventDbPath)}) throw Error('wrong event store');
            if (host.memoryData.globalDbPath !== ${JSON.stringify(memoryData.globalDbPath)}) throw Error('wrong global store');
            if (!host.dataPath || host.memoryData.dataDir === host.dataPath) throw Error('deployment paths must stay canonical');
            return {actions: {
              'memory.describe'() { return ${JSON.stringify({ ...memoryDescriptor(), storageFormat })}; },
              async 'memory.dispatch'({operation, input}) {
                const {threadRef, key, value, updatedBy} = input;
                if (operation === 'kv.get') return JSON.parse(await host.memoryThreadKv.get(threadRef, key));
                const entry = { key, value, updatedBy, threadId: threadRef, updatedAt: 5 };
                const expected = await host.memoryThreadKv.list(threadRef);
                if (!await host.memoryThreadKv.compareAndSet(threadRef, expected, {set: {key, value: JSON.stringify(entry)}})) {
                  throw Error('unexpected test contention');
                }
                return entry;
              },
            }, async stop(){}};
          }}}};`,
      },
    });
    const archiveUrl = `https://registry.npmjs.org/@clowder-ai/memory-plugin/-/memory-plugin-${version}.tgz`;
    artifacts.set(archiveUrl, archive.bytes);
    published = catalogEntry(archive.integrity, {
      pluginId,
      catalogId: pluginId,
      packageName,
      version,
      archiveUrl,
      presentation: { displayName: 'Memory', publisher: 'Clowder AI' },
    });
    return archive;
  }
  const catalog = { snapshot: async () => ({ entries: [published], status: 'fresh', checkedAt: 100 }) };
  const managerRuntime = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: catalog,
    catalogManifests: [],
    threads,
    fetchOfficialArchive: async (entry) => artifacts.get(entry.archiveUrl),
  });
  const { manager } = managerRuntime;
  const read = async (key) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/memory?threadId=default&key=${key}`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().value;
  };
  const write = async (key, value) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { threadId: 'default', key, value, updatedBy: 'user' },
    });
    assert.equal(response.statusCode, 201, response.body);
  };

  const a = await publish('0.1.0');
  const first = await prepareHostInitialPlugins({
    runtime,
    managerRuntime,
    catalog,
    signal: new AbortController().signal,
    hostListening: Promise.resolve(),
    loadSelection: async () => ({ schemaVersion: 1, plugins: [] }),
    onFailure: (_id, error) => {
      throw error;
    },
  });
  await first.activate();
  const installed = (await manager.get(pluginId)).plugin;
  assert.equal(installed.live, 'running');
  await write('before', 'A');

  await publish('0.2.0');
  await manager.update(pluginId, { expectedVersion: '0.2.0', expectedRevision: installed.lifecycleRevision });
  const updated = (await manager.get(pluginId)).plugin;
  assert.equal(updated.pluginInstanceId, installed.pluginInstanceId);
  assert.equal(updated.installedVersion, '0.2.0');
  assert.equal(updated.live, 'running');
  assert.equal(await read('before'), 'A');
  await write('after', 'B');

  await publish('0.3.0', 2);
  assert.equal((await manager.get(pluginId)).plugin.availableVersion, '0.3.0');
  await assert.rejects(
    manager.update(pluginId, { expectedVersion: '0.3.0', expectedRevision: updated.lifecycleRevision }),
  );
  const restored = (await manager.get(pluginId)).plugin;
  assert.equal(restored.installedVersion, '0.2.0');
  assert.equal(restored.live, 'running');
  assert.equal(await read('after'), 'B');

  const path = join(projectRoot, 'verified-a.tgz');
  await writeFile(path, a.bytes);
  const source = { kind: 'local-archive', path };
  let replacement;
  await assert.rejects(manager.install({ source }), (error) => {
    assert.equal(error.code, 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED');
    replacement = error.replacement.confirmation;
    assert.equal(replacement.candidatePackageDigest, a.integrity);
    assert.equal(replacement.pluginInstanceId, installed.pluginInstanceId);
    return true;
  });
  await manager.install({ source, replacement });
  const rolledBack = (await manager.get(pluginId)).plugin;
  assert.equal(rolledBack.installedVersion, '0.1.0');
  assert.equal(rolledBack.live, 'running');
  assert.equal(await read('before'), 'A');
  assert.equal(await read('after'), 'B');
  await write('after-rollback', 'A again');
});
