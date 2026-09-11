/**
 * Tests for desktop/scripts/lib/installed-layout.mjs.
 *
 * These cover the checks that decide whether an INSTALLED tree is usable —
 * the one class of claim that source-level tests cannot make on their own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkDesktopConfig,
  checkInstalledLayout,
  evaluateToolchainResults,
  requiredPathsFor,
  toolchainChecks,
} from './installed-layout.mjs';

/** Build an `exists` stub backed by a set of root-relative paths. */
function fakeTree(presentPaths) {
  const present = new Set(presentPaths);
  return (absPath) => present.has(absPath);
}

const ALL_WINDOWS = requiredPathsFor('win32').map((entry) => `C:/app/${entry.path}`);

describe('installed-layout: required paths', () => {
  it('accepts a complete Windows install', () => {
    const result = checkInstalledLayout({ platform: 'win32', root: 'C:/app', exists: fakeTree(ALL_WINDOWS) });

    assert.equal(result.ok, true, JSON.stringify(result.missing, null, 2));
    assert.equal(result.checked, requiredPathsFor('win32').length);
  });

  it('reports every missing path together with the reason it matters', () => {
    const withoutRedis = ALL_WINDOWS.filter((p) => !p.includes('redis-server.exe'));
    const result = checkInstalledLayout({ platform: 'win32', root: 'C:/app', exists: fakeTree(withoutRedis) });

    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0].path, /redis-server\.exe/);
    assert.match(result.missing[0].why, /no system Redis/);
  });

  it('promises the zero-system-dependency pieces explicitly', () => {
    const paths = requiredPathsFor('win32').map((entry) => entry.path);

    assert.ok(paths.includes('node/node.exe'), 'the bundled Node must be required');
    assert.ok(paths.includes('.cat-cafe/redis/windows/redis-server.exe'), 'the bundled Redis must be required');
  });

  it('gives every required path an actionable reason', () => {
    for (const platform of ['win32', 'darwin']) {
      for (const entry of requiredPathsFor(platform)) {
        assert.equal(typeof entry.why, 'string', `${platform}:${entry.path}`);
        assert.ok(entry.why.length > 10, `${platform}:${entry.path} needs a real reason`);
      }
    }
  });

  it('checks the macOS bundle layout separately', () => {
    const root = '/Applications/Clowder AI.app';
    const present = requiredPathsFor('darwin').map((entry) => `${root}/${entry.path}`);

    assert.equal(checkInstalledLayout({ platform: 'darwin', root, exists: fakeTree(present) }).ok, true);
    assert.equal(checkInstalledLayout({ platform: 'darwin', root, exists: fakeTree([]) }).ok, false);
  });

  it('refuses a platform it has no expectations for', () => {
    assert.throws(() => requiredPathsFor('linux'), /No installed-layout expectations for platform "linux"/);
  });
});

describe('installed-layout: desktop-config.json', () => {
  it('accepts the metadata the installer writes', () => {
    const result = checkDesktopConfig('{"version":"0.10.1","installType":"installer","installedAt":"2026-09-10"}');

    assert.equal(result.ok, true);
    assert.equal(result.config.installType, 'installer');
  });

  it('rejects missing, empty and malformed metadata', () => {
    assert.equal(checkDesktopConfig(null).ok, false);
    assert.equal(checkDesktopConfig('   ').ok, false);
    assert.match(checkDesktopConfig('{ not json').reason, /not valid JSON/);
  });

  it('names the field that is wrong', () => {
    assert.match(checkDesktopConfig('{"version":"1.0.0"}').reason, /installType missing/);
    assert.match(checkDesktopConfig('{"installType":"installer"}').reason, /version missing/);
  });
});

describe('installed-layout: toolchain checks', () => {
  it('uses the bundled executables under the install root', () => {
    const checks = toolchainChecks({ root: 'C:/app' });
    const ids = checks.map((check) => check.id);

    assert.deepEqual(ids, ['bundled-node-runs', 'bundled-redis-runs', 'native-module-abi']);
    assert.equal(checks[0].cmd, 'C:/app/node/node.exe');
    assert.equal(checks[1].cmd, 'C:/app/.cat-cafe/redis/windows/redis-server.exe');
  });

  it('loads native modules with the bundled Node from the API package', () => {
    const abi = toolchainChecks({ root: 'C:/app' }).find((check) => check.id === 'native-module-abi');

    assert.equal(abi.cwd, 'C:/app/packages/api', 'require() must resolve from packages/api');
    assert.match(abi.args.at(-1), /better-sqlite3/);
    assert.match(abi.args.at(-1), /node-pty/);
  });

  it('explains why each check exists', () => {
    for (const check of toolchainChecks({ root: 'C:/app' })) {
      assert.ok(check.why.length > 10, `${check.id} needs a reason`);
    }
  });
});

describe('installed-layout: judging toolchain results', () => {
  const floor = 24;

  it('passes when every command succeeds', () => {
    const result = evaluateToolchainResults(
      [
        { id: 'bundled-node-runs', code: 0, stdout: 'v24.16.0' },
        { id: 'bundled-redis-runs', code: 0, stdout: 'Redis server v=8.10.1' },
        { id: 'native-module-abi', code: 0 },
      ],
      { nodeMajorFloor: floor },
    );

    assert.equal(result.ok, true, JSON.stringify(result.failures));
  });

  it('fails and quotes the error when a command exits non-zero', () => {
    const result = evaluateToolchainResults(
      [{ id: 'native-module-abi', code: 1, stderr: 'Error: NODE_MODULE_VERSION 127 mismatch' }],
      { nodeMajorFloor: floor },
    );

    assert.equal(result.ok, false);
    assert.equal(result.failures[0].id, 'native-module-abi');
    assert.match(result.failures[0].reason, /NODE_MODULE_VERSION/);
  });

  it('fails when the bundled Node is below the declared floor', () => {
    const result = evaluateToolchainResults([{ id: 'bundled-node-runs', code: 0, stdout: 'v22.12.0' }], {
      nodeMajorFloor: floor,
    });

    assert.equal(result.ok, false);
    assert.match(result.failures[0].reason, /below the declared floor v24/);
  });

  it('fails when the Node version cannot be parsed', () => {
    const result = evaluateToolchainResults([{ id: 'bundled-node-runs', code: 0, stdout: 'garbage' }], {
      nodeMajorFloor: floor,
    });

    assert.equal(result.ok, false);
    assert.match(result.failures[0].reason, /could not parse a version/);
  });

  it('does not apply the Node floor to other checks', () => {
    const result = evaluateToolchainResults([{ id: 'bundled-redis-runs', code: 0, stdout: 'v=8.10.1' }], {
      nodeMajorFloor: floor,
    });

    assert.equal(result.ok, true);
  });
});
