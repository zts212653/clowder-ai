/**
 * F202 W2-6 — official IM connectors get from the Host exactly the grants their shipped features use
 * (ledger「W2-6」). Found by the baseline acceptance (Host thread …000037): WeCom Bot could not start
 * on a production Host, because the Host's grant table listed only two of the seven connectors and a
 * package without an entry is granted nothing.
 *
 * The table is Host-owned and explicit. A package receives what its entry lists and its manifest
 * requests — never more: a manifest asking for something new does not get it. Instances installed
 * before a table change are brought to it at startup, before any runtime resumes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';
import { resolveLocalPluginEffectiveGrants } from '../dist/domains/plugin/manager/machine-catalog-provider.js';
import { reconcileOfficialPluginGrants } from '../dist/domains/plugin/manager/official-plugin-grants.js';
import { OFFICIAL_PLUGIN_HOST_POLICIES } from '../dist/domains/plugin/manager/official-plugin-host-policies.js';
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

const CONNECTOR = [
  'streams.read',
  'message.event.subscribe',
  'messaging.send',
  'plugin.config.read',
  'plugin.state.get',
  'plugin.state.set',
  'secret.read',
  'thread.listMetadata',
  'thread.readContent',
  'thread.write',
];
const without = (...unused) => CONNECTOR.filter((capability) => !unused.includes(capability));
/** What the task296 alpha.3 packages request, verified from their actual archives. */
const EXPECTED = {
  'official.connector.dingtalk': CONNECTOR,
  'official.connector.feishu': CONNECTOR,
  'official.connector.telegram': without('plugin.config.read'),
  'official.connector.wecom-agent': CONNECTOR,
  'official.connector.wecom-bot': CONNECTOR,
  'official.connector.weixin': CONNECTOR,
  'official.connector.xiaoyi': without('streams.read'),
};
const W2_1_GRANTS = without('streams.read', 'plugin.state.get', 'plugin.state.set', 'thread.readContent');
const sorted = (values) => [...values].sort();

function collectiveManifest(capabilities = []) {
  const value = manifest('official.collective-connector', capabilities);
  value.runtime.dataDirectory = 'collective';
  value.features[0].contributions = [];
  value.contributions = [];
  return value;
}

test('Collective local directory admission gets a stable dataPath without a data-directory grant', async () => {
  const host = await installed(collectiveManifest());
  try {
    assert.deepEqual(host.grants.requestedCapabilities, []);
    assert.deepEqual(host.grants.effectiveGrants, []);
  } finally {
    await host.shutdown();
  }
});

test('Collective can read its declared service port but cannot gain secrets or schedules', () => {
  assert.deepEqual(
    resolveLocalPluginEffectiveGrants(
      OFFICIAL_PLUGIN_HOST_POLICIES,
      collectiveManifest(['plugin.config.read', 'secret.read', 'schedule.register']),
    ),
    ['plugin.config.read'],
  );
  assert.deepEqual(resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, collectiveManifest([])), []);
});

test('Collective backend receives only its ordinary declared grants on install and restart', async () => {
  const capabilities = [
    'plugin.state.get',
    'thread.readContent',
    'thread.listMetadata',
    'thread.write',
    'messaging.send',
  ];
  const current = collectiveManifest(capabilities);
  const grants = resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, current);
  assert.deepEqual(sorted(grants), sorted(capabilities));
  const host = await installed(
    current,
    `export default {
    create() { return { async start(host) {
      if (host.browserServices) throw new Error('unexpected Host server manager');
      return { actions: { 'collective.service.status': async () => ({ status: 'ready' }) }, async stop() {} };
    } }; }
  };`,
  );
  try {
    assert.deepEqual(sorted(host.grants.effectiveGrants), sorted(capabilities));
    await host.enable();
  } finally {
    await host.shutdown();
  }
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_collective', now: () => 1 });
  const digest = `sha512-${createHash('sha512').update('collective-native-policy').digest('base64')}`;
  await inventory.installPackage({
    manifest: current,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: current.pluginId,
    effectiveGrants: [],
  });
  const changes = await reconcileOfficialPluginGrants({
    store,
    inventory,
    hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES,
  });
  assert.deepEqual(sorted(changes[0].added), sorted(capabilities));
  assert.deepEqual(sorted((await store.snapshot()).grants[0].effectiveGrants), sorted(capabilities));
  assert.deepEqual(
    await reconcileOfficialPluginGrants({ store, inventory, hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES }),
    [],
  );
});

