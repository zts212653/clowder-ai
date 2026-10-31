import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { PluginManagerService } from '../dist/domains/plugin/manager/plugin-manager-service.js';

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
  capabilities: [{ id: 'messaging.send', kind: 'messaging', name: 'Scene events' }],
};

const emptyInventory = { schemaVersion: 1, packages: [], instances: [] };

const bundledGithub = {
  pluginId: 'github',
  pluginInstanceId: 'instance:github',
  displayName: 'GitHub',
  description: 'Track pull requests and CI.',
  publisher: 'Clowder AI',
  source: { kind: 'local-archive', packageName: '@clowder-ai/github', trust: 'unverified' },
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
  installedPackages = [],
  inventory = emptyInventory,
  installer,
  lifecycle,
  configuration,
  quarantine,
  stateProjection,
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
    installedPackages: { list: async () => installedPackages },
    ...(stateProjection === undefined ? {} : { stateProjection }),
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
        provenance: { kind: 'catalog', catalogId: published.catalogId, packageName: published.packageName },
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
          features: [{ id: 'events', name: 'Events', resources: [], capabilities: ['messaging.send'] }],
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
  };
}

describe('F202 terminal Plugin Manager service', () => {
  it('projects Host-bundled candidates without awaiting remote catalog discovery', async () => {
    let remoteCatalogReads = 0;
    let localCatalogReads = 0;
    const manager = new PluginManagerService({
      catalog: {
        snapshot: async () => {
          remoteCatalogReads += 1;
          return new Promise(() => {});
        },
        localSnapshot: async () => {
          localCatalogReads += 1;
          return {
            candidates: [published],
            status: 'stale',
            refreshedAt: null,
          };
        },
      },
      inventory: { snapshot: async () => emptyInventory },
      installedPackages: { list: async () => [] },
    });

    const result = await Promise.race([
      manager.listLocal(),
      new Promise((resolve) => setTimeout(() => resolve('remote-blocked-bundled-state'), 100)),
    ]);

    assert.notEqual(result, 'remote-blocked-bundled-state');
    assert.equal(remoteCatalogReads, 0);
    assert.equal(localCatalogReads, 1);
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.pluginId),
      [published.pluginId],
    );
  });

  it('projects installed plugins without awaiting remote catalog discovery', async () => {
    let catalogReads = 0;
    const neverSettles = new Promise(() => {});
    const manager = new PluginManagerService({
      catalog: {
        snapshot: async () => {
          catalogReads += 1;
          return neverSettles;
        },
      },
      inventory: { snapshot: async () => emptyInventory },
      installedPackages: { list: async () => [bundledGithub] },
    });

    const result = await Promise.race([
      manager.listLocal(),
      new Promise((resolve) => setTimeout(() => resolve('remote-blocked-local-state'), 100)),
    ]);

    assert.notEqual(result, 'remote-blocked-local-state');
    assert.equal(catalogReads, 0);
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.pluginId),
      ['github'],
    );
    assert.deepEqual(result.catalog, {
      status: 'loading',
      refreshedAt: null,
      message: 'Loading available plugins; installed plugins are ready.',
    });
  });

  it('operates on installed plugins without awaiting remote catalog discovery', async () => {
    let catalogReads = 0;
    const lifecycleCalls = [];
    const manager = new PluginManagerService({
      catalog: {
        snapshot: async () => {
          catalogReads += 1;
          return new Promise(() => {});
        },
      },
      inventory: { snapshot: async () => emptyInventory },
      installedPackages: { list: async () => [bundledGithub] },
      lifecycle: {
        setEnabled: async (...args) => lifecycleCalls.push(args),
        uninstall: async () => {},
      },
    });

    const result = await Promise.race([
      manager.setEnabled('github', { enabled: false, expectedRevision: 1 }),
      new Promise((resolve) => setTimeout(() => resolve('remote-blocked-operation'), 100)),
    ]);

    assert.notEqual(result, 'remote-blocked-operation');
    assert.equal(catalogReads, 0);
    assert.deepEqual(lifecycleCalls, [['instance:github', false, 1]]);
  });

  it('applies the live state projection to local installed rows before authorizing lifecycle writes', async () => {
    let projectionCalls = 0;
    const lifecycleCalls = [];
    const installed = {
      ...bundledGithub,
      pluginId: published.pluginId,
      pluginInstanceId: 'pi_video',
      displayName: published.displayName,
      source: {
        kind: 'catalog',
        catalogId: published.catalogId,
        packageName: published.packageName,
        trust: 'official',
      },
      installedVersion: published.version,
      availableVersion: published.version,
      packageDigest: published.packageDigest,
      auth: 'connected',
      config: 'ready',
      intent: 'disabled',
      live: 'stopped',
      lifecycleRevision: 3,
      capabilitySummary: [],
      capabilities: [],
    };
    const manager = service({
      inventory: installedInventory(),
      installedPackages: [installed],
      stateProjection: {
        read: async () => {
          projectionCalls += 1;
          return { authState: 'disconnected', configState: 'incomplete', intentState: 'disabled' };
        },
      },
      lifecycle: {
        setEnabled: async (...args) => lifecycleCalls.push(args),
        uninstall: async () => {},
      },
    });

    const canonical = (await manager.get(published.pluginId)).plugin;
    const local = (await manager.getLocal(published.pluginId)).plugin;
    assert.deepEqual(
      { auth: local.auth, config: local.config, actions: local.actions },
      { auth: canonical.auth, config: canonical.config, actions: canonical.actions },
    );
    assert.equal(local.auth, 'disconnected');
    assert.equal(local.config, 'incomplete');
    assert.equal(local.actions.setEnabled, false);
    await assert.rejects(
      manager.setEnabled(published.pluginId, { enabled: true, expectedRevision: 3 }),
      (error) => error?.code === 'ACTION_NOT_ALLOWED',
    );
    assert.equal(projectionCalls, 3);
    assert.deepEqual(lifecycleCalls, []);
  });

  it('returns installed package contributions in detail without treating grants as tools', async () => {
    const manager = service({ inventory: installedInventory() });

    const result = await manager.get(published.pluginId);

    assert.deepEqual(result.plugin.contributions, [
      { id: 'video-analysis-toolset', kind: 'mcp', name: 'video-analysis-toolset' },
    ]);
  });

  it('preserves unavailable catalog contribution metadata in detail', async () => {
    const manager = service();

    const result = await manager.get(published.pluginId);

    assert.equal('contributions' in result.plugin, false);
  });

  it('returns one searchable list across catalog and installed packages', async () => {
    const manager = service({ installedPackages: [bundledGithub] });

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

  it('deduplicates an installed row when the same plugin is in catalog inventory', async () => {
    const installedPackagesDuplicate = { ...bundledGithub, pluginId: published.pluginId, displayName: 'Old Video' };
    const manager = service({ installedPackages: [installedPackagesDuplicate] });

    const result = await manager.list();
    assert.equal(result.plugins.filter((plugin) => plugin.pluginId === published.pluginId).length, 1);
    assert.equal(result.plugins.find((plugin) => plugin.pluginId === published.pluginId).displayName, 'Video Analysis');
  });

  it('keeps installed packages visible when catalog discovery fails', async () => {
    const manager = new PluginManagerService({
      catalog: { snapshot: async () => Promise.reject(new Error('offline')) },
      inventory: { snapshot: async () => emptyInventory },
      installedPackages: { list: async () => [bundledGithub] },
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

  it('gets the same projection used by list and reports an unknown plugin honestly', async () => {
    const manager = service({ installedPackages: [bundledGithub] });

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

it('keeps one plugin row without exposing source or version choices', async () => {
  const gitCandidate = {
    ...published,
    catalogId: 'git.team.video',
    version: '1.2.0',
    packageDigest: null,
    sourceLabel: 'team-plugins · preview',
    directorySource: {
      kind: 'git',
      url: 'ssh://git@example.invalid/team/plugins.git',
      packageName: published.packageName,
      trust: 'unverified',
      marketplace: {
        sourceId: 'team-preview',
        commit: 'a'.repeat(40),
        path: 'packages/video',
        pluginId: published.pluginId,
        version: '1.2.0',
      },
    },
  };
  const manager = service({ catalog: { candidates: [published, gitCandidate], status: 'fresh', refreshedAt: 1 } });
  const listed = await manager.list();
  assert.equal(listed.plugins.length, 1);
  assert.equal(listed.plugins[0].source.kind, 'catalog', 'official remains the default, not an implicit override');
  const detail = (await manager.get(published.pluginId)).plugin;
  assert.equal(Object.hasOwn(listed.plugins[0], 'installSources'), false);
  assert.equal(Object.hasOwn(detail, 'installSources'), false);
});

for (const version of ['0.9.0', '1.0.0', '1.0.1', '1.0.1-alpha.1']) {
  it(`offers only newer compatible updates: ${version}`, async () => {
    const manager = service({
      inventory: installedInventory(),
      catalog: {
        candidates: [{ ...published, version, compatibleReplacement: true, packageDigest: digest(version) }],
        status: 'fresh',
        refreshedAt: 1,
      },
    });
    const plugin = (await manager.get(published.pluginId)).plugin;
    assert.equal(plugin.actions.install, version.startsWith('1.0.1'));
    assert.equal(Object.hasOwn(plugin, 'installSources'), false);
    assert.equal(Object.hasOwn(plugin, 'installRequest'), false);
    await assert.rejects(manager.update(published.pluginId, { expectedVersion: version, expectedRevision: 99 }));
    if (!version.startsWith('1.0.1')) {
      await assert.rejects(manager.update(published.pluginId, { expectedVersion: version, expectedRevision: 3 }));
    }
    await assert.rejects(manager.update(published.pluginId, { expectedVersion: '9.9.9', expectedRevision: 3 }));
  });
}
