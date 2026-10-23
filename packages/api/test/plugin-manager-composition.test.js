import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { pluginManagerUploadRoutes, registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';
import { catalogEntry, manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

const roots = [];

it('real Manager JSON and upload routes confirm replacement of the same legacy instance', async () => {
  const { composition, entry, projectRoot, runtime } = await harness();
  const installed = await composition.manager.install({
    source: { kind: 'catalog', catalogId: entry.catalogId },
    expectedVersion: entry.version,
    expectedDigest: entry.packageDigest,
  });
  await runtime.inventoryStore.transaction((tx) => {
    const { provenance: _oldSource, ...legacy } = tx.packages.get(entry.packageDigest);
    tx.packages.put(legacy);
  });
  const before = await runtime.inventoryStore.snapshot();
  const next = await packageArchive({ packageManifest: manifest({ version: '0.2.0' }) });
  const path = join(projectRoot, 'replacement.tgz');
  await writeFile(path, next.bytes);
  const app = Fastify();
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  const options = { manager: composition.manager, auditLog: { append: async () => {} } };
  registerPluginManagerRoutes(app, options);
  await app.register(pluginManagerUploadRoutes, options);
  const headers = { host: 'localhost:3004', origin: 'http://localhost:5173', 'x-test-session-user': owner };
  try {
    const offer = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install',
      headers,
      remoteAddress: '127.0.0.1',
      payload: { source: { kind: 'local-archive', path } },
    });
    assert.equal(offer.statusCode, 409, offer.payload);
    assert.equal(offer.json().code, 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED');
    assert.deepEqual(await runtime.inventoryStore.snapshot(), before);
    const replacement = offer.json().replacement.confirmation;
    assert.equal(replacement.pluginInstanceId, installed.pluginInstanceId);
    const boundary = 'legacy-replacement-boundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="replacement"\r\n\r\n${JSON.stringify(replacement)}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="replacement.tgz"\r\nContent-Type: application/gzip\r\n\r\n`,
      ),
      next.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install/upload',
      remoteAddress: '127.0.0.1',
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(response.statusCode, 201, response.payload);
    assert.equal(response.json().pluginInstanceId, installed.pluginInstanceId);
    const after = await runtime.inventoryStore.snapshot();
    assert.equal(after.instances.length, 1);
    assert.equal(after.instances[0].packageDigest, next.integrity);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install',
      headers,
      remoteAddress: '127.0.0.1',
      payload: { source: { kind: 'local-archive', path }, replacement },
    });
    assert.equal(stale.statusCode, 409, stale.payload);
    assert.equal(stale.json().code, 'STALE_ARCHIVE_REPLACEMENT');
    assert.deepEqual(await runtime.inventoryStore.snapshot(), after);
  } finally {
    await app.close();
  }
});

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
  catalogManifests,
  extraFiles = {},
  effectiveGrants,
} = {}) {
  const projectRoot = await root('cat-cafe-f202-manager-composition-');
  let archive = await packageArchive({ packageManifest, extraFiles });
  const entry = catalogEntry(archive.integrity, {
    pluginId: packageManifest.pluginId,
    version: packageManifest.version,
    ...(effectiveGrants ? { effectiveGrants } : {}),
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
    catalogManifests: catalogManifests ?? [packageManifest],
    fetchOfficialArchive: async () => archive.bytes,
    now: () => 9_000,
  });
  return {
    archive,
    composition,
    entry,
    projectRoot,
    provider,
    runtime,
    async setRelease(nextManifest, nextFiles) {
      archive = await packageArchive({ packageManifest: nextManifest, extraFiles: nextFiles });
      Object.assign(entry, { version: nextManifest.version, packageDigest: archive.integrity });
      Object.assign(packageManifest, nextManifest);
    },
  };
}

function contributionContractRuntime() {
  return {
    manifestContractRange: '0.1.0',
    validateEffectiveGrants,
    validateManifest,
  };
}