test('Collective Work receives declared data and material grants on install and reconciliation', async () => {
  const original = ['thread.readContent', 'thread.listMetadata', 'thread.write', 'messaging.send'];
  const declared = [
    ...original,
    'task.read',
    'task.write',
    'task.admitEntrusted',
    'plugin.state.get',
    'plugin.state.set',
    'message.event.subscribe',
    'streams.read',
  ];
  const current = collectiveManifest([...declared, 'secret.read']);
  assert.deepEqual(sorted(resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, current)), sorted(declared));
  assert.deepEqual(
    sorted(resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, collectiveManifest(original))),
    sorted(original),
    'older manifests must not receive undeclared task.read',
  );
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_collective', now: () => 1 });
  const digest = `sha512-${createHash('sha512').update('collective-owner-view-policy').digest('base64')}`;
  await inventory.installPackage({
    manifest: current,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: current.pluginId,
    effectiveGrants: original,
  });
  const changes = await reconcileOfficialPluginGrants({
    store,
    inventory,
    hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES,
  });
  assert.deepEqual(changes, [
    {
      pluginId: current.pluginId,
      pluginInstanceId: 'pi_collective',
      added: sorted(declared.filter((grant) => !original.includes(grant))),
      removed: [],
    },
  ]);
  assert.deepEqual(sorted((await store.snapshot()).grants[0].effectiveGrants), sorted(declared));
  assert.deepEqual(
    await reconcileOfficialPluginGrants({ store, inventory, hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES }),
    [],
  );
});

test('Collective startup reconciliation adds only declared ordinary capabilities', async () => {
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_collective', now: () => 1 });
  const digest = `sha512-${createHash('sha512').update('collective-policy').digest('base64')}`;
  const installed = await inventory.installPackage({
    manifest: collectiveManifest(['thread.readContent', 'plugin.config.read']),
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: 'official.collective-connector',
    effectiveGrants: [],
  });
  const before = await store.snapshot();
  const changes = await reconcileOfficialPluginGrants({
    store,
    inventory,
    hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES,
  });
  assert.deepEqual(changes, [
    {
      pluginId: 'official.collective-connector',
      pluginInstanceId: installed.pluginInstanceId,
      added: ['plugin.config.read', 'thread.readContent'],
      removed: [],
    },
  ]);
  const after = await store.snapshot();
  assert.deepEqual(after.instances, before.instances);
  assert.deepEqual(after.packages, before.packages);
  assert.deepEqual(after.grants[0].requestedCapabilities, before.grants[0].requestedCapabilities);
  const grant = (await store.snapshot()).grants[0];
  assert.deepEqual(grant.effectiveGrants, ['plugin.config.read', 'thread.readContent']);
  assert.equal(grant.grantRevision, 2);
  assert.deepEqual(
    await reconcileOfficialPluginGrants({ store, inventory, hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES }),
    [],
  );
});

const GITHUB = [
  'schedule.register',
  'plugin.config.read',
  'secret.read',
  'plugin.state.get',
  'plugin.state.set',
  'thread.listMetadata',
  'thread.write',
  'messaging.send',
];

