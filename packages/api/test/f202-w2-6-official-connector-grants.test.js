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

const CONNECTOR = [
  'media.read',
  'message.event.subscribe',
  'messaging.send',
  'plugin.config.read',
  'plugin.state.get',
  'plugin.state.set',
  'secret.read',
  'thread.listMetadata',
  'thread.write',
];
const without = (...unused) => CONNECTOR.filter((capability) => !unused.includes(capability));
/** What each package of the fifth batch requests, per its manifest (ledger「基线验收」). */
const EXPECTED = {
  'official.connector.dingtalk': CONNECTOR,
  'official.connector.feishu': CONNECTOR,
  'official.connector.telegram': without('plugin.config.read'),
  'official.connector.wecom-agent': CONNECTOR,
  'official.connector.wecom-bot': CONNECTOR,
  'official.connector.weixin': CONNECTOR,
  'official.connector.xiaoyi': without('media.read'),
};
const W2_1_GRANTS = without('media.read', 'plugin.state.get', 'plugin.state.set');
const sorted = (values) => [...values].sort();

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
        await host.threads.listBindings();
        return {
          actions: { 'probe.read-thread': async () => host.threads.get('thread-1') },
          async stop() {},
        };
      },
    };
  },
};
`;

/** A production composition with the Host's real grant table, and one package installed from disk. */
async function installed(packageManifest) {
  const projectRoot = await tempRoot('f202-w2-6-project-');
  const packageRoot = await tempRoot('f202-w2-6-package-');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest)}\n`);
  await writeFile(join(packageRoot, 'dist/plugin.js'), moduleSource);
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
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
  const host = await installed(manifest('official.connector.wecom-bot', [...CONNECTOR, 'thread.readContent']));
  assert.deepEqual(sorted(host.grants.requestedCapabilities), sorted([...CONNECTOR, 'thread.readContent']));
  assert.deepEqual(sorted(host.grants.effectiveGrants), sorted(CONNECTOR));
  await host.enable();

  await assert.rejects(
    host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.read-thread', {}),
    (error) => error?.code === 'DELIVERY_REJECTED' && /lacks thread\.readContent/.test(error.message),
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
  const olderDingtalk = await install('official.connector.dingtalk', [], without('media.read'));
  const askingMore = await install('official.connector.xiaoyi', [], [...CONNECTOR, 'thread.readContent']);
  const unlisted = await install('dev.example.unlisted-connector', []);
  const grantsOf = async (id) => (await store.snapshot()).grants.find((grant) => grant.pluginInstanceId === id);
  const reconcile = (hostPolicies = OFFICIAL_PLUGIN_HOST_POLICIES) =>
    reconcileOfficialPluginGrants({ store, inventory, hostPolicies });

  const changes = await reconcile();

  assert.deepEqual(
    changes.map(({ pluginId, added, removed }) => [pluginId, sorted(added), removed]),
    [
      ['official.connector.feishu', ['media.read', 'plugin.state.get', 'plugin.state.set'], []],
      ['official.connector.wecom-bot', sorted(CONNECTOR), []],
      ['official.connector.dingtalk', sorted(without('media.read')), []],
      ['official.connector.xiaoyi', sorted(without('media.read')), []],
    ],
  );
  assert.deepEqual(sorted((await grantsOf(feishu)).effectiveGrants), sorted(CONNECTOR));
  assert.equal((await grantsOf(feishu)).grantRevision, 2);
  assert.deepEqual(sorted((await grantsOf(wecomBot)).effectiveGrants), sorted(CONNECTOR));
  assert.deepEqual(
    sorted((await grantsOf(olderDingtalk)).effectiveGrants),
    sorted(without('media.read')),
    'the table never grants what the installed package does not request',
  );
  assert.deepEqual(
    sorted((await grantsOf(askingMore)).effectiveGrants),
    sorted(without('media.read')),
    'what a package asks beyond its entry is never reconciled onto it',
  );
  assert.deepEqual((await grantsOf(unlisted)).effectiveGrants, []);
  assert.equal((await grantsOf(unlisted)).grantRevision, 1);

  assert.deepEqual(await reconcile(), [], 'a second run changes nothing');
  assert.equal((await grantsOf(feishu)).grantRevision, 2);

  const narrowed = OFFICIAL_PLUGIN_HOST_POLICIES.map((entry) =>
    entry.pluginId === 'official.connector.feishu'
      ? { ...entry, effectiveGrants: entry.effectiveGrants.filter((capability) => capability !== 'media.read') }
      : entry,
  );
  assert.deepEqual(
    (await reconcile(narrowed)).map(({ pluginId, added, removed }) => [pluginId, added, removed]),
    [['official.connector.feishu', [], ['media.read']]],
  );
  assert.deepEqual(sorted((await grantsOf(feishu)).effectiveGrants), sorted(without('media.read')));
  assert.equal((await grantsOf(feishu)).grantRevision, 3);
});

test('production reconciles official grants before any plugin runtime resumes', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const reconcile = source.indexOf('await reconcileOfficialPluginGrants(');
  const recovery = source.indexOf('await pluginRuntime.recoverAfterRestart()');
  assert.ok(reconcile > 0 && reconcile < recovery, 'grants are reconciled before recovery resumes any runtime');
  assert.match(source.slice(reconcile, recovery), /hostPolicies: pluginManagerHostPolicies/);
});
