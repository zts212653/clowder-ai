import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeInfo, probeNode, satisfiesEngine, validateNode } from './lib/build-node.mjs';
import { evaluateArch, inspectBundle } from './lib/mac-bundle-arch.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktop);
const verifier = path.join(desktop, 'scripts/verify-build-node.mjs');
const host = nodeInfo();

for (const scenario of ['missing-node', 'unsupported-engine', 'foreign-arch']) {
  test(`mac build preflight rejects ${scenario} before install/deploy`, { skip: host.platform !== 'darwin' }, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-build-preflight-'));
    try {
      fs.mkdirSync(path.join(fixture, 'desktop/scripts'), { recursive: true });
      fs.mkdirSync(path.join(fixture, 'bin'));
      fs.copyFileSync(path.join(desktop, 'scripts/build-mac.sh'), path.join(fixture, 'desktop/scripts/build-mac.sh'));
      fs.copyFileSync(verifier, path.join(fixture, 'desktop/scripts/verify-build-node.mjs'));
      fs.cpSync(path.join(desktop, 'scripts/lib'), path.join(fixture, 'desktop/scripts/lib'), { recursive: true });
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ engines: { node: scenario === 'unsupported-engine' ? '>=99.0.0' : '>=24.0.0' } }),
      );
      fs.writeFileSync(path.join(fixture, 'bin/pnpm'), '#!/bin/sh\necho INSTALL_WAS_REACHED\nexit 9\n', {
        mode: 0o755,
      });
      if (scenario === 'missing-node')
        fs.writeFileSync(path.join(fixture, 'bin/node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
      else fs.symlinkSync(process.execPath, path.join(fixture, 'bin/node'));
      const args = scenario === 'foreign-arch' ? ['--arch', host.arch === 'arm64' ? 'x64' : 'arm64'] : [];
      const result = spawnSync('/bin/bash', [path.join(fixture, 'desktop/scripts/build-mac.sh'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: path.join(fixture, 'bin') + ':/usr/bin:/bin' },
      });
      assert.notEqual(result.status, 0);
      assert.equal(
        (result.stdout + result.stderr).includes('INSTALL_WAS_REACHED'),
        false,
        result.stdout + result.stderr,
      );
      assert.equal(fs.existsSync(path.join(fixture, 'bundled')), false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test('engines validates complete versions and rejects unknown/missing constraints', () => {
  assert.equal(satisfiesEngine('v24.15.0', '>=24.0.0 <26.0.0'), true);
  assert.equal(satisfiesEngine('v22.12.0', '>=24.0.0'), false);
  assert.equal(satisfiesEngine('v24.0.0', '>=24.1.0'), false);
  assert.equal(satisfiesEngine('v26.0.0', '>=24.0.0 <26.0.0'), false);
  for (const range of [undefined, '', '^24', '>=24.0.0 || unknown'])
    assert.throws(() => satisfiesEngine('v24.15.0', range));
  assert.throws(() => satisfiesEngine('v24.15.0-nightly', '>=24.0.0'));
});

test('same-major runtime caches still fail on exact version, ABI or target mismatch', () => {
  const info = { version: 'v24.15.0', abi: '137', platform: 'darwin', arch: 'arm64' };
  const options = { engine: '>=24.0.0', platform: 'darwin', arch: 'arm64', builtWith: info };
  assert.equal(validateNode(info, options), info);
  for (const delta of [{ version: 'v24.14.0' }, { abi: '136' }, { abi: '' }, { platform: 'win32' }, { arch: 'x64' }]) {
    assert.throws(() => validateNode({ ...info, ...delta }, options));
  }
});

test('CLI rejects missing/incompatible bundled Node instead of guessing', () => {
  assert.equal(spawnSync(process.execPath, [verifier, 'host', root, host.platform, host.arch]).status, 0);
  assert.notEqual(
    spawnSync(process.execPath, [verifier, 'node', root, host.platform, host.arch, '/missing-node']).status,
    0,
  );
  assert.notEqual(
    spawnSync(process.execPath, [verifier, 'host', root, host.platform, host.arch === 'arm64' ? 'x64' : 'arm64'])
      .status,
    0,
  );
});

test('a bundled executable that never responds fails at the probe budget', { skip: host.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hung-node-probe-'));
  try {
    const executable = path.join(dir, 'node');
    fs.writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    assert.throws(() => probeNode(executable, 100), { code: 'ETIMEDOUT' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native smoke cannot fall back to build-host modules when deploy is incomplete', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-api-artifact-'));
  try {
    fs.writeFileSync(path.join(empty, 'package.json'), '{}');
    const result = spawnSync(
      process.execPath,
      [verifier, 'artifact', root, host.platform, host.arch, process.execPath, empty],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /better-sqlite3|node_modules/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('architecture verification checks bytes, loader choice, universal and optional prebuild siblings', () => {
  const entry = (file, archs) => ({ path: file, archs });
  assert.equal(evaluateArch([entry('better_sqlite3.node', ['arm64'])], 'x64').length > 0, true);
  assert.equal(evaluateArch([entry('sharp-darwin-x64/sharp.node', ['arm64'])], 'x64').length > 0, true);
  assert.equal(evaluateArch([entry('sharp-darwin-universal/sharp.node', ['arm64'])], 'x64').length > 0, true);
  assert.equal(
    evaluateArch(
      [entry('prebuilds/darwin-arm64/pty.node', ['arm64']), entry('prebuilds/darwin-x64/pty.node', ['x86_64'])],
      'x64',
    ).length,
    0,
  );
  assert.equal(
    evaluateArch([{ path: 'prebuilds/ios-x64-simulator/bare-fs.bare', archs: ['x86_64'] }], 'arm64').length,
    0,
  );
  assert.equal(
    evaluateArch(
      [entry('prebuilds/darwin-arm64/pty.node', ['arm64']), entry('prebuilds/darwin-x64/pty.node', ['arm64'])],
      'x64',
    ).length > 0,
    true,
  );
  assert.equal(
    evaluateArch(
      [entry('better_sqlite3.node', ['x86_64', 'arm64']), entry('prebuilds/linux-x64/pty.node', [])],
      'arm64',
    ).length,
    0,
  );
  assert.equal(evaluateArch([entry('better_sqlite3.node', [])], 'arm64').length > 0, true);
});

test('afterPack rejects an incomplete app instead of shipping absent native modules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-mac-bundle-'));
  try {
    const { default: afterPack } = await import('../afterPack.js');
    await assert.rejects(
      afterPack.default({
        electronPlatformName: 'darwin',
        arch: 3,
        appOutDir: dir,
        packager: { appInfo: { productFilename: 'Test' } },
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('afterPack module copy stays portable after the build source moves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-module-copy-'));
  try {
    const src = path.join(dir, 'deploy/node_modules');
    const dest = path.join(dir, 'app/node_modules');
    fs.mkdirSync(path.join(src, '.bin'), { recursive: true });
    fs.mkdirSync(path.join(src, 'sdk'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sdk/cli.js'), 'CLI');
    fs.symlinkSync('../sdk/cli.js', path.join(src, '.bin/sdk'));
    const { default: afterPack } = await import('../afterPack.js');
    afterPack.copyRuntimeModules(src, dest);
    fs.renameSync(path.join(dir, 'deploy'), path.join(dir, 'moved-deploy'));
    assert.equal(fs.readFileSync(path.join(dest, '.bin/sdk'), 'utf8'), 'CLI');
    assert.equal(fs.realpathSync(path.join(dest, '.bin/sdk')), path.join(fs.realpathSync(dest), 'sdk/cli.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'real Mach-O mismatch and corrupt/symlinked native files fail closed',
  { skip: process.platform !== 'darwin' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-bundle-'));
    try {
      fs.mkdirSync(path.join(dir, 'native'));
      fs.copyFileSync(process.execPath, path.join(dir, 'native', 'better_sqlite3.node'));
      assert.equal(inspectBundle(dir, host.arch), 1);
      assert.throws(() => inspectBundle(dir, host.arch === 'arm64' ? 'x64' : 'arm64'), /architecture failed/);
      fs.writeFileSync(path.join(dir, 'broken.node'), 'not Mach-O');
      assert.throws(() => inspectBundle(dir, host.arch));
      fs.unlinkSync(path.join(dir, 'broken.node'));
      fs.symlinkSync(process.execPath, path.join(dir, 'escaped.node'));
      assert.throws(() => inspectBundle(dir, host.arch), /escapes app/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
