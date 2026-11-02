import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveServersForCat } from '../dist/config/capabilities/capability-orchestrator.js';
import { bindInvocationPluginMcpView } from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { fixture, policy } from './helpers/native-plugin-launch-fixture.js';

const pluginCapability = (pluginId) => ({
  id: `plugin:${pluginId}:native`,
  pluginId,
  type: 'mcp',
  source: 'plugin',
  enabled: true,
  mcpServer: { command: 'node', args: ['/formal/mcp.js'] },
});
async function addInstance(f, samePlugin = false) {
  const instance = { ...f.instance, pluginInstanceId: 'instance-b' };
  if (!samePlugin) {
    const record = structuredClone(f.packageRecord);
    record.pluginId = record.manifest.pluginId = instance.pluginId = 'dev.clowder.healthy-fixture';
    record.packageDigest = instance.packageDigest = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;
    f.snapshot.packages.push(record);
  }
  f.snapshot.instances.push(instance);
  await f.router.start(instance.pluginInstanceId);
  return instance;
}
async function select(f, view, other) {
  const config = {
    version: 2,
    capabilities: [
      pluginCapability(f.instance.pluginId),
      ...(other ? [pluginCapability(other.pluginId)] : []),
      {
        id: 'external',
        type: 'mcp',
        source: 'external',
        enabled: true,
        mcpServer: { command: 'node', args: ['/user/mcp.js'] },
      },
    ],
  };
  const iterator = bindInvocationPluginMcpView(
    () =>
      (async function* () {
        yield resolveServersForCat(config, 'codex');
      })(),
    view,
  );
  return (await iterator.next()).value;
}

test('real member views isolate inventory, package and declaration drift from healthy plugins', async (t) => {
  const f = await fixture(t, { persistCapabilities: false });
  await f.ready();
  const healthy = await addInstance(f);
  const baseline = structuredClone(f.snapshot);
  const mutations = [
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
  ];
  for (const mutate of mutations) {
    Object.assign(f.instance, structuredClone(baseline.instances[0]));
    Object.assign(f.packageRecord, structuredClone(baseline.packages[0]));
    mutate();
    const view = await f.router.resolveMemberMcpView();
    const servers = await select(f, view, healthy);
    assert.equal(servers[0].enabled, false, 'the rejected activation cannot revive its formal declaration');
    assert.equal(servers[1].enabled, true, 'an unrelated healthy plugin remains usable');
    assert.notDeepEqual(servers[1].args, ['/formal/mcp.js']);
    assert.equal(servers[2].enabled, true);
    await assert.rejects(f.router.resolveNativeMcpLaunch(policy()));
  }
  assert.deepEqual(f.config().capabilities, [], 'the isolated Host has never published shared capabilities');
});

test('admission read errors deny only that member activation and preserve unrelated discovery', async (t) => {
  const f = await fixture(t, { persistCapabilities: false });
  await f.ready();
  const healthy = await addInstance(f);
  let reads = 0;
  f.pauseSnapshot(async () => {
    if (reads++ === 0) throw new Error('fixture inventory read unavailable');
  });
  const servers = await select(f, await f.router.resolveMemberMcpView(), healthy);
  assert.equal(servers[0].enabled, false);
  assert.equal(servers[1].enabled, true);
});

test('a drifted same-plugin instance retains ambiguity with the other healthy instance', async (t) => {
  const f = await fixture(t, { persistCapabilities: false });
  await f.ready();
  await addInstance(f, true);
  f.instance.configReadiness = 'missing';
  const view = await f.router.resolveMemberMcpView();
  assert.equal(view.entries.length, 2, 'a denied activation cannot disappear and elect another same-plugin instance');
  assert.equal(view.entries.filter((entry) => entry.isCurrent()).length, 1);
  assert.equal((await select(f, view))[0].enabled, false);
});

function barrier(f) {
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.pauseSnapshot(async () => {
    enter();
    await blocked;
  });
  return { entered, release };
}

test('concurrent stop during real member admission omits the stopped instance without failing other discovery', async (t) => {
  const f = await fixture(t, { persistCapabilities: false });
  await f.ready();
  const healthy = await addInstance(f);
  const gate = barrier(f);
  const pending = f.router.resolveMemberMcpView();
  await gate.entered;
  const stopping = f.router.stop('instance-a', 'owner_disabled');
  gate.release();
  const [view] = await Promise.all([pending, stopping]);
  assert.equal(view.entries.length, 1);
  const servers = await select(f, view, healthy);
  assert.equal(servers[0].enabled, false);
  assert.equal(servers[1].enabled, true);
});

test('concurrent refresh cannot adopt a replacement activation inside an already-started member snapshot', async (t) => {
  const f = await fixture(t, { persistCapabilities: false });
  await f.ready();
  const gate = barrier(f);
  const pending = f.router.resolveMemberMcpView();
  await gate.entered;
  f.pauseSnapshot(async () => {});
  await f.router.configRefresh('instance-a');
  gate.release();
  const view = await pending;
  assert.equal((await select(f, view))[0].enabled, false);
  assert.equal((await select(f, await f.router.resolveMemberMcpView()))[0].enabled, true);
});
