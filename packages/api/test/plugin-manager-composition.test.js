import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { InstalledPluginOperations } from '../dist/domains/plugin/operations/plugin-operation-routes.js';
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
  extraFiles = {},
} = {}) {
  const projectRoot = await root('cat-cafe-f202-manager-composition-');
  const archive = await packageArchive({ packageManifest, extraFiles });
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
  let mcpConfig = null;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    now: () => 9_000,
    mcpConfigIO: {
      readConfig: async () => structuredClone(mcpConfig),
      writeAndRegenCli: async (config) => {
        mcpConfig = structuredClone(config);
      },
      withLock: async (fn) => fn(),
    },
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

  it('projects hidden and conditional fields and derives readiness from the effective selector', async () => {
    const packageManifest = manifest({
      configuration: [
        { key: 'mode', label: 'Mode', kind: 'string', required: false, default: 'webhook' },
        { key: 'internalFlag', label: 'Internal', kind: 'boolean', required: false, hidden: true, default: false },
        {
          key: 'token',
          label: 'Token',
          kind: 'string',
          required: true,
          requiredWhen: { key: 'mode', value: ['webhook', 'hybrid'] },
        },
      ],
    });
    const { composition, entry } = await harness({ packageManifest, contract: contributionContractRuntime() });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    const before = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(before.config, 'incomplete');
    assert.equal(before.configFields.find((field) => field.key === 'internalFlag').hidden, true);
    assert.deepEqual(before.configFields.find((field) => field.key === 'token').requiredWhen, {
      key: 'mode',
      value: ['webhook', 'hybrid'],
    });
    assert.equal(before.configFields.find((field) => field.key === 'token').requiredNow, true);
    await composition.manager.configure(entry.pluginId, {
      expectedRevision: before.lifecycleRevision,
      updates: [{ key: 'mode', value: 'polling' }],
    });
    const after = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(after.config, 'ready');
    assert.equal(after.configFields.find((field) => field.key === 'token').requiredNow, false);
  });

  it('projects declared operations, persisted operation state, setup steps, and testability', async () => {
    const packageManifest = manifest({
      configuration: [
        { key: 'provider', label: 'Provider', kind: 'string', required: false },
        {
          key: 'login',
          label: 'Log in',
          kind: 'operation',
          required: false,
          target: ['provider'],
          actions: [
            {
              id: 'begin',
              label: 'Begin',
              render: 'button',
              action: { method: 'login.begin', params: { private: true } },
              next: 'status',
            },
            { id: 'status', label: 'Status', render: 'polling', action: { method: 'login.status' } },
          ],
        },
      ],
      test: { action: { method: 'self.test' } },
      steps: [{ text: 'Open the login page.' }, { text: 'Approve access.' }],
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
    await composition.configuration.writeOperationState(entry.pluginId, 'login', {
      currentAction: 'status',
      updatedAt: 12,
      lastResult: { render: 'polling', data: { waiting: true } },
    });

    const plugin = (await composition.manager.get(entry.pluginId)).plugin;
    assert.deepEqual(plugin.steps, ['Open the login page.', 'Approve access.']);
    assert.equal(plugin.testable, true);
    const operation = plugin.configFields.find((field) => field.key === 'login');
    assert.deepEqual(operation, {
      key: 'login',
      label: 'Log in',
      kind: 'operation',
      required: false,
      currentValue: null,
      sensitive: false,
      target: ['provider'],
      configured: false,
      actions: [
        { id: 'begin', label: 'Begin', render: 'button', next: 'status' },
        { id: 'status', label: 'Status', render: 'polling' },
      ],
      operationState: {
        currentAction: 'status',
        updatedAt: 12,
        lastResult: { render: 'polling', data: { waiting: true } },
      },
    });
    assert.equal(JSON.stringify(operation).includes('login.begin'), false);
    assert.equal(JSON.stringify(operation).includes('private'), false);
    await composition.manager.configure(entry.pluginId, {
      expectedRevision: plugin.lifecycleRevision,
      updates: [{ key: 'provider', value: 'feishu' }],
    });
    const configured = (await composition.manager.get(entry.pluginId)).plugin.configFields.find(
      (field) => field.key === 'login',
    );
    assert.equal(configured.configured, true);
  });

  it('projects operation configured only for declared targets with all effective values', async () => {
    const packageManifest = manifest({
      configuration: [
        { key: 'account', label: 'Account', kind: 'string', required: false, default: 'fixture' },
        { key: 'token', label: 'Token', kind: 'secret', required: false },
        { key: 'mode', label: 'Mode', kind: 'string', required: false },
        {
          key: 'connect',
          label: 'Connect',
          kind: 'operation',
          required: false,
          target: ['account', 'token'],
          actions: [{ id: 'start', label: 'Start', render: 'button', action: { method: 'connect.start' } }],
        },
        {
          key: 'inspect',
          label: 'Inspect',
          kind: 'operation',
          required: false,
          actions: [{ id: 'check', label: 'Check', render: 'button', action: { method: 'inspect.check' } }],
        },
      ],
    });
    const { composition, entry } = await harness({ packageManifest, contract: contributionContractRuntime() });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    const before = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(before.configFields.find((field) => field.key === 'connect').configured, false);
    assert.equal(
      Object.hasOwn(
        before.configFields.find((field) => field.key === 'inspect'),
        'configured',
      ),
      false,
    );
    await composition.configuration.configureOperationTargets(entry.pluginId, before.pluginInstanceId, 'connect', {
      token: 'secret',
    });
    const after = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(after.configFields.find((field) => field.key === 'connect').configured, true);
    assert.equal(after.configFields.find((field) => field.key === 'token').currentValue, '••••••');
  });

  it('invokes operation and test handlers through an installed and enabled builtin fixture package', async () => {
    const packageManifest = manifest({
      runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js' },
      configuration: [
        { key: 'token', label: 'Token', kind: 'secret', required: false },
        {
          key: 'login',
          label: 'Log in',
          kind: 'operation',
          required: false,
          target: ['token'],
          actions: [{ id: 'begin', label: 'Begin', render: 'button', action: { method: 'login.begin' } }],
        },
      ],
      test: { action: { method: 'self.test' } },
    });
    const entrypoint = `
export default {
  create() {
    return {
      async start() {
        return {
          actions: {
            async 'login.begin'() {
              return { render: 'img', data: { url: 'fixture://qr' }, targetValues: { token: 'fixture-secret' } };
            },
            async 'self.test'() { return { ok: true }; },
          },
          stop() {},
        };
      },
    };
  },
};
`;
    const { composition, entry, runtime } = await harness({
      packageManifest,
      contract: contributionContractRuntime(),
      extraFiles: { 'dist/entrypoint.js': entrypoint },
    });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    const installed = (await composition.manager.get(entry.pluginId)).plugin;
    await composition.manager.setEnabled(entry.pluginId, {
      enabled: true,
      expectedRevision: installed.lifecycleRevision,
    });
    const operations = new InstalledPluginOperations({
      inventory: runtime.inventoryStore,
      configuration: composition.configuration,
      invocation: runtime.supervisor,
    });

    const action = await operations.runAction(entry.pluginId, 'login', 'begin', {});
    assert.equal(action.status, 200);
    assert.deepEqual(action.body.data, { url: 'fixture://qr' });
    assert.deepEqual(await operations.runTest(entry.pluginId), {
      matched: true,
      status: 200,
      body: { ok: true },
    });
    assert.equal(
      (await composition.configuration.fields(entry.pluginId)).find((field) => field.key === 'token').currentValue,
      '••••••',
    );

    const running = (await composition.manager.get(entry.pluginId)).plugin;
    await composition.manager.setEnabled(entry.pluginId, {
      enabled: false,
      expectedRevision: running.lifecycleRevision,
    });
    const disabled = (await composition.manager.get(entry.pluginId)).plugin;
    await composition.manager.uninstall(entry.pluginId, { expectedRevision: disabled.lifecycleRevision });
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
    assert.deepEqual(snapshot.packages[0].provenance, {
      kind: 'local-archive',
      packageName: '@clowder-ai/official-test-source',
    });
    assert.deepEqual(snapshot.grants[0].effectiveGrants, []);
    assert.deepEqual(listed.plugin.source, {
      kind: 'local-archive',
      packageName: '@clowder-ai/official-test-source',
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

  it('projects runtime-less declared MCP capabilities from the canonical capability state', async () => {
    let catalogOffline = false;
    const packageManifest = manifest({
      runtime: { transport: 'builtin' },
      description: 'Installs the fixture capability through the canonical MCP pipeline.',
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
    const composition = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: provider,
      // Production discovery has release metadata only; the verified package manifest
      // becomes authoritative after inventory admission.
      catalogManifests: [],
      fetchOfficialArchive: async () => archive.bytes,
    });
    await composition.manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    await composition.manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: 2 });

    const running = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(running.live, 'running');
    assert.deepEqual(running.capabilitySummary, [
      { id: 'events.publish', kind: 'events', name: 'Source', active: true },
    ]);
    assert.equal(
      (await runtime.mcpConfigIO.readConfig()).capabilities.find(
        (capability) => capability.id === `plugin:${entry.pluginId}:fixture-tools`,
      )?.enabled,
      true,
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
  });
});
