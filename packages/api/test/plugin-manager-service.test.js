import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  PluginManagerCompatibilityAdapter,
  RepositoryPluginManagerCompatibilityProvider,
} from '../dist/domains/plugin/manager/plugin-manager-compatibility.js';
import { PluginManagerService } from '../dist/domains/plugin/plugin-manager-service.js';

function digest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

const published = {
  catalogId: 'published-video',
  pluginId: 'official.video',
  packageName: '@clowder-ai/video',
  version: '1.0.0',
  packageDigest: digest('video'),
  displayName: 'Video Analysis',
  description: 'Search scenes in selected videos.',
  publisher: 'Clowder AI',
  ownerAuthRequired: false,
  capabilities: [{ id: 'events.publish', kind: 'events', name: 'Scene events' }],
};

const emptyInventory = { schemaVersion: 1, packages: [], instances: [], grants: [] };

const bundledGithub = {
  pluginId: 'github',
  pluginInstanceId: 'compat:github',
  displayName: 'GitHub',
  description: 'Track pull requests and CI.',
  publisher: 'Clowder AI',
  source: { kind: 'bundled', packageName: '@clowder-ai/github', trust: 'first-party' },
  availableVersion: '1.0.0',
  installedVersion: '1.0.0',
  packageDigest: null,
  artifact: 'installed',
  config: 'ready',
  auth: 'connected',
  intent: 'enabled',
  live: 'running',
  lifecycleRevision: 1,
  capabilitySummary: [{ id: 'repo-scan', kind: 'mcp', name: 'Repository scan', active: true }],
  actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
  capabilities: [
    { id: 'repo-scan', kind: 'mcp', name: 'Repository scan', description: 'Scans repositories', active: true },
  ],
  docsUrl: 'https://docs.example/github',
  setupSteps: ['Create a token'],
  configFields: [],
};

