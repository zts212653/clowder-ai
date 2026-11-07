import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';

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

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'task229-module-execution-'));
  await mkdir(join(rootDir, 'dist'));
  await writeFile(join(rootDir, 'package.json'), '{"type":"module"}');
  await writeFile(join(rootDir, 'dist/plugin.js'), source);
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
  const runtime = new ModulePluginRuntime({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir,
        manifest,
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
  return { runtime, record, events };
}

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
