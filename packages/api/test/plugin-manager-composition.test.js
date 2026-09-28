import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import { registerOfficialPluginRoutes } from '../dist/routes/plugin-official-routes.js';
import { catalogEntry, manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(label) {
  const path = await mkdtemp(join(tmpdir(), label));
  roots.push(path);
  return path;
}

async function harness({
  packageManifest = manifest(),
  offline = () => false,
  contract,
  machinePresentation = false,
} = {}) {
  const projectRoot = await root('cat-cafe-f202-manager-composition-');
  const archive = await packageArchive({ packageManifest });
  const entry = catalogEntry(archive.integrity, {
    pluginId: packageManifest.pluginId,
    version: packageManifest.version,
    ...(machinePresentation
      ? {
          presentation: {
            displayName: packageManifest.name,
            description: packageManifest.description,
            icon: packageManifest.icon,
            publisher: 'Clowder AI',
          },
        }
      : {}),
  });
  const provider = {
    snapshot: async () => {
      if (offline()) throw new Error('catalog offline');
      return { entries: [entry], status: 'fresh', checkedAt: 8_000 };
    },
  };
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    now: () => 9_000,
    ...(contract === undefined ? {} : { contract }),
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: provider,
    catalogManifests: [packageManifest],
    fetchOfficialArchive: async () => archive.bytes,
    now: () => 9_000,
  });
  return { archive, composition, entry, projectRoot, provider, runtime };
}

function contributionContractRuntime() {
  return {
    manifestContractVersions: ['0.1.0'],
    validateEffectiveGrants,
    validateManifest,
  };
}

