import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  loadMachinePluginCatalog,
  MachineOfficialPluginCatalog,
  OfficialPluginManagerCatalogAdapter,
  RepositoryPluginManagerCompatibilityProvider,
  resolveRepositoryReplacementPluginIds,
} from '../dist/domains/plugin/index.js';

const digest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function rawCatalog() {
  return {
    schemaVersion: '1',
    plugins: [
      {
        pluginId: 'dev.clowder.video-analysis',
        name: 'Video Analysis',
        description: {
          default: 'Analyze remote videos.',
          translations: { 'zh-CN': '分析远程视频。' },
        },
        icon: { type: 'svg', src: 'assets/icon.svg' },
        publisher: { id: 'clowder-ai', name: 'Clowder AI' },
        keywords: ['analysis', 'video'],
        versions: [
          {
            version: '0.1.0-alpha.0',
            contractVersion: '0.1.0-beta.13',
            manifestPath: 'plugin.yaml',
            artifact: {
              kind: 'npm',
              packageName: '@clowder-ai/video-analysis',
              version: '0.1.0-alpha.0',
              tarballUrl: 'https://registry.npmjs.org/@clowder-ai/video-analysis/-/video-analysis-0.1.0-alpha.0.tgz',
              integrity: digest,
              shasum: '0'.repeat(40),
              provenance: {
                repository: 'https://github.com/zts212653/clowder-ai-plugins',
                sourceDirectory: 'packages/video-analysis',
              },
            },
          },
        ],
      },
    ],
  };
}

function canonicalValidator(value) {
  return { valid: true, catalog: value, errors: [] };
}

test('projects canonical machine catalog release truth while Host policy remains authoritative', async () => {
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => rawCatalog(),
    validateCatalog: canonicalValidator,
    hostPolicies: [
      {
        pluginId: 'dev.clowder.video-analysis',
        replacesRepositoryPluginId: 'video-analysis',
        effectiveGrants: ['events.publish'],
      },
    ],
    now: () => 1_000,
  });

  const snapshot = await provider.snapshot();
  assert.equal(snapshot.status, 'fresh');
  assert.equal(snapshot.checkedAt, 1_000);
  assert.deepEqual(snapshot.entries, [
    {
      catalogId: 'dev.clowder.video-analysis',
      pluginId: 'dev.clowder.video-analysis',
      packageName: '@clowder-ai/video-analysis',
      version: '0.1.0-alpha.0',
      distribution: 'registry',
      archiveUrl: 'https://registry.npmjs.org/@clowder-ai/video-analysis/-/video-analysis-0.1.0-alpha.0.tgz',
      packageDigest: digest,
      replacesRepositoryPluginId: 'video-analysis',
      effectiveGrants: ['events.publish'],
      presentation: {
        displayName: 'Video Analysis',
        description: {
          default: 'Analyze remote videos.',
          translations: { 'zh-CN': '分析远程视频。' },
        },
        icon: { type: 'svg', src: 'assets/icon.svg' },
        publisher: 'Clowder AI',
      },
    },
  ]);

  const managerCatalog = await new OfficialPluginManagerCatalogAdapter(provider, []).snapshot();
  assert.equal(managerCatalog.status, 'fresh');
  assert.deepEqual(managerCatalog.candidates[0], {
    catalogId: 'dev.clowder.video-analysis',
    pluginId: 'dev.clowder.video-analysis',
    packageName: '@clowder-ai/video-analysis',
    version: '0.1.0-alpha.0',
    packageDigest: digest,
    displayName: 'Video Analysis',
    description: {
      default: 'Analyze remote videos.',
      translations: { 'zh-CN': '分析远程视频。' },
    },
    icon: { type: 'svg', src: 'assets/icon.svg' },
    publisher: 'Clowder AI',
    ownerAuthRequired: false,
    capabilities: [],
  });
});

test('selects the newest validated release independently of catalog array order', async () => {
  const catalog = rawCatalog();
  catalog.plugins[0].versions = [
    catalog.plugins[0].versions[0],
    {
      ...catalog.plugins[0].versions[0],
      version: '0.1.0-alpha.2',
      artifact: {
        ...catalog.plugins[0].versions[0].artifact,
        version: '0.1.0-alpha.2',
        tarballUrl: 'https://registry.npmjs.org/@clowder-ai/video-analysis/-/video-analysis-0.1.0-alpha.2.tgz',
        integrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
      },
    },
  ];
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => catalog,
    validateCatalog: canonicalValidator,
    hostPolicies: [{ pluginId: 'dev.clowder.video-analysis', effectiveGrants: [] }],
    now: () => 1_500,
  });

  const snapshot = await provider.snapshot();
  assert.equal(snapshot.entries[0].version, '0.1.0-alpha.2');
  assert.equal(snapshot.entries[0].packageDigest, `sha512-${Buffer.alloc(64, 8).toString('base64')}`);
});

