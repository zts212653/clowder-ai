import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { prepareHostInitialPlugins } from '../dist/domains/plugin/manager/initial-plugin-installation.js';
import { registerPluginRuntimeShutdown } from '../dist/routes/plugin-runtime-shutdown.js';
import { catalogEntry, manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

test('a failed initial stop still invokes final runtime shutdown and rejects Host close', async () => {
  const app = Fastify();
  let finalStops = 0;
  registerPluginRuntimeShutdown(
    app,
    {
      shutdown: async () => {
        finalStops++;
      },
    },
    async () => {
      throw new Error('initial cleanup failed');
    },
  );
  await app.ready();
  await assert.rejects(app.close(), /initial cleanup failed/);
  assert.equal(finalStops, 1);
});

for (const heldStage of ['discovery', 'archive', 'activation'])
  test(`Host shutdown cancels pending ${heldStage} and drains any admitted write before final stop`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'initial-shutdown-'));
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const gateKey = `initial_shutdown_${randomUUID()}`;
    globalThis[gateKey] = { entered, release };
    const archive = await packageArchive({
      packageManifest: manifest({
        signals: undefined,
        features: [{ id: 'core', name: 'Core', resources: [], capabilities: [] }],
        runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js' },
      }),
      extraFiles: {
        'dist/entrypoint.js':
          heldStage === 'activation'
            ? `export default {create(){return {async start(){const gate=globalThis[${JSON.stringify(gateKey)}];gate.entered.resolve();await gate.release.promise;return {actions:{},async stop(){}}}}}};`
            : 'export default {create(){return {async start(){return {actions:{},async stop(){}}}}}};',
      },
    });
    const entry = catalogEntry(archive.integrity, {});
    const catalog = { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 1 }) };
    const runtime = createDormantPluginRuntimeComposition({ projectRoot: root, messageStore: new MessageStore() });
    const managerRuntime = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: catalog,
      catalogManifests: [],
      fetchOfficialArchive: async () => {
        if (heldStage === 'archive') {
          entered.resolve();
          await release.promise;
        }
        return archive.bytes;
      },
    });
    const controller = new AbortController();
    const app = Fastify();
    let task = Promise.resolve();
    registerPluginRuntimeShutdown(app, runtime, async () => {
      controller.abort();
      const results = await Promise.allSettled([runtime.supervisor.stopAll('api_shutdown'), task]);
      const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Initial plugin shutdown failed');
    });
    task = prepareHostInitialPlugins({
      runtime,
      managerRuntime,
      catalog,
      hostListening: Promise.resolve(),
      signal: controller.signal,
      loadSelection: async () => {
        if (heldStage === 'discovery') {
          entered.resolve();
          await release.promise;
        }
        return { schemaVersion: 1, plugins: [{ pluginId: entry.pluginId, enabled: true }] };
      },
      onFailure: (_id, error) => {
        throw error;
      },
    })
      .then((prepared) => prepared.activate())
      .catch((error) => {
        if (!controller.signal.aborted) throw error;
      });
    try {
      await entered.promise;
      await app.ready();
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      if (heldStage === 'discovery') {
        await closing;
        release.resolve();
      } else {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(closed, false, 'an in-flight admission must finish before shutdown reports complete');
        release.resolve();
        await closing;
      }
      await task;
      const inventory = await runtime.inventoryStore.snapshot();
      assert.equal(inventory.instances.length, heldStage === 'discovery' ? 0 : 1);
      for (const instance of inventory.instances) {
        assert.equal(instance.activationState, heldStage === 'activation' ? 'error' : 'disabled');
        assert.equal(instance.runtimeState, 'stopped');
      }
      if (heldStage !== 'discovery') {
        const journal = JSON.parse(
          await readFile(join(root, '.cat-cafe/plugin-host/initial-installation.json'), 'utf8'),
        );
        assert.equal(journal.plugins[0].done, false, 'cancellation must leave the journal resumable');
        assert.ok(journal.plugins[0].instanceId, 'an admitted package keeps its receipt');
      }
    } finally {
      release.resolve();
      controller.abort();
      await task;
      await app.close();
      await runtime.shutdown('test_cleanup');
      delete globalThis[gateKey];
    }
  });
