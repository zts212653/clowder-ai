/** Stable module dataPath, declared directory admission and uninstall stop-failure behavior.
 * Directory allocation is lifecycle context and requires no additional grant. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { pluginDataDirectoryParent } from '../dist/domains/plugin/host-surface/plugin-data-directory.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  PluginLifecycleError,
} from '../dist/domains/plugin/index.js';
import { workerObservation } from './helpers/worker-observation.js';

const roots = [];
const runtimes = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const moduleSource = (observation, stopControl) => `
${observation.source}
import { statSync } from 'node:fs';
import { join } from 'node:path';
export default {
  create() {
    return {
      async start(host) {
        const entry = { call: 'start', dataPath: host.dataPath };
        if (host.dataPath !== undefined) {
          entry.mode = statSync(host.dataPath).mode & 0o777;
          writeFileSync(join(host.dataPath, 'pairing.json'), '{}');
        }
        state.log.push(entry);
        saveState();
        return {
          actions: {},
          async stop({ reason }) {
            state.log.push({ call: 'stop', reason });
            saveState();
            const failures = Number(readFileSync(${JSON.stringify(stopControl)}, 'utf8'));
            if (failures > 0) {
              writeFileSync(${JSON.stringify(stopControl)}, String(failures - 1));
              throw new Error('module refused to stop');
            }
          },
        };
      },
    };
  },
};
`;

function manifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.h2-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'H2 fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js', dataDirectory: 'personal-chrome-host' },
    ...overrides,
  };
}

const digestOf = (seed) => `sha512-${createHash('sha512').update(seed).digest('base64')}`;
const lifecycleError = (code) => (error) => error instanceof PluginLifecycleError && error.code === code;

async function tempDir(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function harness({ packageManifest = manifest() } = {}) {
  let now = 1_000;
  const projectRoot = await tempDir('f202-h2-project-');
  const rootDir = await tempDir('f202-h2-package-');
  const observation = workerObservation(join(projectRoot, 'worker-observation.json'), { log: [] });
  const stopControl = join(projectRoot, 'stop-failures.txt');
  await writeFile(stopControl, '0');
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await writeFile(join(rootDir, 'dist/plugin.js'), moduleSource(observation, stopControl), 'utf8');
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_h2', now: () => now++ });
  await inventory.installPackage({
    manifest: packageManifest,
    computedPackageDigest: digestOf(rootDir),
    expectedPackageDigest: digestOf(rootDir),
    packagePluginId: packageManifest.pluginId,
  });
  const released = [];
  const moduleRuntime = new ModulePluginRuntime({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir,
        manifest: packageManifest,
        verifyIntegrity: async () => {},
        release: async () => {
          released.push('released');
        },
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    dataDirectoryParent: pluginDataDirectoryParent(projectRoot),
    log: () => {},
  });
  runtimes.push({ shutdown: () => moduleRuntime.stop('pi_h2', 'test_done') });
  const router = new PluginRuntimeCarrierRouter(store);
  router.register(new BundledPluginRuntimeCarrier({ inventory: store, runtimes: [moduleRuntime], now: () => now++ }));
  const lifecycle = new ExternalPluginLifecycleService({ store, supervisor: router, now: () => now++ });
  const directory = join(pluginDataDirectoryParent(projectRoot), 'personal-chrome-host');
  const enable = async () => {
    const prepared = await lifecycle.prepare('pi_h2', 1);
    return lifecycle.enable('pi_h2', prepared.lifecycleRevision);
  };
  return {
    store,
    lifecycle,
    released,
    directory,
    enable,
    log: () => observation.read().log,
    failNextStop: () => writeFile(stopControl, '1'),
  };
}

test('⑥ a stop that fails during uninstall is retried by the next uninstall, not forgotten', async () => {
  const h = await harness();
  const enabled = await h.enable();
  await h.failNextStop();

  await assert.rejects(h.lifecycle.uninstall('pi_h2', enabled.lifecycleRevision), lifecycleError('STOP_FAILED'));
  const failed = (await h.store.snapshot()).instances[0];
  assert.equal(failed.activationState, 'error');
  assert.equal(h.released.length, 1, 'the cleanup steps that succeeded are not repeated');

  const retired = await h.lifecycle.uninstall('pi_h2', failed.lifecycleRevision);

  assert.deepEqual(
    h
      .log()
      .filter((entry) => entry.call === 'stop')
      .map((entry) => entry.reason),
    ['owner_uninstalled', 'owner_uninstalled'],
    'the retry must stop the module again',
  );
  assert.equal(h.released.length, 2);
  assert.equal(retired.lifecycleState, 'retired');
});

test('a granted module gets its data directory, created 0700 before it starts', async () => {
  const h = await harness();

  await h.enable();

  const start = h.log().find((entry) => entry.call === 'start');
  assert.equal(start.dataPath, h.directory);
  assert.equal(start.mode, 0o700);
});

test('an existing directory is kept and tightened to 0700', async () => {
  const h = await harness();
  await mkdir(h.directory, { recursive: true, mode: 0o755 });
  await chmod(h.directory, 0o755);
  await writeFile(join(h.directory, 'pairing.json'), '{"kept":true}');

  await h.enable();

  assert.equal(h.log().find((entry) => entry.call === 'start').mode, 0o700);
});

test('dataPath is injected without a separate capability grant', async () => {
  const h = await harness();

  await h.enable();

  assert.equal(h.log().find((entry) => entry.call === 'start').dataPath, h.directory);
  assert.equal((await stat(h.directory)).isDirectory(), true);
});

test('uninstall keeps the directory and what the module wrote there', async () => {
  const h = await harness();
  const enabled = await h.enable();

  await h.lifecycle.uninstall('pi_h2', enabled.lifecycleRevision);

  assert.equal(await readFile(join(h.directory, 'pairing.json'), 'utf8'), '{}');
});

test('anything but a real directory at that path fails the start closed', async () => {
  for (const occupy of [
    (path) => writeFile(path, 'not a directory'),
    async (path) => symlink(await tempDir('f202-h2-elsewhere-'), path),
  ]) {
    const h = await harness();
    await mkdir(dirname(h.directory), { recursive: true });
    await occupy(h.directory);

    await assert.rejects(h.enable());

    assert.equal(
      h.log().some((entry) => entry.call === 'start'),
      false,
    );
  }
});

test('the production composition gives a granted module its directory under the project', async () => {
  const projectRoot = await tempDir('f202-h2-composition-');
  const packageRoot = await tempDir('f202-h2-composition-package-');
  const observation = workerObservation(join(projectRoot, 'worker-observation.json'), { log: [] });
  const stopControl = join(projectRoot, 'stop-failures.txt');
  await writeFile(stopControl, '0');
  const source = moduleSource(observation, stopControl);
  const packageManifest = manifest({
    pluginId: 'dev.clowder.h2-composed',
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js', dataDirectory: 'h2-composed' },
  });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest)}\n`, 'utf8');
  await writeFile(join(packageRoot, 'dist/plugin.js'), source, 'utf8');
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    contract: { manifestContractRange: '0.1.0', validateManifest },
  });
  runtimes.push(runtime);
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });

  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const detail = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: detail.lifecycleRevision,
  });

  const directory = join(projectRoot, '.cat-cafe', 'plugin-host', 'h2-composed');
  assert.equal(observation.read().log.find((entry) => entry.call === 'start')?.dataPath, directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);

  // A second local package that wants the same directory is refused, and the owner is told why.
  const rivalRoot = await tempDir('f202-h2-composition-rival-');
  await mkdir(join(rivalRoot, 'dist'), { recursive: true });
  await writeFile(
    join(rivalRoot, 'manifest.json'),
    `${JSON.stringify({ ...packageManifest, pluginId: 'dev.clowder.h2-rival' })}\n`,
  );
  await writeFile(join(rivalRoot, 'dist/plugin.js'), source, 'utf8');
  await assert.rejects(
    composition.manager.install({ source: { kind: 'local-directory', path: rivalRoot } }),
    (error) => error?.code === 'DATA_DIRECTORY_IN_USE' && error.message.includes('dev.clowder.h2-composed'),
  );
});
