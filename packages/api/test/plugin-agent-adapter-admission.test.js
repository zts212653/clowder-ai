import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { tarArchive } from '../scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../scripts/canonical-gzip.mjs';

const contractVersion = '0.4.0-candidate.0';
const operations = ['describe', 'detect', 'openSession', 'startTurn', 'cancel', 'release'];
const describe = (version) => ({
  protocolVersion: 1,
  label: `Fixture ${version}`,
  capabilities: {
    resume: { status: 'supported', data: { mode: 'native' } },
    tools: { status: 'unsupported' },
    modelCatalog: { status: 'unknown', reason: 'not_probed' },
    quota: { status: 'unsupported' },
  },
});

async function setup(t) {
  const temp = resolve(tmpdir());
  const projectRoot = await mkdtemp(join(temp, 'agent-adapter-admission-'));
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    contract: { manifestContractRange: contractVersion, validateManifest },
  });
  t.after(async () => {
    await runtime.shutdown();
    assert.equal(dirname(projectRoot), temp);
    await rm(projectRoot, { recursive: true, force: true });
  });
  const { manager } = createPluginManagerRuntimeComposition({
    runtime,
    catalogManifests: [],
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
  });
  async function install({
    pluginId,
    version = '1.0.0',
    declaration,
    actionNames = operations,
    description = describe(version),
  }) {
    const manifest = {
      pluginId,
      name: pluginId,
      version,
      contractVersion,
      features: [{ id: 'agent', name: 'Agent adapter', capabilities: [], resources: [] }],
      runtime: { transport: 'builtin', entrypoint: 'entrypoint.mjs' },
    };
    assert.deepEqual(validateManifest(manifest).errors ?? [], []);
    const entrypoint = [
      'export default { create: () => ({ start: () => ({',
      'actions: Object.fromEntries(' +
        JSON.stringify(actionNames) +
        ".map(name => [name, () => name === 'describe' ? " +
        JSON.stringify(description) +
        ' : ({name})])),',
      'stop() {}',
      '}) }) };',
    ].join('\n');
    const archive = join(projectRoot, `${pluginId}-${version}.tgz`);
    const files = [
      ['manifest.json', JSON.stringify(manifest)],
      ['package.json', JSON.stringify({ name: pluginId, version, type: 'module' })],
      ['agent-adapter.json', JSON.stringify(declaration)],
      ['entrypoint.mjs', entrypoint],
    ].map(([name, content]) => ({ name: `package/${name}`, bytes: Buffer.from(content) }));
    await writeFile(archive, canonicalGzip(tarArchive(files)));
    return manager.install({ source: { kind: 'local-archive', path: archive } });
  }
  return { manager, runtime, install };
}

const declaration = (id) => ({ protocolVersion: 1, id, operations });

test('invalid adapter declaration is rejected before installing or replacing a package', async (t) => {
  const { manager, install } = await setup(t);
  const pluginId = 'local.alpha-adapter';
  await install({ pluginId, declaration: declaration('alpha') });
  const { plugin: previous } = await manager.get(pluginId);
  await assert.rejects(
    install({ pluginId, version: '2.0.0', declaration: { ...declaration('alpha'), protocolVersion: 2 } }),
    /agent adapter.*protocol version/i,
  );
  const { plugin: current } = await manager.get(pluginId);
  assert.equal(current.packageDigest, previous.packageDigest);
  assert.equal(current.lifecycleRevision, previous.lifecycleRevision);
  assert.equal(current.version, previous.version);
  await assert.rejects(
    install({
      pluginId: 'local.missing-action-adapter',
      declaration: { ...declaration('missing'), operations: ['describe'] },
    }),
    /invalid agent adapter declaration/i,
  );
});

