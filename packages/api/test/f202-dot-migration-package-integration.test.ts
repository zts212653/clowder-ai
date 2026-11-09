import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LEGACY_BUNDLED_MANIFESTS } from '../src/domains/plugin/legacy-bundled-manifests.js';
import { StaticOfficialPluginCatalog } from '../src/domains/plugin/manager/official-catalog-provider.js';
import {
  type DotLegacyMigrationAudit,
  DotLegacyMigrationCoordinator,
} from '../src/domains/plugin/migration/dot-legacy-migration-coordinator.js';
import { DotLegacyMigrationJourney } from '../src/domains/plugin/migration/dot-legacy-migration-journey.js';
import { DotLegacySourceReader } from '../src/domains/plugin/migration/dot-legacy-source-reader.js';
import { PluginMigrationInvoker } from '../src/domains/plugin/migration/plugin-migration-invoker.js';
import {
  bundledManifestDigest,
  OFFICIAL_BUNDLED_MANIFESTS,
  OFFICIAL_PLUGIN_CATALOG,
} from '../src/domains/plugin/official-catalog.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import {
  InstalledPluginOperations,
  pluginOperationRoutes,
} from '../src/domains/plugin/operations/plugin-operation-routes.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../src/domains/plugin/runtime-composition.js';
import { pluginExternalRequestRoutes } from '../src/routes/plugin/plugin-external-request-routes.js';
import { pluginSharedExtensionRoutes } from '../src/routes/plugin/plugin-shared-extension-routes.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';
import { registerPluginManagerRoutes } from '../src/routes/plugin-manager-routes.js';
import { memoryPluginStorage } from './helpers/memory-plugin-private-storage.js';

const ownerUserId = 'owner-1';
const sourceInstanceId = 'legacy-dot-instance';
const secret = 'a'.repeat(64);
const salt = 'migration-salt';
const eventId = `dot_evt_${'1'.repeat(64)}`;
const imageId = `dot_img_${'2'.repeat(64)}`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

