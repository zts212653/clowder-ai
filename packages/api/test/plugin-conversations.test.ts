import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { DeclaredPluginUi } from '../src/domains/plugin/declared/declared-plugin-ui.js';
import {
  listPluginConversations,
  openPluginConversation,
} from '../src/domains/plugin/declared/plugin-conversations.js';
import type { PluginInventoryTransaction } from '../src/domains/plugin/host-inventory/ports.js';
import { parseInstance } from '../src/domains/plugin/host-inventory/snapshot.js';
import type { PluginInstanceRecord, PluginInventorySnapshot } from '../src/domains/plugin/host-inventory/types.js';
import { pluginUiRoutes } from '../src/routes/plugin/plugin-ui-routes.js';

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
    inventory: {
      snapshot: async () => snapshot,
      transaction: async <T>(work: (transaction: PluginInventoryTransaction) => Promise<T> | T) =>
        work({
          instances: {
            get: (id) => snapshot.instances.find((row) => row.pluginInstanceId === id),
            getCurrent: (id) =>
              snapshot.instances.find((row) => row.pluginId === id && row.lifecycleState === 'installed'),
            list: () => snapshot.instances,
            put: (record) => {
              snapshot = {
                ...snapshot,
                instances: snapshot.instances.map((row) =>
                  row.pluginInstanceId === record.pluginInstanceId ? record : row,
                ),
              };
            },
          },
          packages: {
            get: (digest) => snapshot.packages.find((row) => row.packageDigest === digest),
            list: () => snapshot.packages,
            put: () => {
              throw new Error('Unexpected package write');
            },
          },
        }),
    },
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
  await openPluginConversation(f.deps, 'owner', 'installed', 'open');
  const entries = await listPluginConversations(f.deps, 'owner');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].threadId, f.own.id);
  assert.equal(f.calls(), 1, 'subsequent reads reuse the confirmed native target');
  const unbound = await fixture();
  unbound.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  await assert.rejects(
    openPluginConversation(
      { ...unbound.deps, runtime: { invoke: async () => ({ threadId: unbound.foreign.id }) } },
      'owner',
      'installed',
      'open',
    ),
    /unavailable/,
    'a plugin cannot bind another user thread',
  );
});

test('runtime errors preserve a repairable entry; retired installations disappear without deleting threads', async () => {
  const f = await fixture();
  f.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  await assert.rejects(
    openPluginConversation(
      {
        ...f.deps,
        runtime: {
          invoke: async () => {
            throw new Error('unavailable');
          },
        },
      },
      'owner',
      'installed',
      'open',
    ),
    /unavailable/,
  );
  const entries = await listPluginConversations(f.deps, 'owner');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'ready', 'a failed explicit open does not misreport Host activation');
  f.updateInstance({ lifecycleState: 'retired' });
  assert.deepEqual(await listPluginConversations(f.deps, 'owner'), []);
  assert.ok(f.deps.threads.get(f.own.id));
});

test('listing resident entries never executes an ordinary UI command', async () => {
  const f = await fixture();
  f.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  await listPluginConversations(f.deps, 'owner');
  assert.equal(f.calls(), 0, 'a list read cannot imply a click on a generic UI action');
});

test('a hung plugin action cannot delay the installed resident list', async () => {
  const f = await fixture();
  f.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  const entries = await Promise.race([
    listPluginConversations({ ...f.deps, runtime: { invoke: () => new Promise(() => {}) } }, 'owner'),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
  ]);
  assert.ok(entries, 'installed metadata must be readable without waiting for runtime code');
  assert.equal(entries.length, 1);
});

test('enabled crashed and degraded instances are unavailable rather than disabled', async () => {
  for (const runtimeState of ['crashed', 'degraded'] as const) {
    const f = await fixture();
    f.updateInstance({ activationState: 'enabled', runtimeState });
    const [entry] = await listPluginConversations(f.deps, 'owner');
    assert.equal(entry.status, 'error', runtimeState);
  }
});

test('confirmed bindings survive restart, errors and disable; deletion and retirement release navigation', async () => {
  const f = await fixture();
  f.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  await openPluginConversation(f.deps, 'owner', 'installed', 'open');
  const record = (await f.deps.inventory.snapshot()).instances[0];
  const persisted = parseInstance({ ...record, packageDigest: `sha512-${Buffer.alloc(64).toString('base64')}` }, 0);
  assert.equal(persisted.conversationBindings?.[0].role, 'main-conversation');
  f.updateInstance({ conversationBindings: persisted.conversationBindings, runtimeState: 'crashed' });
  assert.equal((await listPluginConversations(f.deps, 'owner'))[0].threadId, f.own.id);
  f.updateInstance({ activationState: 'disabled', runtimeState: 'stopped' });
  assert.equal((await openPluginConversation(f.deps, 'owner', 'installed', 'open')).threadId, f.own.id);
  assert.equal(f.calls(), 1, 'disabled history navigation does not restart the plugin');
  const outage = await listPluginConversations(
    {
      ...f.deps,
      threads: {
        get: async () => {
          throw new Error('temporary store failure');
        },
      },
    },
    'owner',
  );
  assert.equal(outage[0].threadId, f.own.id, 'temporary read failure keeps the last Host-confirmed coordinate');
  await f.deps.threads.softDelete(f.own.id);
  assert.equal((await listPluginConversations(f.deps, 'owner'))[0].threadId, null);
  f.updateInstance({ lifecycleState: 'retired' });
  assert.deepEqual(await listPluginConversations(f.deps, 'owner'), []);
  assert.ok(await f.deps.threads.get(f.own.id), 'uninstall does not delete the native history');
});

test('only a direct authenticated owner action may resolve and persist the native binding', async (t) => {
  const f = await fixture();
  f.updateInstance({ activationState: 'enabled', runtimeState: 'healthy' });
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-fixture-owner']) request.sessionUserId = 'owner';
  });
  await app.register(pluginUiRoutes, { ui: new DeclaredPluginUi(), conversations: f.deps });
  const url = '/api/plugin-conversations/installed/open/open';
  const headers = { host: 'localhost:5173', origin: 'http://localhost:5173', 'x-fixture-owner': 'yes' };
  assert.ok(
    [401, 403].includes(
      (await app.inject({ method: 'POST', url, headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } }))
        .statusCode,
    ),
  );
  assert.ok(
    [401, 403].includes(
      (await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://outside.invalid' } }))
        .statusCode,
    ),
  );
  assert.equal(f.calls(), 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugin-conversations', headers })).statusCode, 200);
  assert.equal(f.calls(), 0, 'an authenticated GET still cannot execute a command');
  const opened = await app.inject({ method: 'POST', url, headers });
  assert.equal(opened.statusCode, 200, opened.payload);
  assert.equal(opened.json().entry.threadId, f.own.id);
  assert.equal(f.calls(), 1);
});
