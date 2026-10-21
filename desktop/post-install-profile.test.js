const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test(
  'an isolated installer without explicit UserProfileRoot keeps hook writes out of the real client home',
  { skip: process.platform !== 'win32' },
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-isolated-hooks-'));
    const instance = path.join(base, 'instance');
    const result = path.join(base, 'target.json');
    fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(instance, 'home'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'desktop-instance.json'),
      JSON.stringify({ CAT_CAFE_DESKTOP_INSTANCE_ROOT: instance }),
    );
    fs.writeFileSync(
      path.join(base, 'scripts/sync-agent-hooks-offline.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify(process.argv.slice(2)));`,
    );
    try {
      const run = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, 'scripts/post-install-offline.ps1'),
          '-AppDir',
          base,
          '-AgentHooksOnly',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(run.status, 0, run.stderr);
      const args = JSON.parse(fs.readFileSync(result, 'utf8'));
      assert.equal(fs.realpathSync.native(args[3]), fs.realpathSync.native(path.join(instance, 'home')));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  'installer hook sync targets an explicit owned profile, including original-user execution',
  { skip: process.platform !== 'win32' },
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-profile-'));
    const profile = path.join(base, 'profile');
    const result = path.join(base, 'target.json');
    fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
    fs.mkdirSync(profile);
    fs.writeFileSync(
      path.join(base, 'scripts/sync-agent-hooks-offline.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify(process.argv.slice(2)));`,
    );
    try {
      const run = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, 'scripts/post-install-offline.ps1'),
          '-AppDir',
          base,
          '-AgentHooksOnly',
          '-UserProfileRoot',
          profile,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(run.status, 0, run.stderr);
      const args = JSON.parse(fs.readFileSync(result, 'utf8'));
      assert.equal(args[0], '--project-root');
      assert.equal(args[2], '--target-root');
      assert.equal(args.length, 4);
      // Windows PowerShell expands a short 8.3 TEMP spelling to the same long path.
      const identity = (directory) => {
        const stat = fs.statSync(directory, { bigint: true });
        return { device: stat.dev, inode: stat.ino };
      };
      assert.deepEqual(identity(args[1]), identity(base));
      assert.deepEqual(identity(args[3]), identity(profile));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);

test('post-install verification accepts shared workspace dependencies', { skip: process.platform !== 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-shared-'));
  try {
    for (const file of [
      '.env',
      'packages/api/dist/index.js',
      'node_modules/@cat-cafe/shared/dist/index.js',
      'node_modules/.runtime-lock.json',
      'node_modules/next/dist/bin/next',
    ]) {
      const target = path.join(base, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file === '.env' ? 'REDIS_URL=redis://127.0.0.1:6330\n' : '{}');
    }
    fs.mkdirSync(path.join(base, 'packages/web/.next'), { recursive: true });
    fs.mkdirSync(path.join(base, 'node_modules/zod'), { recursive: true });
    const run = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'scripts/post-install-offline.ps1'),
        '-AppDir',
        base,
        '-UserProfileRoot',
        path.join(base, 'home'),
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Clowder AI configured!/);
    assert.doesNotMatch(run.stdout, /packages\/api\/node_modules\/@cat-cafe\/shared\/dist\/index.js - missing/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