describe('F202 Plugin Manager runtime composition', () => {
  it('constructs, lists, and shuts down with no installed business packages', async () => {
    const projectRoot = await root('cat-cafe-f202-empty-host-');
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore: new MessageStore(),
    });
    try {
      const composition = createPluginManagerRuntimeComposition({
        runtime,
        catalogProvider: {
          snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 9_000 }),
        },
        catalogManifests: [],
        fetchOfficialArchive: async () => assert.fail('an empty Host must not fetch a business package'),
        now: () => 9_000,
      });
      const result = await composition.manager.list();
      assert.deepEqual(result.plugins, []);
      assert.equal(result.catalog.status, 'fresh');
      const inventory = await runtime.inventoryStore.snapshot();
      assert.deepEqual(inventory.packages, []);
      assert.deepEqual(inventory.instances, []);
      assert.deepEqual(inventory.grants, []);
    } finally {
      await runtime.shutdown('empty_host_test');
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
      { id: 'messaging.send', kind: 'messaging', name: 'Source', active: false },
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

  it('saves configuration independently of enabled intent and invokes the explicit refresh hook', async () => {
    const packageManifest = manifest({
      runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js' },
      features: [{ id: 'source', name: 'Source', resources: [], capabilities: ['plugin.config.read'] }],
      configuration: [{ key: 'endpoint', label: 'Endpoint', kind: 'url', required: true }],
      test: { action: { method: 'self.test' } },
    });
    const entrypoint = `
export default { create() { return { async start(host) {
  let endpoint;
  async function configure() {
    const next = await host.config.get('endpoint');
    if (next === 'https://fail.test') throw new Error('fixture reconnect failed');
    endpoint = next;
  }
  await configure();
  return { actions: { 'self.test': async () => ({ ok: true, message: endpoint }) }, configRefresh: configure, stop() {} };
} }; } };
`;
    const { composition, entry, runtime } = await harness({
      packageManifest,
      contract: contributionContractRuntime(),
      effectiveGrants: ['plugin.config.read'],
      extraFiles: { 'dist/entrypoint.js': entrypoint },
    });
    const manager = composition.manager;
    const detail = async () => (await manager.get(entry.pluginId)).plugin;
    const save = async (value, expectedRevision) =>
      manager.configure(entry.pluginId, {
        expectedRevision: expectedRevision ?? (await detail()).lifecycleRevision,
        updates: [{ key: 'endpoint', value }],
      });
    try {
      await manager.install({
        source: { kind: 'catalog', catalogId: entry.catalogId },
        expectedVersion: entry.version,
        expectedDigest: entry.packageDigest,
      });
      await save('https://first.test');
      assert.equal((await detail()).intent, 'disabled');
      assert.equal((await detail()).live, 'stopped');
      await manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: (await detail()).lifecycleRevision });
      const operations = new InstalledPluginOperations({
        inventory: runtime.inventoryStore,
        configuration: composition.configuration,
        invocation: runtime.supervisor,
      });
      const observed = async () => (await operations.runTest(entry.pluginId)).body.message;
      assert.equal(await observed(), 'https://first.test');
      const originalRevision = (await detail()).lifecycleRevision;
      await assert.rejects(save('invalid-url'), (error) => error?.code === 'INVALID_CONFIGURATION');
      assert.equal((await detail()).lifecycleRevision, originalRevision);
      assert.equal(await observed(), 'https://first.test');
      await save('https://second.test');
      assert.equal((await detail()).intent, 'enabled');
      assert.equal((await detail()).live, 'running');
      assert.equal(await observed(), 'https://second.test');
      await assert.rejects(save('https://stale.test', originalRevision), (error) => error?.code === 'STALE_REVISION');
      assert.equal(await observed(), 'https://second.test');
      await save(null);
      assert.equal((await detail()).config, 'incomplete');
      assert.equal((await detail()).intent, 'enabled');
      assert.equal((await detail()).live, 'stopped');
      await save('https://third.test');
      assert.equal(await observed(), 'https://third.test');
      await assert.rejects(save('https://fail.test'), (error) => error?.code === 'RUNTIME_START_FAILED');
      assert.equal((await detail()).intent, 'enabled');
      assert.equal((await detail()).live, 'stopped');
      assert.equal((await detail()).configFields[0].currentValue, 'https://fail.test');
      await save('https://recovered.test');
      assert.equal(await observed(), 'https://recovered.test');
      assert.equal((await runtime.inventoryStore.snapshot()).instances[0].lastRuntimeError, undefined);
      await manager.setEnabled(entry.pluginId, {
        enabled: false,
        expectedRevision: (await detail()).lifecycleRevision,
      });
      await save('https://disabled.test');
      assert.equal((await detail()).intent, 'disabled');
      assert.equal((await detail()).live, 'stopped');
    } finally {
      await runtime.shutdown('configuration_test');
    }
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
    await composition.configuration.completeOperation(
      entry.pluginId,
      before.pluginInstanceId,
      before.lifecycleRevision,
    );
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

  for (const { failOld, sourceKind } of [false, true].flatMap((failOld) =>
    ['local-directory', 'catalog'].map((sourceKind) => ({ failOld, sourceKind })),
  )) {
    it(`HTTP ${sourceKind} replacement with a throwing real module restores old package (old restart fails: ${failOld})`, async () => {
      const packageManifest = manifest({
        runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js' },
        configuration: [{ key: 'ownerValue', label: 'Owner value', kind: 'string', required: false }],
        test: { action: { method: 'self.test' } },
      });
      const failureMarker = join(await root('cat-cafe-old-restart-failure-'), 'fail');
      const entrypoint = `import { existsSync } from 'node:fs';
export default { create() { return { async start() {
  if (existsSync(${JSON.stringify(failureMarker)})) throw new Error('old runtime recovery fixture failure');
  return { actions: { 'self.test': async () => ({ ok: true }) }, stop() {} };
} }; } };`;
      const { composition, entry, runtime, projectRoot, setRelease } = await harness({
        packageManifest,
        contract: contributionContractRuntime(),
        extraFiles: { 'dist/entrypoint.js': entrypoint },
      });
      const app = Fastify();
      app.addHook('preHandler', async (request) => {
        request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
      });
      registerPluginManagerRoutes(app, { manager: composition.manager, auditLog: { append: async () => {} } });
      try {
        await composition.manager.install({
          source: { kind: 'catalog', catalogId: entry.catalogId },
          expectedVersion: entry.version,
          expectedDigest: entry.packageDigest,
        });
        let plugin = (await composition.manager.get(entry.pluginId)).plugin;
        await composition.manager.configure(entry.pluginId, {
          expectedRevision: plugin.lifecycleRevision,
          updates: [{ key: 'ownerValue', value: 'keep owner configuration' }],
        });
        plugin = (await composition.manager.get(entry.pluginId)).plugin;
        await composition.manager.setEnabled(entry.pluginId, {
          enabled: true,
          expectedRevision: plugin.lifecycleRevision,
        });
        if (failOld) await writeFile(failureMarker, 'fail next old runtime start');
        const before = await runtime.inventoryStore.snapshot();
        const dataFile = join(projectRoot, 'retained-owner-data');
        await writeFile(dataFile, 'retained');
        const directory = await root('cat-cafe-broken-replacement-');
        await mkdir(join(directory, 'dist'));
        await mkdir(join(directory, 'schemas'));
        await writeFile(
          join(directory, 'manifest.json'),
          JSON.stringify({ ...packageManifest, version: '0.1.0-alpha.2' }),
        );
        await writeFile(join(directory, 'schemas/official.test.v1.schema.json'), JSON.stringify({ type: 'object' }));
        await writeFile(
          join(directory, 'dist/entrypoint.js'),
          `export default { create() { return { async start() { throw new Error('new runtime fixture failure'); } }; } };`,
        );
        let payload = { source: { kind: 'local-directory', path: directory } };
        if (sourceKind === 'catalog') {
          await setRelease(
            { ...packageManifest, version: '0.1.0-alpha.2' },
            {
              'dist/entrypoint.js': await readFile(join(directory, 'dist/entrypoint.js'), 'utf8'),
            },
          );
          const projected = (await composition.manager.get(entry.pluginId)).plugin;
          assert.equal(projected.actions.install, true);
          payload = { expectedVersion: projected.availableVersion, expectedRevision: projected.lifecycleRevision };
        }
        const response = await app.inject({
          method: 'POST',
          url:
            sourceKind === 'catalog'
              ? `/api/plugin-manager/plugins/${entry.pluginId}/update`
              : '/api/plugin-manager/plugins/install',
          headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
          payload,
        });
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json().code, failOld ? 'UPDATE_ROLLBACK_RESUME_FAILED' : 'UPDATE_RESUME_FAILED');
        const after = await runtime.inventoryStore.snapshot();
        assert.equal(after.instances[0].packageDigest, before.instances[0].packageDigest);
        assert.equal(after.instances[0].pluginInstanceId, before.instances[0].pluginInstanceId);
        assert.deepEqual(after.grants[0].effectiveGrants, before.grants[0].effectiveGrants);
        const current = (await composition.manager.get(entry.pluginId)).plugin;
        assert.equal(current.intent, 'enabled');
        assert.equal(current.live, failOld ? 'crashed' : 'running');
        assert.equal(current.config, 'ready');
        assert.equal(current.configFields.find((f) => f.key === 'ownerValue').currentValue, 'keep owner configuration');
        assert.equal(await readFile(dataFile, 'utf8'), 'retained');
        if (!failOld) {
          const operations = new InstalledPluginOperations({
            inventory: runtime.inventoryStore,
            configuration: composition.configuration,
            invocation: runtime.supervisor,
          });
          assert.deepEqual(await operations.runTest(entry.pluginId), {
            matched: true,
            status: 200,
            body: { ok: true },
          });
        }
      } finally {
        await app.close();
        await runtime.shutdown('replacement_recovery_test');
      }
    });
  }

  for (const nextVersion of ['1.0.0', '2.0.0']) {
    it(`fresh catalog after Host restart cannot replace installed v2 with ${nextVersion} different bytes`, async () => {
      const { composition, entry, runtime, projectRoot } = await harness({
        packageManifest: manifest({ version: '2.0.0' }),
      });
      await composition.manager.install({
        source: { kind: 'catalog', catalogId: entry.catalogId },
        expectedVersion: entry.version,
        expectedDigest: entry.packageDigest,
      });
      const before = await runtime.inventoryStore.snapshot();
      await runtime.shutdown('restart_continuity_test');
      const restarted = createDormantPluginRuntimeComposition({ projectRoot, messageStore: new MessageStore() });
      const nextManifest = manifest({ version: nextVersion });
      const nextArchive = await packageArchive({
        packageManifest: nextManifest,
        extraFiles: { 'dist/entrypoint.js': '// different release bytes' },
      });
      const nextEntry = catalogEntry(nextArchive.integrity, { version: nextVersion });
      let fetched = 0;
      const next = createPluginManagerRuntimeComposition({
        runtime: restarted,
        catalogProvider: { snapshot: async () => ({ entries: [nextEntry], status: 'fresh', checkedAt: 1 }) },
        catalogManifests: [nextManifest],
        fetchOfficialArchive: async () => {
          fetched++;
          return nextArchive.bytes;
        },
      });
      try {
        await assert.rejects(
          next.manager.install({
            source: { kind: 'catalog', catalogId: nextEntry.catalogId },
            expectedVersion: nextEntry.version,
            expectedDigest: nextEntry.packageDigest,
          }),
          (error) => error.code === 'UPDATE_NOT_NEWER',
        );
        assert.equal(fetched, 0, 'reject before package preparation or runtime suspension');
        assert.deepEqual(await restarted.inventoryStore.snapshot(), before);
      } finally {
        await restarted.shutdown('restart_continuity_test_done');
      }
    });
  }

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

  it('keeps installed legacy inventory visible with unknown origin when catalog discovery is offline', async () => {
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

    const before = await runtime.inventoryStore.snapshot();
    const listed = (await composition.manager.list()).plugins;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].pluginId, entry.pluginId);
    assert.deepEqual(listed[0].source, { kind: 'unknown', packageName: null, trust: 'unknown' });
    assert.deepEqual(await runtime.inventoryStore.snapshot(), before, 'legacy display does not rewrite admission');
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
      trust: 'unverified',
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
          capabilities: ['messaging.send'],
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
      { id: 'messaging.send', kind: 'messaging', name: 'Source', active: true },
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
      { id: 'messaging.send', kind: 'messaging', name: 'Source', active: true },
    ]);
    catalogOffline = false;

    await composition.manager.setEnabled(entry.pluginId, { enabled: false, expectedRevision: 4 });
    const stopped = (await composition.manager.get(entry.pluginId)).plugin;
    assert.equal(stopped.live, 'stopped');
    assert.deepEqual(stopped.capabilitySummary, [
      { id: 'messaging.send', kind: 'messaging', name: 'Source', active: false },
    ]);
  });
});

