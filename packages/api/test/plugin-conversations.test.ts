import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { listPluginConversations } from '../src/domains/plugin/declared/plugin-conversations.js';
import type { PluginInstanceRecord, PluginInventorySnapshot } from '../src/domains/plugin/host-inventory/types.js';

async function fixture() {
  const result = validateManifest({
    pluginId: 'dev.example.resident',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Resident',
    features: [
      {
        id: 'resident',
        name: 'Resident',
        resources: [],
        contributions: [
          { type: 'ui', id: 'open' },
          { type: 'ui', id: 'row' },
        ],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    contributions: [
      { type: 'ui', id: 'open', kind: 'command', label: '助手', action: { method: 'resident.view' } },
      { type: 'ui', id: 'row', kind: 'slot-item', label: '助手', command: 'open', group: 'thread-sidebar.top' },
    ],
  });
  assert.ok(result.valid, JSON.stringify(result.errors));
  let snapshot: PluginInventorySnapshot = {
    schemaVersion: 1,
    packages: [
      {
        packageDigest: 'digest',
        pluginId: result.manifest.pluginId,
        version: '1.0.0',
        contractVersion: '0.1.0',
        manifest: result.manifest,
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
    ],
    instances: [
      {
        pluginInstanceId: 'installed',
        pluginId: result.manifest.pluginId,
        packageDigest: 'digest',
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
  };
  const threads = new ThreadStore();
  const own = await threads.create('owner', 'Bot main');
  const foreign = await threads.create('another-user', 'Private');
  let calls = 0;
  const deps = {
    inventory: { snapshot: async () => snapshot },
    threads,
    runtime: {
      invoke: async (_id: string, _method: string, _params: unknown) => {
        calls++;
        return { threadId: own.id, label: '我的助手', status: 'listening', badgeCount: 2 };
      },
    },
  };
  const updateInstance = (patch: Partial<PluginInstanceRecord>) => {
    snapshot = { ...snapshot, instances: snapshot.instances.map((row) => ({ ...row, ...patch })) };
  };
  return { deps, own, foreign, calls: () => calls, updateInstance };
}

test('an installed disabled resident remains discoverable without starting its runtime', async () => {
  const f = await fixture();
  const entries = await listPluginConversations(f.deps, 'owner');
  assert.equal(entries.length, 1, 'installation itself supplies the top entry');
  assert.equal(f.calls(), 0);
});

test('an active generic slot opens only an owner-visible live native conversation', async () => {
  const f = await fixture();
  f.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  const entries = await listPluginConversations(f.deps, 'owner');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].threadId, f.own.id);
  assert.equal(entries[0].badgeCount, 2);
  const foreign = await listPluginConversations(
    { ...f.deps, runtime: { invoke: async () => ({ threadId: f.foreign.id, status: 'listening', badgeCount: 0 }) } },
    'owner',
  );
  assert.equal(foreign[0].threadId, null, 'a plugin cannot navigate the operator into another user thread');
  assert.equal(foreign[0].status, 'error');
});

test('runtime errors preserve a repairable entry; retired installations disappear without deleting threads', async () => {
  const f = await fixture();
  f.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  const entries = await listPluginConversations(
    {
      ...f.deps,
      runtime: {
        invoke: async () => {
          throw new Error('unavailable');
        },
      },
    },
    'owner',
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'error');
  f.updateInstance({ lifecycleState: 'retired' });
  assert.deepEqual(await listPluginConversations(f.deps, 'owner'), []);
  assert.ok(f.deps.threads.get(f.own.id));
});
