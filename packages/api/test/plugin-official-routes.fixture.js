import Fastify from 'fastify';

import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OFFICIAL_PLUGIN_CATALOG,
} from '../dist/domains/plugin/index.js';
import { registerOfficialPluginRoutes } from '../dist/routes/plugin-official-routes.js';

export const entry = OFFICIAL_PLUGIN_CATALOG[0];

function manifest(overrides = {}) {
  return {
    pluginId: entry.pluginId,
    version: entry.version,
    contractVersion: '0.1.0',
    name: 'Feishu Meeting Intake',
    features: [{ id: 'source', name: 'Source', resources: [], capabilities: ['events.publish'] }],
    runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
    ...overrides,
  };
}

export async function harness(options = {}) {
  let now = 1_000;
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => now++,
  });
  const installedVersion = options.installedVersion ?? entry.version;
  const installedDigest = options.installedDigest ?? entry.packageDigest;
  const installed = await inventory.installPackage({
    manifest: manifest({ version: installedVersion }),
    computedPackageDigest: installedDigest,
    expectedPackageDigest: installedDigest,
    packagePluginId: entry.pluginId,
    effectiveGrants: ['events.publish'],
  });
  const processCalls = [];
  const lifecycle = new ExternalPluginLifecycleService({
    store,
    now: () => now++,
    supervisor: {
      start: async (instanceId) => {
        processCalls.push(`start:${instanceId}`);
        return options.start?.(instanceId);
      },
      stop: async (instanceId) => {
        processCalls.push(`stop:${instanceId}`);
        return options.stop?.(instanceId);
      },
    },
  });
  const app = Fastify();
  const installCalls = [];
  const updateCalls = [];
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  registerOfficialPluginRoutes(app, {
    ...(options.catalogProvider
      ? { catalogProvider: options.catalogProvider }
      : { catalog: options.catalog ?? OFFICIAL_PLUGIN_CATALOG }),
    inventory: store,
    lifecycle,
    installer: {
      install: async (catalogId, expectedRelease) => {
        installCalls.push({ catalogId, expectedRelease });
        return installed;
      },
      update: async (catalogId, instanceId, expectedRevision, expectedRelease) => {
        updateCalls.push({ catalogId, instanceId, expectedRevision, expectedRelease });
        if (options.update) {
          return options.update({ catalogId, instanceId, expectedRevision, expectedRelease });
        }
        return inventory.upgradePackage({
          pluginInstanceId: instanceId,
          expectedLifecycleRevision: expectedRevision,
          expectedGrantRevision: 1,
          manifest: manifest(),
          computedPackageDigest: entry.packageDigest,
          expectedPackageDigest: entry.packageDigest,
          packagePluginId: entry.pluginId,
          effectiveGrants: ['events.publish'],
        });
      },
    },
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    ...(options.historyImport === undefined ? {} : { historyImport: options.historyImport }),
    ...(options.meetingIntake === undefined ? {} : { meetingIntake: options.meetingIntake }),
  });
  await app.ready();
  return { app, store, processCalls, installCalls, updateCalls };
}

const ownerUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
export const readHeaders = { 'x-test-session-user': ownerUserId };
export const writeHeaders = {
  host: 'localhost:3004',
  origin: 'http://localhost:5173',
  'x-test-session-user': ownerUserId,
};
export const installPayload = {
  expectedCatalogVersion: entry.version,
  expectedPackageDigest: entry.packageDigest,
};
