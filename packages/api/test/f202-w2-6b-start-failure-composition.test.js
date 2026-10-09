/**
 * F202 W2-6b — on the production composition, an owner whose plugin fails to start is told why, and
 * the Host log has the failure (ledger「W2-6b」; the gap the baseline acceptance found with WeCom Bot).
 *
 * The package here is installed from disk and granted nothing (it has no Host policy entry), as an
 * official connector was before W2-6. Its module is real code loaded by the Host.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

const roots = [];
after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** What the package's start does, chosen per test through a global the module reads. */
const moduleSource = `
export default {
  create() {
    return {
      async start(host) {
        await globalThis.__f202W26bStart?.(host);
        return { actions: {}, async stop() {} };
      },
    };
  },
};
`;

async function installed({ capabilities, contributions = [], configuration, files = {} }) {
  const projectRoot = await tempRoot('f202-w2-6b-project-');
  const packageRoot = await tempRoot('f202-w2-6b-package-');
  const manifest = {
    pluginId: 'dev.example.w26b-connector',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'W2-6b connector fixture',
    ...(configuration === undefined ? {} : { configuration }),
    ...(contributions.length === 0 ? {} : { contributions }),
    features: [
      {
        id: 'messaging',
        name: 'Messaging',
        resources: [],
        capabilities,
        ...(contributions.length === 0 ? {} : { contributions: contributions.map(({ type, id }) => ({ type, id })) }),
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(packageRoot, 'dist/plugin.js'), moduleSource);
  for (const [path, contents] of Object.entries(files)) await writeFile(join(packageRoot, path), contents);
  const reports = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    threadStore: new ThreadStore(),
    threadBindingStore: new MemoryConnectorThreadBindingStore(),
    threadOwnerUserId: 'owner-1',
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
    mcpConfigIO: {
      readConfig: async () => null,
      writeAndRegenCli: async () => assert.fail('a refused MCP must never be written'),
      withLock: (fn) => fn(),
    },
    onPluginStartFailure: (report) => reports.push(report),
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: () => [],
  });
  const { pluginId } = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const detail = async () => (await composition.manager.get(pluginId)).plugin;
  const setEnabled = async (enabled) =>
    composition.manager.setEnabled(pluginId, { enabled, expectedRevision: (await detail()).lifecycleRevision });
  const stored = async () => JSON.parse(await readFile(runtime.paths.inventorySnapshotPath, 'utf8'));
  return { runtime, reports, detail, setEnabled, stored, shutdown: () => runtime.shutdown('test_done') };
}

after(() => {
  delete globalThis.__f202W26bStart;
});