test('GitHub operations receives only its requested shipped capabilities without retiring the legacy source', () => {
  const policy = OFFICIAL_PLUGIN_HOST_POLICIES.find((entry) => entry.pluginId === 'official.github-operations');
  assert.deepEqual(sorted(policy?.effectiveGrants ?? []), sorted(GITHUB));
  assert.equal(policy.replacesRepositoryPluginId, undefined, 'granting capabilities is not a legacy cutover');
  assert.deepEqual(
    resolveLocalPluginEffectiveGrants(
      OFFICIAL_PLUGIN_HOST_POLICIES,
      manifest('official.github-operations', ['thread.listMetadata']),
    ),
    ['thread.listMetadata'],
  );
  assert.deepEqual(
    resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest('dev.example.github-operations', GITHUB)),
    [],
  );
});

test('installed GitHub operations cannot widen its Host grants through its manifest', async () => {
  const host = await installed(manifest('official.github-operations', [...GITHUB, 'task.read']));
  try {
    assert.deepEqual(sorted(host.grants.effectiveGrants), sorted(GITHUB));
    await host.enable();
    await assert.rejects(
      host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.read-task', {}),
      (error) => error?.code === 'DELIVERY_REJECTED' && /lacks task\.read/.test(error.message),
    );
  } finally {
    await host.shutdown();
  }
});

test('meeting intake reads the selected thread with four grants, never unrelated capabilities', async () => {
  const capabilities = ['plugin.config.read', 'secret.read', 'thread.readContent', 'messaging.send'];
  const current = manifest('official.feishu-meeting-intake', [
    ...capabilities,
    'task.read',
    'thread.write',
    'thread.listMetadata',
  ]);
  current.runtime.dataDirectory = 'feishu-meeting-intake';
  const host = await installed(
    current,
    `
export default {
  create() {
    return {
      async start(host) {
        return {
          actions: {
            'probe.read-thread': async () => host.threads.get('selected-thread'),
            'probe.list-threads': async () => host.threads.list(),
            'probe.read-task': async () => host.tasks.get({ id: 'task-1' }),
          },
          async stop() {},
        };
      },
    };
  },
};
`,
  );
  try {
    assert.deepEqual(sorted(host.grants.effectiveGrants), sorted(capabilities));
    await host.enable();
    assert.equal(await host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.read-thread', {}), null);
    await assert.rejects(
      host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.list-threads', {}),
      (error) => error?.code === 'DELIVERY_REJECTED' && /lacks thread\.listMetadata/.test(error.message),
    );
    await assert.rejects(
      host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.read-task', {}),
      (error) => error?.code === 'DELIVERY_REJECTED' && /lacks task\.read/.test(error.message),
    );
    assert.deepEqual(
      resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest(current.pluginId, [])),
      [],
    );
  } finally {
    await host.shutdown();
  }
});

test('each official connector is granted exactly what its shipped features use', () => {
  for (const [pluginId, expected] of Object.entries(EXPECTED)) {
    const policy = OFFICIAL_PLUGIN_HOST_POLICIES.find((entry) => entry.pluginId === pluginId);
    assert.deepEqual(sorted(policy?.effectiveGrants ?? []), sorted(expected), pluginId);
  }
  const ids = OFFICIAL_PLUGIN_HOST_POLICIES.map((entry) => entry.pluginId);
  assert.equal(new Set(ids).size, ids.length, 'one entry per plugin');
});

