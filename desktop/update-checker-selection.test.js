// F273 Phase A — selectUpdateTarget + settings persistence tests
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');

const { selectUpdateTarget, loadSettings, saveSettings } = require('./update-checker');

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
    prerelease: true,
    body: 'Beta release',
    assets: [
      makeAsset('ClowderAI-Setup-0.13.0-beta.1.exe', 301, 810000000, 'sha256:ddd444'),
      makeAsset('ClowderAI-0.13.0-beta.1-arm64.dmg', 302, 625000000, 'sha256:eee555'),
      makeAsset('ClowderAI-0.13.0-beta.1-x64.dmg', 303, 635000000, 'sha256:fff666'),
    ],
  },
  {
    tag_name: 'v0.14.0',
    draft: true,
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
    tag_name: 'v0.11.2',
    draft: false,
    prerelease: false,
    body: 'Incomplete release',
    assets: [makeAsset('ClowderAI-0.11.2-arm64.dmg', 501, 622000000, 'sha256:mmm333')],
  },
];

describe('selectUpdateTarget', () => {
  test('selects highest non-draft non-prerelease with complete assets (win)', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'win32', 'x64');
    assert.notEqual(result, null);
    assert.equal(result.version, '0.12.0');
    assert.equal(result.asset.name, 'ClowderAI-Setup-0.12.0.exe');
    assert.equal(result.asset.id, 201);
    assert.equal(result.asset.digest, 'sha256:aaa111');
    assert.equal(result.releaseNotes, 'New features in 0.12.0');
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
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.12.0', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('filters out prerelease', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.12.0', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('skips releases with incomplete assets', () => {
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
    assert.equal(result, null, 'release incomplete (win32 asset has no digest)');
  });

  test('skippedVersion = highest → returns null (no fallback to older)', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'win32', 'x64', {
      skippedVersion: '0.12.0',
    });
    assert.equal(result, null);
  });

  test('requiredVersion selects the exact release for recovery validation', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.10.1', 'win32', 'x64', {
      requiredVersion: '0.11.1',
    });
    assert.equal(result?.version, '0.11.1');
    assert.equal(result?.asset.digest, 'sha256:jjj000');
  });

  test('handles empty releases array', () => {
    assert.equal(selectUpdateTarget([], '0.10.1', 'win32', 'x64'), null);
  });

  test('handles releases with no assets', () => {
    const r = [{ tag_name: 'v0.12.0', draft: false, prerelease: false, body: '', assets: [] }];
    assert.equal(selectUpdateTarget(r, '0.10.1', 'win32', 'x64'), null);
  });

  test('handles malformed tag_name gracefully', () => {
    const r = [{ tag_name: 'not-a-version', draft: false, prerelease: false, body: '', assets: [] }];
    assert.equal(selectUpdateTarget(r, '0.10.1', 'win32', 'x64'), null);
  });

  // ── Pre-release currentVersion scenarios ──
  test('finds update when current is pre-release of available release', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.12.0-rc.1', 'win32', 'x64');
    assert.notEqual(result, null);
    assert.equal(result.version, '0.12.0');
  });

  test('no update when current pre-release is higher than all releases', () => {
    const result = selectUpdateTarget(FIXTURE_RELEASES, '0.13.0-rc.1', 'win32', 'x64');
    assert.equal(result, null);
  });

  test('pre-release current does not downgrade to lower release', () => {
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
