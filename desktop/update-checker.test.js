// F258 Phase A — update-checker unit tests (TDD)
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');

const {
  parseVersion,
  compareSemver,
  resolveAssetName,
  extractAssetQuad,
  selectUpdateTarget,
  loadSettings,
  saveSettings,
  loadCachedReleases,
  saveCachedReleases,
} = require('./update-checker');

function makeAsset(name, id, size, digest) {
  return { id, name, size, browser_download_url: `https://github.com/download/${name}`, digest };
}

const FIXTURE_RELEASES = [
  {
    tag_name: 'v0.12.0',
    draft: false,
    prerelease: false,
    body: 'New features in 0.12.0',
    assets: [
      makeAsset('ClowderAI-Setup-0.12.0.exe', 201, 802000000, 'sha256:aaa111'),
      makeAsset('ClowderAI-0.12.0-arm64.dmg', 202, 622000000, 'sha256:bbb222'),
      makeAsset('ClowderAI-0.12.0-x64.dmg', 203, 632000000, 'sha256:ccc333'),
    ],
  },
  {
    tag_name: 'v0.13.0-beta.1',
    draft: false,
    prerelease: true, // ← should be filtered
    body: 'Beta release',
    assets: [
      makeAsset('ClowderAI-Setup-0.13.0-beta.1.exe', 301, 810000000, 'sha256:ddd444'),
      makeAsset('ClowderAI-0.13.0-beta.1-arm64.dmg', 302, 625000000, 'sha256:eee555'),
      makeAsset('ClowderAI-0.13.0-beta.1-x64.dmg', 303, 635000000, 'sha256:fff666'),
    ],
  },
  {
    tag_name: 'v0.14.0',
    draft: true, // ← should be filtered
    prerelease: false,
    body: 'Draft release',
    assets: [
      makeAsset('ClowderAI-Setup-0.14.0.exe', 401, 820000000, 'sha256:ggg777'),
      makeAsset('ClowderAI-0.14.0-arm64.dmg', 402, 640000000, 'sha256:hhh888'),
      makeAsset('ClowderAI-0.14.0-x64.dmg', 403, 650000000, 'sha256:iii999'),
    ],
  },
  {
    tag_name: 'v0.11.1',
    draft: false,
    prerelease: false,
    body: 'Patch release',
    assets: [
      makeAsset('ClowderAI-Setup-0.11.1.exe', 101, 802000000, 'sha256:jjj000'),
      makeAsset('ClowderAI-0.11.1-arm64.dmg', 102, 622000000, 'sha256:kkk111'),
      makeAsset('ClowderAI-0.11.1-x64.dmg', 103, 632000000, 'sha256:lll222'),
    ],
  },
  {
    // Release with incomplete assets (missing Setup.exe) — should be skipped
    tag_name: 'v0.11.2',
    draft: false,
    prerelease: false,
    body: 'Incomplete release',
    assets: [
      makeAsset('ClowderAI-0.11.2-arm64.dmg', 501, 622000000, 'sha256:mmm333'),
      // missing Setup.exe and x64.dmg
    ],
  },
];