describe('F202 Plugin Manager runtime composition', () => {
  it('keeps legacy official discovery and installation on the same catalog authority', async () => {
    const projectRoot = await root('cat-cafe-f202-official-route-composition-');
    const packageManifest = manifest();
    const archive = await packageArchive({ packageManifest });
    const legacyEntry = catalogEntry(archive.integrity, {
      pluginId: packageManifest.pluginId,
      version: packageManifest.version,
    });
    const legacyCatalog = {
      snapshot: async () => ({ entries: [legacyEntry], status: 'fresh', checkedAt: 8_000 }),
    };
    const machineCatalog = {
      snapshot: async () => ({
        entries: [
          {
            ...legacyEntry,
            catalogId: 'video-analysis',
            pluginId: 'dev.clowder.video-analysis',
            packageName: '@clowder-ai/video-analysis',
          },
        ],
        status: 'fresh',
        checkedAt: 8_000,
      }),
    };
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
      contract: contributionContractRuntime(),
    });
    const composition = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: machineCatalog,
      officialRouteCatalogProvider: legacyCatalog,
      catalogManifests: [],
      fetchOfficialArchive: async () => archive.bytes,
    });
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
    });
    registerOfficialPluginRoutes(app, {
      inventory: runtime.inventoryStore,
      lifecycle: runtime.lifecycle,
      catalogProvider: legacyCatalog,
      installer: composition.officialRouteInstaller,
    });
    await app.ready();
    try {
      const listed = await app.inject({ method: 'GET', url: '/api/plugins/official' });
      assert.equal(listed.statusCode, 200, listed.payload);
      assert.equal(listed.json().plugins[0].catalogId, legacyEntry.catalogId);

      const installed = await app.inject({
        method: 'POST',
        url: `/api/plugins/official/${legacyEntry.catalogId}/install`,
        headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
        remoteAddress: '127.0.0.1',
        payload: {
          expectedCatalogVersion: legacyEntry.version,
          expectedPackageDigest: legacyEntry.packageDigest,
        },
      });
      assert.equal(installed.statusCode, 200, installed.payload);
      assert.equal(installed.json().pluginId, legacyEntry.pluginId);
    } finally {
      await app.close();
    }
  });

  it('joins validated package metadata to release discovery and installs through the shared Host inventory', async () => {
    const { composition, entry, runtime } = await harness();

    const before = await composition.manager.list();
    assert.equal(before.catalog.status, 'fresh');
    assert.deepEqual(
      before.plugins.map((plugin) => plugin.pluginId),
      [entry.pluginId],
    );
    assert.equal(before.plugins[0].actions.install, true);
    assert.deepEqual(before.plugins[0].capabilitySummary, [
      { id: 'events.publish', kind: 'events', name: 'Source', active: false },
    ]);

    const installed = await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    const snapshot = await runtime.inventoryStore.snapshot();

    assert.equal(installed.pluginId, entry.pluginId);
    assert.equal(snapshot.instances.length, 1);
    assert.deepEqual(snapshot.packages[0].provenance, {
      kind: 'catalog',
      catalogId: entry.catalogId,
      packageName: entry.packageName,
      ownerAuthRequired: false,
    });
    const projected = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(projected.artifact, 'installed');
    assert.equal(projected.config, 'ready', 'a manifest without required configuration is immediately ready');
    assert.equal(projected.lifecycleRevision, 2);
  });

  it('rewrites a verified package-relative icon to the Host same-origin asset route', async () => {
    const packageManifest = manifest({
      icon: { type: 'svg', src: 'assets/icon.svg' },
    });
    const { composition, entry } = await harness({
      packageManifest,
      contract: contributionContractRuntime(),
    });

    const [plugin] = (await composition.manager.list()).plugins;

    assert.equal(plugin.pluginId, entry.pluginId);
    assert.deepEqual(plugin.icon, {
      type: 'svg',
      src: `/api/plugin-manager/plugins/${encodeURIComponent(entry.pluginId)}/icon`,
    });
  });

  it('persists typed configuration, masks secrets, and advances readiness under the lifecycle fence', async () => {
    const packageManifest = manifest({
      configuration: [
        {
          key: 'provider',
          label: 'Video provider',
          kind: 'select',
          required: true,
          options: [
            { value: 'gemini', label: 'Gemini' },
            { value: 'zhipu', label: 'Zhipu' },
          ],
        },
        { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
        { key: 'baseUrl', label: 'Base URL', kind: 'url', required: false },
      ],
    });
    const { composition, entry, runtime } = await harness({
      packageManifest,
      contract: contributionContractRuntime(),
    });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });

    const before = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(before.config, 'incomplete');
    assert.deepEqual(
      before.configFields.map(({ key, kind, currentValue, sensitive }) => ({ key, kind, currentValue, sensitive })),
      [
        { key: 'provider', kind: 'select', currentValue: null, sensitive: false },
        { key: 'apiKey', kind: 'secret', currentValue: null, sensitive: true },
        { key: 'baseUrl', kind: 'url', currentValue: null, sensitive: false },
      ],
    );

    await assert.rejects(
      () =>
        composition.manager.configure(entry.pluginId, {
          expectedRevision: 1,
          updates: [{ key: 'provider', value: 'unknown' }],
        }),
      (error) => error?.code === 'INVALID_CONFIGURATION',
    );
    await composition.manager.configure(entry.pluginId, {
      expectedRevision: 1,
      updates: [
        { key: 'provider', value: 'gemini' },
        { key: 'apiKey', value: 'private-key' },
      ],
    });

    const after = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(after.config, 'ready');
    assert.equal(after.lifecycleRevision, 2);
    assert.equal(after.configFields.find((field) => field.key === 'provider').currentValue, 'gemini');
    assert.equal(after.configFields.find((field) => field.key === 'apiKey').currentValue, '••••••');
    assert.equal(JSON.stringify(await runtime.inventoryStore.snapshot()).includes('private-key'), false);
  });

  it('projects typed defaults as the same effective values used for readiness', async () => {
    const packageManifest = manifest({
      configuration: [
        { key: 'model', label: 'Model', kind: 'string', required: true, default: 'default-model' },
        { key: 'retries', label: 'Retries', kind: 'number', required: true, default: 3 },
        { key: 'stream', label: 'Stream', kind: 'boolean', required: true, default: false },
      ],
    });
    const { composition, entry } = await harness({
      packageManifest,
      contract: contributionContractRuntime(),
    });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });

    const plugin = (await composition.manager.get(entry.pluginId)).plugin;

    assert.equal(plugin.config, 'ready');
    assert.deepEqual(
      plugin.configFields.map(({ key, currentValue }) => ({ key, currentValue })),
      [
        { key: 'model', currentValue: 'default-model' },
        { key: 'retries', currentValue: '3' },
        { key: 'stream', currentValue: 'false' },
      ],
    );
  });

  it('keeps an installed catalog plugin manageable while discovery is offline and fences uninstall', async () => {
    let offline = false;
    const { composition, entry, runtime } = await harness({ offline: () => offline });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    offline = true;

    const degraded = await composition.manager.list();
    assert.equal(degraded.catalog.status, 'unavailable');
    assert.equal(degraded.plugins.length, 1);
    assert.deepEqual(degraded.plugins[0].source, {
      kind: 'catalog',
      catalogId: entry.catalogId,
      packageName: entry.packageName,
      trust: 'official',
    });
    assert.equal(degraded.plugins[0].actions.uninstall, true);

    await assert.rejects(
      () => composition.manager.uninstall(entry.pluginId, { expectedRevision: 99 }),
      (error) => error?.code === 'STALE_REVISION',
    );
    assert.equal((await runtime.inventoryStore.snapshot()).instances[0].lifecycleState, 'installed');

    await composition.manager.uninstall(entry.pluginId, { expectedRevision: 2 });
    assert.equal((await runtime.inventoryStore.snapshot()).instances[0].lifecycleState, 'retired');
  });

  it('fails closed for legacy inventory whose admission provenance cannot be proven', async () => {
    let offline = false;
    const { composition, entry, runtime } = await harness({ offline: () => offline });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    await runtime.inventoryStore.transaction((transaction) => {
      const current = transaction.packages.get(entry.packageDigest);
      assert.ok(current);
      const { provenance: _legacyMissingField, ...legacy } = current;
      transaction.packages.put(legacy);
    });
    offline = true;

    const [plugin] = (await composition.manager.list()).plugins;
    assert.deepEqual(plugin.source, { kind: 'legacy', packageName: null, trust: 'unknown' });
    assert.equal(plugin.auth, 'error');
    assert.equal(plugin.actions.setEnabled, false);
    assert.deepEqual(plugin.actions.blockingReasons, ['auth-error']);
    assert.equal(plugin.actions.uninstall, true);
  });

  it('admits a local archive without persisting its raw host path or granting requested authority', async () => {
    const packageManifest = manifest({ pluginId: 'local.test-source', name: 'Local Test Source' });
    const { archive, composition, projectRoot, runtime } = await harness({ packageManifest });
    const archivePath = join(projectRoot, 'local-plugin.tgz');
    await writeFile(archivePath, archive.bytes);

    const installed = await composition.manager.install({
      source: { kind: 'local-archive', path: archivePath },
    });
    const snapshot = await runtime.inventoryStore.snapshot();
    const listed = await composition.manager.get(packageManifest.pluginId);

    assert.equal(installed.pluginId, packageManifest.pluginId);
    assert.deepEqual(snapshot.packages[0].provenance, { kind: 'local-archive' });
    assert.deepEqual(snapshot.grants[0].effectiveGrants, []);
    assert.deepEqual(listed.plugin.source, {
      kind: 'local-archive',
      packageName: null,
      trust: 'local-trusted',
    });
    assert.equal(JSON.stringify(snapshot).includes(archivePath), false);
  });

  it('degrades closed when release metadata and package-owned manifest versions diverge', async () => {
    const { composition, entry } = await harness({
      packageManifest: manifest({ version: '0.1.0-alpha.0' }),
    });
    // The harness catalog follows the package version, so replace the catalog manifest input
    // by constructing a deliberately stale composition over the same runtime/provider.
    const stale = createPluginManagerRuntimeComposition({
      runtime: (await harness()).runtime,
      catalogProvider: {
        snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 8_000 }),
      },
      catalogManifests: [manifest({ version: '9.9.9' })],
    });

    const result = await stale.manager.list();
    assert.equal(result.catalog.status, 'degraded');
    assert.deepEqual(result.plugins, []);
    assert.match(result.catalog.message, /did not match/i);
    assert.ok(composition.manager, 'baseline composition remains independently usable');
  });

  it('does not retire inventory when the Host lifecycle rejects uninstall', async () => {
    const { composition, entry, runtime } = await harness();
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    runtime.lifecycle.uninstall = async () => {
      throw new Error('runtime authority could not be revoked');
    };

    await assert.rejects(
      () => composition.manager.uninstall(entry.pluginId, { expectedRevision: 2 }),
      (error) => error?.code === 'LIFECYCLE_UNAVAILABLE',
    );
    const snapshot = await runtime.inventoryStore.snapshot();
    assert.equal(snapshot.instances[0].lifecycleState, 'installed');
    assert.equal(snapshot.instances[0].lifecycleRevision, 2);
    assert.equal(snapshot.grants.length, 1);
  });

  it('routes builtin contribution packages through the Host-owned materializer and supervisor', async () => {
    let catalogOffline = false;
    const packageManifest = manifest({
      runtime: { transport: 'builtin' },
      description: 'Runs the fixture capability through a Host-supervised contribution.',
      icon: 'github',
      contributions: [
        {
          type: 'mcp',
          id: 'fixture-tools',
          runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
        },
      ],
      features: [
        {
          id: 'source',
          name: 'Source',
          resources: [],
          contributions: [{ type: 'mcp', id: 'fixture-tools' }],
          capabilities: ['events.publish'],
        },
      ],
    });
    const contract = contributionContractRuntime();
    const { archive, entry, provider, runtime } = await harness({
      packageManifest,
      contract,
      offline: () => catalogOffline,
      machinePresentation: true,
    });
    const materializedRoot = await root('cat-cafe-f202-builtin-materialized-');
    await mkdir(join(materializedRoot, 'dist'), { recursive: true });
    await writeFile(join(materializedRoot, 'dist/entrypoint.js'), '// builtin fixture\n', 'utf8');
    const launches = [];
    const composition = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: provider,
      // Production discovery has release metadata only; the verified package manifest
      // becomes authoritative after inventory admission.
      catalogManifests: [],
      fetchOfficialArchive: async () => archive.bytes,
      builtinContributions: {
        materializer: {
          resolve: async () => ({
            rootDir: materializedRoot,
            verifyIntegrity: async () => {},
            release: async () => {},
          }),
        },
        configuration: {
          readConfig: async () => undefined,
          readSecret: async () => undefined,
        },
        runtime: {
          start: async (spec) => {
            launches.push(structuredClone(spec));
            return {
              tools: [
                {
                  name: 'fixture_tool',
                  description: 'Run the fixture capability.',
                  inputSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                  },
                },
              ],
              callTool: async (name, args) => ({ ok: true, name, args }),
              close: async () => {},
            };
          },
        },
      },
    });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    await composition.manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: 2 });

    assert.equal(launches.length, 1);
    assert.equal(launches[0].contributionId, 'fixture-tools');
    assert.equal(launches[0].cwd, await realpath(materializedRoot));
    const running = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(running.live, 'running');
    assert.deepEqual(running.capabilitySummary, [
      { id: 'events.publish', kind: 'events', name: 'Source', active: true },
    ]);
    assert.deepEqual(await composition.builtinSupervisor.listPluginTools(entry.pluginId), [
      {
        contributionId: 'fixture-tools',
        name: 'fixture_tool',
        description: 'Run the fixture capability.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ]);
    assert.deepEqual(
      await composition.builtinSupervisor.callPluginTool(entry.pluginId, 'fixture-tools', 'fixture_tool', {
        value: 'real-call',
      }),
      { ok: true, name: 'fixture_tool', args: { value: 'real-call' } },
    );

    catalogOffline = true;
    const degraded = await composition.manager.list();
    assert.equal(degraded.catalog.status, 'unavailable');
    assert.deepEqual(degraded.plugins[0].capabilitySummary, [
      { id: 'events.publish', kind: 'events', name: 'Source', active: true },
    ]);
    catalogOffline = false;

    await composition.manager.setEnabled(entry.pluginId, { enabled: false, expectedRevision: 4 });
    const stopped = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(stopped.live, 'stopped');
    assert.deepEqual(stopped.capabilitySummary, [
      { id: 'events.publish', kind: 'events', name: 'Source', active: false },
    ]);
    await assert.rejects(composition.builtinSupervisor.listPluginTools(entry.pluginId), /is not active/);
  });

  it('surfaces a typed diagnostic when a builtin contribution cannot start', async () => {
    const packageManifest = manifest({
      runtime: { transport: 'builtin' },
      description: 'Runs the fixture capability through a Host-supervised contribution.',
      icon: 'github',
      contributions: [
        {
          type: 'mcp',
          id: 'fixture-tools',
          runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
        },
      ],
      features: [
        {
          id: 'source',
          name: 'Source',
          resources: [],
          contributions: [{ type: 'mcp', id: 'fixture-tools' }],
          capabilities: ['events.publish'],
        },
      ],
    });
    const contract = contributionContractRuntime();
    const { archive, entry, provider, runtime } = await harness({
      packageManifest,
      contract,
      machinePresentation: true,
    });
    const materializedRoot = await root('cat-cafe-f202-builtin-start-failure-');
    await mkdir(join(materializedRoot, 'dist'), { recursive: true });
    await writeFile(join(materializedRoot, 'dist/entrypoint.js'), '// builtin fixture\n', 'utf8');
    const composition = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: provider,
      catalogManifests: [],
      fetchOfficialArchive: async () => archive.bytes,
      builtinContributions: {
        materializer: {
          resolve: async () => ({
            rootDir: materializedRoot,
            verifyIntegrity: async () => {},
            release: async () => {},
          }),
        },
        configuration: {
          readConfig: async () => undefined,
          readSecret: async () => undefined,
        },
        runtime: {
          start: async () => {
            throw new Error('secret-bearing child failure');
          },
        },
      },
    });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });

    await assert.rejects(
      () => composition.manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: 2 }),
      (error) => error?.code === 'RUNTIME_START_FAILED',
    );
    const failed = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(failed.live, 'stopped');
    assert.equal(failed.diagnostic?.code, 'UNEXPECTED_RUNTIME_FAILURE');
    assert.equal(failed.diagnostic?.revision, 5);
  });
});
