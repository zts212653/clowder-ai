import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { snapshotInventoryFixture } from './helpers/snapshot-inventory-fixture.js';

const source = `
import { isMainThread, threadId } from 'node:worker_threads';
const execution = () => ({ isMainThread, threadId });
export default {
  create() {
    return {
      async start() {
        return { actions: { inspect: async () => execution() }, stop() {} };
      },
      async settings() {
        return { actions: { 'self.test': async () => execution() }, dispose() {} };
      },
      async preUninstall(host) { host.log('info', 'preUninstall', execution()); },
      async uninstall(host) { host.log('info', 'uninstall', execution()); }
    };
  }
};
`;
const sharedSource = `
import { isMainThread, threadId } from 'node:worker_threads';
export function create() {
  return {
    async connect(transport) {
      await transport.send({ jsonrpc: '2.0', method: 'notifications/execution', params: { isMainThread, threadId } });
    },
    async close() {}
  };
}
`;

async function fixture(t, moduleSource = source) {
  const rootDir = await mkdtemp(join(tmpdir(), 'task229-module-execution-'));
  await mkdir(join(rootDir, 'dist'));
  await writeFile(join(rootDir, 'package.json'), '{"type":"module"}');
  await writeFile(join(rootDir, 'dist/plugin.js'), moduleSource);
  await writeFile(join(rootDir, 'dist/server.js'), sharedSource);
  const manifest = {
    pluginId: 'dev.clowder.execution-fixture',
    name: 'Execution fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    test: { action: { method: 'self.test', params: {} } },
    contributions: [
      {
        type: 'mcp',
        id: 'ordinary',
        runtime: { transport: 'stdio', entrypoint: 'dist/server.js' },
        sharedFactory: { module: 'dist/server.js', export: 'create' },
      },
    ],
  };
  const record = {
    pluginId: manifest.pluginId,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    packageDigest: 'execution-fixture-digest',
    manifest,
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 1,
    updatedAt: 1,
  };
  const events = [];
  const records = new Map([[record.packageDigest, record]]);
  const runtime = new ModulePluginRuntime({
    packages: {
      resolveInstalledPackage: async (digest) => ({
        rootDir,
        manifest: records.get(digest).manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    dataDirectoryParent: join(rootDir, 'host-data'),
    log: (_level, message, fields) => events.push({ message, fields }),
  });
  t.after(async () => {
    await runtime.stop('instance', 'test-finished');
    await rm(rootDir, { recursive: true, force: true });
  });
  return { runtime, record, records, events, rootDir };
}

test(
  'real shared Worker exit revokes every affected publication and records a safe failure',
  { timeout: 20000 },
  async (t) => {
    const { runtime, record, records, rootDir } = await fixture(
      t,
      source.replace(
        'inspect: async () => execution()',
        'inspect: async () => execution(), crash: async () => process.exit(27)',
      ),
    );
    // No shared factory is needed: this test exercises the actual module leases and
    // the Host launch lifecycle, without a provider or any external service.
    delete record.manifest.contributions[0].sharedFactory;
    const second = structuredClone(record);
    second.packageDigest = 'second-execution-fixture-digest';
    second.pluginId = second.manifest.pluginId = `${record.pluginId}.second`;
    records.set(second.packageDigest, second);
    const hostRoot = await mkdtemp(join(tmpdir(), 'issue1978-host-'));
    t.after(() => rm(hostRoot, { recursive: true, force: true }));
    const instances = ['instance', 'second'].map((pluginInstanceId, index) => ({
      pluginInstanceId,
      pluginId: index === 0 ? record.pluginId : second.pluginId,
      packageDigest: index === 0 ? record.packageDigest : second.packageDigest,
      lifecycleState: 'installed',
      activationState: 'enabled',
      configReadiness: 'ready',
      runtimeState: 'stopped',
      lifecycleRevision: 1,
    }));
    const inventory = snapshotInventoryFixture({
      snapshot: async () => structuredClone({ instances, packages: [...records.values()] }),
      transaction: async (work) =>
        work({
          instances: {
            get: (id) => instances.find((instance) => instance.pluginInstanceId === id),
            put: (next) =>
              Object.assign(
                instances.find((instance) => instance.pluginInstanceId === next.pluginInstanceId),
                next,
              ),
          },
        }),
    });
    let config = { version: 2, capabilities: [] };
    const router = new PluginRuntimeCarrierRouter(inventory, {
      projectRoot: hostRoot,
      packages: {
        resolveInstalledPackage: async (digest) => ({
          rootDir,
          manifest: records.get(digest).manifest,
          verifyIntegrity: async () => {},
          release: async () => {},
        }),
      },
      configuration: { resolve: async () => ({}) },
      mcpConfigIO: {
        readConfig: async () => config,
        withLock: async (run) => run(),
        writeAndRegenCli: async (next) => {
          config = next;
        },
      },
      persistCapabilities: false,
    });
    router.register(new BundledPluginRuntimeCarrier({ inventory, runtimes: [runtime], now: () => 1978 }));
    t.after(() => router.stopAll('test_cleanup'));
    const handles = await Promise.all(instances.map(({ pluginInstanceId }) => router.start(pluginInstanceId)));
    const view = await router.resolveMemberMcpView();
    assert.equal(view.entries.length, 2);
    assert.ok(view.entries.every((entry) => entry.isCurrent()));
    const completions = instances.map(({ pluginInstanceId }) => runtime.completion(pluginInstanceId));
    assert.equal((await router.invoke('instance', 'inspect', {})).isMainThread, false);
    const crashedAction = await router.attemptInvoke('instance', 'crash', {});
    assert.equal(crashedAction.status, 'failed');
    assert.equal(crashedAction.effect, 'unknown', 'an entered action is never safe to replay after Worker exit');
    assert.ok((await Promise.all(completions)).every((error) => error instanceof Error));
    assert.ok(
      view.entries.every((entry) => !entry.isCurrent()),
      'all leases lose publication before cleanup finishes',
    );
    await Promise.all(handles.map(({ closed }) => closed));
    assert.ok(instances.every((instance) => instance.runtimeState === 'crashed'));
    assert.ok(instances.every((instance) => instance.activationState === 'enabled'));
    assert.ok(instances.every((instance) => instance.lastRuntimeError.code === 'UNEXPECTED_RUNTIME_FAILURE'));
    assert.ok(instances.every((instance) => instance.lastRuntimeError.occurredAt === 1978));
    assert.ok(!JSON.stringify(instances).includes('stack'));
    assert.equal(
      (await router.resolveMemberMcpView()).entries.length,
      2,
      'unavailable slots preserve source ambiguity',
    );
    await assert.rejects(
      router.resolveNativeMcpLaunch({
        mode: 'plugin_native',
        pluginInstanceId: 'instance',
        contributionId: 'ordinary',
      }),
    );
    const refused = await router.attemptInvoke('instance', 'inspect', {});
    assert.equal(refused.status, 'failed');
    assert.equal(refused.effect, 'not_started');
    const repaired = await router.start('instance');
    assert.equal((await router.invoke('instance', 'inspect', {})).isMainThread, false);
    assert.equal(view.entries[0].isCurrent(), false, 'repair must not revive the old captured activation');
    assert.equal((await router.resolveMemberMcpView()).entries[0].isCurrent(), true);
    await router.stop('instance', 'test_cleanup');
    await repaired.closed;
  },
);

function assertIsolated(execution, path) {
  assert.equal(execution.isMainThread, false, `${path} must execute outside the API thread`);
  assert.ok(execution.threadId > 0, `${path} must run on an execution worker`);
}

test('production module start and action execute outside the API thread', async (t) => {
  const { runtime, record } = await fixture(t);
  await runtime.start('instance', record);
  assertIsolated(await runtime.invoke('instance', 'inspect', {}), 'module action');
});

test('dormant module settings execute outside the API thread', async (t) => {
  const { runtime, record } = await fixture(t);
  const result = await runtime.invokeSettings({
    pluginInstanceId: 'instance',
    packageRecord: record,
    method: 'self.test',
    params: {},
    assertCurrent: async () => {},
  });
  assert.equal(result.handled, true);
  assertIsolated(result.result, 'settings action');
});

test('module uninstall hooks execute outside the API thread', async (t) => {
  const { runtime, record, events } = await fixture(t);
  await runtime.uninstall('instance', record);
  assert.deepEqual(
    events.map((event) => event.message),
    ['preUninstall', 'uninstall'],
  );
  for (const event of events) assertIsolated(event.fields, event.message);
});

test('module shared MCP factory and server callbacks execute outside the API thread', async (t) => {
  const { runtime, record } = await fixture(t);
  await runtime.start('instance', record);
  const factory = await runtime.resolveMcpFactory('instance', 'ordinary');
  assert.equal(typeof factory, 'function');
  const messages = [];
  const server = factory({ invoke: async () => ({}) });
  try {
    await server.connect({
      async start() {},
      async close() {},
      async send(message) {
        messages.push(message);
      },
    });
    assert.equal(messages.length, 1);
    assertIsolated(messages[0].params, 'shared MCP server');
  } finally {
    await server.close();
  }
});

test('dormant settings still recheck current authority before executing plugin code', async (t) => {
  const { runtime, record, events } = await fixture(t);
  await assert.rejects(
    runtime.invokeSettings({
      pluginInstanceId: 'instance',
      packageRecord: record,
      method: 'self.test',
      params: {},
      assertCurrent: async () => {
        throw new Error('revoked-before-settings');
      },
    }),
    /revoked-before-settings/,
  );
  assert.deepEqual(events, []);
});