test('a plugin refused a capability it requested: the owner is told which, the log has it, old Hosts can still read', async () => {
  globalThis.__f202W26bStart = (host) => host.threads.listBindings();
  const host = await installed({ capabilities: ['thread.listMetadata'] });

  await assert.rejects(host.setEnabled(true), (error) => {
    assert.equal(error.code, 'RUNTIME_START_FAILED');
    assert.equal(error.message, 'official plugin runtime failed to start: the Host refused it thread.listMetadata');
    return true;
  });

  const { diagnostic } = await host.detail();
  assert.equal(diagnostic.code, 'CAPABILITY_NOT_GRANTED');
  assert.equal(diagnostic.capability, 'thread.listMetadata');
  assert.equal(
    diagnostic.message,
    'This plugin version uses thread.listMetadata, which the current Host policy does not grant it. ' +
      'Check for a plugin version compatible with this Host, or contact the plugin maintainer.',
  );

  const [report] = host.reports;
  assert.equal(report.phase, 'enable');
  assert.deepEqual(report.category, { kind: 'capability_not_granted', capability: 'thread.listMetadata' });
  assert.equal(report.occurredAt, diagnostic.occurredAt);

  const [instance] = (await host.stored()).instances;
  assert.deepEqual(Object.keys(instance.lastRuntimeError).sort(), ['code', 'exitCode', 'occurredAt', 'signal']);
  assert.equal(instance.lastRuntimeError.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.deepEqual(instance.lastRuntimeErrorDetail, {
    kind: 'capability_not_granted',
    capability: 'thread.listMetadata',
    occurredAt: instance.lastRuntimeError.occurredAt,
    packageDigest: instance.packageDigest,
  });

  globalThis.__f202W26bStart = undefined;
  await host.setEnabled(true);
  const [recovered] = (await host.stored()).instances;
  assert.equal(recovered.lastRuntimeError, undefined, 'a start that succeeds clears the failure');
  assert.equal(recovered.lastRuntimeErrorDetail, undefined, 'and its reason with it');
  assert.equal((await host.detail()).diagnostic, undefined);
  await host.shutdown();
});

test('a plugin using a capability it never declared is told it is a defect in the plugin', async () => {
  globalThis.__f202W26bStart = (host) => host.storage.get('bookkeeping');
  const host = await installed({ capabilities: ['thread.listMetadata'] });

  await assert.rejects(host.setEnabled(true), /refused it plugin\.state\.get/u);
  const { diagnostic } = await host.detail();
  assert.equal(diagnostic.capability, 'plugin.state.get');
  assert.match(diagnostic.message, /uses plugin\.state\.get without declaring it, which is a defect in the plugin/u);
  await host.shutdown();
});

test('what the plugin throws in place of the refusal decides nothing, and nothing of it leaks', async () => {
  globalThis.__f202W26bStart = async (host) => {
    try {
      await host.threads.listBindings();
    } catch {
      const error = new Error('bind failed for https://example.invalid/?token=FAKE_W26B_QUERY');
      error.secret = 'FAKE_W26B_PROPERTY';
      throw error;
    }
  };
  const swallowed = await installed({ capabilities: ['thread.listMetadata'] });
  await assert.rejects(
    swallowed.setEnabled(true),
    (error) => error.message === 'official plugin runtime failed to start',
  );
  assert.equal((await swallowed.detail()).diagnostic.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.deepEqual(swallowed.reports[0].category, { kind: 'unclassified' });
  assert.doesNotMatch(JSON.stringify(swallowed.reports), /FAKE_W26B/u);
  await swallowed.shutdown();

  globalThis.__f202W26bStart = () => {
    throw Object.assign(new Error('dev.example.w26b-connector lacks thread.listMetadata'), {
      code: 'DELIVERY_REJECTED',
    });
  };
  const lookalike = await installed({ capabilities: ['thread.listMetadata'] });
  await assert.rejects(
    lookalike.setEnabled(true),
    (error) => error.message === 'official plugin runtime failed to start',
  );
  assert.equal((await lookalike.detail()).diagnostic.code, 'UNEXPECTED_RUNTIME_FAILURE');
  await lookalike.shutdown();
});

test('a declared MCP whose environment needs a grant the plugin lacks names that grant', async () => {
  globalThis.__f202W26bStart = undefined;
  const host = await installed({
    capabilities: ['secret.read'],
    configuration: [{ key: 'API_TOKEN', label: 'API token', kind: 'secret', required: false }],
    contributions: [
      {
        type: 'mcp',
        id: 'w26b-mcp',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
        environment: { API_TOKEN: { source: 'secret', key: 'API_TOKEN' } },
      },
    ],
    files: { 'dist/mcp.js': 'process.exit(0);\n' },
  });

  await assert.rejects(host.setEnabled(true), /refused it secret\.read/u);
  const { diagnostic } = await host.detail();
  assert.equal(diagnostic.code, 'CAPABILITY_NOT_GRANTED');
  assert.equal(diagnostic.capability, 'secret.read');
  assert.deepEqual(host.reports[0].category, { kind: 'capability_not_granted', capability: 'secret.read' });
  await host.shutdown();
});