function service({
  catalog,
  compatibility = [],
  inventory = emptyInventory,
  installer,
  lifecycle,
  configuration,
  quarantine,
} = {}) {
  return new PluginManagerService({
    catalog: {
      snapshot: async () =>
        catalog ?? {
          candidates: [published],
          status: 'fresh',
          refreshedAt: 2_000,
        },
    },
    inventory: { snapshot: async () => inventory },
    compatibility: { list: async () => compatibility },
    ...(installer === undefined ? {} : { installer }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(configuration === undefined ? {} : { configuration }),
    ...(quarantine === undefined ? {} : { quarantine }),
  });
}

function quarantinedPublished() {
  return {
    pluginId: published.pluginId,
    pluginInstanceId: null,
    displayName: published.displayName,
    description: published.description,
    publisher: published.publisher,
    source: {
      kind: 'catalog',
      catalogId: published.catalogId,
      packageName: published.packageName,
      trust: 'official',
    },
    availableVersion: published.version,
    installedVersion: null,
    packageDigest: published.packageDigest,
    artifact: 'quarantined',
    config: 'invalid',
    auth: 'not-required',
    intent: 'disabled',
    live: 'stopped',
    lifecycleRevision: 1,
    capabilitySummary: [],
    actions: {
      install: false,
      setEnabled: false,
      uninstall: true,
      blockingReasons: ['package-quarantined'],
    },
    capabilities: [],
    configFields: [],
  };
}

function installedInventory(overrides = {}) {
  return {
    schemaVersion: 1,
    packages: [
      {
        packageDigest: published.packageDigest,
        pluginId: published.pluginId,
        version: published.version,
        contractVersion: '0.1.0',
        manifest: {
          pluginId: published.pluginId,
          version: published.version,
          contractVersion: '0.1.0',
          name: published.displayName,
          contributions: [
            {
              type: 'mcp',
              id: 'video-analysis-toolset',
              runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
            },
          ],
          features: [{ id: 'events', name: 'Events', resources: [], capabilities: ['events.publish'] }],
          runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
        },
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1_000,
        updatedAt: 1_000,
      },
    ],
    instances: [
      {
        pluginInstanceId: 'pi_video',
        pluginId: published.pluginId,
        packageDigest: published.packageDigest,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: 3,
        installedAt: 1_000,
        updatedAt: 1_000,
        ...overrides,
      },
    ],
    grants: [
      {
        pluginInstanceId: 'pi_video',
        requestedCapabilities: ['events.publish'],
        effectiveGrants: ['events.publish'],
        grantRevision: 1,
        updatedAt: 1_000,
      },
    ],
  };
}

describe('F202 terminal Plugin Manager service', () => {
  it('returns installed package contributions in detail without treating grants as tools', async () => {
    const manager = service({ inventory: installedInventory() });

    const result = await manager.get(published.pluginId);

    assert.deepEqual(result.plugin.contributions, [
      { id: 'video-analysis-toolset', kind: 'mcp', name: 'video-analysis-toolset' },
    ]);
    assert.deepEqual(
      result.plugin.capabilities.map(({ id }) => id),
      ['events.publish'],
    );
  });

  it('preserves unavailable catalog contribution metadata in detail', async () => {
    const manager = service();

    const result = await manager.get(published.pluginId);

    assert.equal('contributions' in result.plugin, false);
  });

  it('returns one searchable list across published and compatibility plugins', async () => {
    const manager = service({ compatibility: [bundledGithub] });

    const all = await manager.list();
    assert.deepEqual(
      all.plugins.map((plugin) => plugin.pluginId),
      ['github', 'official.video'],
    );
    assert.equal(all.catalog.status, 'fresh');

    const searched = await manager.search('repository scan');
    assert.deepEqual(
      searched.plugins.map((plugin) => plugin.pluginId),
      ['github'],
    );
  });

  it('searches every localized manifest description without creating a Console-only copy', async () => {
    const localized = {
      ...published,
      description: {
        default: 'Analyze selected videos into scenes and summaries.',
        translations: { 'zh-CN': '分析选定视频中的场景并生成摘要。' },
      },
    };
    const manager = service({
      catalog: { candidates: [localized], status: 'fresh', refreshedAt: 2_000 },
    });

    const result = await manager.search('场景');
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.pluginId),
      [published.pluginId],
    );
    assert.deepEqual(result.plugins[0].description, localized.description);
  });

  it('deduplicates a compatibility row once the same plugin is Host-managed', async () => {
    const compatibilityDuplicate = { ...bundledGithub, pluginId: published.pluginId, displayName: 'Old Video' };
    const manager = service({ compatibility: [compatibilityDuplicate] });

    const result = await manager.list();
    assert.equal(result.plugins.filter((plugin) => plugin.pluginId === published.pluginId).length, 1);
    assert.equal(result.plugins.find((plugin) => plugin.pluginId === published.pluginId).displayName, 'Video Analysis');
  });

  it('keeps installed compatibility plugins visible when catalog discovery fails', async () => {
    const manager = new PluginManagerService({
      catalog: { snapshot: async () => Promise.reject(new Error('offline')) },
      inventory: { snapshot: async () => emptyInventory },
      compatibility: { list: async () => [bundledGithub] },
    });

    const result = await manager.list();
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.pluginId),
      ['github'],
    );
    assert.deepEqual(result.catalog, {
      status: 'unavailable',
      refreshedAt: null,
      message: 'Plugin catalog is unavailable.',
    });
  });

  it('keeps repository compatibility visible when its shared catalog suppression read fails', async () => {
    const catalog = { snapshot: async () => Promise.reject(new Error('offline')) };
    const compatibility = new PluginManagerCompatibilityAdapter([
      new RepositoryPluginManagerCompatibilityProvider(
        async () => [
          {
            id: 'github',
            name: 'GitHub',
            version: '1.0.0',
            status: 'enabled',
            configured: true,
            config: [],
            resources: [{ type: 'mcp', name: 'github-toolset', enabled: true }],
            hasHealthCheck: false,
          },
        ],
        {
          loadSuppressedPluginIds: async () =>
            (await catalog.snapshot()).entries.flatMap((entry) =>
              entry.replacesRepositoryPluginId === undefined ? [] : [entry.replacesRepositoryPluginId],
            ),
        },
      ),
    ]);
    const manager = new PluginManagerService({
      catalog,
      inventory: { snapshot: async () => emptyInventory },
      compatibility,
    });

    const result = await manager.list();

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.pluginId),
      ['github'],
    );
    assert.equal(result.catalog.status, 'unavailable');
  });

  it('gets the same projection used by list and reports an unknown plugin honestly', async () => {
    const manager = service({ compatibility: [bundledGithub] });

    const detail = (await manager.get('github')).plugin;
    assert.equal(detail.pluginId, 'github');
    assert.equal(detail.docsUrl, 'https://docs.example/github');
    assert.equal(detail.capabilities[0].description, 'Scans repositories');
    await assert.rejects(
      () => manager.get('missing'),
      (error) => error?.code === 'PLUGIN_NOT_FOUND',
    );
  });

  it('keeps human package README outside list, search, and Agent detail projections', async () => {
    const manager = service();

    assert.equal('readmeMarkdown' in (await manager.list()).plugins[0], false);
    assert.equal('readmeMarkdown' in (await manager.search('video')).plugins[0], false);
    assert.equal('readmeMarkdown' in (await manager.get(published.pluginId)).plugin, false);
  });

  it('adds a typed Host configuration contribution and fences its mutation', async () => {
    const configured = [];
    const fields = [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'secret',
        required: true,
        currentValue: null,
        sensitive: true,
      },
    ];
    const manager = service({
      inventory: installedInventory({ configReadiness: 'incomplete' }),
      configuration: {
        fields: async (pluginId) => (pluginId === published.pluginId ? fields : undefined),
        configure: async (...input) => configured.push(input),
      },
    });

    assert.deepEqual((await manager.get(published.pluginId)).plugin.configFields, fields);
    await assert.rejects(
      () =>
        manager.configure(published.pluginId, {
          expectedRevision: 2,
          updates: [{ key: 'apiKey', value: 'secret' }],
        }),
      (error) => error?.code === 'STALE_REVISION',
    );
    await manager.configure(published.pluginId, {
      expectedRevision: 3,
      updates: [{ key: 'apiKey', value: 'secret' }],
    });
    assert.deepEqual(configured, [
      [published.pluginId, 'pi_video', { expectedRevision: 3, updates: [{ key: 'apiKey', value: 'secret' }] }],
    ]);
  });

  it('fences catalog installation to the exact version and digest', async () => {
    const calls = [];
    const manager = service({
      installer: {
        install: async (input) => {
          calls.push(input);
          return { pluginId: published.pluginId, pluginInstanceId: 'pi_video' };
        },
      },
    });

    await assert.rejects(
      () =>
        manager.install({
          source: { kind: 'catalog', catalogId: published.catalogId },
          expectedVersion: '0.9.0',
          expectedDigest: published.packageDigest,
        }),
      (error) => error?.code === 'CATALOG_MISMATCH',
    );
    assert.equal(calls.length, 0);

    const result = await manager.install({
      source: { kind: 'catalog', catalogId: published.catalogId },
      expectedVersion: published.version,
      expectedDigest: published.packageDigest,
    });
    assert.deepEqual(result, { pluginId: published.pluginId, pluginInstanceId: 'pi_video' });
    assert.equal(calls.length, 1);
  });

  it('rejects installation while the selected catalog release is quarantined', async () => {
    const calls = [];
    const manager = service({
      installer: {
        install: async (input) => {
          calls.push(input);
          return { pluginId: published.pluginId, pluginInstanceId: 'pi_video' };
        },
      },
      quarantine: {
        list: async () => [quarantinedPublished()],
        remove: async () => undefined,
      },
    });

    await assert.rejects(
      manager.install({
        source: { kind: 'catalog', catalogId: published.catalogId },
        expectedVersion: published.version,
        expectedDigest: published.packageDigest,
      }),
      (error) => error?.code === 'ACTION_NOT_ALLOWED',
    );
    assert.equal(calls.length, 0);
  });

  it('checks lifecycle revision and action policy before enable', async () => {
    const calls = [];
    const manager = service({
      inventory: installedInventory(),
      lifecycle: {
        setEnabled: async (...input) => calls.push(input),
        uninstall: async (...input) => calls.push(input),
      },
    });

    await assert.rejects(
      () => manager.setEnabled(published.pluginId, { enabled: true, expectedRevision: 2 }),
      (error) => error?.code === 'STALE_REVISION',
    );
    assert.equal(calls.length, 0);

    await manager.setEnabled(published.pluginId, { enabled: true, expectedRevision: 3 });
    assert.deepEqual(calls, [['pi_video', true, 3]]);
  });

  it('keeps disable and uninstall available when an enabled plugin config later degrades', async () => {
    const calls = [];
    const manager = service({
      inventory: installedInventory({ configReadiness: 'incomplete', activationState: 'enabled' }),
      lifecycle: {
        setEnabled: async (...input) => calls.push(['set-enabled', ...input]),
        uninstall: async (...input) => calls.push(['uninstall', ...input]),
      },
    });

    await manager.setEnabled(published.pluginId, { enabled: false, expectedRevision: 3 });
    await manager.uninstall(published.pluginId, { expectedRevision: 3 });
    assert.deepEqual(calls, [
      ['set-enabled', 'pi_video', false, 3],
      ['uninstall', 'pi_video', 3],
    ]);
  });
});