function manifest(pluginId, capabilities = CONNECTOR) {
  return {
    pluginId,
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'W2-6 connector fixture',
    features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
}

// What an official connector does first as it activates, and where WeCom Bot failed on the baseline
// Host: read its thread bindings. (Private state needs Redis, which this composition leaves out; the
// plugin.state grants are pinned by the table test and the reconcile test.)
const moduleSource = `
export default {
  create() {
    return {
      async start(host) {
        await host.threads.list();
        return {
          actions: { 'probe.read-task': async () => host.tasks.get({ id: 'task-1' }) },
          async stop() {},
        };
      },
    };
  },
};
`;

/** A production composition with the Host's real grant table, and one package installed from disk. */
async function installed(packageManifest, source = moduleSource) {
  const projectRoot = await tempRoot('f202-w2-6-project-');
  const packageRoot = await tempRoot('f202-w2-6-package-');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest)}\n`);
  await writeFile(join(packageRoot, 'dist/plugin.js'), source);
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    threadStore: new ThreadStore(),
    threadBindingStore: new MemoryConnectorThreadBindingStore(),
    threadOwnerUserId: 'owner-1',
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: (candidate) => resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, candidate),
  });
  const { pluginId, pluginInstanceId } = await composition.manager.install({
    source: { kind: 'local-directory', path: packageRoot },
  });
  const grants = (await runtime.inventoryStore.snapshot()).grants.find(
    (candidate) => candidate.pluginInstanceId === pluginInstanceId,
  );
  const enable = async () => {
    const detail = (await composition.manager.get(pluginId)).plugin;
    return composition.manager.setEnabled(pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
  };
  return { runtime, pluginInstanceId, grants, enable, shutdown: () => runtime.shutdown('test_done') };
}

test('production starts an official connector with the grants the Host gives it; an unlisted package gets none', async () => {
  const official = await installed(manifest('official.connector.wecom-bot'));
  assert.deepEqual(sorted(official.grants.effectiveGrants), sorted(CONNECTOR));
  await official.enable();
  await official.shutdown();

  const unlisted = await installed(manifest('dev.example.unlisted-connector'));
  assert.deepEqual(unlisted.grants.effectiveGrants, []);
  await assert.rejects(unlisted.enable(), { code: 'RUNTIME_START_FAILED' });
  await unlisted.shutdown();
});

test('a package asking for less than its entry still installs and starts, with what it asks for', async () => {
  // An older release (here: the W2-1 feishu request) or a later one that dropped a capability.
  const older = await installed(manifest('official.connector.feishu', W2_1_GRANTS));
  assert.deepEqual(sorted(older.grants.effectiveGrants), sorted(W2_1_GRANTS));
  await older.enable();
  await older.shutdown();
});

test('a manifest cannot widen the grant: what it asks beyond the table is not granted, and using it is refused', async () => {
  const host = await installed(manifest('official.connector.wecom-bot', [...CONNECTOR, 'task.read']));
  assert.deepEqual(sorted(host.grants.requestedCapabilities), sorted([...CONNECTOR, 'task.read']));
  assert.deepEqual(sorted(host.grants.effectiveGrants), sorted(CONNECTOR));
  await host.enable();

  await assert.rejects(
    host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.read-task', {}),
    (error) => error?.code === 'DELIVERY_REJECTED' && /lacks task\.read/.test(error.message),
  );
  await host.shutdown();
});

test('instances installed before a table change are brought to it at startup, never beyond what they request', async () => {
  const store = new MemoryPluginInventoryStore();
  let next = 0;
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => `pi_${++next}`, now: () => 1 });
  const install = async (pluginId, effectiveGrants, requested = CONNECTOR) => {
    const digest = `sha512-${createHash('sha512').update(pluginId).digest('base64')}`;
    return (
      await inventory.installPackage({
        manifest: manifest(pluginId, requested),
        computedPackageDigest: digest,
        expectedPackageDigest: digest,
        packagePluginId: pluginId,
        effectiveGrants,
      })
    ).pluginInstanceId;
  };
  const feishu = await install('official.connector.feishu', W2_1_GRANTS);
  const wecomBot = await install('official.connector.wecom-bot', []);
  const olderDingtalk = await install('official.connector.dingtalk', [], without('streams.read'));
  const askingMore = await install('official.connector.xiaoyi', [], [...CONNECTOR, 'task.read']);
  const unlisted = await install('dev.example.unlisted-connector', []);
  const grantsOf = async (id) => (await store.snapshot()).grants.find((grant) => grant.pluginInstanceId === id);
  const reconcile = (hostPolicies = OFFICIAL_PLUGIN_HOST_POLICIES) =>
    reconcileOfficialPluginGrants({ store, inventory, hostPolicies });

  const changes = await reconcile();

  assert.deepEqual(
    changes.map(({ pluginId, added, removed }) => [pluginId, sorted(added), removed]),
    [
      [
        'official.connector.feishu',
        sorted(['streams.read', 'plugin.state.get', 'plugin.state.set', 'thread.readContent']),
        [],
      ],
      ['official.connector.wecom-bot', sorted(CONNECTOR), []],
      ['official.connector.dingtalk', sorted(without('streams.read')), []],
      ['official.connector.xiaoyi', sorted(without('streams.read')), []],
    ],
  );
  assert.deepEqual(sorted((await grantsOf(feishu)).effectiveGrants), sorted(CONNECTOR));
  assert.equal((await grantsOf(feishu)).grantRevision, 2);
  assert.deepEqual(sorted((await grantsOf(wecomBot)).effectiveGrants), sorted(CONNECTOR));
  assert.deepEqual(
    sorted((await grantsOf(olderDingtalk)).effectiveGrants),
    sorted(without('streams.read')),
    'the table never grants what the installed package does not request',
  );
  assert.deepEqual(
    sorted((await grantsOf(askingMore)).effectiveGrants),
    sorted(without('streams.read')),
    'what a package asks beyond its entry is never reconciled onto it',
  );
  assert.deepEqual((await grantsOf(unlisted)).effectiveGrants, []);
  assert.equal((await grantsOf(unlisted)).grantRevision, 1);

  assert.deepEqual(await reconcile(), [], 'a second run changes nothing');
  assert.equal((await grantsOf(feishu)).grantRevision, 2);

  const narrowed = OFFICIAL_PLUGIN_HOST_POLICIES.map((entry) =>
    entry.pluginId === 'official.connector.feishu'
      ? { ...entry, effectiveGrants: entry.effectiveGrants.filter((capability) => capability !== 'streams.read') }
      : entry,
  );
  assert.deepEqual(
    (await reconcile(narrowed)).map(({ pluginId, added, removed }) => [pluginId, added, removed]),
    [['official.connector.feishu', [], ['streams.read']]],
  );
  assert.deepEqual(sorted((await grantsOf(feishu)).effectiveGrants), sorted(without('streams.read')));
  assert.equal((await grantsOf(feishu)).grantRevision, 3);
});

test('production reconciles official grants before any plugin runtime resumes', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const reconcile = source.indexOf('await reconcileOfficialPluginGrants(');
  const recovery = source.indexOf('await pluginRuntime.recoverAfterRestart(');
  assert.ok(reconcile > 0 && reconcile < recovery, 'grants are reconciled before recovery resumes any runtime');
  assert.match(source.slice(reconcile, recovery), /hostPolicies: pluginManagerHostPolicies/);
});

test('real Collective config carrier reads its declared loopback port under Host admission', async () => {
  const current = collectiveManifest(['plugin.config.read', 'secret.read']);
  current.configuration = [
    { key: 'servicePort', kind: 'string', label: 'Service port', required: false, default: '5813' },
    { key: 'privateToken', kind: 'secret', label: 'Private token', required: false },
  ];
  const host = await installed(
    current,
    `export default {create() {return {async start(host) {
    const port = await host.config.get('servicePort');
    if (port !== '5813') throw new Error('declared service port unavailable');
    return {actions:{'probe.secret': async () => host.secrets.get('privateToken')},async stop(){}};
  }}}};`,
  );
  try {
    await host.enable();
    await assert.rejects(
      host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.secret', {}),
      (error) => error?.code === 'DELIVERY_REJECTED' && /lacks secret\.read/.test(error.message),
    );
  } finally {
    await host.shutdown();
  }
});
