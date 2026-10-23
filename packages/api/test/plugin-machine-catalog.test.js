import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  loadMachinePluginCatalog,
  MachineOfficialPluginCatalog,
  OfficialPluginManagerCatalogAdapter,
  resolveLocalPluginEffectiveGrants,
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
        effectiveGrants: ['messaging.send'],
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
      effectiveGrants: ['messaging.send'],
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
    compatibleReplacement: false,
    updateRequiresValidation: true,
    capabilities: [],
  });
});

test('projects the Host bundle locally without starting remote catalog discovery', async () => {
  let remoteLoads = 0;
  const bundled = {
    catalogId: 'chatgpt-dot',
    pluginId: 'official.chatgpt-dot',
    packageName: '@clowder-ai/chatgpt-dot',
    version: '0.1.0',
    distribution: 'bundled',
    archiveUrl: 'builtin://chatgpt-dot',
    packageDigest: digest,
    effectiveGrants: [],
    presentation: {
      displayName: 'ChatGPT Dot',
      publisher: 'Clowder AI',
    },
  };
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      remoteLoads += 1;
      return new Promise(() => {});
    },
    validateCatalog: canonicalValidator,
    hostPolicies: [],
    bundledEntries: [bundled],
  });
  const catalog = new OfficialPluginManagerCatalogAdapter(provider, []);

  const snapshot = await catalog.localSnapshot();

  assert.equal(remoteLoads, 0);
  assert.equal(snapshot.status, 'loading');
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.pluginId),
    ['official.chatgpt-dot'],
  );
});

test('uses the same Host-owned grants for local development archives as catalog releases', () => {
  const policies = [
    {
      pluginId: 'official.weixin-mp',
      effectiveGrants: ['plugin.config.read', 'secret.read'],
    },
    {
      pluginId: 'dev.clowder.video-generation',
      effectiveGrants: ['plugin.config.read', 'secret.read'],
    },
    {
      pluginId: 'dev.clowder.video-analysis',
      effectiveGrants: ['plugin.config.read', 'secret.read'],
    },
  ];

  // The package's request bounds the grant too (F202 W2-6): less than the entry gets less, more gets no more.
  const requesting = (pluginId, ...capabilities) => ({ pluginId, features: [{ capabilities }] });
  assert.deepEqual(
    resolveLocalPluginEffectiveGrants(policies, requesting('official.weixin-mp', 'plugin.config.read', 'secret.read')),
    ['plugin.config.read', 'secret.read'],
  );
  assert.deepEqual(
    resolveLocalPluginEffectiveGrants(
      policies,
      requesting('dev.clowder.video-generation', 'plugin.config.read', 'secret.read', 'messaging.send'),
    ),
    ['plugin.config.read', 'secret.read'],
  );
  assert.deepEqual(
    resolveLocalPluginEffectiveGrants(policies, requesting('untrusted.local', 'plugin.config.read', 'secret.read')),
    [],
  );
  assert.deepEqual(
    resolveLocalPluginEffectiveGrants(policies, requesting('dev.clowder.video-analysis', 'secret.read')),
    ['secret.read'],
  );
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

test('fails closed when catalog validation fails but discovers valid entries without Host grants', async () => {
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
  const discovered = await missingPolicy.snapshot();
  assert.equal(discovered.status, 'fresh');
  assert.equal(discovered.checkedAt, 3_000);
  assert.equal(discovered.entries.length, 1);
  assert.equal(discovered.entries[0].pluginId, 'dev.clowder.video-analysis');
  assert.deepEqual(discovered.entries[0].effectiveGrants, []);
  const manager = await new OfficialPluginManagerCatalogAdapter(missingPolicy, []).snapshot();
  assert.equal(manager.candidates[0].pluginId, 'dev.clowder.video-analysis');
  assert.deepEqual(manager.candidates[0].capabilities, []);
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

test('retries a failed catalog read on the next snapshot request', async () => {
  let loadCount = 0;
  let now = 5_500;
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      loadCount += 1;
      if (loadCount === 1) throw new Error('temporary network failure');
      return rawCatalog();
    },
    validateCatalog: canonicalValidator,
    hostPolicies: [],
    now: () => now,
  });

  const degraded = await provider.snapshot();
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.errorCode, 'CATALOG_FETCH_FAILED');
  assert.equal(loadCount, 1);

  now += 1;
  const recovered = await provider.snapshot();
  assert.equal(recovered.status, 'fresh');
  assert.equal(recovered.checkedAt, now);
  assert.equal(loadCount, 2);
});

