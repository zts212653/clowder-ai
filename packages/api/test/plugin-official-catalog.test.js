import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OFFICIAL_PLUGIN_POLICIES } from '../dist/domains/plugin/index.js';
import { compareOfficialPluginVersions } from '../dist/domains/plugin/manager/official-catalog-provider.js';

test('offline Companion bootstrap uses the exact published alpha.13 archive with the same Host grant', () => {
  const companion = OFFICIAL_PLUGIN_POLICIES.find((entry) => entry.catalogId === 'companion');
  assert.ok(companion);
  assert.equal(companion.bootstrapRelease.version, '0.1.0-alpha.13');
  assert.equal(
    companion.bootstrapRelease.packageDigest,
    'sha512-ABEFM559peLzWfxlBKiCtYznDZ+olFdjfH/P7BZ6qeeykVCyUdtA7abF9jkrvzZefNvx3ghDk9n1IRgmP9lU/A==',
  );
  assert.equal(
    companion.bootstrapRelease.archiveUrl,
    'https://registry.npmjs.org/@clowder-ai/companion/-/companion-0.1.0-alpha.13.tgz',
  );
  assert.deepEqual(companion.effectiveGrants, ['windows.create']);
});

test('compares arbitrarily large SemVer numeric identifiers without precision loss', () => {
  assert.equal(compareOfficialPluginVersions('0.1.0-alpha.9007199254740993', '0.1.0-alpha.9007199254740992'), 1);
  assert.equal(compareOfficialPluginVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
});
