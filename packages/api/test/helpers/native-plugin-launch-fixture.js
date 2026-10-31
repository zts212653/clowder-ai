import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { PluginRuntimeCarrierRouter } from '../../dist/domains/plugin/carrier/runtime-carrier.js';

export const policy = (overrides = {}) => ({
  mode: 'plugin_native',
  pluginInstanceId: 'instance-a',
  contributionId: 'native',
  ...overrides,
});

export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-native-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/mcp.js'), 'process.exit(0);\n');
  const manifest = {
    pluginId: 'dev.clowder.native-launch-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Native launch fixture',
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'mcp', id: 'native' }],
      },
    ],
    contributions: [
      {
        type: 'mcp',
        id: 'native',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js', args: ['--fixture'] },
      },
    ],
  };
  const validation = validateManifest(manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const digest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const instance = {
    pluginInstanceId: 'instance-a',
    pluginId: manifest.pluginId,
    packageDigest: digest,
    lifecycleRevision: 1,
    activationState: 'enabled',
    lifecycleState: 'installed',
    configReadiness: 'ready',
  };
  const packageRecord = { pluginId: manifest.pluginId, packageDigest: digest, packageState: 'installed', manifest };
  const snapshot = { instances: [instance], packages: [packageRecord] };
  let config = { version: 1, capabilities: [] };
  let beforeSnapshot = async () => {};
  let beforeConfigWrite = async () => {};
  const router = new PluginRuntimeCarrierRouter(
    {
      snapshot: async () => {
        await beforeSnapshot();
        return structuredClone(snapshot);
      },
    },
    {
      projectRoot: root,
      persistCapabilities: options.persistCapabilities ?? true,
      packages: {
        resolveInstalledPackage: async (digest) => ({
          rootDir: packageRoot,
          manifest: structuredClone(snapshot.packages.find((record) => record.packageDigest === digest).manifest),
          verifyIntegrity: async () => {},
          release: async () => {},
        }),
      },
      configuration: { resolve: async () => ({}) },
      mcpConfigIO: {
        readConfig: async () => config,
        withLock: async (fn) => fn(),
        writeAndRegenCli: async (next) => {
          await beforeConfigWrite();
          config = structuredClone(next);
        },
      },
    },
  );
  router.register({
    claims: () => true,
    start: async () => {},
    stop: async () => {},
    stopAll: async () => {},
    invoke: async () => ({}),
  });
  t.after(() => router.stopAll('test_cleanup'));
  return {
    router,
    instance,
    packageRecord,
    snapshot,
    config: () => config,
    pauseSnapshot: (fn) => {
      beforeSnapshot = fn;
    },
    pauseConfigWrite: (fn) => {
      beforeConfigWrite = fn;
    },
    ready: async () => {
      await router.start(instance.pluginInstanceId);
      return router.resolveNativeMcpLaunch(policy());
    },
  };
}