test('coalesces only concurrent refreshes and reloads the catalog on the next snapshot request', async () => {
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
    now: () => now,
  });

  const first = provider.snapshot();
  const concurrent = provider.snapshot();
  assert.equal(loadCount, 1);
  releaseFirstLoad();
  const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
  assert.deepEqual(concurrentSnapshot, firstSnapshot);

  now = 6_001;
  const refreshed = await provider.snapshot();
  assert.equal(loadCount, 2);
  assert.equal(refreshed.checkedAt, 6_001);
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

function releaseCatalog(version, seed) {
  const raw = rawCatalog();
  const release = raw.plugins[0].versions[0];
  release.version = version;
  release.artifact.version = version;
  release.artifact.tarballUrl = `https://registry.npmjs.org/@clowder-ai/video-analysis/-/video-analysis-${version}.tgz`;
  release.artifact.integrity = `sha512-${Buffer.alloc(64, seed).toString('base64')}`;
  return raw;
}

for (const [name, mutate, code] of [
  ['rollback', () => releaseCatalog('1.0.0', 1), 'CATALOG_ROLLBACK_REJECTED'],
  [
    'same-version digest change',
    (raw) => {
      raw.plugins[0].versions[0].artifact.integrity = digest;
      return raw;
    },
    'CATALOG_EQUIVOCATION_REJECTED',
  ],
  [
    'same-version archive change',
    (raw) => {
      raw.plugins[0].versions[0].artifact.tarballUrl += '?changed';
      return raw;
    },
    'CATALOG_EQUIVOCATION_REJECTED',
  ],
  [
    'same-version presentation change',
    (raw) => {
      raw.plugins[0].name = 'Different publisher claim';
      return raw;
    },
    'CATALOG_EQUIVOCATION_REJECTED',
  ],
  [
    'same-version package identity change',
    (raw) => {
      raw.plugins[0].versions[0].artifact.packageName = '@other/package';
      return raw;
    },
    'CATALOG_EQUIVOCATION_REJECTED',
  ],
  ['new-version digest reuse', () => releaseCatalog('3.0.0', 2), 'CATALOG_EQUIVOCATION_REJECTED'],
]) {
  test(`machine release continuity rejects ${name} and preserves the trusted snapshot`, async () => {
    let raw = releaseCatalog('2.0.0', 2);
    let now = 1;
    const provider = new MachineOfficialPluginCatalog({
      loadCatalog: async () => raw,
      validateCatalog: canonicalValidator,
      hostPolicies: [],
      now: () => now,
    });
    const first = await provider.snapshot();
    raw = mutate(structuredClone(raw));
    now++;
    const rejected = await provider.snapshot();
    assert.equal(rejected.status, 'degraded');
    assert.equal(rejected.errorCode, code);
    assert.deepEqual(rejected.entries, first.entries);
    raw = releaseCatalog('3.0.0', 3);
    now++;
    const recovered = await provider.snapshot();
    assert.equal(recovered.status, 'fresh');
    assert.equal(recovered.entries[0].version, '3.0.0');
  });
}

test('continuity retains historical digest bindings across upgrades and temporary catalog omission', async () => {
  let raw = releaseCatalog('1.0.0', 1);
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => raw,
    validateCatalog: canonicalValidator,
    hostPolicies: [],
  });
  await provider.snapshot();
  raw = releaseCatalog('2.0.0', 2);
  const trusted = await provider.snapshot();
  raw = releaseCatalog('3.0.0', 1);
  const reused = await provider.snapshot();
  assert.equal(reused.errorCode, 'CATALOG_EQUIVOCATION_REJECTED');
  assert.deepEqual(reused.entries, trusted.entries);
  raw = { schemaVersion: '1', plugins: [] };
  assert.equal((await provider.snapshot()).status, 'fresh');
  raw = releaseCatalog('1.0.0', 1);
  assert.equal((await provider.snapshot()).errorCode, 'CATALOG_ROLLBACK_REJECTED');
});