test('fails closed when catalog validation fails and omits entries outside Host admission scope', async () => {
  const invalid = new MachineOfficialPluginCatalog({
    loadCatalog: async () => rawCatalog(),
    validateCatalog: () => ({ valid: false, errors: [{ message: 'invalid' }] }),
    hostPolicies: [],
    now: () => 2_000,
  });
  assert.deepEqual(await invalid.snapshot(), {
    entries: [],
    status: 'degraded',
    checkedAt: 2_000,
    errorCode: 'CATALOG_CONTRACT_INVALID',
  });

  const missingPolicy = new MachineOfficialPluginCatalog({
    loadCatalog: async () => rawCatalog(),
    validateCatalog: canonicalValidator,
    hostPolicies: [],
    now: () => 3_000,
  });
  assert.deepEqual(await missingPolicy.snapshot(), {
    entries: [],
    status: 'fresh',
    checkedAt: 3_000,
  });
});

test('keeps an installed Host replacement authoritative during a cold catalog outage', async () => {
  const hostPolicies = [
    {
      pluginId: 'dev.clowder.video-analysis',
      replacesRepositoryPluginId: 'video-analysis',
      effectiveGrants: ['events.publish'],
    },
  ];
  const catalog = new MachineOfficialPluginCatalog({
    loadCatalog: async () => Promise.reject(new Error('offline')),
    validateCatalog: canonicalValidator,
    hostPolicies,
    now: () => 3_000,
  });
  const inventory = {
    snapshot: async () => ({
      schemaVersion: 1,
      packages: [],
      instances: [
        {
          pluginId: 'dev.clowder.video-analysis',
          pluginInstanceId: 'pi_video',
          lifecycleState: 'installed',
        },
      ],
      grants: [],
    }),
  };
  const compatibility = new RepositoryPluginManagerCompatibilityProvider(
    async () => [
      {
        id: 'video-analysis',
        name: 'Video Analysis (repository)',
        version: '0.0.0',
        status: 'disabled',
        configured: false,
        config: [],
        resources: [],
        hasHealthCheck: false,
      },
    ],
    {
      loadSuppressedPluginIds: async () => {
        const [catalogSnapshot, inventorySnapshot] = await Promise.all([catalog.snapshot(), inventory.snapshot()]);
        return resolveRepositoryReplacementPluginIds(
          hostPolicies,
          catalogSnapshot.entries,
          inventorySnapshot.instances
            .filter((instance) => instance.lifecycleState === 'installed')
            .map((instance) => instance.pluginId),
        );
      },
    },
  );

  assert.deepEqual(await compatibility.list(), []);
  assert.equal((await catalog.snapshot()).status, 'degraded');
});

test('retains the last canonical machine catalog when a later read fails', async () => {
  let fail = false;
  let now = 4_000;
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      if (fail) throw new Error('private upstream detail');
      return rawCatalog();
    },
    validateCatalog: canonicalValidator,
    hostPolicies: [
      {
        pluginId: 'dev.clowder.video-analysis',
        effectiveGrants: [],
      },
    ],
    refreshTtlMs: 0,
    now: () => now,
  });

  assert.equal((await provider.snapshot()).status, 'fresh');
  fail = true;
  now = 5_000;
  const degraded = await provider.snapshot();
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.errorCode, 'CATALOG_FETCH_FAILED');
  assert.equal(degraded.checkedAt, 5_000);
  assert.equal(degraded.entries[0].pluginId, 'dev.clowder.video-analysis');
  assert.equal(JSON.stringify(degraded).includes('private upstream detail'), false);
});

test('coalesces concurrent refreshes and reuses catalog truth within the refresh TTL', async () => {
  let loadCount = 0;
  let now = 6_000;
  let releaseFirstLoad;
  const firstLoad = new Promise((resolve) => {
    releaseFirstLoad = resolve;
  });
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      loadCount += 1;
      if (loadCount === 1) await firstLoad;
      return rawCatalog();
    },
    validateCatalog: canonicalValidator,
    hostPolicies: [
      {
        pluginId: 'dev.clowder.video-analysis',
        effectiveGrants: [],
      },
    ],
    refreshTtlMs: 1_000,
    now: () => now,
  });

  const first = provider.snapshot();
  const concurrent = provider.snapshot();
  assert.equal(loadCount, 1);
  releaseFirstLoad();
  const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
  assert.deepEqual(concurrentSnapshot, firstSnapshot);

  now = 6_999;
  assert.deepEqual(await provider.snapshot(), firstSnapshot);
  assert.equal(loadCount, 1);

  now = 7_001;
  const refreshed = await provider.snapshot();
  assert.equal(loadCount, 2);
  assert.equal(refreshed.checkedAt, 7_001);
});

test('loads the configured machine catalog through a bounded HTTPS-only reader', async () => {
  const catalog = rawCatalog();
  const body = Buffer.from(JSON.stringify(catalog));
  const loaded = await loadMachinePluginCatalog('https://raw.githubusercontent.com/example/catalog.json', {
    fetchFn: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.accept, 'application/json');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.byteLength) },
      });
    },
  });

  assert.deepEqual(loaded, catalog);
  await assert.rejects(loadMachinePluginCatalog('http://raw.githubusercontent.com/example/catalog.json'), /HTTPS/);
  await assert.rejects(
    loadMachinePluginCatalog('https://example.com/catalog.json', {
      fetchFn: async () => new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
    }),
    /not JSON/,
  );
});

test('rejects an oversized machine catalog before buffering it', async () => {
  await assert.rejects(
    loadMachinePluginCatalog('https://raw.githubusercontent.com/example/catalog.json', {
      maxBytes: 32,
      fetchFn: async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '33' },
        }),
    }),
    /size limit/,
  );
});
