import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';

const policy = (overrides = {}) => ({
  mode: 'plugin_native',
  pluginInstanceId: 'instance-a',
  contributionId: 'native',
  ...overrides,
});

async function fixture(t) {
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
        capabilities: ['task.write'],
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
      packages: {
        resolveInstalledPackage: async () => ({
          rootDir: packageRoot,
          manifest: structuredClone(manifest),
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

test('native launch resolves a frozen exact activation descriptor without trusting ambient MCP configuration', async (t) => {
  const f = await fixture(t);
  const first = await f.ready();
  assert.equal(first.transport, 'stdio');
  assert.equal(first.command, process.execPath);
  assert.equal(first.args[1], '--fixture');
  assert.equal(first.args[0], await realpath(join(first.workingDirectory, 'dist/mcp.js')));
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.args) && Object.isFrozen(first.env));
  assert.deepEqual(f.router.nativeActions.target(first.env.CLOWDER_PLUGIN_ACTION_TOKEN), {
    instanceId: 'instance-a',
    contributionId: 'native',
  });
  assert.equal(
    f.config().capabilities[0].mcpServer.env?.CLOWDER_PLUGIN_ACTION_TOKEN,
    f.router.nativeActions.environmentReferences('instance-a', 'native').CLOWDER_PLUGIN_ACTION_TOKEN,
  );
  assert.equal(
    f.config().capabilities[0].mcpServer.env?.CLOWDER_PLUGIN_ACTION_PATH,
    f.router.nativeActions.environmentReferences('instance-a', 'native').CLOWDER_PLUGIN_ACTION_PATH,
  );
  assert.equal(first.env.CLOWDER_PLUGIN_ACTION_PATH, '/api/plugin-runtime/action');
  const ambient = f.config().capabilities[0];
  ambient.mcpServer.command = '/ambient-command';
  ambient.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN = 'ambient-token';
  f.config().capabilities.push({ ...structuredClone(ambient), id: 'unrelated-server' });
  assert.deepEqual(await f.router.resolveNativeMcpLaunch(policy()), first);
});

test('native launch rejects wrong instance, contribution and invocation mode', async (t) => {
  const f = await fixture(t);
  await f.ready();
  for (const request of [
    policy({ pluginInstanceId: 'instance-b' }),
    policy({ contributionId: 'other' }),
    { mode: 'read_only' },
  ]) {
    await assert.rejects(f.router.resolveNativeMcpLaunch(request));
  }
});

test('native launch rejects inventory lifecycle and package drift from its activation', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const baseline = structuredClone(f.snapshot);
  const restore = () => {
    Object.assign(f.instance, structuredClone(baseline.instances[0]));
    Object.assign(f.packageRecord, structuredClone(baseline.packages[0]));
  };
  for (const mutate of [
    () => {
      f.instance.activationState = 'disabled';
    },
    () => {
      f.instance.lifecycleState = 'uninstalled';
    },
    () => {
      f.instance.configReadiness = 'missing';
    },
    () => {
      f.instance.packageDigest = 'other';
    },
    () => {
      f.packageRecord.packageState = 'quarantined';
    },
    () => {
      f.packageRecord.manifest.contributions[0].runtime.args = ['changed'];
    },
    () => {
      f.packageRecord.manifest.contributions.push(structuredClone(f.packageRecord.manifest.contributions[0]));
    },
  ]) {
    restore();
    mutate();
    await assert.rejects(f.router.resolveNativeMcpLaunch(policy()));
  }
});

test('native launch binds same-plugin instances to distinct Host tokens and never revives stopped descriptors', async (t) => {
  const f = await fixture(t);
  const first = await f.ready();
  f.snapshot.instances.push({ ...f.instance, pluginInstanceId: 'instance-b' });
  await f.router.start('instance-b');
  const second = await f.router.resolveNativeMcpLaunch(policy({ pluginInstanceId: 'instance-b' }));
  assert.notEqual(first.env.CLOWDER_PLUGIN_ACTION_TOKEN, second.env.CLOWDER_PLUGIN_ACTION_TOKEN);
  assert.deepEqual(await f.router.resolveNativeMcpLaunch(policy()), first);
  await f.router.stop('instance-a', 'owner_disabled');
  await assert.rejects(f.router.resolveNativeMcpLaunch(policy()));
  assert.equal(f.router.nativeActions.target(first.env.CLOWDER_PLUGIN_ACTION_TOKEN), undefined);
  await f.router.start('instance-a');
  const restarted = await f.router.resolveNativeMcpLaunch(policy());
  assert.equal(
    restarted.env.CLOWDER_PLUGIN_ACTION_TOKEN,
    first.env.CLOWDER_PLUGIN_ACTION_TOKEN,
    'enable/disable must not rotate Host-lifetime connection credentials',
  );
});

test('native launch rechecks stop intent after asynchronous inventory admission', async (t) => {
  const f = await fixture(t);
  await f.ready();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.pauseSnapshot(async () => {
    entered();
    await blocked;
  });
  const pending = f.router.resolveNativeMcpLaunch(policy());
  const rejected = assert.rejects(pending);
  await started;
  const stopping = f.router.stop('instance-a', 'owner_disabled');
  release();
  await Promise.all([rejected, stopping]);
});

test('native launch is unavailable until resource activation completes and stays unavailable after startup stop race', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.router.resolveNativeMcpLaunch, 'function');
  await assert.rejects(f.router.resolveNativeMcpLaunch(policy()));
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.pauseConfigWrite(async () => {
    entered();
    await blocked;
  });
  const starting = f.router.start('instance-a');
  const settled = starting.catch(() => {});
  await started;
  await assert.rejects(f.router.resolveNativeMcpLaunch(policy()));
  const stopping = f.router.stop('instance-a', 'owner_disabled');
  release();
  await Promise.all([settled, stopping]);
  await assert.rejects(f.router.resolveNativeMcpLaunch(policy()));
});
