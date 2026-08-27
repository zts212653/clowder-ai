import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entry, harness, readHeaders, writeHeaders } from './plugin-official-routes.fixture.js';

test('observes a newer catalog snapshot without rebuilding routes and never offers a downgrade', async () => {
  const alpha9 = {
    ...entry,
    version: '0.1.0-alpha.9',
    archiveUrl:
      'https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-0.1.0-alpha.9.tgz',
    packageDigest: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
  };
  let current = entry;
  const catalogProvider = {
    snapshot: async () => ({ entries: [current], status: 'fresh', checkedAt: 1_000 }),
  };
  const { app, installCalls, updateCalls } = await harness({ catalogProvider });
  try {
    const before = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(before.statusCode, 200, before.payload);
    assert.equal(before.json().plugins[0].availableVersion, entry.version);
    assert.equal(before.json().plugins[0].updateAvailable, false);
    assert.deepEqual(before.json().catalog, { status: 'fresh', checkedAt: 1_000 });

    current = alpha9;
    const after = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(after.statusCode, 200, after.payload);
    assert.equal(after.json().plugins[0].availableVersion, '0.1.0-alpha.9');
    assert.equal(after.json().plugins[0].updateAvailable, true);

    const staleInstall = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedCatalogVersion: entry.version,
        expectedPackageDigest: entry.packageDigest,
      },
    });
    assert.equal(staleInstall.statusCode, 409, staleInstall.payload);
    assert.equal(staleInstall.json().code, 'STALE_CATALOG');
    assert.deepEqual(installCalls, []);

    const staleCatalog = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/update',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        expectedCatalogVersion: entry.version,
        expectedPackageDigest: entry.packageDigest,
      },
    });
    assert.equal(staleCatalog.statusCode, 409, staleCatalog.payload);
    assert.equal(staleCatalog.json().code, 'STALE_CATALOG');
    assert.deepEqual(updateCalls, []);
  } finally {
    await app.close();
  }

  const newerInstall = await harness({
    catalogProvider,
    installedVersion: '0.1.0-alpha.10',
    installedDigest: `sha512-${Buffer.alloc(64, 10).toString('base64')}`,
  });
  try {
    current = entry;
    const response = await newerInstall.app.inject({
      method: 'GET',
      url: '/api/plugins/official',
      headers: readHeaders,
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().plugins[0].updateAvailable, false);
  } finally {
    await newerInstall.app.close();
  }
});
