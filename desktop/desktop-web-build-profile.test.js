const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Run actual CLI bytes in a disposable source root. Tests replace build and
// packaging commands with inert tripwires; no application is built or launched.
function fixture(t, script) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-web-profile-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  const bin = path.join(base, 'bin');
  const entry = path.join(root, 'desktop', 'scripts', script);
  const receipt = path.join(base, 'build-profile.txt');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(__dirname, 'scripts', script), entry);
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/bin/sh\ncase " $* " in *" run build "*)\n printf %s "$CAT_CAFE_DESKTOP_WEB_BUILD" >"$F330_BUILD_FLAG_RECEIPT"\n exit 42\n;; esac\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'pnpm.cmd'),
    '@echo off\r\necho %* | findstr /C:"run build" >nul\r\nif not errorlevel 1 (\r\n >"%F330_BUILD_FLAG_RECEIPT%" echo %CAT_CAFE_DESKTOP_WEB_BUILD%\r\n exit /b 42\r\n)\r\nexit /b 0\r\n',
  );
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    F330_BUILD_FLAG_RECEIPT: receipt,
    CAT_CAFE_DESKTOP_WEB_BUILD: '0',
  };
  return { root, bin, entry, receipt, env };
}

test(
  'macOS build entry selects the desktop image profile before invoking the real build command',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t, 'build-mac.sh');
    const result = spawnSync('bash', [f.entry, '--arch', 'arm64'], {
      cwd: f.root,
      env: f.env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.notEqual(result.status, 0, 'the inert pnpm must stop before packaging');
    assert.equal(fs.readFileSync(f.receipt, 'utf8').trim(), '1', result.stdout + result.stderr);
  },
);

test(
  'Windows build entry selects the desktop image profile before invoking the real build command',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = fixture(t, 'build-desktop.ps1');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', f.entry], {
      cwd: f.root,
      env: f.env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.notEqual(result.status, 0, 'the inert pnpm must stop before packaging');
    assert.equal(fs.readFileSync(f.receipt, 'utf8').trim(), '1', result.stdout + result.stderr);
  },
);

test(
  'macOS reused Web input is admitted before frozen export or packaging',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t, 'build-mac.sh');
    fs.writeFileSync(path.join(f.bin, 'node'), '#!/bin/sh\nprintf %s "$1" >"$F330_BUILD_FLAG_RECEIPT"\nexit 42\n', {
      mode: 0o755,
    });
    const result = spawnSync('bash', [f.entry, '--skip-web', '--arch', 'arm64'], {
      cwd: f.root,
      env: f.env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(
      path.basename(fs.readFileSync(f.receipt, 'utf8').trim()),
      'verify-web-build.cjs',
      result.stdout + result.stderr,
    );
  },
);

function webSnapshot(web, revision, unoptimized) {
  fs.mkdirSync(path.join(web, '.next'), { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{}');
  fs.writeFileSync(path.join(web, '.next', '.build-commit'), revision);
  fs.writeFileSync(path.join(web, '.next', 'BUILD_ID'), 'fixture');
  fs.writeFileSync(
    path.join(web, '.next', 'required-server-files.json'),
    JSON.stringify({
      version: 1,
      config: { distDir: '.next', env: { NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION: revision }, images: { unoptimized } },
    }),
  );
  for (const [relative, data] of Object.entries({
    'next/package.json': '{"name":"next","version":"fixture"}',
    '@next/env/index.js': 'exports.loadEnvConfig = () => {};',
  })) {
    const file = path.join(web, 'node_modules', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
}

for (const invalid of ['ordinary', 'stale', 'valid']) {
  test(
    invalid === 'valid'
      ? 'macOS admits a valid reused deploy Web before reaching inert packaging'
      : `macOS refuses ${invalid} reused deploy Web before electron-builder despite a valid source Web`,
    { skip: process.platform !== 'darwin' },
    (t) => {
      const f = fixture(t, 'build-mac.sh');
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
      webSnapshot(path.join(f.root, 'packages', 'web'), revision, true);
      webSnapshot(
        path.join(f.root, 'bundled', 'deploy', 'web'),
        invalid === 'stale' ? 'a'.repeat(40) : revision,
        invalid !== 'ordinary',
      );
      fs.copyFileSync(
        path.join(__dirname, 'runtime-web-config.js'),
        path.join(f.root, 'desktop', 'runtime-web-config.js'),
      );
      fs.copyFileSync(
        path.join(__dirname, 'scripts', 'verify-web-build.cjs'),
        path.join(f.root, 'desktop', 'scripts', 'verify-web-build.cjs'),
      );
      const node = path.join(f.root, 'bundled', 'node-darwin-arm64', 'bin', 'node');
      const redis = path.join(f.root, 'bundled', 'redis-darwin-arm64', 'redis-server');
      const icon = path.join(f.root, 'desktop', 'assets', 'icon.icns');
      for (const file of [node, redis, icon]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
      }
      for (const command of ['npm', 'npx', 'curl', 'make', 'codesign', 'hdiutil', 'sips', 'iconutil']) {
        fs.writeFileSync(
          path.join(f.bin, command),
          '#!/bin/sh\nprintf %s "$0" >"$F330_BUILD_FLAG_RECEIPT"\nexit 42\n',
          { mode: 0o755 },
        );
      }
      const result = spawnSync(
        'bash',
        [f.entry, '--skip-web', '--skip-deploy', '--skip-node', '--skip-redis', '--arch', 'arm64'],
        {
          cwd: f.root,
          env: { ...f.env, CATCAFE_VERSION: '0.14.0' },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      assert.notEqual(result.status, 0);
      if (invalid === 'valid') {
        assert.equal(path.basename(fs.readFileSync(f.receipt, 'utf8')), 'npm');
        assert.match(result.stderr, /npm ci failed/);
        return;
      }
      assert.equal(fs.existsSync(f.receipt), false, 'unadmitted deploy reached packaging or download');
      assert.match(result.stderr, invalid === 'ordinary' ? /requires desktop images/ : /revision differs/);
    },
  );
}