// Production ships bundled metadata only for dot; ordinary releases are verified on update.
it('offers and verifies an exact catalog update without a bundled package manifest', async () => {
  const h = await harness({ machinePresentation: true, catalogManifests: [] });
  const installed = await h.composition.manager.install({
    source: { kind: 'catalog', catalogId: h.entry.catalogId },
    expectedVersion: h.entry.version,
    expectedDigest: h.entry.packageDigest,
  });
  await h.setRelease(manifest({ version: '0.2.0' }));
  const item = (await h.composition.manager.get(h.entry.pluginId)).plugin;
  assert.equal(item.actions.install, true, 'the remote release must expose Update');
  await h.composition.manager.update(h.entry.pluginId, {
    expectedVersion: '0.2.0',
    expectedRevision: item.lifecycleRevision,
  });
  const updated = (await h.composition.manager.get(h.entry.pluginId)).plugin;
  assert.equal(updated.pluginInstanceId, installed.pluginInstanceId);
  assert.equal(updated.installedVersion, '0.2.0');
  const before = await h.runtime.inventoryStore.snapshot();
  await h.setRelease(manifest({ version: '0.3.0', contractVersion: '999.0.0' }));
  const invalid = (await h.composition.manager.get(h.entry.pluginId)).plugin;
  await assert.rejects(
    h.composition.manager.update(h.entry.pluginId, {
      expectedVersion: '0.3.0',
      expectedRevision: invalid.lifecycleRevision,
    }),
  );
  assert.deepEqual(
    await h.runtime.inventoryStore.snapshot(),
    before,
    'validation must reject before changing the installed package',
  );
});
