import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';

import { createPluginManagerHttpClient } from '../../mcp-server/dist/tools/plugin-management-tools.js';
import { FileHostBrokerStore } from '../dist/domains/plugin/host-broker/stores.js';
import { FilePluginInventoryStore } from '../dist/domains/plugin/host-inventory/stores.js';
import { PluginManagerService } from '../dist/domains/plugin/manager/plugin-manager-service.js';
import { InventoryPluginManagerInstalledPackages } from '../dist/domains/plugin/runtime-composition.js';
import { registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';

function installation(pluginId, index, recordedOrigin) {
  const packageDigest = `sha512-${createHash('sha512').update(pluginId).digest('base64')}`;
  const pluginInstanceId = `instance-${index}`;
  const candidate = {
    pluginId,
    packageDigest,
    catalogId: pluginId,
    packageName: `@test/plugin-${index}`,
    version: '0.1.0',
    displayName: `Plugin ${index}`,
    ownerAuthRequired: false,
    capabilities: [{ id: 'messaging.send', kind: 'messaging', name: 'Messages' }],
  };
  return {
    candidate,
    packageRecord: {
      pluginId,
      packageDigest,
      version: '0.1.0',
      contractVersion: '0.1.0',
      manifest: {
        pluginId,
        version: '0.1.0',
        contractVersion: '0.1.0',
        name: `Installed ${index}`,
        features: [{ id: 'messages', name: 'Messages', resources: [], capabilities: ['messaging.send'] }],
        runtime: { transport: 'builtin' },
      },
      ...(recordedOrigin
        ? { provenance: { kind: 'catalog', catalogId: pluginId, packageName: candidate.packageName } }
        : {}),
      signalSchemas: {},
      packageState: 'installed',
      verifiedAt: 1000,
      updatedAt: 1000,
    },
    instance: {
      pluginId,
      pluginInstanceId,
      packageDigest,
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: index === 0 ? 'enabled' : 'disabled',
      runtimeState: index === 0 ? 'healthy' : 'stopped',
      lifecycleRevision: 4,
      installedAt: 1000,
      updatedAt: 1000,
    },
    grant: {
      pluginInstanceId,
      requestedCapabilities: ['messaging.send'],
      effectiveGrants: index === 0 ? [] : ['messaging.send'],
      grantRevision: 2,
      updatedAt: 1000,
    },
  };
}

test('mixed legacy origins remain readable through real file stores and Manager HTTP without writes or new authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f202-manager-legacy-origin-'));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const installations = [
    'official.chatgpt-dot',
    'dev.clowder.genoffice-docx',
    'dev.clowder.video-analysis',
    'official.collective-connector',
  ].map((id, index) => installation(id, index, index === 2));
  const snapshot = {
    schemaVersion: 1,
    packages: installations.map((row) => row.packageRecord),
    instances: installations.map((row) => row.instance),
    grants: installations.map((row) => row.grant),
  };
  const path = join(root, 'inventory.json');
  await writeFile(path, JSON.stringify(snapshot));
  const before = await readFile(path);
  const store = new FilePluginInventoryStore(path);
  const parsedBefore = await store.snapshot();
  let writes = 0;
  const inventory = {
    snapshot: () => store.snapshot(),
    transaction: async () => {
      writes++;
      throw new Error('read projection must not transact');
    },
  };
  let offline = false;
  let installCalls = 0;
  const manager = new PluginManagerService({
    inventory,
    catalog: {
      snapshot: async () => ({
        candidates: offline ? [] : installations.slice(0, 3).map((row) => row.candidate),
        status: offline ? 'unavailable' : 'fresh',
        refreshedAt: null,
      }),
    },
    installedPackages: new InventoryPluginManagerInstalledPackages(
      inventory,
      new FileHostBrokerStore(join(root, 'broker.json')),
      { readConfig: async () => null },
    ),
    installer: {
      install: async () => {
        installCalls++;
        throw new Error('unexpected installation');
      },
    },
  });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  });
  registerPluginManagerRoutes(app, {
    manager,
    auditLog: {
      append: async () => {
        writes++;
      },
    },
  });
  const mcpClient = createPluginManagerHttpClient({
    resolveAuth: () => ({ apiUrl: 'http://localhost:3102', headers: {} }),
    fetchImpl: async (url, init) => {
      const response = await app.inject({
        method: init?.method ?? 'GET',
        url: new URL(url).pathname,
        headers: init?.headers,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  for (const catalogOffline of [false, true]) {
    offline = catalogOffline;
    const response = await app.inject({ method: 'GET', url: '/api/plugin-manager/plugins' });
    assert.equal(response.statusCode, 200, response.body);
    const listed = response.json();
    assert.equal(listed.plugins.length, 4, 'also retain a legacy installation absent from catalog');
    assert.deepEqual(await mcpClient.list(), listed, 'MCP forwards unknown-origin rows without relabeling');
    for (const row of installations) {
      const detail = await app.inject({ method: 'GET', url: `/api/plugin-manager/plugins/${row.candidate.pluginId}` });
      assert.equal(detail.statusCode, 200, detail.body);
      const plugin = detail.json().plugin;
      assert.deepEqual(await mcpClient.get(row.candidate.pluginId), detail.json());
      assert.deepEqual(
        plugin.source,
        row.packageRecord.provenance
          ? {
              kind: 'catalog',
              catalogId: row.candidate.catalogId,
              packageName: row.candidate.packageName,
              trust: 'official',
            }
          : { kind: 'unknown', packageName: null, trust: 'unknown' },
      );
      assert.equal(plugin.pluginInstanceId, row.instance.pluginInstanceId);
      assert.equal(plugin.packageDigest, row.instance.packageDigest);
      assert.equal(plugin.displayName, row.packageRecord.manifest.name);
      assert.equal(plugin.config, 'ready');
      assert.equal(plugin.intent, row.instance.activationState);
      assert.equal(plugin.live, row.instance.runtimeState === 'healthy' ? 'running' : 'stopped');
      assert.equal(plugin.lifecycleRevision, row.instance.lifecycleRevision);
      assert.equal(plugin.capabilities[0].active, false, 'no broker lease means no active capability');
    }
    const absent = await app.inject({ method: 'GET', url: '/api/plugin-manager/plugins/not.installed' });
    assert.equal(absent.statusCode, 404, absent.body);
  }
  offline = false;
  for (const expectedRevision of [3, 4]) {
    await assert.rejects(
      () =>
        manager.update('official.chatgpt-dot', {
          expectedVersion: '0.1.0',
          expectedRevision,
        }),
      (error) => error.code === (expectedRevision === 3 ? 'STALE_REVISION' : 'ACTION_NOT_ALLOWED'),
    );
  }
  assert.equal(installCalls, 0, 'an unknown source does not become an update route');
  assert.equal(writes, 0);
  assert.deepEqual(await readFile(path), before, 'read operations preserve the original disk bytes');
  assert.deepEqual(await store.snapshot(), parsedBefore, 'no new provenance, grants or lifecycle changes');
});