test('two adapter archives activate independently and a missing operation cannot become ready', async (t) => {
  const { manager, runtime, install } = await setup(t);
  const first = 'local.first-adapter';
  const second = 'local.second-adapter';
  const incomplete = 'local.incomplete-adapter';
  async function enable(pluginId) {
    const { plugin } = await manager.get(pluginId);
    return manager.setEnabled(pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
  }
  const authority = async (pluginId) => (await runtime.inventoryStore.readCurrentAuthority(pluginId))?.instance;
  await install({ pluginId: first, declaration: declaration('first') });
  await install({ pluginId: second, declaration: declaration('second') });
  assert.deepEqual(await runtime.agentAdapters.list(), []);
  await enable(first);
  await enable(second);
  const a = await authority(first);
  const b = await authority(second);
  assert.equal(a.runtimeState, 'healthy');
  assert.equal(b.runtimeState, 'healthy');
  assert.notEqual(a.pluginInstanceId, b.pluginInstanceId);
  const firstRef = { pluginId: first, contributionId: 'first' };
  const secondRef = { pluginId: second, contributionId: 'second' };
  assert.deepEqual((await runtime.agentAdapters.list()).map((adapter) => adapter.ref).sort(), [
    `plugin:${first}/first`,
    `plugin:${second}/second`,
  ]);
  assert.deepEqual(await runtime.agentAdapters.describe(firstRef), describe('1.0.0'));
  await assert.rejects(runtime.agentAdapters.describe({ ...firstRef, contributionId: 'other' }), /not active/i);

  await install({
    pluginId: incomplete,
    declaration: declaration('incomplete'),
    actionNames: operations.filter((action) => action !== 'startTurn'),
  });
  await enable(incomplete).catch((error) => assert.match(String(error), /startTurn|activation|runtime/i));
  assert.notEqual((await authority(incomplete))?.runtimeState, 'healthy');

  const replacement = await install({ pluginId: first, version: '1.1.0', declaration: declaration('first') });
  assert.equal(replacement.pluginInstanceId, a.pluginInstanceId);
  const upgraded = await authority(first);
  assert.notEqual(upgraded.packageDigest, a.packageDigest);
  assert.deepEqual(await runtime.agentAdapters.describe(firstRef), describe('1.1.0'));
  await assert.rejects(
    install({
      pluginId: first,
      version: '1.2.0',
      declaration: declaration('first'),
      actionNames: operations.filter((action) => action !== 'startTurn'),
    }),
    { code: 'UPDATE_RESUME_FAILED' },
  );
  const restored = await authority(first);
  assert.equal(restored.packageDigest, upgraded.packageDigest);
  assert.equal(restored.runtimeState, 'healthy');
  assert.deepEqual(await runtime.agentAdapters.describe(firstRef), describe('1.1.0'));

  await install({ pluginId: first, declaration: declaration('first') });
  const rolledBack = await authority(first);
  assert.equal(rolledBack.pluginInstanceId, a.pluginInstanceId);
  assert.equal(rolledBack.packageDigest, a.packageDigest);
  assert.deepEqual(await runtime.agentAdapters.describe(firstRef), describe('1.0.0'));

  await manager.setEnabled(first, {
    enabled: false,
    expectedRevision: (await manager.get(first)).plugin.lifecycleRevision,
  });
  assert.equal((await authority(first)).activationState, 'disabled');
  const other = await authority(second);
  assert.equal(other.runtimeState, 'healthy');
  assert.equal(other.lifecycleRevision, b.lifecycleRevision);
  assert.deepEqual(
    (await runtime.agentAdapters.list()).map((adapter) => adapter.ref),
    [`plugin:${second}/second`],
  );
  await assert.rejects(runtime.agentAdapters.describe(firstRef), /not active/i);
  assert.deepEqual(await runtime.agentAdapters.describe(secondRef), describe('1.0.0'));
});

test('the Host rejects malformed or undeclared capability data from a real installed module', async (t) => {
  const { manager, runtime, install } = await setup(t);
  for (const [id, quota] of [
    ['absent', { status: 'supported' }],
    ['undeclared', { status: 'supported', data: { source: 'account-api', units: ['ratio'] } }],
    ['fake-quota', { status: 'unsupported', data: { source: 'account-api', units: ['ratio'] } }],
  ]) {
    const pluginId = `local.${id}-adapter`;
    const description = describe('1.0.0');
    description.capabilities.quota = quota;
    await install({ pluginId, declaration: declaration(id), description });
    const { plugin } = await manager.get(pluginId);
    await manager.setEnabled(pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    await assert.rejects(runtime.agentAdapters.describe({ pluginId, contributionId: id }), {
      code: 'PROTOCOL_VIOLATION',
    });
  }
});
