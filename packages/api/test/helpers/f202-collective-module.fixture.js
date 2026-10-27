import { cp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parse } from 'yaml';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { ModulePluginRuntime } from '../../src/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { createCollectiveArtifactOwnerProxy } from '../../src/domains/plugin/host-surface/collective-artifact-owner.js';
import { collectivePackageRoot } from './f202-collective-installed-business.js';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** Starts the archive's actual entrypoint through the Host module carrier.
 * Only isolated fixture state is seeded; the retained Host owner remains outside the package.
 */
export async function collectiveModuleFixture(t, f, owner) {
  const manifest = parse(await readFile(join(collectivePackageRoot, 'plugin.yaml'), 'utf8'));
  const instanceId = 'pi_collective_lifecycle';
  const parent = join(f.root, 'plugin-host');
  const dataPath = join(parent, manifest.runtime.dataDirectory);
  await cp(join(f.root, 'connector'), join(dataPath, 'connector'), { recursive: true });
  const port = await unusedPort();
  const entries = new Map();
  const packageRecord = {
    pluginId: manifest.pluginId,
    version: manifest.version,
    manifest,
    packageDigest: 'verified-collective-archive',
    packageState: 'installed',
  };
  const runtime = new ModulePluginRuntime({
    taskStore: new TaskStore(),
    taskOwnerUserId: 'real-local-owner',
    taskThreadStore: new ThreadStore(),
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: collectivePackageRoot,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: {
      readConfig: async (_instance, key) => (key === 'servicePort' ? String(port) : undefined),
      readSecret: async () => undefined,
    },
    storage: {
      get: async (instance, key) => entries.get(`${instance}:${key}`),
      list: async () => ({}),
      set: async (instance, key, value) => {
        const k = `${instance}:${key}`;
        const revision = (entries.get(k)?.revision ?? 0) + 1;
        entries.set(k, { revision, value });
        return { revision };
      },
      delete: async (instance, key) => ({ deleted: entries.delete(`${instance}:${key}`) }),
      compareAndSet: async (instance, key, expected, value) => {
        const k = `${instance}:${key}`,
          old = entries.get(k);
        if ((old?.revision ?? null) !== expected) return { applied: false };
        const revision = (expected ?? 0) + 1;
        entries.set(k, { revision, value });
        return { applied: true, revision };
      },
    },
    neutral: async (_instance, _digest, assertActivation, signal) => ({
      members: { list: async () => [], get: async () => null },
      collectiveArtifactOwner: createCollectiveArtifactOwnerProxy({
        owner: () => owner,
        assertCurrent: async () => assertActivation(),
        signal,
      }),
    }),
    dataDirectoryParent: parent,
    log: () => {},
  });
  t.after(() => runtime.stop(instanceId, 'fixture complete'));
  return {
    runtime,
    dataPath,
    start: () => runtime.start(instanceId, packageRecord),
    stop: () => runtime.stop(instanceId, 'fixture restart'),
  };
}
