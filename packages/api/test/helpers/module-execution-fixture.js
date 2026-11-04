import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledPluginRuntimeCarrier } from '../../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { MemoryPluginInventoryStore } from '../../dist/domains/plugin/host-inventory/stores.js';

export async function executionFixture(t, source, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task229-execution-authority-'));
  const cleanup = {};
  t.after(async () => {
    try {
      try {
        await cleanup.carrier?.stop('instance', 'test-cleanup');
      } finally {
        await cleanup.runtime?.stop('instance', 'test-cleanup');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'dist/plugin.js'), source);
  const manifest = {
    pluginId: 'dev.clowder.execution-authority',
    name: 'Execution authority fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['plugin.state.get', 'plugin.state.set'] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    configuration: options.configuration ?? [],
    ...(options.manifest ?? {}),
  };
  const record = {
    packageDigest: `sha512-${createHash('sha512').update(source).digest('base64')}`,
    pluginId: manifest.pluginId,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    manifest,
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 1,
    updatedAt: 1,
  };
  const inventory = new MemoryPluginInventoryStore({
    schemaVersion: 1,
    packages: [record],
    instances: [
      {
        pluginInstanceId: 'instance',
        pluginId: manifest.pluginId,
        packageDigest: record.packageDigest,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
  });
  const events = [];
  const writes = [];
  const runtime = new ModulePluginRuntime({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: root,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: { readConfig: options.readConfig ?? (async () => undefined), readSecret: async () => undefined },
    ...(options.neutral ? { neutral: options.neutral } : {}),
    dataDirectoryParent: join(root, 'data'),
    storage: options.storage ?? {
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
      async set(pluginId, key, value) {
        writes.push({ pluginId, key, value });
        return { revision: writes.length };
      },
      async compareAndSet() {
        throw new Error('unused fixture CAS');
      },
      async delete() {
        throw new Error('unused fixture delete');
      },
    },
    log: (_level, message, fields) => events.push({ message, fields }),
  });
  const carrier = new BundledPluginRuntimeCarrier({ inventory, runtimes: [runtime] });
  Object.assign(cleanup, { runtime, carrier });
  return { runtime, carrier, inventory, record, events, writes, manifest };
}
