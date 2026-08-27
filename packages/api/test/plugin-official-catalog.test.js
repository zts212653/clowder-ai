import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareOfficialPluginVersions,
  OFFICIAL_PLUGIN_POLICIES,
  RefreshingOfficialPluginCatalog,
} from '../dist/domains/plugin/index.js';

const policy = OFFICIAL_PLUGIN_POLICIES[0];
const alpha8Digest = 'sha512-unl8sq1rEMckgiqE8mI0e0+Qa6l69J4cxT2GOe5AMUSomkrbmpKdZR/EYljvH+hP4tNaR9l1KQd6T9GWX49L4w==';
const alpha9Digest = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;

function tarball(version) {
  return `https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-${version}.tgz`;
}

function metadata(version, digest, overrides = {}) {
  return {
    name: policy.packageName,
    version,
    dist: {
      tarball: tarball(version),
      integrity: digest,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/@clowder-ai%2ffeishu-meeting-intake@${version}`,
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
    ...overrides,
  };
}

function response(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('bootstraps alpha.8 policy and hot-refreshes release coordinates without widening Host authority', async () => {
  let now = 1_000;
  let fetches = 0;
  const catalog = new RefreshingOfficialPluginCatalog({
    policies: OFFICIAL_PLUGIN_POLICIES,
    now: () => now,
    refreshTtlMs: 1_000,
    fetchFn: async () => {
      fetches += 1;
      return response(
        metadata('0.1.0-alpha.9', alpha9Digest, {
          pluginId: 'attacker.plugin',
          effectiveGrants: ['filesystem.write'],
        }),
      );
    },
  });

  assert.equal(policy.bootstrapRelease.version, '0.1.0-alpha.8');
  assert.equal(policy.bootstrapRelease.packageDigest, alpha8Digest);

  const fresh = await catalog.snapshot();
  assert.equal(fetches, 1);
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.checkedAt, 1_000);
  assert.equal(fresh.entries[0].version, '0.1.0-alpha.9');
  assert.equal(fresh.entries[0].packageDigest, alpha9Digest);
  assert.equal(fresh.entries[0].pluginId, 'official.feishu-meeting-intake');
  assert.deepEqual(fresh.entries[0].effectiveGrants, ['events.publish']);
  assert.deepEqual(fresh.entries[0].ownerAuth?.domains, ['event', 'minutes', 'note', 'vc']);

  now = 1_999;
  assert.equal((await catalog.snapshot()).entries[0].version, '0.1.0-alpha.9');
  assert.equal(fetches, 1, 'fresh reads must stay inside the TTL');
});

test('compares arbitrarily large SemVer numeric identifiers without precision loss', () => {
  assert.equal(compareOfficialPluginVersions('0.1.0-alpha.9007199254740993', '0.1.0-alpha.9007199254740992'), 1);
  assert.equal(compareOfficialPluginVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
});

test('joins concurrent refreshes and retains last-known-good with bounded degraded truth', async () => {
  let now = 1_000;
  let fetches = 0;
  let release;
  const firstResponse = new Promise((resolve) => {
    release = resolve;
  });
  const catalog = new RefreshingOfficialPluginCatalog({
    policies: OFFICIAL_PLUGIN_POLICIES,
    now: () => now,
    refreshTtlMs: 1_000,
    fetchFn: async () => {
      fetches += 1;
      if (fetches === 1) return firstResponse;
      throw new Error('secret upstream detail');
    },
  });

  const first = catalog.snapshot();
  const second = catalog.snapshot();
  assert.equal(fetches, 1);
  release(response(metadata('0.1.0-alpha.9', alpha9Digest)));
  assert.deepEqual(
    (await Promise.all([first, second])).map((snapshot) => snapshot.entries[0].version),
    ['0.1.0-alpha.9', '0.1.0-alpha.9'],
  );

  now = 2_000;
  const degraded = await catalog.snapshot();
  assert.equal(fetches, 2);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.errorCode, 'CATALOG_FETCH_FAILED');
  assert.equal(degraded.checkedAt, 2_000);
  assert.equal(degraded.entries[0].version, '0.1.0-alpha.9');
  assert.equal(JSON.stringify(degraded).includes('secret upstream detail'), false);

  now = 2_999;
  await catalog.snapshot();
  assert.equal(fetches, 2, 'degraded refreshes must also back off for one TTL');
});

test('rejects a newer release that reuses any previously accepted digest', async () => {
  let now = 1_000;
  let next = metadata('0.1.0-alpha.9', alpha9Digest);
  const catalog = new RefreshingOfficialPluginCatalog({
    policies: OFFICIAL_PLUGIN_POLICIES,
    now: () => now,
    refreshTtlMs: 1_000,
    fetchFn: async () => response(next),
  });

  assert.equal((await catalog.snapshot()).entries[0].version, '0.1.0-alpha.9');
  now = 2_000;
  next = metadata('0.1.0-alpha.10', alpha8Digest);

  const degraded = await catalog.snapshot();
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.errorCode, 'CATALOG_INVALID_METADATA');
  assert.equal(degraded.entries[0].version, '0.1.0-alpha.9');
  assert.equal(degraded.entries[0].packageDigest, alpha9Digest);
});

for (const [label, metadataFactory, expectedCode] of [
  [
    'rollback',
    () => metadata('0.1.0-alpha.7', `sha512-${Buffer.alloc(64, 7).toString('base64')}`),
    'CATALOG_ROLLBACK_REJECTED',
  ],
  [
    'same-version digest equivocation',
    () => metadata('0.1.0-alpha.8', `sha512-${Buffer.alloc(64, 8).toString('base64')}`),
    'CATALOG_EQUIVOCATION_REJECTED',
  ],
  [
    'newer version reusing the current digest',
    () => metadata('0.1.0-alpha.9', alpha8Digest),
    'CATALOG_INVALID_METADATA',
  ],
  [
    'wrong package identity',
    () => metadata('0.1.0-alpha.9', alpha9Digest, { name: '@attacker/not-official' }),
    'CATALOG_INVALID_METADATA',
  ],
  [
    'wrong tarball origin',
    () => ({
      ...metadata('0.1.0-alpha.9', alpha9Digest),
      dist: { ...metadata('0.1.0-alpha.9', alpha9Digest).dist, tarball: 'https://attacker.invalid/p.tgz' },
    }),
    'CATALOG_INVALID_METADATA',
  ],
  [
    'credentials in tarball URL',
    () => {
      const value = metadata('0.1.0-alpha.9', alpha9Digest);
      return {
        ...value,
        dist: { ...value.dist, tarball: value.dist.tarball.replace('https://', 'https://user:pass@') },
      };
    },
    'CATALOG_INVALID_METADATA',
  ],
  [
    'credentials in provenance URL',
    () => {
      const value = metadata('0.1.0-alpha.9', alpha9Digest);
      return {
        ...value,
        dist: {
          ...value.dist,
          attestations: {
            ...value.dist.attestations,
            url: value.dist.attestations.url.replace('https://', 'https://user:pass@'),
          },
        },
      };
    },
    'CATALOG_INVALID_METADATA',
  ],
  [
    'missing provenance',
    () => ({
      ...metadata('0.1.0-alpha.9', alpha9Digest),
      dist: { tarball: tarball('0.1.0-alpha.9'), integrity: alpha9Digest },
    }),
    'CATALOG_INVALID_METADATA',
  ],
]) {
  test(`keeps the reviewed bootstrap on ${label}`, async () => {
    const catalog = new RefreshingOfficialPluginCatalog({
      policies: OFFICIAL_PLUGIN_POLICIES,
      now: () => 1_000,
      fetchFn: async () => response(metadataFactory()),
    });

    const snapshot = await catalog.snapshot();
    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.errorCode, expectedCode);
    assert.equal(snapshot.entries[0].version, '0.1.0-alpha.8');
    assert.equal(snapshot.entries[0].packageDigest, alpha8Digest);
  });
}

test('rejects oversized metadata before parsing it', async () => {
  const catalog = new RefreshingOfficialPluginCatalog({
    policies: OFFICIAL_PLUGIN_POLICIES,
    now: () => 1_000,
    fetchFn: async () => response(metadata('0.1.0-alpha.9', alpha9Digest), { 'content-length': '1048576' }),
  });

  const snapshot = await catalog.snapshot();
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.errorCode, 'CATALOG_INVALID_METADATA');
  assert.equal(snapshot.entries[0].version, '0.1.0-alpha.8');
});