test('legacy Dot updates through the owner journey, starts with its old credential, and does not resurrect it after reinstall', async (t) => {
  const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  const legacy = LEGACY_BUNDLED_MANIFESTS.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  assert.ok(dot);
  assert.ok(legacy);
  const projectRoot = await mkdtemp(join(tmpdir(), 'f202-dot-migration-package-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const sourceRoot = join(projectRoot, 'legacy');
  const dispatchesPath = join(sourceRoot, 'dot-dispatches');
  const imagesPath = join(sourceRoot, 'dot-images');
  const imageFilesPath = join(imagesPath, 'files');
  await mkdir(dispatchesPath, { recursive: true });
  await mkdir(imageFilesPath, { recursive: true });

  const connection = {
    v: 1,
    revision: 1,
    ownerUserId,
    pluginInstanceId: sourceInstanceId,
    agentKeyId: 'ak_legacy',
    credentialSecret: secret,
    attemptId: 'attempt-1',
    pairingCode: 'b'.repeat(32),
    pairingExpiresAt: Date.now() + 60_000,
    pairedAt: 1,
    pairedCallbackUrl: 'https://example.com/dot',
    subscription: null,
    lastSourceReadAt: null,
    lastReplyAt: null,
    lastImageAt: null,
    revokedAt: null,
    testEventIds: [],
  };
  const dispatch = {
    eventId,
    ownerUserId,
    threadId: 'thread-1',
    sourceMessageId: 'message-1',
    dispatchInvocationId: 'invocation-1',
    attemptId: connection.attemptId,
    agentKeyId: connection.agentKeyId,
    occurredAt: 2,
    webhookAcknowledgedAt: null,
    sourceReadAt: null,
    replyMessageId: null,
    imagePublicationIds: [imageId],
    connectionTest: false,
  };
  const image = {
    id: imageId,
    ownerUserId,
    threadId: dispatch.threadId,
    eventId,
    publicationKey: 'publication-1',
    sha256: createHash('sha256').update(png).digest('hex'),
    byteSize: png.byteLength,
    width: 1,
    height: 1,
    messageId: null,
    alt: 'legacy image',
  };
  await Promise.all([
    writeFile(join(sourceRoot, 'dot-connection.json'), JSON.stringify(connection)),
    writeFile(join(dispatchesPath, `${eventId}.json`), JSON.stringify(dispatch)),
    writeFile(join(imagesPath, `${imageId}.json`), JSON.stringify(image)),
    writeFile(join(imageFilesPath, `${imageId}.png`), png),
  ]);

  const storage = memoryPluginStorage();
  const sharedAgentKeys = new AgentKeyRegistry();
  const sharedAgentKey = await sharedAgentKeys.issue(createCatId('gpt-pro'), ownerUserId, { expiresAt: null });
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    privateStorage: storage,
    sharedAgentKeys,
    sharedPublicEndpoint: '/mcp',
  });
  assert.ok(runtime.sharedExtension);
  t.after(() => runtime.shutdown());
  const legacyEntry = {
    catalogId: dot.catalogId,
    packageName: dot.packageName,
    version: legacy.version,
    pluginId: legacy.pluginId,
    distribution: 'bundled' as const,
    bundledFormat: 'manifest' as const,
    archiveUrl: `builtin://${dot.catalogId}/${legacy.version}`,
    packageDigest: bundledManifestDigest(legacy),
    effectiveGrants: [],
  };
  const legacyInstalled = await new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [legacyEntry],
  }).install(legacyEntry.catalogId, {
    version: legacyEntry.version,
    packageDigest: legacyEntry.packageDigest,
  });
  const legacyPrepared = await runtime.lifecycle.prepare(legacyInstalled.pluginInstanceId, 1);
  await runtime.lifecycle.enable(legacyInstalled.pluginInstanceId, legacyPrepared.lifecycleRevision);

  const audits: unknown[] = [];
  const progress = {
    records: [] as DotLegacyMigrationAudit[],
    supersessions: [] as Array<{ ownerUserId: string; sourceInstanceId: string; reason: string }>,
    save: async (audit: DotLegacyMigrationAudit) => {
      audits.push(audit);
      progress.records.push(audit);
    },
    findCompleted: async (query: {
      ownerUserId: string;
      sourceInstanceId: string;
      pluginInstanceId: string;
      packageDigest?: string;
    }) =>
      progress.records.find(
        (record) =>
          record.ownerUserId === query.ownerUserId &&
          record.sourceInstanceId === query.sourceInstanceId &&
          record.pluginInstanceId === query.pluginInstanceId &&
          (query.packageDigest === undefined || record.packageDigest === query.packageDigest),
      ),
    hasCompletedSource: async (query: { ownerUserId: string; sourceInstanceId: string }) =>
      progress.records.some(
        (record) => record.ownerUserId === query.ownerUserId && record.sourceInstanceId === query.sourceInstanceId,
      ),
    isSuperseded: async (query: { ownerUserId: string; sourceInstanceId: string }) =>
      progress.supersessions.some(
        (record) => record.ownerUserId === query.ownerUserId && record.sourceInstanceId === query.sourceInstanceId,
      ),
    supersede: async (record: { ownerUserId: string; sourceInstanceId: string; reason: string }) => {
      progress.supersessions.push(record);
    },
  };
  const coordinator = new DotLegacyMigrationCoordinator({
    source: new DotLegacySourceReader({
      connection: join(sourceRoot, 'dot-connection.json'),
      dispatches: dispatchesPath,
      images: imagesPath,
      imageFiles: imageFilesPath,
    }),
    keys: {
      get: async () => ({
        agentKeyId: connection.agentKeyId,
        catId: createCatId('gpt-dot'),
        userId: ownerUserId,
        secretHash: createHash('sha256')
          .update(secret + salt)
          .digest('hex'),
        salt,
        scope: 'user-bound',
        issuedAt: 1,
        expiresAt: null,
      }),
    },
    invoker: new PluginMigrationInvoker({
      inventory: runtime.inventoryStore,
      packages: runtime.packages,
      configuration: runtime.configuration,
      projectRoot: runtime.projectRoot,
      ...(runtime.privateStorage ? { storage: runtime.privateStorage } : {}),
      log: () => {},
    }),
    media: runtime.mediaLedger,
    audit: progress,
    externalAccess: runtime.externalAccess,
    sharedExtension: runtime.sharedExtension,
  });
  const journey = new DotLegacyMigrationJourney({
    source: new DotLegacySourceReader({
      connection: join(sourceRoot, 'dot-connection.json'),
      dispatches: dispatchesPath,
      images: imagesPath,
      imageFiles: imageFilesPath,
    }),
    coordinator,
    audit: progress,
  });
  const managerRuntime = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: new StaticOfficialPluginCatalog([dot]),
    catalogManifests: OFFICIAL_BUNDLED_MANIFESTS,
  });
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = ownerUserId;
    request.sessionBindingId = 'session-1';
    request.assertSessionCurrent = () => {};
  });
  registerPluginManagerRoutes(app, {
    manager: managerRuntime.manager,
    installedMigration: journey,
    auditLog: { append: async () => {} },
  });
  await app.register(pluginExternalRequestRoutes, { external: runtime.externalAccess });
  await app.register(pluginSharedExtensionRoutes, { service: runtime.sharedExtension });
  await app.register(pluginWebhookForwardingRoutes, { webhooks: runtime.supervisor });
  await app.register(pluginOperationRoutes, {
    operations: new InstalledPluginOperations({
      inventory: runtime.inventoryStore,
      configuration: managerRuntime.configuration,
      invocation: runtime.supervisor,
      settingsInvocation: runtime.settingsInvocation,
      sharedExtension: runtime.sharedExtension,
      // This packed integration performs cold archive verification and materialization
      // inside the owner action. Production keeps the ordinary 60-second action budget;
      // the fixture must distinguish that bounded setup cost from a transport deadlock.
      timeoutMs: 180_000,
    }),
  });

  const beforeUpdate = (await managerRuntime.manager.get(dot.pluginId)).plugin;
  assert.equal(beforeUpdate.installedVersion, legacy.version);
  assert.equal(beforeUpdate.intent, 'enabled');
  assert.ok(beforeUpdate.lifecycleRevision);
  const updated = await app.inject({
    method: 'POST',
    url: `/api/plugin-manager/plugins/${dot.pluginId}/update`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: { expectedVersion: dot.version, expectedRevision: beforeUpdate.lifecycleRevision },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const installed = updated.json() as { pluginId: string; pluginInstanceId: string };
  assert.equal(installed.pluginId, dot.pluginId);
  assert.equal(installed.pluginInstanceId, legacyInstalled.pluginInstanceId);
  assert.equal((await managerRuntime.addressedTargets.list(true))[0]?.alias, 'dot');

  const signal = new AbortController().signal;
  const migrate = () =>
    journey.ensure({
      pluginId: dot.pluginId,
      pluginInstanceId: installed.pluginInstanceId,
      packageDigest: dot.packageDigest,
      ownerUserId,
      requestId: 'request-1',
      signal,
      assertCurrent: () => {},
    });

  assert.equal(await migrate(), null, 'the completed target must not replay immutable legacy input');
  const importedConnection = (await storage.get(dot.pluginId, 'dot/connection/v1'))?.value as
    | { pluginInstanceId?: string }
    | undefined;
  assert.equal(importedConnection?.pluginInstanceId, installed.pluginInstanceId);
  assert.equal((await stat(join(sourceRoot, 'dot-connection.json'))).isFile(), true);
  assert.equal((await stat(join(imageFilesPath, `${imageId}.png`))).isFile(), true);

  assert.equal(await migrate(), null);
  assert.equal(audits.length, 1);

  const afterMigration = (await managerRuntime.manager.get(dot.pluginId)).plugin;
  assert.equal(afterMigration.intent, 'disabled');
  assert.ok(afterMigration.lifecycleRevision);
  const enabled = await app.inject({
    method: 'POST',
    url: `/api/plugin-manager/plugins/${dot.pluginId}/set-enabled`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: { enabled: true, expectedRevision: afterMigration.lifecycleRevision },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const unconfirmedEndpointSetup = await app.inject({
    method: 'POST',
    url: `/api/plugins/${dot.pluginId}/actions/longLivedEndpoint/use-long-lived`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: {
      endpointMode: 'long-lived',
      longLivedServerUrlTemplate: 'https://dot.example/api/plugin-runtime/handle?token={token}',
      externalTokenDays: '180',
    },
  });
  assert.equal(unconfirmedEndpointSetup.statusCode, 400, unconfirmedEndpointSetup.body);
  assert.deepEqual(unconfirmedEndpointSetup.json(), { error: 'Confirm this operation first' });
  const beforeStatus = structuredClone((await storage.get(dot.pluginId, 'dot/connection/v1'))?.value);
  for (let read = 0; read < 2; read += 1) {
    const status = await app.inject({
      method: 'POST',
      url: `/api/plugins/${dot.pluginId}/actions/connection/status`,
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      payload: {},
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().render, 'rows');
    assert.deepEqual(status.json().data.rows, [{ key: 'waiting-connection', label: '待连接', detail: '' }]);
    assert.equal(JSON.stringify(status.json()).includes(secret), false, 'the owner journey never returns a Host token');
    assert.deepEqual(
      (await storage.get(dot.pluginId, 'dot/connection/v1'))?.value,
      beforeStatus,
      'status is a pure read and preserves the migrated pairing',
    );
    assert.equal(
      (beforeStatus as { attemptId?: string } | undefined)?.attemptId,
      connection.attemptId,
      'the self-service endpoint journey preserves the live migrated pairing',
    );
  }
  const tools = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/handle',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(tools.statusCode, 200, tools.body);
  assert.equal(tools.json().jsonrpc, '2.0');
  assert.ok(Array.isArray(tools.json().result?.tools));
  const sharedTools = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/shared/handle',
    headers: { 'content-type': 'application/json', 'x-agent-key-secret': sharedAgentKey.secret },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(sharedTools.statusCode, 200, sharedTools.body);
  assert.ok(Array.isArray(sharedTools.json().result?.tools));
  const running = (await managerRuntime.manager.get(dot.pluginId)).plugin;
  assert.equal(running.intent, 'enabled');
  assert.ok(running.lifecycleRevision);
  const disabled = await app.inject({
    method: 'POST',
    url: `/api/plugin-manager/plugins/${dot.pluginId}/set-enabled`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: { enabled: false, expectedRevision: running.lifecycleRevision },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  const stopped = (await managerRuntime.manager.get(dot.pluginId)).plugin;
  assert.equal(stopped.intent, 'disabled');
  assert.ok(stopped.lifecycleRevision);
  const uninstalled = await app.inject({
    method: 'POST',
    url: `/api/plugin-manager/plugins/${dot.pluginId}/uninstall`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: { expectedRevision: stopped.lifecycleRevision },
  });
  assert.equal(uninstalled.statusCode, 200, uninstalled.body);

  const reinstalledResponse = await app.inject({
    method: 'POST',
    url: '/api/plugin-manager/plugins/install',
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: {
      source: { kind: 'catalog', catalogId: dot.catalogId },
      expectedVersion: dot.version,
      expectedDigest: dot.packageDigest,
    },
  });
  assert.equal(reinstalledResponse.statusCode, 201, reinstalledResponse.body);
  const reinstalled = reinstalledResponse.json() as { pluginId: string; pluginInstanceId: string };
  assert.notEqual(reinstalled.pluginInstanceId, installed.pluginInstanceId);
  const retainedHistory = (await storage.get(dot.pluginId, 'dot/connection/v1'))?.value as
    | { pluginInstanceId?: string }
    | undefined;
  assert.equal(
    retainedHistory?.pluginInstanceId,
    installed.pluginInstanceId,
    'reinstall preserves the first import as history without rebinding it to the new installation',
  );
  assert.notEqual(retainedHistory?.pluginInstanceId, reinstalled.pluginInstanceId);
  const dormantReinstall = (await managerRuntime.manager.get(dot.pluginId)).plugin;
  assert.equal(dormantReinstall.intent, 'disabled');
  assert.ok(dormantReinstall.lifecycleRevision);
  const reinstalledEnabled = await app.inject({
    method: 'POST',
    url: `/api/plugin-manager/plugins/${dot.pluginId}/set-enabled`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: { enabled: true, expectedRevision: dormantReinstall.lifecycleRevision },
  });
  assert.equal(reinstalledEnabled.statusCode, 200, reinstalledEnabled.body);
  const retiredLegacyTools = await app.inject({
    method: 'POST',
    url: '/api/plugin-runtime/handle',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  });
  assert.equal(retiredLegacyTools.statusCode, 401, retiredLegacyTools.body);
  assert.equal(
    progress.records.length,
    1,
    'reinstall preserves package-owned state without importing the legacy source into a new installation',
  );
  const finalRunning = (await managerRuntime.manager.get(dot.pluginId)).plugin;
  assert.equal(finalRunning.intent, 'enabled');
  assert.ok(finalRunning.lifecycleRevision);
  const finalStop = await app.inject({
    method: 'POST',
    url: `/api/plugin-manager/plugins/${dot.pluginId}/set-enabled`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
    payload: { enabled: false, expectedRevision: finalRunning.lifecycleRevision },
  });
  assert.equal(finalStop.statusCode, 200, finalStop.body);
});
