import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaration, describe, operations, setup } from './helpers/agent-adapter-archive.js';

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
  await install({ pluginId: second, declaration: declaration('first') });
  assert.deepEqual(await runtime.agentAdapters.list(), []);
  await enable(first);
  await enable(second);
  const a = await authority(first);
  const b = await authority(second);
  assert.equal(a.runtimeState, 'healthy');
  assert.equal(b.runtimeState, 'healthy');
  assert.notEqual(a.pluginInstanceId, b.pluginInstanceId);
  const firstRef = { pluginId: first, contributionId: 'first' };
  const secondRef = { pluginId: second, contributionId: 'first' };
  assert.deepEqual((await runtime.agentAdapters.list()).map((adapter) => adapter.ref).sort(), [
    `plugin:${first}/first`,
    `plugin:${second}/first`,
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
  assert.deepEqual(await runtime.agentAdapters.describe(secondRef), describe('1.0.0'));
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
    [`plugin:${second}/first`],
  );
  await assert.rejects(runtime.agentAdapters.describe(firstRef), /not active/i);
  assert.deepEqual(await runtime.agentAdapters.describe(secondRef), describe('1.0.0'));
});

test('the Host rejects malformed or undeclared capability data from a real installed module', async (t) => {
  const { manager, runtime, install } = await setup(t);
  for (const [id, operation, value] of [
    ['absent', 'quota', { status: 'supported' }],
    ['undeclared', 'quota', { status: 'supported', data: { source: 'account-api', units: ['ratio'] } }],
    ['fake-quota', 'quota', { status: 'unsupported', data: { source: 'account-api', units: ['ratio'] } }],
    ['undeclared-input', 'input', { status: 'supported', data: { duringTurn: true } }],
  ]) {
    const pluginId = `local.${id}-adapter`;
    const description = describe('1.0.0');
    description.capabilities[operation] = value;
    await install({ pluginId, declaration: declaration(id), description });
    const { plugin } = await manager.get(pluginId);
    await manager.setEnabled(pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    await assert.rejects(runtime.agentAdapters.describe({ pluginId, contributionId: id }), {
      code: 'PROTOCOL_VIOLATION',
    });
  }
});

test('description sends cooperative abort to an installed Worker and other packages remain usable', async (t) => {
  const { manager, runtime, install } = await setup(t);
  for (const [id, hangingDescribe] of [
    ['slow', true],
    ['ready', false],
  ]) {
    const pluginId = `local.${id}-adapter`;
    await install({ pluginId, declaration: declaration(id), hangingDescribe });
    const { plugin } = await manager.get(pluginId);
    await manager.setEnabled(pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
  }
  await assert.rejects(
    runtime.agentAdapters.describe({
      pluginId: 'local.slow-adapter',
      contributionId: 'slow',
    }),
    { name: 'TimeoutError' },
  );
  const slowRef = { pluginId: 'local.slow-adapter', contributionId: 'slow' };
  let cancellationObserved;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await runtime.agentAdapters.detect(slowRef)).candidates[0]?.id === 'aborted') {
      cancellationObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(cancellationObserved, 'Worker did not observe the describe AbortSignal');
  assert.deepEqual(
    await runtime.agentAdapters.describe({
      pluginId: 'local.ready-adapter',
      contributionId: 'ready',
    }),
    describe('1.0.0'),
  );
});

test('legacy Agent Access and ACP declarations activate without the new adapter declaration', async (t) => {
  const { manager, runtime, install } = await setup(t);
  for (const [pluginId, extraDeclarations] of [
    [
      'local.legacy-access',
      {
        'agent-access.json': {
          protocolVersion: 1,
          operations: [
            'detect',
            'configure',
            'login',
            'readRoles',
            'writeRole',
            'openSession',
            'startTurn',
            'cancel',
            'release',
          ],
          transports: ['acp'],
        },
      },
    ],
    [
      'local.legacy-acp',
      {
        'agent-provider.json': { id: 'old-acp', transport: 'acp', acp: { command: 'old-acp', startupArgs: [] } },
      },
    ],
  ]) {
    await install({ pluginId, extraDeclarations });
    const { plugin } = await manager.get(pluginId);
    assert.equal(plugin.artifact, 'installed');
    await manager.setEnabled(pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    assert.equal((await manager.get(pluginId)).plugin.live, 'running');
  }
  assert.deepEqual(await runtime.agentAdapters.list(), []);
});

test('active adapter detection returns Host attribution and refuses a package-supplied startup command', async (t) => {
  const { manager, runtime, install } = await setup(t);
  const pluginId = 'local.detection-adapter';
  const contributionId = 'detection';
  const ref = { pluginId, contributionId };
  const candidate = { id: 'configured', label: 'Fixture client', state: { status: 'ready', version: '1.0' } };
  await install({ pluginId, declaration: declaration(contributionId), detection: { candidates: [candidate] } });
  const { plugin } = await manager.get(pluginId);
  await manager.setEnabled(pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
  const [binding] = await runtime.agentAdapters.list();
  assert.deepEqual(await runtime.agentAdapters.detect(ref, { refresh: true }), {
    candidates: [candidate],
    binding,
  });
  await install({
    pluginId,
    version: '1.1.0',
    declaration: declaration(contributionId),
    detection: { candidates: [{ ...candidate, command: 'arbitrary-process' }] },
  });
  await assert.rejects(runtime.agentAdapters.detect(ref), { code: 'PROTOCOL_VIOLATION' });
});

test('existing v1 description without the new capability fields remains readable', async (t) => {
  const { manager, runtime, install } = await setup(t);
  const pluginId = 'local.v1-adapter';
  const v1 = describe('1.0.0');
  const operationsOmitted = ['login', 'input', 'inspectInput', 'compact'];
  for (const op of operationsOmitted) delete v1.capabilities[op];
  await install({ pluginId, declaration: declaration('old'), description: v1 });
  const { plugin } = await manager.get(pluginId);
  await manager.setEnabled(pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
  const result = await runtime.agentAdapters.describe({ pluginId, contributionId: 'old' });
  for (const op of operationsOmitted)
    assert.deepEqual(result.capabilities[op], { status: 'unknown', reason: 'not_reported' });
});
