// F273 Phase A — update-checker unit tests: parsing, comparison, asset naming
// Selection + persistence tests: see update-checker-selection.test.js
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { parseVersion, compareSemver, resolveAssetName, extractAssetQuad } = require('./update-checker');

function makeAsset(name, id, size, digest) {
  return { id, name, size, browser_download_url: `https://github.com/download/${name}`, digest };
}

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

// Selection + persistence tests split into update-checker-selection.test.js