describe('parseVersion', () => {
  test('parses v-prefixed tag', () => {
    assert.deepEqual(parseVersion('v0.11.1'), { major: 0, minor: 11, patch: 1, prerelease: null });
  });

  test('parses bare version string', () => {
    assert.deepEqual(parseVersion('0.11.1'), { major: 0, minor: 11, patch: 1, prerelease: null });
  });

  test('parses major version', () => {
    assert.deepEqual(parseVersion('v1.0.0'), { major: 1, minor: 0, patch: 0, prerelease: null });
  });

  test('parses double-digit components', () => {
    assert.deepEqual(parseVersion('v12.34.56'), { major: 12, minor: 34, patch: 56, prerelease: null });
  });

  test('parses pre-release suffix', () => {
    assert.deepEqual(parseVersion('0.12.0-rc.1'), {
      major: 0,
      minor: 12,
      patch: 0,
      prerelease: ['rc', '1'],
    });
  });

  test('parses pre-release with v-prefix', () => {
    assert.deepEqual(parseVersion('v0.13.0-beta.2'), {
      major: 0,
      minor: 13,
      patch: 0,
      prerelease: ['beta', '2'],
    });
  });

  test('parses single-identifier pre-release', () => {
    assert.deepEqual(parseVersion('1.0.0-alpha'), {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['alpha'],
    });
  });

  test('parses multi-identifier pre-release', () => {
    assert.deepEqual(parseVersion('1.0.0-alpha.beta.3'), {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['alpha', 'beta', '3'],
    });
  });

  test('returns null for invalid input', () => {
    assert.equal(parseVersion('invalid'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion('v1.2'), null);
    assert.equal(parseVersion('v1.2.3.4'), null);
    assert.equal(parseVersion('v1.2.beta'), null);
  });
});

describe('compareSemver', () => {
  test('greater major version', () => {
    assert.ok(compareSemver('1.0.0', '0.99.99') > 0);
  });

  test('greater minor version', () => {
    assert.ok(compareSemver('0.12.0', '0.11.1') > 0);
  });

  test('greater patch version', () => {
    assert.ok(compareSemver('0.10.2', '0.10.1') > 0);
  });

  test('equal versions', () => {
    assert.equal(compareSemver('0.11.1', '0.11.1'), 0);
  });

  test('lesser version returns negative', () => {
    assert.ok(compareSemver('0.10.1', '0.11.1') < 0);
  });

  test('handles v-prefix on either side', () => {
    assert.ok(compareSemver('v0.12.0', '0.11.1') > 0);
    assert.ok(compareSemver('0.12.0', 'v0.11.1') > 0);
    assert.equal(compareSemver('v0.11.1', 'v0.11.1'), 0);
  });

  test('throws on invalid version', () => {
    assert.throws(() => compareSemver('invalid', '0.11.1'));
    assert.throws(() => compareSemver('0.11.1', 'garbage'));
  });

  // ── Pre-release ordering (semver §11) ──
  test('release > same version pre-release', () => {
    assert.ok(compareSemver('0.12.0', '0.12.0-rc.1') > 0);
  });

  test('pre-release < same version release', () => {
    assert.ok(compareSemver('0.12.0-rc.1', '0.12.0') < 0);
  });

  test('pre-release with higher major.minor.patch wins', () => {
    assert.ok(compareSemver('0.12.0-rc.1', '0.11.99') > 0);
    assert.ok(compareSemver('0.13.0-rc.1', '0.12.0') > 0);
  });

  test('pre-release numeric ordering: rc.2 > rc.1', () => {
    assert.ok(compareSemver('0.12.0-rc.2', '0.12.0-rc.1') > 0);
  });

  test('pre-release string ordering: rc > beta > alpha', () => {
    assert.ok(compareSemver('0.12.0-rc.1', '0.12.0-beta.1') > 0);
    assert.ok(compareSemver('0.12.0-beta.1', '0.12.0-alpha.1') > 0);
  });

  test('pre-release equal', () => {
    assert.equal(compareSemver('0.12.0-rc.1', '0.12.0-rc.1'), 0);
  });

  test('pre-release longer > shorter when prefix equal', () => {
    assert.ok(compareSemver('0.12.0-alpha.1', '0.12.0-alpha') > 0);
  });

  test('pre-release numeric < string identifier', () => {
    // semver: numeric identifiers always have lower precedence than string
    assert.ok(compareSemver('0.12.0-1', '0.12.0-alpha') < 0);
  });
});

describe('resolveAssetName', () => {
  test('Windows Setup.exe', () => {
    assert.equal(resolveAssetName('0.12.0', 'win32', 'x64'), 'ClowderAI-Setup-0.12.0.exe');
  });

  test('Windows ignores arch (single installer)', () => {
    assert.equal(resolveAssetName('0.12.0', 'win32', 'arm64'), 'ClowderAI-Setup-0.12.0.exe');
  });

  test('mac arm64 DMG', () => {
    assert.equal(resolveAssetName('0.12.0', 'darwin', 'arm64'), 'ClowderAI-0.12.0-arm64.dmg');
  });

  test('mac x64 DMG', () => {
    assert.equal(resolveAssetName('0.12.0', 'darwin', 'x64'), 'ClowderAI-0.12.0-x64.dmg');
  });

  test('strips v-prefix from version', () => {
    assert.equal(resolveAssetName('v0.12.0', 'win32', 'x64'), 'ClowderAI-Setup-0.12.0.exe');
    assert.equal(resolveAssetName('v0.12.0', 'darwin', 'arm64'), 'ClowderAI-0.12.0-arm64.dmg');
  });
});

describe('asset name ↔ build config contract', () => {
  // Regression test: resolveAssetName must match the names produced by
  // electron-builder (package.json artifactName) and Inno Setup (OutputBaseFilename).
  // If the build config renames artifacts, this test catches the drift.
  const pkgJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const issContent = readFileSync(path.join(__dirname, 'installer', 'cat-cafe.iss'), 'utf-8');

  test('win32 asset name matches Inno Setup OutputBaseFilename', () => {
    // Inno Setup: OutputBaseFilename=ClowderAI-Setup-{#MyAppVersion}
    const issMatch = issContent.match(/OutputBaseFilename=(.+)/);
    assert.ok(issMatch, 'OutputBaseFilename must exist in cat-cafe.iss');
    // Replace Inno variable with a concrete version to compare
    const issFilename = issMatch[1].replace('{#MyAppVersion}', '0.12.0') + '.exe';
    assert.equal(resolveAssetName('0.12.0', 'win32', 'x64'), issFilename);
  });

  test('darwin asset name matches electron-builder artifactName', () => {
    // electron-builder: artifactName=ClowderAI-${version}-${arch}.${ext}
    const artifactName = pkgJson.build?.artifactName;
    assert.ok(artifactName, 'package.json build.artifactName must exist');
    const expected = artifactName.replace('${version}', '0.12.0').replace('${arch}', 'arm64').replace('${ext}', 'dmg');
    assert.equal(resolveAssetName('0.12.0', 'darwin', 'arm64'), expected);
  });
});

describe('extractAssetQuad', () => {
  test('extracts asset info including browser_download_url', () => {
    const asset = makeAsset('ClowderAI-Setup-0.12.0.exe', 201, 802000000, 'sha256:aaa111');
    const result = extractAssetQuad(asset);
    assert.equal(result.id, 201);
    assert.equal(result.name, 'ClowderAI-Setup-0.12.0.exe');
    assert.equal(result.size, 802000000);
    assert.equal(result.digest, 'sha256:aaa111');
    assert.equal(result.browser_download_url, 'https://github.com/download/ClowderAI-Setup-0.12.0.exe');
  });

  test('returns null when digest is missing', () => {
    const asset = makeAsset('test.exe', 1, 100, undefined);
    assert.equal(extractAssetQuad(asset), null);
  });

  test('returns null when digest is empty string', () => {
    const asset = makeAsset('test.exe', 1, 100, '');
    assert.equal(extractAssetQuad(asset), null);
  });
});

describe('selectUpdateTarget', () => {
  test('selects highest non-draft non-prerelease with complete assets (win)', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'win32', 'x64');
    assert.notEqual(result, null);
    assert.equal(result.version, '0.12.0');
    assert.equal(result.asset.name, 'ClowderAI-Setup-0.12.0.exe');
    assert.equal(result.asset.id, 201);
    assert.equal(result.asset.digest, 'sha256:aaa111');
    assert.equal(result.releaseNotes, 'New features in 0.12.0');
    // P1-2: browser_download_url must survive through selectUpdateTarget
    assert.equal(result.asset.browser_download_url, 'https://github.com/download/ClowderAI-Setup-0.12.0.exe');
  });

  test('selects highest for mac arm64', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'darwin', 'arm64');
    assert.notEqual(result, null);
    assert.equal(result.version, '0.12.0');
    assert.equal(result.asset.name, 'ClowderAI-0.12.0-arm64.dmg');
    assert.equal(result.asset.id, 202);
  });

  test('selects highest for mac x64', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'darwin', 'x64');
    assert.notEqual(result, null);
    assert.equal(result.version, '0.12.0');
    assert.equal(result.asset.name, 'ClowderAI-0.12.0-x64.dmg');
    assert.equal(result.asset.id, 203);
  });

  test('returns null when current version >= all releases', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.12.0', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('returns null when current version > all releases', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '1.0.0', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('filters out draft releases', () => {
    // v0.14.0 is draft — should not be selected even though it's highest
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.12.0', 'win32', 'x64');
    // 0.12.0 current, 0.14.0 is draft → no update available
    assert.equal(result, null);
  });

  test('filters out prerelease', () => {
    // v0.13.0-beta.1 is prerelease
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.12.0', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('skips releases with incomplete assets for the platform', () => {
    // v0.11.2 missing Setup.exe → skipped for win32
    // So win from 0.10.1 should get 0.12.0 (not 0.11.2)
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'win32', 'x64');
    assert.equal(result.version, '0.12.0');
  });

  test('skips release when platform asset has no digest', () => {
    const releasesNoDigest = [
      {
        tag_name: 'v0.12.0',
        draft: false,
        prerelease: false,
        body: 'No digest',
        assets: [
          makeAsset('ClowderAI-Setup-0.12.0.exe', 201, 802000000, null),
          makeAsset('ClowderAI-0.12.0-arm64.dmg', 202, 622000000, 'sha256:bbb222'),
          makeAsset('ClowderAI-0.12.0-x64.dmg', 203, 632000000, 'sha256:ccc333'),
        ],
      },
    ];
    const result = selectUpdateTarget(releasesNoDigest, '0.10.1', 'win32', 'x64');
    assert.equal(result, null, 'should skip release when target asset has no digest');
  });

  test('respects skippedVersion option', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'win32', 'x64', {
      skippedVersion: '0.12.0',
    });
    // 0.12.0 is skipped → falls back to 0.11.1
    assert.notEqual(result, null);
    assert.equal(result.version, '0.11.1');
  });

  test('handles empty releases array', () => {
    const result = selectUpdateTarget([], '0.10.1', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('handles releases with no assets', () => {
    const emptyAssets = [{ tag_name: 'v0.12.0', draft: false, prerelease: false, body: '', assets: [] }];
    const result = selectUpdateTarget(emptyAssets, '0.10.1', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('handles malformed tag_name gracefully', () => {
    const badTags = [{ tag_name: 'not-a-version', draft: false, prerelease: false, body: '', assets: [] }];
    const result = selectUpdateTarget(badTags, '0.10.1', 'win32', 'x64');
    assert.equal(result, null);
  });

  // ── Pre-release currentVersion scenarios ──
  test('finds update when current is pre-release of available release', () => {
    // User has 0.12.0-rc.1 installed, v0.12.0 release exists → update available
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.12.0-rc.1', 'win32', 'x64');
    assert.notEqual(result, null);
    assert.equal(result.version, '0.12.0');
  });

  test('no update when current pre-release is higher than all releases', () => {
    // User has 0.13.0-rc.1 installed, highest release is v0.12.0 → no update
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.13.0-rc.1', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('pre-release current does not downgrade to lower release', () => {
    // User has 0.12.0-rc.1, v0.11.1 exists but is lower → should not offer
    const onlyOlder = FIXTURE_RELEASES.filter((r) => r.tag_name === 'v0.11.1');
    const result = selectUpdateTarget(onlyOlder, '0.12.0-rc.1', 'win32', 'x64');
    assert.equal(result, null);
  });
});

describe('settings persistence', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'update-settings-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loadSettings returns defaults when file does not exist', () => {
    const settingsPath = path.join(tempDir, 'update-settings.json');
    const settings = loadSettings(settingsPath);
    assert.equal(settings.autoCheck, true);
    assert.equal(settings.skippedVersion, null);
    assert.equal(settings.lastCheckAt, null);
    assert.equal(settings.etag, null);
  });

  test('saveSettings writes and loadSettings reads back', () => {
    const settingsPath = path.join(tempDir, 'update-settings.json');
    const data = {
      autoCheck: false,
      skippedVersion: '0.12.0',
      lastCheckAt: '2026-07-07T00:00:00.000Z',
      etag: '"abc123"',
    };
    saveSettings(settingsPath, data);
    const loaded = loadSettings(settingsPath);
    assert.deepEqual(loaded, data);
  });

  test('loadSettings tolerates corrupted JSON', () => {
    const settingsPath = path.join(tempDir, 'update-settings.json');
    writeFileSync(settingsPath, 'not valid json!!!');
    const settings = loadSettings(settingsPath);
    // Should return defaults, not throw
    assert.equal(settings.autoCheck, true);
    assert.equal(settings.skippedVersion, null);
  });

  test('saveSettings creates parent directory if needed', () => {
    const settingsPath = path.join(tempDir, 'subdir', 'update-settings.json');
    const data = { autoCheck: true, skippedVersion: null, lastCheckAt: null, etag: null };
    saveSettings(settingsPath, data);
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(content.autoCheck, true);
  });
});

describe('release cache (P1-4: ETag/304 must not suppress Later re-prompt)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'release-cache-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loadCachedReleases returns null when file missing', () => {
    assert.equal(loadCachedReleases(path.join(tempDir, 'nope.json')), null);
  });

  test('saveCachedReleases + loadCachedReleases round-trip', () => {
    const cachePath = path.join(tempDir, 'release-cache.json');
    const releases = [{ tag_name: 'v0.12.0', draft: false, prerelease: false, body: 'test', assets: [] }];
    saveCachedReleases(cachePath, releases);
    const loaded = loadCachedReleases(cachePath);
    assert.deepEqual(loaded, releases);
  });

  test('loadCachedReleases tolerates corrupted JSON', () => {
    const cachePath = path.join(tempDir, 'release-cache.json');
    writeFileSync(cachePath, '{{bad json');
    assert.equal(loadCachedReleases(cachePath), null);
  });

  test('saveCachedReleases creates parent directory', () => {
    const cachePath = path.join(tempDir, 'sub', 'release-cache.json');
    saveCachedReleases(cachePath, []);
    assert.deepEqual(loadCachedReleases(cachePath), []);
  });
});
