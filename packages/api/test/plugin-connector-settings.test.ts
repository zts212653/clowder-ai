import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  ConnectorSettingsService,
  registerConnectorSettingsRoutes,
} from '../src/domains/plugin/manager/connector-settings.js';

function harness(declared = true) {
  const state: any = {
    instances: [
      {
        pluginId: 'demo',
        pluginInstanceId: 'pi_demo',
        packageDigest: 'digest',
        lifecycleState: 'installed',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
      },
    ],
    packages: [
      {
        packageDigest: 'digest',
        manifest: {
          ...(declared ? { permissions: { label: '群聊' } } : {}),
          features: [{ capabilities: ['plugin.state.get', 'plugin.state.set'] }],
        },
      },
    ],
    grants: [{ pluginInstanceId: 'pi_demo' }],
  };
  let entry: any;
  let writes = 0;
  const storage = {
    get: async (id: string, key: string) => {
      assert.equal(id, 'demo');
      assert.equal(key, 'connector.permissions.v1');
      return structuredClone(entry);
    },
    compareAndSet: async (id: string, key: string, revision: number | null, value: unknown) => {
      assert.equal(id, 'demo');
      assert.equal(key, 'connector.permissions.v1');
      if ((entry?.revision ?? null) !== revision) return { applied: false };
      entry = { revision: ++writes, value: structuredClone(value) };
      return { applied: true, revision: writes };
    },
  };
  const service = new ConnectorSettingsService({
    inventory: { snapshot: async () => structuredClone(state) },
    storage,
    now: () => 100,
  });
  return {
    service,
    state,
    storage,
    get entry() {
      return entry;
    },
    get writes() {
      return writes;
    },
  };
}

test('disabled group declaration reads defaults without initializing; owner controls and commands share one CAS record', async () => {
  const h = harness();
  const before = structuredClone(h.state);
  const empty = await h.service.read('demo');
  assert.deepEqual(empty, {
    revision: null,
    whitelistEnabled: false,
    commandAdminOnly: false,
    adminOpenIds: [],
    allowedGroups: [],
  });
  assert.equal(h.writes, 0);
  const added = await h.service.save('demo', {
    expectedRevision: null,
    adminOpenIds: ['owner'],
    allowedGroups: [{ externalChatId: 'group', label: 'Team' }],
  });
  assert.equal(added.revision, 1);
  assert.equal(added.allowedGroups[0]?.addedAt, 100);
  assert.equal(h.entry.value.v, 1);
  assert.equal(h.entry.value.adminConfigured, true);
  // Simulate the existing command's CAS against the same runtime storage key.
  await h.storage.compareAndSet('demo', 'connector.permissions.v1', 1, {
    ...h.entry.value,
    allowedGroups: [...h.entry.value.allowedGroups, { externalChatId: 'command-group', addedAt: 101 }],
  });
  await assert.rejects(h.service.save('demo', { expectedRevision: 1, whitelistEnabled: true }), /changed/);
  const current = await h.service.read('demo');
  assert.equal(current.allowedGroups.length, 2);
  const saved = await h.service.save('demo', { expectedRevision: current.revision, commandAdminOnly: true });
  assert.equal(saved.commandAdminOnly, true);
  assert.equal(saved.allowedGroups[0]?.addedAt, 100);
  assert.deepEqual(h.state, before, 'configuration never changes enabled intent, runtime or package');
});

test('direct-only, invalid edits and corrupt stored state never gain a default write', async () => {
  const direct = harness(false);
  await assert.rejects(direct.service.read('demo'), /not declared/);
  assert.equal(direct.writes, 0);
  const h = harness();
  await assert.rejects(h.service.save('demo', { expectedRevision: null, adminOpenIds: ['a', 'a'] }), /duplicate/);
  await assert.rejects(
    h.service.save('demo', { expectedRevision: null, allowedGroups: [{ externalChatId: 'g', addedAt: 1 }] }),
    /field/,
  );
  await assert.rejects(h.service.save('demo', { expectedRevision: null, enabled: true }), /field/);
  assert.equal(h.writes, 0);
  await h.storage.compareAndSet('demo', 'connector.permissions.v1', null, { v: 1, whitelistEnabled: 'bad' });
  await assert.rejects(h.service.read('demo'), /invalid/);
  assert.equal(h.writes, 1);
});

test('owner/local permissions endpoint works while disabled and rejects unauthenticated or foreign-origin writes', async (t) => {
  const h = harness();
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    (request as any).sessionUserId = request.headers['x-test-owner'];
  });
  registerConnectorSettingsRoutes(app, h.service);
  const url = '/api/plugin-manager/plugins/demo/permissions';
  const headers = {
    host: 'localhost:3004',
    origin: 'http://localhost:3004',
    'x-test-owner': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user',
  };
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers: { ...headers, origin: 'https://outside.example' },
        payload: { expectedRevision: null, whitelistEnabled: true },
      })
    ).statusCode,
    403,
  );
  const read = await app.inject({ method: 'GET', url, headers });
  assert.equal(read.statusCode, 200, read.body);
  const saved = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { expectedRevision: null, whitelistEnabled: true },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().whitelistEnabled, true);
  const stale = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { expectedRevision: null, whitelistEnabled: false },
  });
  assert.equal(stale.statusCode, 409);
});
